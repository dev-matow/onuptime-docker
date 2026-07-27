CREATE TYPE "public"."monitor_check_type" AS ENUM('http', 'tcp');--> statement-breakpoint
ALTER TABLE "monitors" ADD COLUMN "check_type" "monitor_check_type" DEFAULT 'http' NOT NULL;--> statement-breakpoint
ALTER TABLE "monitors" ADD COLUMN "port" integer;--> statement-breakpoint
ALTER TABLE "monitors" ADD COLUMN "tls_check" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "monitors" ADD COLUMN "tls_warn_days" integer DEFAULT 14 NOT NULL;--> statement-breakpoint
ALTER TABLE "monitors" ADD COLUMN "tls_days_remaining" integer;