import {
  httpDeliver,
  parseJsonBody,
  truncate,
  type ChannelProvider,
} from "./types";

/**
 * Pushbullet. The operator's own access token; the note push is the
 * whole API surface used here.
 *
 * Targeting is one optional field with three shapes, because Pushbullet
 * models them as three mutually exclusive parameters and offering three
 * boxes would let an operator fill two. A blank target pushes to every
 * device on the account, which is the documented default and the one
 * most people want.
 *
 * The quota is worth knowing before you wire a monitor to it: a free
 * Pushbullet account allows 500 pushes a month, and a flapping monitor
 * will find that number. Pushbullet answers 429 when it runs out, which
 * the shared classifier retries and then records as failed - visible in
 * the ledger, which is where a quota problem should be visible.
 */

const PUSHBULLET_URL = "https://api.pushbullet.com/v2/pushes";

export const pushbulletProvider: ChannelProvider = {
  id: "pushbullet",
  label: "Pushbullet",
  kind: "push",
  blurb: "Push a note to your Pushbullet devices or a channel.",
  docsUrl: "https://docs.pushbullet.com/#create-push",
  apiVersion: "API v2 (POST /v2/pushes)",
  prerequisite:
    "A Pushbullet access token. Free accounts are limited to 500 pushes a month.",
  capabilities: {
    native: true,
    lifecycle: false,
    duplicateSuppression: false,
    receipt: true,
  },
  fields: [
    {
      key: "accessToken",
      label: "Access token",
      type: "password",
      secret: true,
      required: true,
      placeholder: "o.…",
      help: "Pushbullet Settings, Account, Create Access Token.",
    },
    {
      key: "targetType",
      label: "Send to",
      type: "select",
      options: [
        { value: "all", label: "All my devices" },
        { value: "device_iden", label: "One device (device iden)" },
        { value: "channel_tag", label: "A channel (channel tag)" },
        { value: "email", label: "An email address" },
      ],
      help: "Pushbullet treats these as exclusive, so there is one target rather than three boxes.",
    },
    {
      key: "target",
      label: "Target",
      type: "text",
      placeholder: "leave blank for all devices",
      help: "The device iden, channel tag or email address for the choice above.",
    },
  ],
  check(config, secrets) {
    if (!secrets.accessToken) return "An access token is required.";
    const type = config.targetType ?? "all";
    if (type !== "all" && !config.target?.trim()) {
      return "That target type needs a target value.";
    }
    if (
      type === "email" &&
      !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(config.target ?? "")
    ) {
      return "The target is not a valid email address.";
    }
    return null;
  },
  destinationSummary(config) {
    const type = config.targetType ?? "all";
    if (type === "all" || !config.target) return "Pushbullet (all devices)";
    return `Pushbullet ${config.target}`;
  },
  async deliver({ config, secrets, message, net }) {
    const type = config.targetType ?? "all";
    return httpDeliver({
      url: PUSHBULLET_URL,
      headers: {
        "content-type": "application/json",
        "access-token": secrets.accessToken ?? "",
      },
      body: JSON.stringify({
        type: "note",
        title: truncate(message.title, 250),
        body: truncate(
          [message.text, message.url].filter(Boolean).join("\n") ||
            message.title,
          2_000,
        ),
        ...(type !== "all" && config.target ? { [type]: config.target } : {}),
      }),
      secrets,
      net,
      messageId: (raw) => {
        const parsed = parseJsonBody<{ iden?: unknown }>(raw);
        return typeof parsed?.iden === "string" ? parsed.iden : null;
      },
    });
  },
};
