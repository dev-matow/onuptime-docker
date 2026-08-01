CREATE TYPE "public"."notification_channel" AS ENUM('email', 'webhook');--> statement-breakpoint
CREATE TYPE "public"."notification_state" AS ENUM('queued', 'sending', 'delivered', 'failed');--> statement-breakpoint
CREATE TABLE "notification_outbox" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"organization_id" text NOT NULL,
	"idempotency_key" text NOT NULL,
	"channel" "notification_channel" NOT NULL,
	"destination" text NOT NULL,
	"payload" jsonb NOT NULL,
	"state" "notification_state" DEFAULT 'queued' NOT NULL,
	"attempts" integer DEFAULT 0 NOT NULL,
	"next_attempt_at" timestamp with time zone DEFAULT now() NOT NULL,
	"leased_until" timestamp with time zone,
	"provider_message_id" text,
	"last_error" text,
	"delivered_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "notification_outbox" ADD CONSTRAINT "notification_outbox_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "notification_outbox_idempotency_key" ON "notification_outbox" USING btree ("idempotency_key");--> statement-breakpoint
CREATE INDEX "notification_outbox_due_idx" ON "notification_outbox" USING btree ("next_attempt_at") WHERE "notification_outbox"."state" in ('queued', 'sending');--> statement-breakpoint
CREATE INDEX "notification_outbox_organization_id_created_at_index" ON "notification_outbox" USING btree ("organization_id","created_at" DESC NULLS LAST);