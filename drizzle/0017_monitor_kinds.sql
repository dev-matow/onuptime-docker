-- Monitors that are not probes: groups, heartbeats, manual statements.
--
-- Two structures, and both are shaped by what must NOT happen.
--
-- `monitors.parent_id` points from the member at its group, never the
-- other way round. A group holding a list of member ids has to be kept
-- correct by application code, and is wrong the moment a member is
-- deleted by any path that forgot about it. Here Postgres maintains it —
-- and `ON DELETE SET NULL` rather than CASCADE, because a self-
-- referencing cascade turns "delete this group" into "delete every
-- monitor inside it", recursively, from a confirmation dialog that
-- cannot show you how much you are about to lose.
--
-- `monitor_heartbeats` is current state, not history: one row per
-- passive monitor, upserted by the push endpoint. It exists so that an
-- unauthenticated request writes one row and nothing else — no
-- observation, no incident, no email. The observation is made by the
-- scheduled evaluation that reads this row.
--
-- The unique index on `config ->> 'token'` is what makes the endpoint
-- writable at all: it resolves a caller to exactly one monitor, and
-- "the token matched two rows" is not a case that endpoint could be
-- written to survive. Partial on `check_type = 'push'`, so it costs the
-- other sixteen types nothing and leaves NULL configs alone.
CREATE TABLE "monitor_heartbeats" (
	"monitor_id" uuid PRIMARY KEY NOT NULL,
	"received_at" timestamp with time zone DEFAULT now() NOT NULL,
	"reported_status" text DEFAULT 'up' NOT NULL,
	"message" text,
	"response_time_ms" integer
);
--> statement-breakpoint
ALTER TABLE "monitors" ADD COLUMN "parent_id" uuid;--> statement-breakpoint
ALTER TABLE "monitor_heartbeats" ADD CONSTRAINT "monitor_heartbeats_monitor_id_monitors_id_fk" FOREIGN KEY ("monitor_id") REFERENCES "public"."monitors"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "monitors" ADD CONSTRAINT "monitors_parent_id_monitors_id_fk" FOREIGN KEY ("parent_id") REFERENCES "public"."monitors"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "monitors_parent_idx" ON "monitors" USING btree ("parent_id");--> statement-breakpoint
CREATE UNIQUE INDEX "monitors_push_token_idx" ON "monitors" USING btree (("config" ->> 'token')) WHERE "monitors"."check_type" = 'push';