-- Move every configured org webhook into the notification channel
-- registry before the old table goes. Host detection mirrors what
-- detectWebhookFormat did at delivery time, so a Slack or Discord URL
-- keeps producing a chat message and anything else keeps receiving the
-- signed native payload under its existing secret.
--
-- Secrets are written as 'plain:<json>' because this migration cannot
-- reach the application's encryption key; the worker seals these rows
-- at its next boot (sealPlainChannelSecrets). Every channel keeps the
-- full pre-0022 event set: monitor, incident, and the expiry class
-- that was carved out of monitor down/up.
INSERT INTO "notification_channels" ("organization_id", "name", "provider", "config", "secrets", "events", "enabled")
SELECT
	"organization_id",
	CASE
		WHEN "url" LIKE 'https://hooks.slack.com/%' THEN 'Slack'
		WHEN "url" LIKE 'https://discord.com/api/webhooks/%' THEN 'Discord'
		WHEN "url" LIKE 'https://discordapp.com/api/webhooks/%' THEN 'Discord'
		ELSE 'Webhook'
	END,
	CASE
		WHEN "url" LIKE 'https://hooks.slack.com/%' THEN 'slack'
		WHEN "url" LIKE 'https://discord.com/api/webhooks/%' THEN 'discord'
		WHEN "url" LIKE 'https://discordapp.com/api/webhooks/%' THEN 'discord'
		ELSE 'webhook'
	END,
	CASE
		WHEN "url" LIKE 'https://hooks.slack.com/%'
			OR "url" LIKE 'https://discord.com/api/webhooks/%'
			OR "url" LIKE 'https://discordapp.com/api/webhooks/%'
			THEN '{}'::jsonb
		ELSE jsonb_build_object('url', "url")
	END,
	CASE
		WHEN "url" LIKE 'https://hooks.slack.com/%'
			OR "url" LIKE 'https://discord.com/api/webhooks/%'
			OR "url" LIKE 'https://discordapp.com/api/webhooks/%'
			THEN 'plain:' || json_build_object('webhookUrl', "url")::text
		ELSE 'plain:' || json_build_object('secret', "secret")::text
	END,
	'["monitor", "incident", "expiry"]'::jsonb,
	"enabled"
FROM "webhook_endpoints"
WHERE "url" <> '';--> statement-breakpoint
DROP TABLE "webhook_endpoints" CASCADE;
