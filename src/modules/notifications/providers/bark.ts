import {
  httpDeliver,
  parseJsonBody,
  requireHttpUrl,
  truncate,
  type ChannelMessage,
  type ChannelProvider,
} from "./types";

/**
 * Bark - iOS push through a bark-server the operator runs, or the
 * public one. http is allowed because a LAN deployment is the normal
 * case, and the egress policy still refuses metadata and link-local
 * space.
 *
 * The device key goes in the BODY rather than the URL path, which the
 * v2 API supports and the v1 style does not. That matters: a key in the
 * path is a credential in every access log and reverse-proxy trace
 * between here and the server.
 *
 * bark-server can answer 200 with a non-200 `code` in the body, so the
 * body decides whether this was a delivery.
 *
 * `level` is mapped rather than passed through. Bark's `critical` level
 * breaks through the device's silent switch and needs the app to have
 * been granted that entitlement; sending it for every failing monitor
 * would be the wrong default, so critical alerts arrive as
 * `timeSensitive` and recoveries as `passive`.
 */

const LEVEL: Record<ChannelMessage["severity"], string> = {
  critical: "timeSensitive",
  warning: "active",
  ok: "passive",
  info: "active",
};

export const barkProvider: ChannelProvider = {
  id: "bark",
  label: "Bark",
  kind: "push",
  blurb: "Push to iOS through your own Bark server.",
  docsUrl: "https://github.com/Finb/bark-server/blob/master/docs/API_V2.md",
  apiVersion: "Bark API v2 (POST /push)",
  prerequisite: "The Bark iOS app, its device key, and a Bark server URL.",
  capabilities: {
    native: true,
    lifecycle: false,
    duplicateSuppression: false,
    receipt: false,
  },
  fields: [
    {
      key: "serverUrl",
      label: "Server URL",
      type: "url",
      required: true,
      placeholder: "https://api.day.app",
      help: "Your bark-server, or the public one shown in the app. Without a trailing /push.",
    },
    {
      key: "deviceKey",
      label: "Device key",
      type: "password",
      secret: true,
      required: true,
      help: "From the Bark app's home screen. Sent in the body, never in the URL.",
    },
    {
      key: "group",
      label: "Group",
      type: "text",
      placeholder: "Vigil (optional)",
      help: "Groups alerts together in the iOS notification centre.",
    },
    {
      key: "sound",
      label: "Sound",
      type: "text",
      placeholder: "optional",
      help: "A sound name the Bark app ships, for example alarm or minuet.",
    },
  ],
  check(config, secrets) {
    const urlError = requireHttpUrl(config.serverUrl ?? "", "The server URL");
    if (urlError) return urlError;
    if (!secrets.deviceKey) return "A device key is required.";
    if (config.sound && !/^[A-Za-z0-9_.-]{1,40}$/.test(config.sound)) {
      return "A sound name may only contain letters, digits, . - and _.";
    }
    return null;
  },
  destinationSummary(config) {
    try {
      return `Bark via ${new URL(config.serverUrl ?? "").host}`;
    } catch {
      return "Bark";
    }
  },
  async deliver({ config, secrets, message, net }) {
    const base = (config.serverUrl ?? "").replace(/\/+$/, "");
    return httpDeliver({
      url: `${base}/push`,
      headers: { "content-type": "application/json; charset=utf-8" },
      body: JSON.stringify({
        device_key: secrets.deviceKey,
        title: truncate(message.title, 200),
        body: truncate(message.text || message.title, 2_000),
        level: LEVEL[message.severity],
        ...(config.group ? { group: truncate(config.group, 50) } : {}),
        ...(config.sound ? { sound: config.sound } : {}),
        ...(message.url ? { url: message.url } : {}),
      }),
      secrets,
      net,
      bodyProblem: (raw) => {
        const parsed = parseJsonBody<{ code?: unknown }>(raw);
        return parsed && typeof parsed.code === "number" && parsed.code !== 200
          ? "Bark rejected the push"
          : null;
      },
    });
  },
};
