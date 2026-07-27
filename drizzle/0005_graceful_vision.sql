CREATE TYPE "public"."status_page_visibility" AS ENUM('public', 'private', 'password');--> statement-breakpoint
ALTER TABLE "incident_events" ADD COLUMN "internal" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "status_pages" ADD COLUMN "visibility" "status_page_visibility" DEFAULT 'public' NOT NULL;--> statement-breakpoint
ALTER TABLE "status_pages" ADD COLUMN "password_hash" text;