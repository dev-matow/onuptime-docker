import type { DbClient } from "@/db";
import { auditLogs } from "@/db/schema";

export interface AuditEntry {
  organizationId: string;
  /** Null when the system (worker) acted on its own. */
  actorId: string | null;
  action: string;
  targetType: string;
  targetId: string;
  metadata?: Record<string, unknown>;
}

/**
 * Fire-and-forget on the caller's transaction: audit writes share the
 * mutation's atomicity — if the mutation rolls back, so does its trail.
 */
export async function writeAudit(
  db: DbClient,
  entry: AuditEntry,
): Promise<void> {
  await db.insert(auditLogs).values({
    organizationId: entry.organizationId,
    actorId: entry.actorId,
    action: entry.action,
    targetType: entry.targetType,
    targetId: entry.targetId,
    metadata: entry.metadata,
  });
}
