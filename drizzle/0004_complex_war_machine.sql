ALTER TABLE "monitors" ADD COLUMN "body_keyword" text;--> statement-breakpoint
ALTER TABLE "monitors" ADD COLUMN "keyword_absent" boolean DEFAULT false NOT NULL;