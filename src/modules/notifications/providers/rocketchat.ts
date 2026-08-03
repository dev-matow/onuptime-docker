import {
  httpDeliver,
  parseJsonBody,
  plainTextBody,
  requireHttpUrl,
  truncate,
  type ChannelProvider,
} from "./types";

/**
 * Rocket.Chat, through `chat.postMessage` on the REST API.
 *
 * Same reasoning as Mattermost: Rocket.Chat also offers a Slack-shaped
 * incoming webhook, and using it would make this an alias rather than a
 * provider. The REST call takes a channel name or id, returns the
 * message `_id`, and authenticates with a pair of headers that can be
 * revoked without touching the destination.
 *
 * The API answers 200 with `success: false` for some rejections, so the
 * body is checked rather than the status line alone.
 */

export const rocketchatProvider: ChannelProvider = {
  id: "rocketchat",
  label: "Rocket.Chat",
  kind: "chat",
  blurb: "Post to a Rocket.Chat channel with a personal access token.",
  docsUrl: "https://developer.rocket.chat/apidocs/post-message",
  apiVersion: "REST API v1 (chat.postMessage)",
  prerequisite:
    "A Rocket.Chat personal access token and its user ID, from Account, Personal Access Tokens.",
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
      placeholder: "https://chat.example.com",
      help: "Your Rocket.Chat server, without /api/v1.",
    },
    {
      key: "channel",
      label: "Channel",
      type: "text",
      required: true,
      placeholder: "#alerts",
      help: "A #channel, an @user, or a room ID. The token's user must be able to post there.",
    },
    {
      key: "userId",
      label: "User ID",
      type: "text",
      required: true,
      help: "Shown next to the token when you create it. Sent as X-User-Id.",
    },
    {
      key: "authToken",
      label: "Personal access token",
      type: "password",
      secret: true,
      required: true,
      help: "Account, Personal Access Tokens, Add. Sent as X-Auth-Token.",
    },
  ],
  check(config, secrets) {
    const urlError = requireHttpUrl(config.serverUrl ?? "", "The server URL");
    if (urlError) return urlError;
    if (!config.channel?.trim()) return "A channel is required.";
    if (!/^[A-Za-z0-9]{8,}$/.test(config.userId ?? "")) {
      return "The user ID does not look like a Rocket.Chat user ID.";
    }
    if (!secrets.authToken) return "A personal access token is required.";
    return null;
  },
  destinationSummary(config) {
    return `Rocket.Chat ${config.channel ?? ""}`.trim();
  },
  async deliver({ config, secrets, message, net }) {
    const base = (config.serverUrl ?? "").replace(/\/+$/, "");
    return httpDeliver({
      url: `${base}/api/v1/chat.postMessage`,
      headers: {
        "content-type": "application/json",
        "x-auth-token": secrets.authToken ?? "",
        "x-user-id": config.userId ?? "",
      },
      body: JSON.stringify({
        channel: config.channel,
        text: truncate(plainTextBody(message), 4_000),
      }),
      secrets,
      net,
      messageId: (raw) => {
        const parsed = parseJsonBody<{ message?: { _id?: unknown } }>(raw);
        const id = parsed?.message?._id;
        return typeof id === "string" ? id : null;
      },
      bodyProblem: (raw) => {
        const parsed = parseJsonBody<{ success?: unknown }>(raw);
        return parsed && parsed.success === false
          ? "Rocket.Chat rejected the message"
          : null;
      },
    });
  },
};
