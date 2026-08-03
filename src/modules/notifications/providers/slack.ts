import {
  httpDeliver,
  plainTextBody,
  redactedUrlSummary,
  requireHttpsUrl,
  type ChannelProvider,
} from "./types";

/**
 * Slack incoming webhook. The URL embeds its credential, so the whole
 * URL is a secret field. Slack answers 200 "ok" on success and plain
 * 4xx strings ("no_service", "invalid_payload") on misconfiguration.
 */
export const slackProvider: ChannelProvider = {
  id: "slack",
  label: "Slack",
  kind: "chat",
  blurb: "Post to a Slack channel through an incoming webhook.",
  docsUrl: "https://api.slack.com/messaging/webhooks",
  apiVersion: "Incoming Webhooks",
  prerequisite: "A Slack app with Incoming Webhooks enabled for the workspace.",
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
      placeholder: "https://hooks.slack.com/services/T000/B000/XXXX",
      help: "Slack: Apps, Incoming Webhooks, Add New Webhook to Workspace.",
    },
  ],
  check(_config, secrets) {
    return requireHttpsUrl(secrets.webhookUrl ?? "", "The webhook URL", [
      "hooks.slack.com",
    ]);
  },
  destinationSummary(_config, secrets) {
    return redactedUrlSummary(secrets.webhookUrl ?? "");
  },
  async deliver({ secrets, message, net }) {
    return httpDeliver({
      url: secrets.webhookUrl ?? "",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ text: plainTextBody(message) }),
      secrets,
      net,
    });
  },
};
