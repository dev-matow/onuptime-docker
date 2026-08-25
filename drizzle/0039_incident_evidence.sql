CREATE TABLE "incident_evidence" (
	"incident_id" uuid PRIMARY KEY NOT NULL,
	"organization_id" text NOT NULL,
	"monitor_id" uuid,
	"schema_version" integer DEFAULT 1 NOT NULL,
	"captured_at" timestamp with time zone DEFAULT now() NOT NULL,
	"snapshot" jsonb NOT NULL
);
--> statement-breakpoint
ALTER TABLE "incident_evidence" ADD CONSTRAINT "incident_evidence_incident_id_incidents_id_fk" FOREIGN KEY ("incident_id") REFERENCES "public"."incidents"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "incident_evidence" ADD CONSTRAINT "incident_evidence_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "incident_evidence" ADD CONSTRAINT "incident_evidence_monitor_id_monitors_id_fk" FOREIGN KEY ("monitor_id") REFERENCES "public"."monitors"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "incident_evidence_org_idx" ON "incident_evidence" USING btree ("organization_id","captured_at");