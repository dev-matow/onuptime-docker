import {
  httpDeliver,
  requireHttpUrl,
  truncate,
  type ChannelMessage,
  type ChannelProvider,
} from "./types";

/**
 * ntfy - ntfy.sh or the operator's own instance. Publishing uses the
 * JSON mode against the server root rather than headers-on-topic-URL,
 * because HTTP headers are latin-1 and the titles here carry emoji;
 * JSON has no such rule. Auth is an access token (Bearer) or username
 * and password (Basic), both optional because public topics exist.
 */

const PRIORITY: Record<ChannelMessage["severity"], number> = {
  critical: 5,
  warning: 4,
  ok: 3,
  info: 3,
};

const TOPIC_PATTERN = /^[A-Za-z0-9_-]{1,64}$/;

export const ntfyProvider: ChannelProvider = {
  id: "ntfy",
  label: "ntfy",
  kind: "push",
  blurb: "Publish to an ntfy topic, on ntfy.sh or your own server.",
  docsUrl: "https://docs.ntfy.sh/publish/",
  apiVersion: "Publish API (JSON)",
  prerequisite: "A topic on ntfy.sh or on your own ntfy server.",
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
      placeholder: "https://ntfy.sh",
    },
    {
      key: "topic",
      label: "Topic",
      type: "text",
      required: true,
      placeholder: "my-vigil-alerts",
      help: "Anyone who knows a public topic name can read it; pick an unguessable one or protect it with an access token.",
    },
    {
      key: "username",
      label: "Username",
      type: "text",
      placeholder: "optional",
    },
    {
      key: "password",
      label: "Password or access token",
      type: "password",
      secret: true,
      placeholder: "optional",
      help: "With a username this is Basic auth; alone it is sent as a Bearer access token.",
    },
  ],
  check(config, secrets) {
    const urlError = requireHttpUrl(config.serverUrl ?? "", "The server URL");
    if (urlError) return urlError;
    if (!TOPIC_PATTERN.test(config.topic ?? "")) {
      return "The topic may only contain letters, digits, - and _.";
    }
    if (config.username && !secrets.password) {
      return "A username needs a password.";
    }
    return null;
  },
  destinationSummary(config) {
    try {
      return `ntfy topic ${config.topic} at ${new URL(config.serverUrl ?? "").host}`;
    } catch {
      return `ntfy topic ${config.topic ?? ""}`.trim();
    }
  },
  async deliver({ config, secrets, message, net }) {
    const headers: Record<string, string> = {
      "content-type": "application/json",
    };
    if (secrets.password) {
      headers.authorization = config.username
        ? `Basic ${Buffer.from(`${config.username}:${secrets.password}`).toString("base64")}`
        : `Bearer ${secrets.password}`;
    }
    return httpDeliver({
      url: (config.serverUrl ?? "").replace(/\/+$/, ""),
      headers,
      body: JSON.stringify({
        topic: config.topic,
        title: truncate(message.title, 200),
        message: truncate(message.text || message.title, 4_000),
        priority: PRIORITY[message.severity],
        ...(message.url ? { click: message.url } : {}),
      }),
      secrets,
      net,
      messageId: (body) => {
        try {
          const parsed = JSON.parse(body) as { id?: string };
          return typeof parsed.id === "string" ? parsed.id : null;
        } catch {
          return null;
        }
      },
    });
  },
};
