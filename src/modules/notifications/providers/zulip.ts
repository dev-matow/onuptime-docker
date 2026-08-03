import {
  httpDeliver,
  parseJsonBody,
  plainTextBody,
  requireHttpUrl,
  truncate,
  type ChannelProvider,
} from "./types";

/**
 * Zulip, through `POST /api/v1/messages` with a bot's email and API key
 * over HTTP Basic - the documented scheme for this endpoint.
 *
 * Channel messages only. Zulip's topics are the reason this provider is
 * worth having rather than routing everything into one stream: a topic
 * per channel keeps an outage's messages threaded where an operator can
 * follow them, and a topic is a field here rather than a guess.
 *
 * Zulip answers 200 with `result: "error"` for several rejections, so
 * the body decides, not the status line.
 */

export const zulipProvider: ChannelProvider = {
  id: "zulip",
  label: "Zulip",
  kind: "chat",
  blurb: "Post to a Zulip channel and topic with a bot account.",
  docsUrl: "https://zulip.com/api/send-message",
  apiVersion: "REST API v1 (POST /api/v1/messages)",
  prerequisite:
    "A Zulip bot with its email address and API key, subscribed to the target channel.",
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
      placeholder: "https://example.zulipchat.com",
      help: "Your Zulip organization URL, without /api.",
    },
    {
      key: "channel",
      label: "Channel",
      type: "text",
      required: true,
      placeholder: "monitoring",
      help: "The channel (stream) name the bot is subscribed to.",
    },
    {
      key: "topic",
      label: "Topic",
      type: "text",
      required: true,
      placeholder: "Vigil alerts",
      help: "Zulip requires a topic on channel messages; this keeps alerts threaded.",
    },
    {
      key: "botEmail",
      label: "Bot email",
      type: "text",
      required: true,
      placeholder: "vigil-bot@example.zulipchat.com",
      help: "Settings, Personal, Bots. The bot's own email, not yours.",
    },
    {
      key: "apiKey",
      label: "Bot API key",
      type: "password",
      secret: true,
      required: true,
      help: "Shown beside the bot. Sent as HTTP Basic with the bot email.",
    },
  ],
  check(config, secrets) {
    const urlError = requireHttpUrl(config.serverUrl ?? "", "The server URL");
    if (urlError) return urlError;
    if (!config.channel?.trim()) return "A channel is required.";
    if (!config.topic?.trim()) return "A topic is required.";
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(config.botEmail ?? "")) {
      return "The bot email is not a valid address.";
    }
    if (!secrets.apiKey) return "A bot API key is required.";
    return null;
  },
  destinationSummary(config) {
    return `Zulip #${config.channel ?? ""} > ${config.topic ?? ""}`.trim();
  },
  async deliver({ config, secrets, message, net }) {
    const base = (config.serverUrl ?? "").replace(/\/+$/, "");
    const basic = Buffer.from(
      `${config.botEmail}:${secrets.apiKey}`,
      "utf8",
    ).toString("base64");
    const form = new URLSearchParams({
      // `stream` rather than the newer `channel` spelling. Both are
      // accepted by current Zulip; only `stream` is accepted by the
      // self-hosted servers that predate the rename, and this provider
      // targets whatever the operator is actually running.
      type: "stream",
      to: config.channel ?? "",
      topic: truncate(config.topic ?? "", 60),
      content: truncate(plainTextBody(message), 10_000),
    });
    return httpDeliver({
      url: `${base}/api/v1/messages`,
      headers: {
        "content-type": "application/x-www-form-urlencoded",
        authorization: `Basic ${basic}`,
      },
      body: form.toString(),
      secrets,
      net,
      messageId: (raw) => {
        const parsed = parseJsonBody<{ id?: unknown }>(raw);
        return typeof parsed?.id === "number" ? String(parsed.id) : null;
      },
      bodyProblem: (raw) => {
        const parsed = parseJsonBody<{ result?: unknown }>(raw);
        return parsed && parsed.result === "error"
          ? "Zulip rejected the message"
          : null;
      },
    });
  },
};
