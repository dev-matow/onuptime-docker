-- Durable delivery: fencing, append-only attempt evidence, terminal
-- states and fair selection.
--
-- Additive only. Nothing is dropped, no column changes type, and every
-- new column is nullable or defaulted, so a 1.17.0 database upgrades by
-- applying this and a rollback leaves the old code reading rows it
-- still understands.
--
-- One deliberate omission: `expires_at` is NOT backfilled. A row queued
-- before this migration has no deadline, and is bounded by the attempt
-- count alone. Backfilling would mean writing a horizon into rows that
-- were accepted under different rules, using a default that may not be
-- the horizon this installation configures. The exposure is a minute
-- of queue: 1.17.0's entire retry window was 31 to 62 seconds, so an
-- upgrade finds at most that much still in flight.
--
-- `ALTER TYPE ... ADD VALUE` is safe here because nothing in this
-- migration writes one of the new values; Postgres refuses a new enum
-- value used in the transaction that created it.

CREATE TYPE "public"."notification_attempt_outcome" AS ENUM('claimed', 'delivered', 'retryable', 'permanent', 'unknown');--> statement-breakpoint
ALTER TYPE "public"."notification_state" ADD VALUE 'expired';--> statement-breakpoint
ALTER TYPE "public"."notification_state" ADD VALUE 'dead_letter';--> statement-breakpoint
CREATE TABLE "notification_attempts" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"outbox_id" uuid NOT NULL,
	"organization_id" text NOT NULL,
	"attempt" integer NOT NULL,
	"fence" bigint NOT NULL,
	"outcome" "notification_attempt_outcome" DEFAULT 'claimed' NOT NULL,
	"http_status" integer,
	"error" text,
	"provider_message_id" text,
	"retry_after_ms" integer,
	"next_attempt_at" timestamp with time zone,
	"started_at" timestamp with time zone DEFAULT now() NOT NULL,
	"finished_at" timestamp with time zone
);
--> statement-breakpoint
ALTER TABLE "notification_outbox" ADD COLUMN "fence" bigint DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "notification_outbox" ADD COLUMN "last_claimed_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "notification_outbox" ADD COLUMN "expires_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "notification_outbox" ADD COLUMN "replay_of" uuid;--> statement-breakpoint
ALTER TABLE "notification_attempts" ADD CONSTRAINT "notification_attempts_outbox_id_notification_outbox_id_fk" FOREIGN KEY ("outbox_id") REFERENCES "public"."notification_outbox"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "notification_attempts" ADD CONSTRAINT "notification_attempts_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "notification_attempts_unique" ON "notification_attempts" USING btree ("outbox_id","attempt");--> statement-breakpoint
CREATE INDEX "notification_attempts_timeline_idx" ON "notification_attempts" USING btree ("outbox_id","started_at");--> statement-breakpoint
CREATE INDEX "notification_attempts_org_idx" ON "notification_attempts" USING btree ("organization_id","started_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "notification_attempts_unfinished_idx" ON "notification_attempts" USING btree ("started_at") WHERE "notification_attempts"."outcome" = 'claimed';--> statement-breakpoint
CREATE INDEX "notification_outbox_fair_idx" ON "notification_outbox" USING btree ("organization_id","next_attempt_at") WHERE "notification_outbox"."state" in ('queued', 'sending');