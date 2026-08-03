import {
  httpDeliver,
  plainTextBody,
  truncate,
  type ChannelProvider,
} from "./types";

/**
 * Telegram Bot API. The operator supplies their own bot token (from
 * @BotFather) and a chat id; Vigil funds and hosts nothing. Plain-text
 * sendMessage - no parse_mode, so no escaping rules to get wrong and no
 * way for a monitor name to break the markup.
 *
 * Telegram's 429 carries `parameters.retry_after` (seconds) in the JSON
 * body as well as the Retry-After header; both are honored.
 */

const TOKEN_PATTERN = /^\d{5,}:[\w-]{30,}$/;
const CHAT_ID_PATTERN = /^-?\d+$|^@[A-Za-z0-9_]{5,}$/;

export const telegramProvider: ChannelProvider = {
  id: "telegram",
  label: "Telegram",
  kind: "chat",
  blurb: "Send messages through your own Telegram bot.",
  docsUrl: "https://core.telegram.org/bots/api#sendmessage",
  apiVersion: "Bot API",
  prerequisite: "A bot from @BotFather that can post in the target chat.",
  capabilities: {
    native: true,
    lifecycle: false,
    duplicateSuppression: false,
    receipt: true,
  },
  fields: [
    {
      key: "botToken",
      label: "Bot token",
      type: "password",
      secret: true,
      required: true,
      placeholder: "1234567890:AA…",
      help: "From @BotFather. The bot must be able to message the chat.",
    },
    {
      key: "chatId",
      label: "Chat ID",
      type: "text",
      required: true,
      placeholder: "-1001234567890 or @channelname",
      help: "A user, group or channel id. Groups are negative numbers.",
    },
  ],
  check(config, secrets) {
    if (!TOKEN_PATTERN.test(secrets.botToken ?? "")) {
      return "The bot token does not look like a BotFather token.";
    }
    if (!CHAT_ID_PATTERN.test(config.chatId ?? "")) {
      return "The chat ID must be a number or an @channelname.";
    }
    return null;
  },
  destinationSummary(config) {
    return `Telegram chat ${config.chatId ?? ""}`.trim();
  },
  async deliver({ config, secrets, message, net }) {
    return httpDeliver({
      url: `https://api.telegram.org/bot${secrets.botToken}/sendMessage`,
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        chat_id: config.chatId,
        text: truncate(plainTextBody(message), 4_096),
        disable_web_page_preview: true,
      }),
      secrets,
      net,
      messageId: (body) => {
        try {
          const parsed = JSON.parse(body) as {
            result?: { message_id?: number };
          };
          const id = parsed.result?.message_id;
          return typeof id === "number" ? String(id) : null;
        } catch {
          return null;
        }
      },
      retryAfterFromBody: (body) => {
        try {
          const parsed = JSON.parse(body) as {
            parameters?: { retry_after?: number };
          };
          const seconds = parsed.parameters?.retry_after;
          return typeof seconds === "number" && seconds >= 0
            ? Math.min(seconds * 1_000, 3_600_000)
            : undefined;
        } catch {
          return undefined;
        }
      },
    });
  },
};
