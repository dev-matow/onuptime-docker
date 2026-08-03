import {
  httpDeliver,
  plainTextBody,
  redactedUrlSummary,
  requireHttpsUrl,
  truncate,
  type ChannelProvider,
} from "./types";

/**
 * Discord webhook. The URL embeds its credential, so the whole URL is a
 * secret field. `content` is capped at 2000 characters by Discord;
 * truncated here rather than rejected there. Discord returns 204 on
 * success and JSON rate-limit bodies on 429, which carry Retry-After as
 * a header too, so the shared parser covers them.
 */
export const discordProvider: ChannelProvider = {
  id: "discord",
  label: "Discord",
  kind: "chat",
  blurb: "Post to a Discord channel through a webhook.",
  docsUrl: "https://support.discord.com/hc/en-us/articles/228383668",
  apiVersion: "Webhooks (API v10)",
  prerequisite: "Manage Webhooks permission on the target Discord channel.",
  capabilities: {
    native: true,
    lifecycle: false,
    duplicateSuppression: false,
    receipt: false,
  },
  fields: [
    {
      key: "webhookUrl",
      label: "Webhook URL",
      type: "url",
      secret: true,
      required: true,
      placeholder: "https://discord.com/api/webhooks/000/XXXX",
      help: "Channel settings, Integrations, Webhooks, Copy Webhook URL.",
    },
  ],
  check(_config, secrets) {
    return requireHttpsUrl(secrets.webhookUrl ?? "", "The webhook URL", [
      "discord.com",
      "discordapp.com",
    ]);
  },
  destinationSummary(_config, secrets) {
    return redactedUrlSummary(secrets.webhookUrl ?? "");
  },
  async deliver({ secrets, message, net }) {
    return httpDeliver({
      url: secrets.webhookUrl ?? "",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        content: truncate(plainTextBody(message), 2_000),
      }),
      secrets,
      net,
    });
  },
};
