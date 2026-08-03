import {
  httpDeliver,
  plainTextBody,
  redactedUrlSummary,
  requireHttpsUrl,
  truncate,
  type ChannelProvider,
} from "./types";

/**
 * Google Chat incoming webhook. The URL carries `key` and `token` query
 * parameters - the credential - so the whole URL is a secret field.
 * Simple `{text}` messages; cards are not worth a second payload shape
 * the operator cannot see the difference from.
 */
export const googleChatProvider: ChannelProvider = {
  id: "googlechat",
  label: "Google Chat",
  kind: "chat",
  blurb: "Post to a Google Chat space through an incoming webhook.",
  docsUrl: "https://developers.google.com/workspace/chat/quickstart/webhooks",
  apiVersion: "Chat API v1 incoming webhook",
  prerequisite: "A Google Chat space where you may add webhooks.",
  capabilities: {
    native: true,
    lifecycle: false,
    duplicateSuppression: false,
    receipt: true,
  },
  fields: [
    {
      key: "webhookUrl",
      label: "Webhook URL",
      type: "url",
      secret: true,
      required: true,
      placeholder: "https://chat.googleapis.com/v1/spaces/AAAA/messages?key=…",
      help: "Space settings, Apps & integrations, Webhooks.",
    },
  ],
  check(_config, secrets) {
    return requireHttpsUrl(secrets.webhookUrl ?? "", "The webhook URL", [
      "chat.googleapis.com",
    ]);
  },
  destinationSummary(_config, secrets) {
    return redactedUrlSummary(secrets.webhookUrl ?? "");
  },
  async deliver({ secrets, message, net }) {
    return httpDeliver({
      url: secrets.webhookUrl ?? "",
      headers: { "content-type": "application/json; charset=UTF-8" },
      body: JSON.stringify({ text: truncate(plainTextBody(message), 4_000) }),
      secrets,
      net,
      messageId: (body) => {
        try {
          const parsed = JSON.parse(body) as { name?: string };
          return typeof parsed.name === "string" ? parsed.name : null;
        } catch {
          return null;
        }
      },
    });
  },
};
