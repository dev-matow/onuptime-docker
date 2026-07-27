ALTER TABLE "incidents" ADD COLUMN "notified_at" timestamp with time zone;--> statement-breakpoint
--> statement-breakpoint
-- Pre-upgrade incidents were all notified at open (holding did not
-- exist yet); backfill so their resolved-notifications still fire.
UPDATE "incidents" SET "notified_at" = "created_at";
