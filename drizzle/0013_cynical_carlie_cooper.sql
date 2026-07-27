-- An organization may own many status pages.
--
-- The unique index on `organization_id` was the only thing stopping it;
-- the rest of the schema was already per-page (`status_page_monitors` and
-- `status_page_subscribers` both key on `status_page_id`). Same index
-- name, so this is a drop and recreate rather than a rename.
--
-- Dropping a uniqueness constraint is additive for existing data: every
-- row already satisfies the weaker index. Nothing is backfilled and no
-- install loses a page.
--
-- Core keeps this: Uptime Kuma gives unlimited status pages away free, so
-- putting them behind the paywall would break the rule the edition split
-- rests on. What the commercial edition sells is isolation between
-- clients, not the count of pages.
DROP INDEX "status_pages_organization_id_index";--> statement-breakpoint
CREATE INDEX "status_pages_organization_id_index" ON "status_pages" USING btree ("organization_id");
