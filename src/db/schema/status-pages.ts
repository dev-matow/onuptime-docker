import { sql } from "drizzle-orm";
import {
  boolean,
  integer,
  pgEnum,
  pgTable,
  primaryKey,
  text,
  timestamp,
  index,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";

import { organization } from "./auth";
import { monitors } from "./monitors";

/**
 * Who may view a published status page. `public` = anyone; `private` =
 * signed-in members of the owning organization only; `password` =
 * anyone holding the shared password.
 */
export const statusPageVisibility = pgEnum("status_page_visibility", [
  "public",
  "private",
  "password",
]);

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
    visibility: statusPageVisibility().notNull().default("public"),
    /** scrypt hash (`salt:hash` hex) when visibility = password. */
    passwordHash: text(),
    /**
     * Whether the public page carries a "Powered by Vigil" line.
     *
     * Free in both editions, and off is a supported configuration.
     * Uptime Kuma's status pages are white-label at no cost, so charging
     * for this would put something behind the paywall that the incumbent
     * gives away — which is the one rule the edition split rests on.
     */
    showBranding: boolean().notNull().default(true),
    createdAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp({ withTimezone: true })
      .notNull()
      .defaultNow()
      .$onUpdate(() => new Date()),
  },
  // Slugs are globally unique because they are the public URL. The
  // organization is deliberately NOT unique: an organization owns as many
  // status pages as it likes — one per client, per product, per audience.
  // Anything that used to assume "the" page for an organization has to
  // name which one.
  (t) => [uniqueIndex().on(t.slug), index().on(t.organizationId)],
);

/**
 * Email subscribers to a status page. Double opt-in: a row is created on
 * subscribe but only notified once `confirmedAt` is set (via the link in
 * the confirmation email). One row per (page, email).
 */
export const statusPageSubscribers = pgTable(
  "status_page_subscribers",
  {
    id: uuid()
      .primaryKey()
      .default(sql`uuidv7()`),
    statusPageId: uuid()
      .notNull()
      .references(() => statusPages.id, { onDelete: "cascade" }),
    email: text().notNull(),
    /** Null until the subscriber confirms; only confirmed rows are paged. */
    confirmedAt: timestamp({ withTimezone: true }),
    createdAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [uniqueIndex().on(t.statusPageId, t.email)],
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
