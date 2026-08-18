import dns from "node:dns/promises";
import http from "node:http";
import https from "node:https";
import type { LookupFunction } from "node:net";
import { Readable, type Transform } from "node:stream";
import zlib from "node:zlib";

import { AppError } from "@/lib/errors";
import { env } from "@/lib/env";
import { logger } from "@/lib/logger";

import {
  classifyAddress,
  FORBIDDEN_HOSTNAMES,
  isNeverReachable,
  normalizeHost,
  parseAddress,
  type AddressClass,
} from "./net";

/**
 * The outbound egress policy. One module, every channel.
 *
 * Before this existed the product had four different opinions about
 * where it was allowed to connect: probes resolved once and then let
 * `fetch` resolve again and follow redirects unwatched, webhook
 * delivery checked nothing at all, and recovery compared the hostname
 * against two string literals at the moment an operator typed it and
 * never again. Each of those is a working SSRF vehicle on its own; the
 * combination let a redirect chain turn a monitor into a credential
 * reader.
 *
 * Three properties hold it together:
 *
 * 1. **Every hop is a decision.** Redirects are followed by an explicit
 *    loop here, never by the transport, so the guard sees each URL. An
 *    automatic redirect is a second request nobody validated.
 * 2. **The address validated is the address connected to.** The
 *    transport resolves nothing of its own: it is handed the address
 *    this module classified, via `lookup`, with the hostname left
 *    intact for the `Host` header and the TLS certificate. That is
 *    what closes the rebinding window — re-resolving at connect time
 *    is a second lookup, and the attacker picks what it returns.
 * 3. **Policy is per channel and configurable; the floor is not.**
 *    Whether private space is reachable is a deployment decision and
 *    differs by channel — a recovery hook inside your own network is
 *    the feature. Metadata, link-local, unspecified and reserved space
 *    are reachable by nobody, in any encoding, whatever the policy
 *    says.
 */

/**
 * Which outbound path is asking. The channel selects the default
 * private-network policy, and it is what an approved exception is
 * recorded against.
 */
export type EgressChannel = "monitor" | "webhook" | "recovery";

export interface EgressPolicy {
  channel: EgressChannel;
  /**
   * Whether private and loopback space may be reached. Never widens to
   * metadata, link-local, unspecified or reserved — those are refused
   * by {@link isNeverReachable} before policy is consulted.
   */
  allowPrivate: boolean;
}

/**
 * The shipped defaults, which deliberately differ.
 *
 * Monitors deny: a hosted installation must not be usable as a probe of
 * its own network. Webhooks and recovery allow, because both exist to
 * reach an endpoint the operator runs — recovery's whole purpose is a
 * restart hook on an internal address, and tightening it here would
 * break a shipped feature rather than fix a bug. Each is a separate
 * environment variable so an operator who wants the stricter posture
 * can have it without giving up the other two.
 */
export function egressPolicyFor(
  channel: EgressChannel,
  allowPrivate?: boolean,
): EgressPolicy {
  if (allowPrivate !== undefined) return { channel, allowPrivate };
  switch (channel) {
    case "monitor":
      return { channel, allowPrivate: env.ALLOW_PRIVATE_MONITOR_TARGETS };
    case "webhook":
      return { channel, allowPrivate: env.ALLOW_PRIVATE_WEBHOOK_TARGETS };
    case "recovery":
      return { channel, allowPrivate: env.ALLOW_PRIVATE_RECOVERY_TARGETS };
  }
}

/**
 * A refusal by policy. An `AppError` so a server action shows it to the
 * operator verbatim: "this host cannot be reached" is exactly the
 * message they need, and there is nothing sensitive in it.
 */
export class EgressBlockedError extends AppError {}

export interface ResolvedAddress {
  address: string;
  family: number;
}

export type EgressLookup = (hostname: string) => Promise<ResolvedAddress[]>;

/**
 * `RequestInit` narrowed to what the pinned transport can actually send.
 *
 * Text or bytes, and nothing else: the node path writes the body to a
 * socket, so a `Blob` or a stream has no meaning here. It is widened
 * from plain `string` because Web Push bodies are an encrypted binary
 * record, and it is narrowed from `BodyInit` because a type that
 * promises `FormData` and then throws at runtime is worse than one that
 * never promised it.
 */
