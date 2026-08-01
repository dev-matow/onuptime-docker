CREATE TABLE "monitor_hf_leases" (
	"shard" integer PRIMARY KEY NOT NULL,
	"owner_id" text NOT NULL,
	"acquired_at" timestamp with time zone DEFAULT now() NOT NULL,
	"renewed_at" timestamp with time zone DEFAULT now() NOT NULL,
	"expires_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
CREATE TABLE "monitor_hf_rollups" (
	"monitor_id" uuid NOT NULL,
	"granularity" text NOT NULL,
	"bucket_start" timestamp with time zone NOT NULL,
	"samples" integer NOT NULL,
	"ok_samples" integer NOT NULL,
	"degraded_samples" integer NOT NULL,
	"down_samples" integer NOT NULL,
	"indeterminate_samples" integer NOT NULL,
	"min_response_ms" integer,
	"max_response_ms" integer,
	"sum_response_ms" bigint,
	"response_samples" integer NOT NULL,
	"first_observed_at" timestamp with time zone NOT NULL,
	"last_observed_at" timestamp with time zone NOT NULL,
	"max_gap_ms" integer
);
--> statement-breakpoint
CREATE TABLE "monitor_hf_samples" (
	"monitor_id" uuid NOT NULL,
	"observed_at" timestamp with time zone NOT NULL,
	"ok" boolean NOT NULL,
	"verdict" text NOT NULL,
	"response_time_ms" integer,
	"error" text
);
--> statement-breakpoint
ALTER TABLE "monitors" ADD COLUMN "high_frequency" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "monitors" ADD COLUMN "high_frequency_interval_ms" integer;--> statement-breakpoint
ALTER TABLE "monitor_hf_rollups" ADD CONSTRAINT "monitor_hf_rollups_monitor_id_monitors_id_fk" FOREIGN KEY ("monitor_id") REFERENCES "public"."monitors"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "monitor_hf_samples" ADD CONSTRAINT "monitor_hf_samples_monitor_id_monitors_id_fk" FOREIGN KEY ("monitor_id") REFERENCES "public"."monitors"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "monitor_hf_rollups_bucket_idx" ON "monitor_hf_rollups" USING btree ("monitor_id","granularity","bucket_start");--> statement-breakpoint
CREATE INDEX "monitor_hf_samples_monitor_idx" ON "monitor_hf_samples" USING btree ("monitor_id","observed_at");--> statement-breakpoint
CREATE INDEX "monitors_high_frequency_idx" ON "monitors" USING btree ("organization_id") WHERE "monitors"."high_frequency" = true and "monitors"."paused" = false;