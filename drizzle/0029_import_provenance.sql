-- Imported monitors remember which record they came from.
--
-- Additive: two nullable columns and one partial unique index. Nothing
-- is rewritten, nothing is backfilled, and every monitor that already
-- exists keeps null in both - which is the honest value, because
-- nothing in this database records which Uptime Kuma row a monitor was
-- built from.
--
-- Why: the Uptime Kuma importer called `createMonitor` unconditionally,
-- with no dedup of any kind and nothing in the schema to stop it, so an
-- operator who re-ran a migration - after fixing three refused checks,
-- which is exactly the flow the report invites - got a second copy of
-- the whole fleet. Every duplicate then probed the same endpoint, so
-- the outage that followed was billed to the customer as traffic and
-- paged the on-call twice.
--
-- The API-provider engine did dedup, but on (check type, target, name),
-- and that is a guess rather than a key: rename an imported monitor in
-- Vigil and the next run imports it again. A recorded source id cannot
-- be renamed out of.
--
-- The index is UNIQUE because the importer's own check reads the table
-- at the top of its transaction, and two operators clicking Import on
-- the same backup at the same moment both read "nothing there".
-- Application-side dedup makes that race produce two fleets. Partial on
-- `import_source is not null` so it indexes only imported rows, and
-- scoped to the organisation because two tenants migrating off the same
-- Kuma instance are two migrations and neither may see the other.

ALTER TABLE "monitors" ADD COLUMN "import_source" text;--> statement-breakpoint
ALTER TABLE "monitors" ADD COLUMN "import_source_id" text;--> statement-breakpoint
CREATE UNIQUE INDEX "monitors_import_source_idx" ON "monitors" USING btree ("organization_id","import_source","import_source_id") WHERE "monitors"."import_source" is not null;