export type EgressRequestInit = Omit<RequestInit, "body"> & {
  body?: string | Uint8Array | null;
};

const systemLookup: EgressLookup = (hostname) =>
  dns.lookup(hostname, { all: true, verbatim: true });

/* ------------------------------------------------------------------ */
/* The audit trail for approved exceptions                             */
/* ------------------------------------------------------------------ */

/** One outbound request that policy permitted into non-public space. */
export interface EgressException {
  channel: EgressChannel;
  /** The host as written in the URL. */
  hostname: string;
  /** The address the connection was pinned to. */
  address: string;
  classification: AddressClass;
  /** 0 for the request as issued, 1+ for each redirect hop. */
  hop: number;
  /** Origin and path only — never the query string or any userinfo. */
  url: string;
}

export type EgressAuditSink = (entry: EgressException) => void;

/**
 * The default trail: a structured warning, not a row in `audit_logs`.
 *
 * Egress happens in the worker, on behalf of nobody — there is no actor
 * and, for a probe, no mutation to hang the write on. It also happens
 * on every tick of every monitor, so a database row per approved
 * exception would be a write-amplification bug wearing an audit trail's
 * clothes. A greppable `egress.exception` event carries the same facts
 * to whatever the deployment ships logs to, and callers that do have an
 * organization in hand can pass their own sink.
 */
export const logEgressException: EgressAuditSink = (entry) => {
  logger.warn(
    { event: "egress.exception", ...entry },
    "outbound request approved to a non-public address",
  );
};

/* ------------------------------------------------------------------ */
/* Authorization                                                       */
/* ------------------------------------------------------------------ */

export interface EgressDecision {
  /**
   * The address the connection must use, or null when the hostname did
   * not resolve — see {@link authorizeEgress} for why that is allowed
   * to proceed.
   */
  pin: ResolvedAddress | null;
  classification: AddressClass | null;
  /** True when policy permitted a non-public address. */
  exception: boolean;
}

export interface EgressGuardOptions {
  policy: EgressPolicy;
  lookup?: EgressLookup;
  onException?: EgressAuditSink;
}

/**
 * The message an operator sees, shared with the socket probes' guard so
 * one refusal never reads differently from another. Loopback is
 * reported as "private" on purpose: from the outside they are the same
 * mistake, and every check type has said "resolves to a private
 * address" since 1.9.
 */
export function egressBlockReason(classification: AddressClass): string {
  switch (classification) {
    case "metadata":
      return "Target resolves to a cloud metadata address";
    case "link-local":
      return "Target resolves to a link-local address";
    case "unspecified":
    case "reserved":
      return "Target resolves to a reserved address";
    default:
      return "Target resolves to a private address";
  }
}

/**
 * Resolves one URL and decides whether it may be reached.
 *
 * Throws {@link EgressBlockedError} on refusal; returns the address the
 * caller must pin the connection to on approval. Every resolved address
 * has to pass, not just the one that would be used: a resolver that
 * answers `[93.184.216.34, 127.0.0.1]` is asking the connector to pick,
 * and the connector picks by availability, not by policy.
 *
 * A hostname that does not resolve stops here, and the resolver's own
 * error is what comes out — not a synthetic one, so a monitor on a
 * domain that stopped resolving still reports the DNS failure it always
 * did and is still judged `down`.
 *
 * It used to continue instead, on the premise that "the transport below
 * resolves through the same `dns.lookup`, so it will fail identically."
 * That premise was wrong, and it was the one thing holding the guard
 * shut: a failed lookup became an empty address list, the loop below
 * refused nothing because it had nothing to refuse, and the request went
 * out through the *global* `fetch` — a second, independent getaddrinfo,
 * free to succeed where ours failed, with no classification and no pin.
 * One dropped UDP packet was enough; hostile DNS was not required.
 * `refusesPrivate` in `types/probes/guard.ts` already reasoned it out
 * correctly for the identical question: our resolver failing says
 * nothing about what the next one will do.
 */
