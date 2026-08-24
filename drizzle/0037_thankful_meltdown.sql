CREATE TABLE "bridge_cutover_reports" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"bridge_id" uuid NOT NULL,
	"organization_id" text NOT NULL,
	"verdict" text NOT NULL,
	"reasons" jsonb NOT NULL,
	"body" jsonb NOT NULL,
	"window_from" timestamp with time zone NOT NULL,
	"window_to" timestamp with time zone NOT NULL,
	"generated_by" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "bridge_imports" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"bridge_id" uuid NOT NULL,
	"organization_id" text NOT NULL,
	"facts" jsonb NOT NULL,
	"entries" jsonb NOT NULL,
	"totals" jsonb NOT NULL,
	"created_by" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "bridge_monitors" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"bridge_id" uuid NOT NULL,
	"organization_id" text NOT NULL,
	"source_id" text NOT NULL,
	"source_name" text NOT NULL,
	"source_type" text NOT NULL,
	"monitor_id" uuid,
	"outcome" text NOT NULL,
	"detail" text NOT NULL,
	"compared" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "bridge_polls" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"bridge_id" uuid NOT NULL,
	"organization_id" text NOT NULL,
	"window_from" timestamp with time zone NOT NULL,
	"window_to" timestamp with time zone NOT NULL,
	"status" text NOT NULL,
	"detail" text,
	"request_count" integer DEFAULT 0 NOT NULL,
	"incidents_seen" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "bridge_source_incidents" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"bridge_id" uuid NOT NULL,
	"organization_id" text NOT NULL,
	"source_incident_id" text NOT NULL,
	"resource_type" text,
	"resource_id" text,
	"cause" text,
	"status" text NOT NULL,
	"started_at" timestamp with time zone NOT NULL,
	"acknowledged_at" timestamp with time zone,
	"resolved_at" timestamp with time zone,
	"first_seen_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_seen_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "migration_bridges" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"organization_id" text NOT NULL,
	"provider" text NOT NULL,
	"credential_sealed" text,
	"last_polled_at" timestamp with time zone,
	"last_poll_status" text,
	"last_poll_error" text,
	"consecutive_poll_failures" integer DEFAULT 0 NOT NULL,
	"created_by" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "incidents" ADD COLUMN "shadow" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "monitors" ADD COLUMN "shadow_bridge_id" uuid;--> statement-breakpoint
ALTER TABLE "bridge_cutover_reports" ADD CONSTRAINT "bridge_cutover_reports_bridge_id_migration_bridges_id_fk" FOREIGN KEY ("bridge_id") REFERENCES "public"."migration_bridges"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "bridge_cutover_reports" ADD CONSTRAINT "bridge_cutover_reports_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "bridge_cutover_reports" ADD CONSTRAINT "bridge_cutover_reports_generated_by_user_id_fk" FOREIGN KEY ("generated_by") REFERENCES "public"."user"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "bridge_imports" ADD CONSTRAINT "bridge_imports_bridge_id_migration_bridges_id_fk" FOREIGN KEY ("bridge_id") REFERENCES "public"."migration_bridges"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "bridge_imports" ADD CONSTRAINT "bridge_imports_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "bridge_imports" ADD CONSTRAINT "bridge_imports_created_by_user_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."user"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "bridge_monitors" ADD CONSTRAINT "bridge_monitors_bridge_id_migration_bridges_id_fk" FOREIGN KEY ("bridge_id") REFERENCES "public"."migration_bridges"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "bridge_monitors" ADD CONSTRAINT "bridge_monitors_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "bridge_monitors" ADD CONSTRAINT "bridge_monitors_monitor_id_monitors_id_fk" FOREIGN KEY ("monitor_id") REFERENCES "public"."monitors"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "bridge_polls" ADD CONSTRAINT "bridge_polls_bridge_id_migration_bridges_id_fk" FOREIGN KEY ("bridge_id") REFERENCES "public"."migration_bridges"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "bridge_polls" ADD CONSTRAINT "bridge_polls_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "bridge_source_incidents" ADD CONSTRAINT "bridge_source_incidents_bridge_id_migration_bridges_id_fk" FOREIGN KEY ("bridge_id") REFERENCES "public"."migration_bridges"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "bridge_source_incidents" ADD CONSTRAINT "bridge_source_incidents_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "migration_bridges" ADD CONSTRAINT "migration_bridges_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "migration_bridges" ADD CONSTRAINT "migration_bridges_created_by_user_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."user"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "bridge_cutover_reports_bridge_idx" ON "bridge_cutover_reports" USING btree ("bridge_id","created_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "bridge_imports_bridge_idx" ON "bridge_imports" USING btree ("bridge_id","created_at" DESC NULLS LAST);--> statement-breakpoint
CREATE UNIQUE INDEX "bridge_monitors_source_idx" ON "bridge_monitors" USING btree ("bridge_id","source_id");--> statement-breakpoint
CREATE INDEX "bridge_monitors_monitor_idx" ON "bridge_monitors" USING btree ("monitor_id");--> statement-breakpoint
CREATE INDEX "bridge_polls_bridge_idx" ON "bridge_polls" USING btree ("bridge_id","created_at" DESC NULLS LAST);--> statement-breakpoint
CREATE UNIQUE INDEX "bridge_source_incidents_source_idx" ON "bridge_source_incidents" USING btree ("bridge_id","source_incident_id");--> statement-breakpoint
CREATE INDEX "bridge_source_incidents_resource_idx" ON "bridge_source_incidents" USING btree ("bridge_id","resource_id");--> statement-breakpoint
CREATE UNIQUE INDEX "migration_bridges_org_provider_idx" ON "migration_bridges" USING btree ("organization_id","provider");--> statement-breakpoint
-- Hand-written: the drizzle schema declares monitors.shadow_bridge_id
-- without .references(), because src/db/schema/bridge.ts imports the
-- monitors table and a reference in the other direction would make the
-- two modules import each other. The constraint is real all the same,
-- and RESTRICT is the point: a bridge cannot be deleted while monitors
-- still shadow under it, so ending shadow mode is always an explicit
-- act (cut over or abandon) rather than a side effect of a cascade
-- silently un-silencing or orphaning a fleet.
ALTER TABLE "monitors" ADD CONSTRAINT "monitors_shadow_bridge_id_fk" FOREIGN KEY ("shadow_bridge_id") REFERENCES "public"."migration_bridges"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
-- Partial: almost every monitor everywhere has null here, and the two
-- queries that use it (bridge status, cutover) only ever ask for the
-- non-null rows of one bridge.
CREATE INDEX "monitors_shadow_bridge_idx" ON "monitors" ("shadow_bridge_id") WHERE "shadow_bridge_id" IS NOT NULL;