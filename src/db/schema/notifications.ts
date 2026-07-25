import { sql } from "drizzle-orm";
import {
  boolean,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";

import { organization } from "./auth";

/**
 * One outbound webhook endpoint per organization. Deliveries are signed
 * with `secret` (HMAC-SHA-256) and sent for every notification event
 * while `enabled`. Kept minimal on purpose — the event set is fixed in
 * code (see modules/notifications/webhook.ts), so there is nothing to
 * store per event.
 */
export const webhookEndpoints = pgTable(
  "webhook_endpoints",
  {
    id: uuid()
      .primaryKey()
      .default(sql`uuidv7()`),
    organizationId: text()
      .notNull()
      .references(() => organization.id, { onDelete: "cascade" }),
    url: text().notNull().default(""),
    /** Signing secret; generated on first access, rotatable by the user. */
    secret: text().notNull(),
    enabled: boolean().notNull().default(false),
    createdAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp({ withTimezone: true })
      .notNull()
      .defaultNow()
      .$onUpdate(() => new Date()),
  },
  (t) => [uniqueIndex().on(t.organizationId)],
);