export async function authorizeEgress(
  url: URL,
  options: EgressGuardOptions,
  hop = 0,
): Promise<EgressDecision> {
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new EgressBlockedError(
      `Only http and https targets can be reached, not ${url.protocol.replace(":", "")}`,
    );
  }

  const hostname = normalizeHost(url.hostname);
  if (FORBIDDEN_HOSTNAMES.has(hostname)) {
    throw new EgressBlockedError("Target is a cloud metadata endpoint");
  }

  const literal = parseAddress(hostname);
  const addresses: ResolvedAddress[] = literal
    ? [{ address: hostname, family: literal.family }]
    : await (options.lookup ?? systemLookup)(hostname);
  if (addresses.length === 0) {
    // A resolver that succeeds with no answer is the same position as one
    // that threw: no address was classified, so no socket may be opened.
    throw new EgressBlockedError("Target did not resolve to any address");
  }

  for (const { address } of addresses) {
    // An address the classifier cannot read is refused rather than
    // assumed public: it came out of a resolver, and we are about to
    // open a socket to it.
    const classification = classifyAddress(address) ?? "reserved";
    if (classification === "public") continue;
    if (isNeverReachable(classification) || !options.policy.allowPrivate) {
      throw new EgressBlockedError(egressBlockReason(classification));
    }
  }

  // The first answer is the one the connection is pinned to. It is safe
  // to pick blind: the loop above refused unless *every* address passed.
  const pin = addresses[0] ?? null;
  const classification = pin ? classifyAddress(pin.address) : null;
  const exception = classification !== null && classification !== "public";
  if (pin && classification !== null && exception) {
    (options.onException ?? logEgressException)({
      channel: options.policy.channel,
      hostname,
      address: pin.address,
      classification,
      hop,
      url: redactUrl(url),
    });
  }
  return { pin, classification, exception };
}

/** Origin and path. Userinfo and the query string carry credentials. */
function redactUrl(url: URL): string {
  return `${url.protocol}//${url.host}${url.pathname}`;
}

/* ------------------------------------------------------------------ */
/* The redirect loop                                                   */
/* ------------------------------------------------------------------ */

/**
 * Generous, because a legitimate chain is short and a hostile one is
 * bounded by the guard rather than by this number. `fetch` allows 20.
 */
export const MAX_REDIRECT_HOPS = 10;

const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);

/**
 * Headers that must not survive a hop to a different origin. Nothing in
 * this repo sends a redirect-following request with a signature on it —
 * webhook delivery passes `maxRedirects: 0` — but the day someone does,
 * this is the difference between a misrouted request and a leaked
 * secret.
 */
const ORIGIN_BOUND_HEADERS = ["authorization", "cookie", "x-vigil-signature"];

export interface EgressFetchOptions extends EgressGuardOptions {
  /**
   * The transport.
   *
   * Unset — or set to the global `fetch` — selects the address-pinned
   * client below, which is the only configuration actually protected
   * against rebinding; an injected transport resolves on its own and is
   * the caller's business. Identity against the global is the signal
   * because the probe contract always carries a `fetchImpl` (it is how
   * every test reaches a probe) and in production that value *is* the
   * global. Without the comparison, nothing would be pinned anywhere
   * that matters.
   */
  fetchImpl?: typeof fetch;
  /** 0 refuses to follow at all and returns the 3xx to the caller. */
  maxRedirects?: number;
}

export interface EgressFetchResult {
  response: Response;
  /** Where the response actually came from, after every validated hop. */
  finalUrl: string;
  redirects: number;
  /**
   * One per hop, in order. Callers that open a *second* socket to the
   * same host — the `http` type's certificate read — reuse
   * `decisions[0].pin` rather than resolving again, so both sockets
   * land on the address the policy approved.
   */
  decisions: readonly EgressDecision[];
}

/**
 * A guarded request: resolve, classify, connect to the address that was
 * classified, and walk any redirect chain one validated hop at a time.
 */
