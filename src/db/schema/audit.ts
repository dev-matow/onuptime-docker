import {
  bigint,
  index,
  jsonb,
  pgTable,
  text,
  timestamp,
} from "drizzle-orm/pg-core";

import { organization, user } from "./auth";

/**
 * Append-only audit trail of privileged actions. Rows are never updated;
 * actor is nullable so history survives account deletion.
 */
export const auditLogs = pgTable(
  "audit_logs",
  {
    id: bigint({ mode: "number" }).generatedAlwaysAsIdentity().primaryKey(),
    organizationId: text()
      .notNull()
      .references(() => organization.id, { onDelete: "cascade" }),
    actorId: text().references(() => user.id, { onDelete: "set null" }),
    /** Dot-separated resource.verb, e.g. "monitor.created". */
    action: text().notNull(),
    targetType: text().notNull(),
    targetId: text().notNull(),
    metadata: jsonb().$type<Record<string, unknown>>(),
    createdAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index().on(t.organizationId, t.createdAt.desc())],
);
