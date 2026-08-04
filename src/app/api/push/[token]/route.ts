import { createHash } from "node:crypto";

import { db } from "@/db";
import { checkRateLimit } from "@/lib/rate-limit";
import {
  findMonitorByPushToken,
  recordHeartbeat,
  type HeartbeatArrival,
} from "@/modules/monitors/heartbeat";

/**
 * The receiving end of a push monitor.
 *
 *   curl https://vigil.example.com/api/push/<token>
 *   curl "https://vigil.example.com/api/push/<token>?status=down&msg=backup+failed"
 *
 * GET as well as POST, and that is not laziness: the callers are cron
 * lines, CI steps, embedded devices and `curl` in a shell script, and
 * more than half of them can only issue a GET. Uptime Kuma's endpoint
 * has the same shape and the same query parameters, so a token carried
 * across by an import keeps working in whatever already calls it.
 *
 * The request performs exactly one write — the heartbeat row. It does
 * not judge, open incidents, resolve them or send anything, because
 * possession of the token is the whole of the authentication and an
 * unauthenticated request that pages people is an amplifier aimed at
 * your own operators. The scheduled evaluation turns the arrival into
 * an observation; see `modules/monitors/heartbeat.ts`.
 */
export const dynamic = "force-dynamic";

/**
 * Per token, not per IP.
 *
 * The thing worth protecting is the database, and the write is per
 * monitor — a caller that loops without sleeping should not be able to
 * turn one monitor into a write storm. Keying on the IP instead would
 * punish an entire NAT'd site for one bad cron, and would let a
 * distributed caller past anyway.
 *
 * Comfortably above anything configurable, which is the only number
 * that is safe: `MIN_INTERVAL_SECONDS` is two, so a monitor on the
 * fastest interval the form accepts sends thirty beats a minute, and a
 * limit set anywhere near that would start rejecting a correctly
 * configured job. Four times that leaves room for a retrying client
 * without leaving room for a loop.
 *
 * In-memory and therefore per replica, the same cost model as every
 * other limiter here — a guard against runaway clients, not a security
 * control.
 */
const RATE_LIMIT = { limit: 120, windowMs: 60_000 } as const;

function arrivalFrom(url: URL): HeartbeatArrival {
  const status = url.searchParams.get("status");
  const ping = Number(url.searchParams.get("ping"));
  const message = url.searchParams.get("msg");

  return {
    // Anything that is not an explicit failure is the caller saying it
    // is fine — which is what a bare `curl` with no parameters means,
    // and that is the call this endpoint exists for.
    status: status === "down" ? "down" : "up",
    message:
      message === null || message.trim() === "" ? null : message.slice(0, 500),
    responseTimeMs:
      Number.isFinite(ping) && ping >= 0 && ping <= 3_600_000
        ? Math.round(ping)
        : null,
  };
}

/** SHA-256, hex. The token is 256 bits of CSPRNG, so there is no
 * dictionary to slow an attacker through and no reason to pay for one. */
function sha256Hex(token: string): string {
  return createHash("sha256").update(token, "utf8").digest("hex");
}

async function receive(request: Request, token: string): Promise<Response> {
  // Keyed on the hash, not the token. The limiter's map is
  // process-lifetime state, and a push token is a live bearer credential:
  // putting it there hands every token tried since boot to anything that
  // can read the heap. `api/probe/enroll` already reasoned this out and
  // hashes; this route, on the same map, did not.
  if (!checkRateLimit(`push:${sha256Hex(token)}`, RATE_LIMIT)) {
    return Response.json(
      { ok: false, error: "Too many heartbeats." },
      { status: 429 },
    );
  }

  const target = await findMonitorByPushToken(db, token);

  // The same answer for a token that does not exist and one that does
  // — no timing games, but no confirmation either. A 404 that only
  // appears for wrong tokens turns this endpoint into an oracle for
  // guessing valid ones.
  if (!target) {
    return Response.json({ ok: false }, { status: 404 });
  }

  // A paused monitor accepts the beat and records nothing. Pausing
  // means "stop telling me about this", and the operator who paused it
  // cannot always reach the cron that keeps calling — but the arrival
  // must not resurrect a monitor they deliberately silenced, and it
  // must not leave a stale "last seen" that reads as live on resume.
  if (target.paused) {
    return Response.json({ ok: true, paused: true });
  }

  await recordHeartbeat(
    db,
    target.monitorId,
    arrivalFrom(new URL(request.url)),
  );
  return Response.json({ ok: true });
}

export async function GET(
  request: Request,
  context: { params: Promise<{ token: string }> },
): Promise<Response> {
  const { token } = await context.params;
  return receive(request, token);
}

export async function POST(
  request: Request,
  context: { params: Promise<{ token: string }> },
): Promise<Response> {
  const { token } = await context.params;
  return receive(request, token);
}
