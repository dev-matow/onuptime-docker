import net from "node:net";

import { DEFAULT_MEMCACHED_PORT } from "../catalog";
import type { FactBag, ProbeContext, ProbeResult } from "../contract";
import type { MemcachedConfig } from "../specs/memcached";
import { connectionErrorMessage, elapsedSince, refusesPrivate } from "./guard";

/**
 * memcached's text protocol, spoken by hand.
 *
 * There is no client library here for the same reason there is none in
 * `redis.ts`: the protocol is newline-delimited ASCII, the whole check
 * is three commands, and a driver would cost megabytes in an image
 * whose pitch is two processes and a Postgres.
 *
 * What is asked, and why each of them:
 *
 *  - `version` — the cheapest thing that proves a memcached is on the
 *    port. A `tcp` monitor on 11211 completes its handshake against a
 *    proxy, a TLS terminator, or whatever the compose file was edited
 *    to put there; only a `VERSION` reply says which service answered.
 *  - `stats` — `uptime` (a silent restart is a cache that quietly lost
 *    everything) and `curr_connections`.
 *  - `stats settings` — `maxconns`, which is the denominator that turns
 *    the connection count into the saturation signal the spec asserts
 *    on. Connection exhaustion is the memcached outage a socket check
 *    cannot see, because by then the socket check already has one.
 *
 * Nothing is written to the cache. Every command here is a read, which
 * matters more than usual for this type — see {@link authenticate}.
 */

const CRLF = "\r\n";

/**
 * `stats` and `stats settings` together are a few kilobytes on any real
 * server. The cap is protection against a peer that never stops
 * talking, not a limit anything legitimate approaches: without it the
 * worker buffers whatever it is sent for as long as the check window
 * allows.
 */
const MAX_REPLY_BYTES = 64 * 1024;

/**
 * The command a `stats` block ends with. `ERROR`, `CLIENT_ERROR …` and
 * `SERVER_ERROR …` are the three ways it can end instead.
 */
const END = "END";

/**
 * Whether an error line is the server saying "not without credentials".
 *
 * memcached answers every command on an unauthenticated connection with
 * `CLIENT_ERROR authentication required` when it was started with
 * `-Y/--auth-file`, and answers a rejected credential with
 * `CLIENT_ERROR authentication failure`. Matching on the word rather
 * than the full sentence, because the wording has changed between
 * releases and the classification has not.
 */
export function isAuthError(line: string): boolean {
  return /^(CLIENT_ERROR|SERVER_ERROR)\b.*\bauth/i.test(line);
}

/** The three ways a memcached command can fail. */
function isErrorLine(line: string): boolean {
  return (
    line === "ERROR" ||
    line.startsWith("CLIENT_ERROR ") ||
    line.startsWith("SERVER_ERROR ")
  );
}

/**
 * The ASCII authentication command: a `set` whose key is the user name
 * and whose data block is the password.
 *
 * That is memcached's own design (the `-Y/--auth-file` mode added in
 * 1.5.16), and it is also why this probe never sends it speculatively.
 * On a server that was *not* started with an auth file there is nothing
 * special about this command at all — it is an ordinary store, and it
 * would write the password into the cache under a key named after the
 * user, where any client can `get` it. So authentication is only ever
 * attempted after the server has said it wants some, which it does by
 * refusing `version`.
 */
export function encodeAuth(username: string, password: string): Buffer {
  return Buffer.from(
    `set ${username} 0 0 ${Buffer.byteLength(password)}${CRLF}${password}${CRLF}`,
    "utf8",
  );
}

/** What one exchange with the server yielded. */
export interface MemcachedReply {
  /** The `VERSION` line's argument, or null when it never answered one. */
  version: string | null;
  stats: ReadonlyMap<string, string>;
  settings: ReadonlyMap<string, string>;
  /** The server's own words when it refused a command. */
  serverError: string | null;
}

function statNumber(
  source: ReadonlyMap<string, string>,
  key: string,
): number | null {
  const raw = source.get(key);
  if (raw === undefined) return null;
  const value = Number(raw);
  // Counters arrive as text from a host we do not control. A value that
  // is not a finite number is not a measurement, and recording it as
  // `NaN` would put an unreadable fact on the timeline and hand the
  // saturation assertion something it cannot compare.
  return Number.isFinite(value) ? value : null;
}

