import {
  httpDeliver,
  parseJsonBody,
  plainTextBody,
  requireHttpUrl,
  truncate,
  type ChannelProvider,
} from "./types";

/**
 * Mattermost, through the REST API rather than an incoming webhook.
 *
 * That choice is deliberate and it costs the operator one extra step.
 * Mattermost's incoming webhooks accept Slack's body shape, so a
 * "Mattermost provider" built on them would be the Slack provider with
 * a different URL - a webhook alias, and this release does not count
 * those. `POST /api/v4/posts` with a bot token is Mattermost's own API:
 * it takes a channel id rather than a URL that encodes one, it returns
 * the created post's id as a receipt, and the token can be rotated
 * without re-creating the destination.
 */

/** Mattermost ids are 26-character lowercase base32-ish strings. */
const ID_PATTERN = /^[a-z0-9]{26}$/;

export const mattermostProvider: ChannelProvider = {
  id: "mattermost",
  label: "Mattermost",
  kind: "chat",
  blurb: "Post to a Mattermost channel with a bot account.",
  docsUrl: "https://developers.mattermost.com/api-documentation/",
  apiVersion: "REST API v4 (POST /api/v4/posts)",
  prerequisite:
    "A Mattermost bot account with a token, a member of the target channel, and that channel's ID.",
  capabilities: {
    native: true,
    lifecycle: false,
    duplicateSuppression: false,
    receipt: true,
  },
  fields: [
    {
      key: "serverUrl",
      label: "Server URL",
      type: "url",
      required: true,
      placeholder: "https://mattermost.example.com",
      help: "Your Mattermost server, without /api/v4.",
    },
    {
      key: "channelId",
      label: "Channel ID",
      type: "text",
      required: true,
      placeholder: "26 characters",
      help: "Channel menu, View Info - the ID at the bottom. Not the channel name.",
    },
    {
      key: "accessToken",
      label: "Bot token",
      type: "password",
      secret: true,
      required: true,
      help: "Integrations, Bot Accounts, create a bot and copy its token. Add the bot to the channel.",
    },
  ],
  check(config, secrets) {
    const urlError = requireHttpUrl(config.serverUrl ?? "", "The server URL");
    if (urlError) return urlError;
    if (!ID_PATTERN.test(config.channelId ?? "")) {
      return "A Mattermost channel ID is 26 lowercase letters and digits.";
    }
    if (!secrets.accessToken) return "A bot token is required.";
    return null;
  },
  destinationSummary(config) {
    try {
      return `Mattermost channel on ${new URL(config.serverUrl ?? "").host}`;
    } catch {
      return "Mattermost";
    }
  },
  async deliver({ config, secrets, message, net }) {
    const base = (config.serverUrl ?? "").replace(/\/+$/, "");
    return httpDeliver({
      url: `${base}/api/v4/posts`,
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${secrets.accessToken}`,
      },
      body: JSON.stringify({
        channel_id: config.channelId,
        message: truncate(plainTextBody(message), 16_000),
      }),
      secrets,
      net,
      messageId: (raw) => {
        const parsed = parseJsonBody<{ id?: unknown }>(raw);
        return typeof parsed?.id === "string" ? parsed.id : null;
      },
    });
  },
};