export async function egressFetch(
  target: string,
  init: EgressRequestInit,
  options: EgressFetchOptions,
): Promise<EgressFetchResult> {
  const maxRedirects = options.maxRedirects ?? MAX_REDIRECT_HOPS;
  let url = new URL(target);
  let method = (init.method ?? "GET").toUpperCase();
  let body = init.body ?? null;
  // Kept in the caller's own shape until a hop actually needs to change
  // it. Normalising to `Headers` up front would be tidier and would
  // silently rewrite what an injected transport observes.
  let headers = init.headers;
  const decisions: EgressDecision[] = [];

  for (let hop = 0; ; hop += 1) {
    const decision = await authorizeEgress(url, options, hop);
    decisions.push(decision);
    const injected = options.fetchImpl;
    const transport =
      injected === undefined || injected === globalThis.fetch
        ? pinnedFetch(decision.pin)
        : injected;

    const response = await transport(url.toString(), {
      ...init,
      method,
      headers,
      // An injected `fetch` is a test seam or a caller's own client, and
      // both accept bytes; the DOM type for `body` predates that and
      // does not say so. The pinned transport below is typed honestly.
      body: body as BodyInit | null,
      // Manual, always: an automatic redirect is a second request the
      // guard never saw, sent to a host the attacker chose.
      redirect: "manual",
    });

    const location = response.headers.get("location");
    if (
      hop >= maxRedirects ||
      location === null ||
      !REDIRECT_STATUSES.has(response.status)
    ) {
      return {
        response,
        finalUrl: response.url || url.toString(),
        redirects: hop,
        decisions,
      };
    }

    // A `Location` that will not parse is a broken or hostile server,
    // not a destination. The 3xx goes back as the answer — the type's
    // assertions can say what an unexpected status means — rather than
    // throwing a URL error out of a check that did get a response.
    let next: URL;
    try {
      next = new URL(location, url);
    } catch {
      return {
        response,
        finalUrl: response.url || url.toString(),
        redirects: hop,
        decisions,
      };
    }

    // Drained before moving on: nothing reads a redirect's body, and an
    // unconsumed stream holds its buffers and its socket open.
    await response.arrayBuffer().catch(() => undefined);

    const mutable = new Headers(headers);
    if (next.origin !== url.origin) {
      for (const name of ORIGIN_BOUND_HEADERS) mutable.delete(name);
    }
    // The status rules `fetch` itself applies: 303 always downgrades to
    // GET, 301/302 downgrade anything that was not a GET or HEAD, and
    // 307/308 exist precisely to preserve the method and body.
    if (
      response.status === 303 ||
      ((response.status === 301 || response.status === 302) &&
        method !== "GET" &&
        method !== "HEAD")
    ) {
      method = "GET";
      body = null;
      mutable.delete("content-type");
      mutable.delete("content-length");
    }
    headers = mutable;
    url = next;
  }
}

/* ------------------------------------------------------------------ */
/* The address-pinned transport                                        */
/* ------------------------------------------------------------------ */

/**
 * `fetch`, with the DNS answer supplied rather than looked up.
 *
 * This is the half of the rebinding fix that `fetch` cannot express.
 * The WHATWG interface has no hook for the socket's address, and `Host`
 * is a forbidden request header there, so rewriting the URL to the
 * validated IP would send the wrong `Host` and break every name-based
 * virtual host in existence. `node:http` takes a `lookup` instead: the
 * URL keeps the hostname — correct `Host`, correct SNI, correct
 * certificate check — and the connector is handed the one address the
 * guard classified.
 *
 * Supports the subset the egress paths use: GET/HEAD/POST/PUT, plain
 * headers, a text or byte body, an abort signal, and never following a
 * redirect (the loop above owns that). It advertises itself as `fetch`
 * so an injected transport is interchangeable with it, which is why the
 * body is narrowed back at the call below rather than in the signature.
 */
function pinnedFetch(pin: ResolvedAddress | null): typeof fetch {
  return (input, init) => {
    const target =
      typeof input === "string"
        ? input
        : input instanceof URL
          ? input.href
          : input.url;
    // Unreachable: `authorizeEgress` throws rather than return a null pin.
    // Kept as a refusal anyway, because this is the line that decides
    // whether an unclassified address gets a socket, and the day someone
    // reintroduces a "just fall back to fetch" path it should fail here
    // rather than silently resolve a second time.
    if (pin === null) {
      throw new EgressBlockedError("Target did not resolve to any address");
    }
    return pinnedRequest(
      new URL(target),
      (init ?? {}) as EgressRequestInit,
      pin,
    );
  };
}

