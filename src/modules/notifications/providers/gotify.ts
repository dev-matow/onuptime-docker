import {
  httpDeliver,
  requireHttpUrl,
  truncate,
  type ChannelMessage,
  type ChannelProvider,
} from "./types";

/**
 * Gotify, self-hosted push. The server URL is the operator's own
 * instance (http allowed - a LAN deployment is the normal case, and the
 * egress policy still refuses metadata and link-local space). The app
 * token authenticates via the X-Gotify-Key header rather than the
 * query string, so it can never end up in an access log.
 */

const PRIORITY: Record<ChannelMessage["severity"], number> = {
  critical: 8,
  warning: 5,
  ok: 4,
  info: 4,
};

export const gotifyProvider: ChannelProvider = {
  id: "gotify",
  label: "Gotify",
  kind: "push",
  blurb: "Push to your own Gotify server.",
  docsUrl: "https://gotify.net/docs/pushmsg",
  apiVersion: "Server API (POST /message)",
  prerequisite: "A Gotify server you run, and an application token from it.",
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
      placeholder: "https://gotify.example.com",
      help: "Your Gotify instance, without a trailing /message.",
    },
    {
      key: "appToken",
      label: "Application token",
      type: "password",
      secret: true,
      required: true,
      help: "Gotify: Apps, Create Application, copy its token.",
    },
  ],
  check(config, secrets) {
    const urlError = requireHttpUrl(config.serverUrl ?? "", "The server URL");
    if (urlError) return urlError;
    if (!secrets.appToken) return "An application token is required.";
    return null;
  },
  destinationSummary(config) {
    try {
      return `Gotify at ${new URL(config.serverUrl ?? "").host}`;
    } catch {
      return "Gotify";
    }
  },
  async deliver({ config, secrets, message, net }) {
    const base = (config.serverUrl ?? "").replace(/\/+$/, "");
    return httpDeliver({
      url: `${base}/message`,
      headers: {
        "content-type": "application/json",
        "x-gotify-key": secrets.appToken ?? "",
      },
      body: JSON.stringify({
        title: truncate(message.title, 200),
        message: truncate(
          [message.text, message.url].filter(Boolean).join("\n") ||
            message.title,
          4_000,
        ),
        priority: PRIORITY[message.severity],
      }),
      secrets,
      net,
      messageId: (body) => {
        try {
          const parsed = JSON.parse(body) as { id?: number };
          return typeof parsed.id === "number" ? String(parsed.id) : null;
        } catch {
          return null;
        }
      },
    });
  },
};
