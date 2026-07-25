import { sql } from "drizzle-orm";
import {
  boolean,
  integer,
  pgTable,
  primaryKey,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";

import { organization } from "./auth";
import { monitors } from "./monitors";

/** One public status page per organization. */
export const statusPages = pgTable(
  "status_pages",
  {
    id: uuid()
      .primaryKey()
      .default(sql`uuidv7()`),
    organizationId: text()
      .notNull()
      .references(() => organization.id, { onDelete: "cascade" }),
    /** Public URL segment: /status/[slug] */
    slug: text().notNull(),
    name: text().notNull(),
    published: boolean().notNull().default(false),
    createdAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp({ withTimezone: true })
      .notNull()
      .defaultNow()
      .$onUpdate(() => new Date()),
  },
  (t) => [uniqueIndex().on(t.slug), uniqueIndex().on(t.organizationId)],
);

/** Monitors exposed on a status page, with a public-facing name. */
export const statusPageMonitors = pgTable(
  "status_page_monitors",
  {
    statusPageId: uuid()
      .notNull()
      .references(() => statusPages.id, { onDelete: "cascade" }),
    monitorId: uuid()
      .notNull()
      .references(() => monitors.id, { onDelete: "cascade" }),
    /** Shown publicly instead of the internal monitor name. */
    displayName: text(),
    sortOrder: integer().notNull().default(0),
  },
  (t) => [primaryKey({ columns: [t.statusPageId, t.monitorId] })],
);