/**
 * The resolver `node:http` is handed: one answer, already classified,
 * delivered on a later turn of the loop.
 *
 * The deferral is not decoration, and it is the whole reason this is a
 * named function with a test of its own. Answering synchronously means
 * the connector runs its `connect(2)` inside this callback, still inside
 * `transport.request(...)`, before that call has returned to
 * `pinnedRequest` below. A connect that fails synchronously - `ENETUNREACH`
 * on a host with no route to the pinned address, which is every worker
 * in a network namespace, a container that lost its default route, and a
 * machine whose uplink just went down - then destroys the socket in the
 * same stack. Two things follow, both bad:
 *
 *  1. The TLS layer keeps unwinding through a socket whose `_handle` is
 *     now null and throws `Cannot read properties of null (reading
 *     'setServername')`. That escapes the promise executor, so the
 *     request rejects with a TypeError that has no `cause` - and every
 *     caller in this repo reports `error.cause.message`.
 *  2. The real `ENETUNREACH` is emitted on the socket a tick later, by
 *     which time `transport.request(...)` has thrown rather than
 *     returned, so `request.once("error", ...)` below was never
 *     attached. An 'error' event with no listener is an UNCAUGHT
 *     EXCEPTION: in production that is the worker process dying, which
 *     means monitoring stops at exactly the moment the network broke.
 *
 * `dns.lookup` is asynchronous in every implementation node ships - it
 * answers from the threadpool - so a connector that could not survive a
 * later answer would already be broken. Answering on the next turn is
 * the shape node is written against, and it puts the connect error back
 * on the ordinary socket path, where it becomes the same
 * `TypeError("fetch failed", { cause })` a refused connection produces.
 */
export function pinnedLookup(pin: ResolvedAddress): LookupFunction {
  return (_hostname, lookupOptions, callback) => {
    // `setImmediate` rather than `nextTick`: the nextTick queue drains
    // ahead of I/O, and the point is to look like the I/O completion a
    // real lookup is.
    setImmediate(() => {
      // Node calls this with `all: true` from `net.connect`, and with
      // the single-address shape elsewhere. Answer in the shape asked
      // for; both mean the same one address.
      if (lookupOptions.all) {
        callback(null, [{ address: pin.address, family: pin.family }]);
      } else {
        callback(null, pin.address, pin.family);
      }
    });
  };
}

function pinnedRequest(
  url: URL,
  init: EgressRequestInit,
  pin: ResolvedAddress,
): Promise<Response> {
  const secure = url.protocol === "https:";
  const transport = secure ? https : http;
  const method = (init.method ?? "GET").toUpperCase();
  const body = init.body ?? null;
  const headers = requestHeaders(init.headers, body);
  const signal = init.signal ?? null;

  return new Promise<Response>((resolve, reject) => {
    if (signal?.aborted) {
      reject(signal.reason);
      return;
    }

    const request = transport.request(
      {
        protocol: url.protocol,
        // Unbracketed: `URL.hostname` keeps the brackets on an IPv6
        // literal and `node:http` re-adds them when it builds `Host`.
        hostname: normalizeHost(url.hostname),
        port: url.port || (secure ? 443 : 80),
        path: `${url.pathname}${url.search}`,
        method,
        headers,
        // Pooling would let a later request ride a socket opened for an
        // earlier one, and a reused socket never calls `lookup`. The
        // connections here are one-per-check anyway — undici's pool
        // times out in four seconds and the fastest monitor interval is
        // measured in seconds.
        agent: false,
        lookup: pinnedLookup(pin),
      },
      (message) => {
        resolve(webResponse(message, url, method));
      },
    );

    const onAbort = () => {
      reject(signal?.reason);
      request.destroy();
    };
    signal?.addEventListener("abort", onAbort, { once: true });
    request.once("close", () => signal?.removeEventListener("abort", onAbort));

    // `fetch` reports every transport failure as a TypeError carrying
    // the real error as its cause, and every caller in this repo reads
    // `error.cause.message`. Matching that shape is what keeps the
    // probes' error reporting identical to before.
    request.once("error", (error) =>
      reject(new TypeError("fetch failed", { cause: error })),
    );

    if (body !== null) request.write(body);
    request.end();
  });
}

