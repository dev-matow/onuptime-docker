-- The GIN index 0024 added over `events` was measured after the fact and
-- is a pessimisation on the shape this product has: many organizations
-- owning a few channels each. The planner bitmap-ands a whole-index scan
-- across every tenant against the per-tenant one, which is the cost the
-- index existed to remove. See the comment in db/schema/notifications.ts.
DROP INDEX "notification_channels_events_idx";--> statement-breakpoint
ALTER TABLE "notification_channels" ADD COLUMN "scoped_to_monitors" boolean DEFAULT false NOT NULL;--> statement-breakpoint
-- Whether a channel is scoped was inferred from "has rows in
-- notification_channel_monitors", and those rows cascade when a monitor
-- is deleted. So deleting a client's monitors silently turned that
-- client's channel into an organization default and started sending it
-- every other client's alerts. The flag records the intent so the same
-- deletion leaves the channel matching nothing instead of everything.
--
-- Any channel that already has targets meant to be scoped, so say so.
UPDATE "notification_channels" SET "scoped_to_monitors" = true
WHERE EXISTS (
	SELECT 1 FROM "notification_channel_monitors" m
	WHERE m."channel_id" = "notification_channels"."id"
);
