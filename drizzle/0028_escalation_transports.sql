-- The escalation ladder's transports become outbox rows.
--
-- Two new enum values. Additive, no rewrite, and
-- nothing in this migration writes either new value - which is what
-- makes adding an enum value safe inside the migration transaction.
--
-- Why: `runEscalationStep` paged its recipients with direct calls -
-- `sendEmail`, then Twilio Messages, then Twilio Calls - one at a time,
-- each with a ten-second timeout, with no idempotency key anywhere on
-- the path. pg-boss expires that job after 120 seconds and re-runs it
-- twice. Thirteen responders on a voice rung is 130 seconds, so the
-- ladder re-paged every one of them, and a real on-call engineer took a
-- second phone call for one alert. In the other direction a single
-- Twilio blip meant nobody was called at all, ever, with no retry and
-- no record that anyone was owed a call.

ALTER TYPE "public"."notification_channel" ADD VALUE 'sms';--> statement-breakpoint
ALTER TYPE "public"."notification_channel" ADD VALUE 'voice';
