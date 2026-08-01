-- One active automatic incident per monitor, enforced by Postgres.
--
-- The invariant was previously maintained by reading before inserting,
-- which under READ COMMITTED lets two workers both see "none open" and
-- both insert. Any database that has been running long enough may
-- already hold the duplicates that race produced, and CREATE UNIQUE
-- INDEX on top of them fails — taking the whole upgrade down with it.
--
-- So the duplicates are reconciled first. The OLDEST active incident per
-- monitor survives: it is the one whose id is in the notification
-- ledger, the one operators were paged about, and the one already
-- visible on a public status page. The later duplicates are resolved
-- rather than deleted, because deleting a row a customer has seen is a
-- worse lie than closing it with a reason — so the closure is recorded
-- on the timeline in the same statement that applies it.
WITH ranked AS (
  SELECT
    "id",
    row_number() OVER (
      PARTITION BY "monitor_id"
      ORDER BY "started_at", "created_at", "id"
    ) AS rank
  FROM "incidents"
  WHERE "source" = 'monitor'
    AND "status" <> 'resolved'
    AND "monitor_id" IS NOT NULL
),
closed AS (
  UPDATE "incidents"
  SET
    "status" = 'resolved',
    "resolved_at" = COALESCE("resolved_at", now()),
    "updated_at" = now()
  WHERE "id" IN (SELECT "id" FROM ranked WHERE rank > 1)
  RETURNING "id"
)
INSERT INTO "incident_events" ("incident_id", "type", "status", "message", "internal", "created_by")
SELECT
  "id",
  'status_change',
  'resolved',
  'Closed during the 1.13.0 upgrade: this was a duplicate automatic incident for the same monitor, created by a race the database now prevents. The earlier incident remains the record of the outage.',
  true,
  NULL
FROM closed;
--> statement-breakpoint
CREATE UNIQUE INDEX "incidents_one_active_per_monitor" ON "incidents" USING btree ("monitor_id") WHERE "incidents"."source" = 'monitor' and "incidents"."status" <> 'resolved' and "incidents"."monitor_id" is not null;
