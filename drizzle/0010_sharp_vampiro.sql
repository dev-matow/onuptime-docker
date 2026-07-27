CREATE TABLE "actors" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"kind" text NOT NULL,
	"name" text NOT NULL,
	"public_key" text,
	"sequence" bigint DEFAULT 0 NOT NULL,
	"head_hash" text,
	"last_hlc" bigint DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"revoked_at" timestamp with time zone
);
--> statement-breakpoint
-- monitor_check_type: enum -> text.
--
-- The default has to be dropped before the cast and restored after it:
-- Postgres will not carry an existing DEFAULT across a type change on
-- its own, and drizzle-kit's generated form omits both steps.
--
-- The conversion is the point of this migration. Postgres forbids using
-- a newly added enum value in the same transaction that adds it, and
-- Drizzle wraps every migration in one -- so with an enum, shipping a
-- check type would need two deploys, forever. Every existing value
-- survives verbatim; validation now lives in the check type registry.
ALTER TABLE "monitors" ALTER COLUMN "check_type" DROP DEFAULT;--> statement-breakpoint
ALTER TABLE "monitors" ALTER COLUMN "check_type" SET DATA TYPE text USING "check_type"::text;--> statement-breakpoint
ALTER TABLE "monitors" ALTER COLUMN "check_type" SET DEFAULT 'http';--> statement-breakpoint
ALTER TABLE "monitor_checks" ADD COLUMN "verdict" text;--> statement-breakpoint
ALTER TABLE "monitor_checks" ADD COLUMN "failure_class" text;--> statement-breakpoint
ALTER TABLE "monitor_checks" ADD COLUMN "facts" jsonb;--> statement-breakpoint
ALTER TABLE "monitor_checks" ADD COLUMN "actor_id" uuid;--> statement-breakpoint
ALTER TABLE "monitor_checks" ADD COLUMN "hlc" bigint;--> statement-breakpoint
ALTER TABLE "monitor_checks" ADD COLUMN "seq" bigint;--> statement-breakpoint
ALTER TABLE "monitor_checks" ADD COLUMN "prev_hash" text;--> statement-breakpoint
ALTER TABLE "monitor_checks" ADD COLUMN "hash" text;--> statement-breakpoint
ALTER TABLE "monitor_checks" ADD COLUMN "signatures" jsonb DEFAULT '[]'::jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "monitor_checks" ADD COLUMN "spec_version" integer;--> statement-breakpoint
ALTER TABLE "monitors" ADD COLUMN "config" jsonb;--> statement-breakpoint
ALTER TABLE "monitors" ADD COLUMN "spec_version" integer DEFAULT 1 NOT NULL;--> statement-breakpoint
ALTER TABLE "monitors" ADD COLUMN "failure_window_seconds" integer DEFAULT 120 NOT NULL;--> statement-breakpoint
ALTER TABLE "monitors" ADD COLUMN "first_failure_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "monitors" ADD COLUMN "next_evaluation_at" timestamp with time zone;--> statement-breakpoint
--> statement-breakpoint
--> statement-breakpoint
--> statement-breakpoint
--> statement-breakpoint
--> statement-breakpoint
--> statement-breakpoint
--> statement-breakpoint
-- Failure thresholds become time-based, and every existing monitor
-- keeps exactly the behaviour it had.
--
-- (threshold - 1) x interval, not threshold x interval: at a fixed
-- interval the Nth consecutive failure lands (N-1) intervals after the
-- first one, so this is the window that reproduces the old behaviour
-- exactly rather than one interval late. A threshold of 1 becomes a
-- window of 0 -- open on the first failed check, which is what a
-- threshold of 1 already meant.
--
-- `failure_threshold` is left in place (deprecated, unread) so this
-- migration stays additive and a downgrade to 1.9.x still runs.
UPDATE "monitors" SET "failure_window_seconds" = greatest(("failure_threshold" - 1) * "interval_seconds", 0);--> statement-breakpoint
-- A monitor that is mid-failure keeps its streak instead of restarting
-- it, so upgrading during an outage does not delay the incident.
UPDATE "monitors"
SET "first_failure_at" = "last_checked_at" - make_interval(secs => ("consecutive_failures" - 1) * "interval_seconds")
WHERE "consecutive_failures" > 0 AND "last_checked_at" IS NOT NULL;--> statement-breakpoint
-- Seed the scheduler from where each monitor already was. Leaving these
-- null would make every monitor due at once and stampede the first tick
-- after an upgrade.
UPDATE "monitors"
SET "next_evaluation_at" = coalesce("last_checked_at" + make_interval(secs => "interval_seconds"), now());--> statement-breakpoint
CREATE UNIQUE INDEX "actors_kind_name_index" ON "actors" USING btree ("kind","name");--> statement-breakpoint
-- NOT VALID: Drizzle runs this whole file in one transaction and the
-- ADD COLUMNs above already hold ACCESS EXCLUSIVE on the table, so
-- validating the constraint would do a full seq scan of the largest
-- table in the product while blocking every worker insert — during
-- an upgrade documented as zero-downtime. Nothing needs validating:
-- every actor_id is NULL. A later VALIDATE CONSTRAINT would not
-- help either, since it would run inside this same transaction
-- behind the same lock.
ALTER TABLE "monitor_checks" ADD CONSTRAINT "monitor_checks_actor_id_actors_id_fk" FOREIGN KEY ("actor_id") REFERENCES "public"."actors"("id") ON DELETE set null ON UPDATE no action NOT VALID;--> statement-breakpoint
--> statement-breakpoint
CREATE INDEX "monitors_next_evaluation_idx" ON "monitors" USING btree ("next_evaluation_at") WHERE "monitors"."paused" = false;--> statement-breakpoint
DROP TYPE "public"."monitor_check_type";
