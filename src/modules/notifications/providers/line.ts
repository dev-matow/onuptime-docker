import { createHash } from "node:crypto";

import {
  httpDeliver,
  plainTextBody,
  truncate,
  type ChannelProvider,
} from "./types";

/**
 * LINE, through the Messaging API push endpoint.
 *
 * **Not LINE Notify.** LINE Notify was the easy way to do this and LINE
 * shut it down on 31 March 2025; a provider built on it would have been
 * dead on arrival. The Messaging API is the supported successor: a LINE
 * Official Account, a channel access token, and the user, group or room
 * id to push to.
 *
 * `X-Line-Retry-Key` is the reason this provider suppresses duplicates.
 * LINE treats a repeated request carrying a retry key it has already
 * seen as the same request rather than a second message, so the
 * at-least-once retry after a crash collapses on LINE's side. The key
 * must be a UUID, and the outbox row id is one for real deliveries but
 * not for test sends, so it is derived rather than passed through -
 * same input, same key, always in the right shape.
 */

const PUSH_URL = "https://api.line.me/v2/bot/message/push";

/** A stable RFC 4122-shaped id from any seed, for `X-Line-Retry-Key`. */
export function lineRetryKey(rowId: string): string {
  const hex = createHash("sha256").update(rowId).digest("hex");
  const variant = ((parseInt(hex.slice(16, 17), 16) & 0x3) | 0x8).toString(16);
  return [
    hex.slice(0, 8),
    hex.slice(8, 12),
    `4${hex.slice(13, 16)}`,
    `${variant}${hex.slice(17, 20)}`,
    hex.slice(20, 32),
  ].join("-");
}

/** LINE ids: U for a user, C for a group chat, R for a multi-person room. */
const TARGET_PATTERN = /^[UCR][0-9a-f]{32}$/;

export const lineProvider: ChannelProvider = {
  id: "line",
  label: "LINE",
  kind: "chat",
  blurb: "Push to a LINE user, group or room from your Official Account.",
  docsUrl:
    "https://developers.line.biz/en/reference/messaging-api/#send-push-message",
  apiVersion: "Messaging API v2",
  prerequisite:
    "A LINE Official Account with the Messaging API enabled, its channel access token, and the destination id. LINE Notify was discontinued in March 2025 and is not used.",
  capabilities: {
    native: true,
    lifecycle: false,
    duplicateSuppression: true,
    receipt: false,
  },
  fields: [
    {
      key: "to",
      label: "Destination ID",
      type: "text",
      required: true,
      placeholder: "U1234567890abcdef1234567890abcdef",
      help: "A user, group or room id from a webhook event. Not a LINE display name or @id.",
    },
    {
      key: "channelAccessToken",
      label: "Channel access token",
      type: "password",
      secret: true,
      required: true,
      help: "LINE Developers console: your Messaging API channel, issue a long-lived channel access token.",
    },
  ],
  check(config, secrets) {
    if (!TARGET_PATTERN.test(config.to ?? "")) {
      return "A LINE destination id starts with U, C or R and is 33 characters.";
    }
    if (!secrets.channelAccessToken) {
      return "A channel access token is required.";
    }
    return null;
  },
  destinationSummary(config) {
    return `LINE ${config.to ?? ""}`.trim();
  },
  async deliver({ config, secrets, message, rowId, net }) {
    return httpDeliver({
      url: PUSH_URL,
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${secrets.channelAccessToken}`,
        "x-line-retry-key": lineRetryKey(rowId),
      },
      // 409 "The retry key is already accepted" is LINE telling us the
      // ORIGINAL request succeeded and it is refusing to send twice.
      // Without this the classifier would call it a permanent failure
      // and write "not delivered" about a message that was delivered.
      acceptedStatuses: [409],
      body: JSON.stringify({
        to: config.to,
        messages: [
          { type: "text", text: truncate(plainTextBody(message), 5_000) },
        ],
      }),
      secrets,
      net,
    });
  },
};
