import {
  httpDeliver,
  redactedUrlSummary,
  requireHttpsUrl,
  type ChannelMessage,
  type ChannelProvider,
} from "./types";

/**
 * Microsoft Teams via a Workflows webhook - the supported path since
 * Office 365 connectors were disabled in May 2026. The operator creates
 * a workflow from the "Post to a channel when a webhook request is
 * received" template and pastes its HTTP URL here.
 *
 * That URL is a Power Automate endpoint on a tenant-specific host
 * (*.logic.azure.com and friends), so no host pinning - https and the
 * egress policy are the constraints. The URL embeds an access signature
 * in its query string, so it is a secret field.
 *
 * The payload is the `message` + Adaptive Card attachment shape the
 * template expects; MessageCard is the retired connector format and is
 * deliberately not sent. Workflows answers 202 with an empty body.
 */

const SEVERITY_COLOR: Record<ChannelMessage["severity"], string> = {
  critical: "attention",
  warning: "warning",
  ok: "good",
  info: "default",
};

export function buildTeamsCard(message: ChannelMessage): string {
  const body: Record<string, unknown>[] = [
    {
      type: "TextBlock",
      text: message.title,
      weight: "bolder",
      size: "medium",
      color: SEVERITY_COLOR[message.severity],
      wrap: true,
    },
  ];
  if (message.text) {
    body.push({ type: "TextBlock", text: message.text, wrap: true });
  }
  return JSON.stringify({
    type: "message",
    attachments: [
      {
        contentType: "application/vnd.microsoft.card.adaptive",
        content: {
          $schema: "http://adaptivecards.io/schemas/adaptive-card.json",
          type: "AdaptiveCard",
          version: "1.4",
          body,
          ...(message.url
            ? {
                actions: [
                  {
                    type: "Action.OpenUrl",
                    title: "Open in Vigil",
                    url: message.url,
                  },
                ],
              }
            : {}),
        },
      },
    ],
  });
}

export const teamsProvider: ChannelProvider = {
  id: "teams",
  label: "Microsoft Teams",
  kind: "chat",
  blurb: "Post to a Teams channel through a Workflows webhook.",
  docsUrl:
    "https://support.microsoft.com/en-us/office/create-incoming-webhooks-with-workflows-for-microsoft-teams-8ae491c7-0394-4861-ba59-055e33f75498",
  apiVersion: "Workflows (Power Automate) trigger",
  prerequisite:
    "A Teams Workflow using the 'when a Teams webhook request is received' trigger.",
  capabilities: {
    native: true,
    lifecycle: false,
    duplicateSuppression: false,
    receipt: false,
  },
  fields: [
    {
      key: "webhookUrl",
      label: "Workflow HTTP URL",
      type: "url",
      secret: true,
      required: true,
      placeholder: "https://prod-00.westus.logic.azure.com/workflows/…",
      help: "Teams: Workflows, 'Post to a channel when a webhook request is received'. The retired Office 365 connector URLs no longer deliver.",
    },
  ],
  check(_config, secrets) {
    return requireHttpsUrl(secrets.webhookUrl ?? "", "The workflow URL");
  },
  destinationSummary(_config, secrets) {
    return redactedUrlSummary(secrets.webhookUrl ?? "");
  },
  async deliver({ secrets, message, net }) {
    return httpDeliver({
      url: secrets.webhookUrl ?? "",
      headers: { "content-type": "application/json" },
      body: buildTeamsCard(message),
      secrets,
      net,
    });
  },
};
