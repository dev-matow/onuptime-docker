import {
  httpDeliver,
  parseJsonBody,
  truncate,
  type ChannelMessage,
  type ChannelProvider,
} from "./types";

/**
 * Pushover. The operator's own application token and user or group key;
 * Vigil funds nothing and hosts nothing.
 *
 * Two things about this API make it worth reading the code rather than
 * assuming the shape:
 *
 *  - It answers HTTP 200 with `{"status": 1}` on success and, in some
 *    cases, 200 with `status` not 1. A 200 alone is not delivery here,
 *    so the body is checked.
 *  - Emergency priority (2) is not just a number: without `retry` and
 *    `expire` Pushover rejects it. The field is offered because a pager
 *    that repeats until acknowledged is exactly what some operators
 *    want at 3am, and the two required companions are sent with it
 *    rather than left as a trap.
 *
 * The form encoding is the documented one; this endpoint does not take
 * JSON.
 */

const PUSHOVER_URL = "https://api.pushover.net/1/messages.json";

/** Non-critical severities map the same either way; only `critical`
 * follows the operator's choice. */
const BASE_PRIORITY: Record<ChannelMessage["severity"], number> = {
  critical: 1,
  warning: 0,
  ok: 0,
  info: 0,
};

/** Emergency retries every minute for an hour, the shortest interval
 * and a conservative expiry inside Pushover's three-hour maximum. */
const EMERGENCY_RETRY_SECONDS = 60;
const EMERGENCY_EXPIRE_SECONDS = 3_600;

const KEY_PATTERN = /^[A-Za-z0-9]{30}$/;

export const pushoverProvider: ChannelProvider = {
  id: "pushover",
  label: "Pushover",
  kind: "push",
  blurb: "Push to your Pushover devices, users or a delivery group.",
  docsUrl: "https://pushover.net/api",
  apiVersion: "Messages API (/1/messages.json)",
  prerequisite:
    "A Pushover application token and the user or group key to deliver to.",
  capabilities: {
    native: true,
    lifecycle: false,
    duplicateSuppression: false,
    receipt: true,
  },
  fields: [
    {
      key: "apiToken",
      label: "Application token",
      type: "password",
      secret: true,
      required: true,
      placeholder: "30 characters",
      help: "Pushover: Your Applications, Create an Application, copy its API Token.",
    },
    {
      key: "userKey",
      label: "User or group key",
      type: "password",
      secret: true,
      required: true,
      placeholder: "30 characters",
      help: "The 30-character key on your Pushover dashboard, or a delivery group key.",
    },
    {
      key: "device",
      label: "Device",
      type: "text",
      placeholder: "optional - all devices when blank",
      help: "Limits delivery to one registered device name.",
    },
    {
      key: "criticalPriority",
      label: "Priority for critical alerts",
      type: "select",
      options: [
        { value: "high", label: "High - bypasses quiet hours" },
        {
          value: "emergency",
          label: "Emergency - repeats for an hour until acknowledged",
        },
      ],
      help: "Emergency sends retry=60 and expire=3600, which Pushover requires with it.",
    },
  ],
  check(config, secrets) {
    if (!KEY_PATTERN.test(secrets.apiToken ?? "")) {
      return "The application token must be 30 letters and digits.";
    }
    if (!KEY_PATTERN.test(secrets.userKey ?? "")) {
      return "The user or group key must be 30 letters and digits.";
    }
    if (config.device && !/^[A-Za-z0-9_-]{1,25}$/.test(config.device)) {
      return "A device name may only contain letters, digits, - and _.";
    }
    return null;
  },
  destinationSummary(config) {
    return config.device ? `Pushover device ${config.device}` : "Pushover";
  },
  async deliver({ config, secrets, message, net }) {
    const emergency =
      message.severity === "critical" &&
      config.criticalPriority === "emergency";
    const priority = emergency ? 2 : BASE_PRIORITY[message.severity];

    const form = new URLSearchParams({
      token: secrets.apiToken ?? "",
      user: secrets.userKey ?? "",
      title: truncate(message.title, 250),
      message: truncate(message.text || message.title, 1_024),
      priority: String(priority),
    });
    if (config.device) form.set("device", config.device);
    if (message.url) {
      form.set("url", truncate(message.url, 512));
      form.set("url_title", "Open in Vigil");
    }
    if (emergency) {
      form.set("retry", String(EMERGENCY_RETRY_SECONDS));
      form.set("expire", String(EMERGENCY_EXPIRE_SECONDS));
    }

    return httpDeliver({
      url: PUSHOVER_URL,
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: form.toString(),
      secrets,
      net,
      messageId: (raw) => {
        const parsed = parseJsonBody<{ request?: unknown }>(raw);
        return typeof parsed?.request === "string" ? parsed.request : null;
      },
      bodyProblem: (raw) => {
        const parsed = parseJsonBody<{ status?: unknown }>(raw);
        return parsed && parsed.status !== 1
          ? "Pushover rejected the message"
          : null;
      },
    });
  },
};
