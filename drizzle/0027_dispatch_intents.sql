-- Dispatch intents, an incident status generation, and terminality
-- enforced by the database rather than only by the service layer.
--
-- Additive. One new table, one new column with a default, one trigger.
-- Nothing is dropped and nothing changes type, so a 1.18.1 database
-- upgrades by applying this, and 1.18.1 code reading these tables
-- afterwards sees columns it already understands plus one it ignores.
--
-- `status_revision` starts at 0 on every existing row and is NOT
-- backfilled from the timeline. It is a fence, not a history: what
-- matters is that it moves from here on, and a job scheduled before the
-- upgrade carries no fence to compare against anyway. Those jobs run
-- unfenced, exactly as they do today, and drain within one recovery
-- chain.
--
-- The trigger is the part worth reading twice. "Resolved is terminal"
-- has been true in this product since the incident module was written,
-- and it was true the way most invariants are: every path that could
-- break it had a guard, and each guard was added after somebody found
-- the path. A predicate on a statement protects that statement. A
-- trigger protects the table - including from a migration, a restore, a
-- support script and the path nobody has written yet.

CREATE TYPE "public"."notification_intent_state" AS ENUM('pending', 'expanded', 'failed');--> statement-breakpoint
CREATE TABLE "notification_intents" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"organization_id" text NOT NULL,
	"cause_key" text NOT NULL,
	"kind" text NOT NULL,
	"incident_id" uuid,
	"payload" jsonb NOT NULL,
	"state" "notification_intent_state" DEFAULT 'pending' NOT NULL,
	"attempts" integer DEFAULT 0 NOT NULL,
	"last_error" text,
	"expanded_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "incidents" ADD COLUMN "status_revision" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "notification_intents" ADD CONSTRAINT "notification_intents_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "notification_intents" ADD CONSTRAINT "notification_intents_incident_id_incidents_id_fk" FOREIGN KEY ("incident_id") REFERENCES "public"."incidents"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "notification_intents_cause_key" ON "notification_intents" USING btree ("cause_key");--> statement-breakpoint
CREATE INDEX "notification_intents_pending_idx" ON "notification_intents" USING btree ("created_at") WHERE "notification_intents"."state" = 'pending';--> statement-breakpoint
CREATE INDEX "notification_intents_org_idx" ON "notification_intents" USING btree ("organization_id","created_at" DESC NULLS LAST);--> statement-breakpoint
CREATE FUNCTION vigil_incident_terminal() RETURNS trigger AS $$
BEGIN
  -- Reopening. `canTransition` refuses it, `changeIncidentStatus`
  -- compare-and-swaps against it, and both of those are one deploy of
  -- one application away from being the only things that do.
  IF NEW.status IS DISTINCT FROM OLD.status THEN
    RAISE EXCEPTION 'incident % is resolved and resolved is terminal', OLD.id
      USING ERRCODE = 'restrict_violation',
            HINT = 'Open a new incident instead of reopening a closed one.';
  END IF;

  -- Moving the closing time. Two paths can observe the same monitor
  -- come back, and the second one rewriting `resolved_at` changes how
  -- long a published status page says the outage lasted - after the
  -- page has already reported it.
  IF OLD.resolved_at IS NOT NULL
     AND NEW.resolved_at IS DISTINCT FROM OLD.resolved_at THEN
    RAISE EXCEPTION 'incident % is resolved; its resolution time cannot move', OLD.id
      USING ERRCODE = 'restrict_violation';
  END IF;

  RETURN NEW;
END;
$$ LANGUAGE plpgsql;--> statement-breakpoint
-- WHEN, so the function is not entered for the overwhelming majority of
-- incident updates, and FOR EACH ROW rather than a statement trigger
-- because the condition is about a row's own before-and-after.
--
-- It deliberately does NOT reject every update to a resolved incident,
-- which is the shape used elsewhere in this schema for genuinely
-- immutable rows. Two things legitimately write to a closed incident:
-- `savePostmortem`, which exists to, and Postgres itself - `monitor_id`,
-- `created_by` and `acknowledged_by` are all ON DELETE SET NULL, and a
-- referential SET NULL is an UPDATE that fires row triggers. A blanket
-- rule here would make deleting a monitor fail for any organization
-- that had ever had an outage on it.
CREATE TRIGGER incidents_terminal
  BEFORE UPDATE ON "incidents"
  FOR EACH ROW WHEN (OLD.status = 'resolved')
  EXECUTE FUNCTION vigil_incident_terminal();
