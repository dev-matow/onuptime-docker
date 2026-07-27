import net from "node:net";

import type { ProbeContext, ProbeResult } from "../contract";
import type { TcpConfig } from "../specs/tcp";
import { elapsedSince, refusesPrivate, connectionErrorMessage } from "./guard";

/**
 * One TCP connect. A completed handshake is the observation; the
 * connect time is the measurement.
 */
export async function tcpProbe(
  ctx: ProbeContext<TcpConfig>,
): Promise<ProbeResult> {
  const guard = await refusesPrivate(ctx.target, ctx.allowPrivateTargets);
  if (guard) {
    return { facts: {}, responseTimeMs: null, statusCode: null, error: guard };
  }

  const port = ctx.port ?? 0;
  const startedAt = performance.now();

  return new Promise<ProbeResult>((resolve) => {
    const socket = net.connect({ host: ctx.target, port });
    let settled = false;
    const settle = (result: ProbeResult) => {
      if (settled) return;
      settled = true;
      socket.destroy();
      resolve(result);
    };
    socket.setTimeout(ctx.timeoutMs);
    socket.once("connect", () => {
      const responseTimeMs = elapsedSince(startedAt);
      settle({
        facts: { responseTimeMs },
        responseTimeMs,
        statusCode: null,
        error: null,
      });
    });
    socket.once("timeout", () => {
      const responseTimeMs = elapsedSince(startedAt);
      settle({
        facts: { responseTimeMs },
        responseTimeMs,
        statusCode: null,
        error: `Timed out after ${ctx.timeoutMs}ms`,
      });
    });
    socket.once("error", (error: Error) => {
      const responseTimeMs = elapsedSince(startedAt);
      settle({
        facts: { responseTimeMs },
        responseTimeMs,
        statusCode: null,
        error: connectionErrorMessage(error, "Connection failed"),
      });
    });
  });
}
