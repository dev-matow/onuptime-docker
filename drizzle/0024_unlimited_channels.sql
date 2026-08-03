CREATE TABLE "notification_channel_monitors" (
	"channel_id" uuid NOT NULL,
	"monitor_id" uuid NOT NULL,
	CONSTRAINT "notification_channel_monitors_channel_id_monitor_id_pk" PRIMARY KEY("channel_id","monitor_id")
);
--> statement-breakpoint
ALTER TABLE "notification_channels" ADD COLUMN "destination" text DEFAULT '' NOT NULL;--> statement-breakpoint
ALTER TABLE "notification_channel_monitors" ADD CONSTRAINT "notification_channel_monitors_channel_id_notification_channels_id_fk" FOREIGN KEY ("channel_id") REFERENCES "public"."notification_channels"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "notification_channel_monitors" ADD CONSTRAINT "notification_channel_monitors_monitor_id_monitors_id_fk" FOREIGN KEY ("monitor_id") REFERENCES "public"."monitors"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "notification_channel_monitors_monitor_idx" ON "notification_channel_monitors" USING btree ("monitor_id");--> statement-breakpoint
CREATE INDEX "notification_channels_events_idx" ON "notification_channels" USING gin ("events");--> statement-breakpoint
CREATE INDEX "notification_outbox_channel_recent_idx" ON "notification_outbox" USING btree ("channel_id","created_at" DESC NULLS LAST);