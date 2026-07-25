import { AppError } from "@/lib/errors";
import { logger } from "@/lib/logger";

/**
 * Uniform envelope returned by every server action. Client components
 * branch on `ok` instead of catching — thrown errors never cross the
 * server-action boundary with a useful message in production.
 */
export type ActionResult<T = undefined> =
  { ok: true; data: T } | { ok: false; error: string };

export function actionOk<T>(data: T): ActionResult<T> {
  return { ok: true, data };
}

export function actionError<T>(error: string): ActionResult<T> {
  return { ok: false, error };
}

/** Domain errors surface their message; anything else is logged and masked. */
export function toActionError<T>(error: unknown): ActionResult<T> {
  if (error instanceof AppError) return { ok: false, error: error.message };
  logger.error({ err: error }, "unexpected error in server action");
  return { ok: false, error: "Something went wrong. Please try again." };
}