/**
 * Turns a reply into facts. Pure, and exported, because reading the
 * answer is the whole check — the socket around it is plumbing.
 *
 * Unknown counters are omitted rather than recorded as null: a hosted
 * memcached that restricts `stats settings` has not told us its
 * connection limit, and a null on the timeline reads as "measured, and
 * it was nothing".
 */
export function memcachedFacts(
  reply: MemcachedReply,
  responseTimeMs: number,
): FactBag {
  const facts: FactBag = { responseTimeMs };
  if (reply.version !== null) facts.version = reply.version;
  if (reply.serverError !== null) facts.serverError = reply.serverError;

  const uptime = statNumber(reply.stats, "uptime");
  if (uptime !== null) facts.uptimeSeconds = uptime;

  const current = statNumber(reply.stats, "curr_connections");
  if (current !== null) facts.currentConnections = current;

  const max = statNumber(reply.settings, "maxconns");
  if (max !== null) facts.maxConnections = max;

  if (current !== null && max !== null && max > 0) {
    facts.connectionUsagePercent = Math.round((current / max) * 100);
  }
  return facts;
}

export async function memcachedProbe(
  ctx: ProbeContext<MemcachedConfig>,
): Promise<ProbeResult> {
  const guard = await refusesPrivate(
    ctx.target,
    ctx.allowPrivateTargets,
    ctx.lookup,
  );
  if (guard) {
    return { facts: {}, responseTimeMs: null, statusCode: null, error: guard };
  }

  const port = ctx.port ?? DEFAULT_MEMCACHED_PORT;
  const { username, password } = ctx.config;
  const credential =
    username !== null && password !== null ? { username, password } : null;
  const startedAt = performance.now();

  return new Promise<ProbeResult>((resolve) => {
    const socket = net.connect({ host: ctx.target, port });
    // The commands here are a dozen bytes each and the thing being
    // measured is how long the answer takes. Nagle would hold a command
    // back waiting for an ACK of the previous one and charge the server
    // up to 40ms of the kernel's arithmetic — a latency an operator
    // would alert on and no packet capture would explain. memcached
    // sets the same option on its own side.
    socket.setNoDelay(true);

    let settled = false;
    const settle = (result: ProbeResult) => {
      if (settled) return;
      settled = true;
      clearTimeout(deadline);
      socket.destroy();
      resolve(result);
    };

    /** The conversation ended having measured something. */
    const measured = (reply: MemcachedReply, unavailable?: string) => {
      const responseTimeMs = elapsedSince(startedAt);
      settle({
        facts: memcachedFacts(reply, responseTimeMs),
        responseTimeMs,
        statusCode: null,
        error: null,
        unavailable: unavailable ?? null,
      });
    };

    /** The conversation could not happen at all. */
    const failed = (error: string) => {
      const responseTimeMs = elapsedSince(startedAt);
      settle({
        facts: { responseTimeMs },
        responseTimeMs,
        statusCode: null,
        error,
      });
    };

    // `socket.setTimeout` is an *idle* timer: every byte resets it, so a
    // peer that dribbles one byte at a time holds the worker open long
    // past the check window without ever going idle. A `stats` block
    // legitimately arrives in several packets, so this exchange needs a
    // deadline over the whole of it as well as an idle timer.
    const deadline = setTimeout(
      () => failed(`Timed out after ${ctx.timeoutMs}ms`),
      ctx.timeoutMs,
    );
    socket.setTimeout(ctx.timeoutMs);

    let phase: "version" | "auth" | "stats" | "settings" = "version";
    let version: string | null = null;
    let serverError: string | null = null;
    const stats = new Map<string, string>();
    const settings = new Map<string, string>();
    const reply = (): MemcachedReply => ({
      version,
      stats,
      settings,
      serverError,
    });
    /** True once the credential has been offered, so it is offered once. */
    let authenticated = false;

    // Buffered as bytes rather than as a growing string: a chunk
    // boundary can fall inside a multi-byte character, and decoding
    // each chunk on its own would turn the halves into two replacement
    // characters that no longer match anything the protocol defines.
    let pending: Buffer = Buffer.alloc(0);
    let received = 0;

    const askVersion = () => socket.write(`version${CRLF}`);
    const askStats = () => socket.write(`stats${CRLF}stats settings${CRLF}`);

    socket.once("connect", askVersion);

    const readLine = (line: string) => {
      if (phase === "auth") {
        // `STORED` is what a successful ASCII authentication answers.
        if (line === "STORED") {
          phase = "version";
          askVersion();
          return;
        }
        serverError = line;
        // A rejected credential is neither an outage nor a measurement:
        // the server is up and talking, and the stored password is
        // wrong. That is an operator error, and an operator error that
        // reads as `down` is indistinguishable from the cache being
        // gone.
        measured(
          reply(),
          `The server refused the stored credentials: ${summarise(line)}`,
        );
        return;
      }

      if (phase === "version") {
        if (line.startsWith("VERSION ")) {
          version = line.slice("VERSION ".length).trim();
          phase = "stats";
          askStats();
          return;
        }
        serverError = line;
        if (isAuthError(line)) {
          if (credential === null) {
            measured(
              reply(),
              "The server requires authentication and this monitor has no credentials",
            );
            return;
          }
          if (authenticated) {
            // Authenticated, and still refused: the credential was
            // accepted for the `set` and rejected for everything else,
            // which is a server-side ACL problem rather than an outage.
            measured(
              reply(),
              `The server still requires authentication after signing in: ${summarise(line)}`,
            );
            return;
          }
          authenticated = true;
          phase = "auth";
          socket.write(encodeAuth(credential.username, credential.password));
          return;
        }
        // Something answered, and it was not memcached. The facts carry
        // the server's words and the `version` assertion calls it down;
        // reporting it as a transport failure would say the network ate
        // it, which is exactly what did not happen.
        measured(reply());
        return;
      }

      const target = phase === "stats" ? stats : settings;
      if (line === END) {
        if (phase === "stats") {
          phase = "settings";
          return;
        }
        measured(reply());
        return;
      }
      if (line.startsWith("STAT ")) {
        // `STAT <name> <value>`; a value may itself contain spaces
        // (`stats settings` reports `maxconns_fast yes`, and some builds
        // report multi-word values), so only the first two fields are
        // split off.
        const [, key, ...rest] = line.split(" ");
        if (key !== undefined) target.set(key, rest.join(" "));
        return;
      }
      if (isErrorLine(line)) {
        // A server that will not answer `stats settings` — some hosted
        // memcacheds refuse it — has still answered `version`, and that
        // is a measurement. Settle with what was gathered instead of
        // waiting for an `END` that is never coming.
        serverError = line;
        measured(reply());
        return;
      }
      // Anything else inside a stats block is noise from a peer that is
      // not following the protocol. Ignored rather than fatal: the
      // block still ends with END, and the facts already gathered are
      // real.
    };

    socket.on("data", (chunk: Buffer) => {
      received += chunk.byteLength;
      if (received > MAX_REPLY_BYTES) {
        failed(
          `The server sent more than ${MAX_REPLY_BYTES} bytes without finishing its reply`,
        );
        return;
      }
      pending = pending.length === 0 ? chunk : Buffer.concat([pending, chunk]);
      let end = pending.indexOf(CRLF);
      while (end !== -1 && !settled) {
        const line = pending.subarray(0, end).toString("utf8");
        pending = pending.subarray(end + CRLF.length);
        readLine(line);
        end = pending.indexOf(CRLF);
      }
    });

    socket.once("timeout", () => failed(`Timed out after ${ctx.timeoutMs}ms`));
    socket.once("error", (error: Error) =>
      failed(connectionErrorMessage(error, "Connection failed")),
    );
    // A server that answered `version` and then hung up has still told
    // us what it is, so that answer is kept. One that hung up before
    // saying anything has not, and without this branch it would say
    // nothing at all until the deadline expired — leaving the operator
    // reading "the network ate it" instead of "the server dropped me".
    socket.once("close", () => {
      if (version !== null) {
        measured(reply());
        return;
      }
      failed("The server closed the connection without replying");
    });
  });
}

/**
 * The server's own words, kept short and printable. This lands in the
 * ledger and in an incident email, and the far end chose every byte of
 * it.
 */
function summarise(line: string): string {
  const printable = line.replace(/\p{Cc}/gu, " ").trim();
  return printable.length > 80 ? `${printable.slice(0, 80)}…` : printable;
}