function requestHeaders(
  init: HeadersInit | undefined,
  body: string | Uint8Array | null,
): Record<string, string> {
  const headers: Record<string, string> = {
    // What `fetch` sends by default and what servers expect to see.
    // Content negotiation changes what a health endpoint returns, so a
    // transport swap that dropped these would change observations.
    accept: "*/*",
    "accept-encoding": "gzip, deflate, br",
  };
  for (const [name, value] of new Headers(init)) headers[name] = value;
  if (body !== null && headers["content-length"] === undefined) {
    headers["content-length"] = String(Buffer.byteLength(body));
  }
  return headers;
}

/**
 * A real `Response` over the node stream, so callers keep `ok`,
 * `status`, `headers`, `arrayBuffer()` and a readable `body` without
 * knowing which client produced it.
 */
function webResponse(
  message: http.IncomingMessage,
  url: URL,
  method: string,
): Response {
  const status = message.statusCode ?? 502;
  const headers = responseHeaders(message.headers);

  // 204/205/304 may not carry a body at all, and a HEAD response has
  // none to carry. `new Response` throws on the first three rather than
  // ignoring them.
  const bodyless =
    method === "HEAD" || status === 204 || status === 205 || status === 304;

  let stream: Readable = message;
  const encoding = (message.headers["content-encoding"] ?? "").toLowerCase();
  // Decode only what has bytes. A HEAD's `content-encoding` describes
  // the GET it stands in for, not the zero bytes it actually sent, and
  // Cloudflare among others sends exactly that. Building a decoder for
  // it fed EOF to brotli at byte zero, which is a `Z_BUF_ERROR` — and
  // `pipe()` does not forward errors, so it surfaced as an unhandled
  // 'error' event and killed the process. `fetch` does not decompress a
  // bodyless response either, so skipping it is also the compatible
  // answer, and the encoding header stays because no decoding happened.
  const decompressor = bodyless ? null : decompressorFor(encoding);
  if (decompressor) {
    // Errors reach the caller through the web stream `Readable.toWeb`
    // wraps this in, and a rejected `text()` is what a truncated body
    // should be. This listener is the safety net for a decoder that
    // errors after the reader is gone: still not a crash, still not a
    // silent wrong answer, because nobody is reading by then.
    decompressor.on("error", () => undefined);
    stream = message.pipe(decompressor);
    // `pipe()` forwards bytes and nothing else. A server that hangs up
    // mid-body errors `message`, the decoder never hears about it, and
    // the read waits for an end that is not coming — a check job that
    // hangs rather than reporting a failure. Destroying the decoder with
    // the cause makes the reader reject, which is what a truncated body
    // is.
    message.on("error", (error) => decompressor.destroy(error));
    // The body is no longer encoded and no longer that length; leaving
    // the headers on would describe a body that is not there.
    headers.delete("content-encoding");
    headers.delete("content-length");
  }

  if (bodyless) stream.resume();

  const response = new Response(
    bodyless
      ? null
      : (Readable.toWeb(stream) as unknown as ReadableStream<Uint8Array>),
    { status, statusText: reasonPhrase(message.statusMessage), headers },
  );
  // `Response.url` is read-only and empty on a hand-built response;
  // domain-expiry decides who answered a 404 from it.
  Object.defineProperty(response, "url", { value: url.toString() });
  return response;
}

function decompressorFor(encoding: string): Transform | null {
  if (encoding === "gzip" || encoding === "x-gzip") return zlib.createGunzip();
  if (encoding === "deflate") return zlib.createInflate();
  if (encoding === "br") return zlib.createBrotliDecompress();
  return null;
}

/**
 * Header names and values come off the wire from a host we do not
 * trust. `Headers` throws on anything that is not a valid token, and a
 * probe that threw here would report a hostile server as a crash rather
 * than as a response — so an unusable header is dropped instead.
 */
function responseHeaders(raw: http.IncomingHttpHeaders): Headers {
  const headers = new Headers();
  for (const [name, value] of Object.entries(raw)) {
    if (value === undefined) continue;
    for (const single of Array.isArray(value) ? value : [value]) {
      try {
        headers.append(name, single);
      } catch {
        continue;
      }
    }
  }
  return headers;
}

/** Same reasoning as the headers: a reason phrase is attacker-supplied. */
function reasonPhrase(statusMessage: string | undefined): string {
  if (!statusMessage) return "";
  return /^[\t\x20-\x7e\x80-\xff]*$/.test(statusMessage) ? statusMessage : "";
}
