import { signBody } from "../webhook";
import {
  httpDeliver,
  requireHttpUrl,
  type ChannelMessage,
  type ChannelProvider,
} from "./types";

/**
 * The generic signed webhook - the same wire contract the single org
 * webhook has had since 1.7: the versioned JSON payload, HMAC-SHA-256
 * over the exact body in X-Vigil-Signature, the event name in
 * X-Vigil-Event. Receivers written against the old endpoint keep
 * working; migration 0022 moved those endpoints here with their
 * secrets, so their signatures did not even change key.
 *
 * The timestamp in the body is the enqueue time, deliberately: a retry
 * re-sends the exact signed bytes that were decided, so a receiver that
 * dedupes on the body sees the duplicate for what it is.
 */

export function buildSignedWebhookBody(message: ChannelMessage): string {
  return JSON.stringify({
    version: 1,
    event: message.event,
    timestamp: message.timestamp,
    organization: { id: message.organizationId },
    data: message.data,
  });
}

export const webhookProvider: ChannelProvider = {
  id: "webhook",
  label: "Webhook",
  kind: "webhook",
  blurb: "POST the signed JSON payload to your own endpoint.",
  docsUrl: "/docs/notifications.html",
  apiVersion: "Vigil payload v1",
  prerequisite:
    "An endpoint that can verify an HMAC-SHA-256 signature over the raw body.",
  capabilities: {
    native: true,
    lifecycle: false,
    duplicateSuppression: false,
    receipt: false,
  },
  fields: [
    {
      key: "url",
      label: "Endpoint URL",
      type: "url",
      required: true,
      placeholder: "https://ops.example.com/hooks/vigil",
      help: "Verify X-Vigil-Signature: HMAC-SHA-256 of the raw body, keyed by the signing secret.",
    },
    {
      key: "secret",
      label: "Signing secret",
      type: "password",
      secret: true,
      placeholder: "generated when left blank",
      help: "Kept encrypted. Shared only with your receiver.",
    },
  ],
  check(config) {
    return requireHttpUrl(config.url ?? "", "The endpoint URL");
  },
  destinationSummary(config) {
    try {
      const url = new URL(config.url ?? "");
      return `${url.host}${url.pathname === "/" ? "" : url.pathname}`;
    } catch {
      return "webhook";
    }
  },
  async deliver({ config, secrets, message, net }) {
    const body = buildSignedWebhookBody(message);
    return httpDeliver({
      url: config.url ?? "",
      headers: {
        "content-type": "application/json",
        "user-agent": "vigil-webhooks/1.0",
        "x-vigil-event": message.event,
        "x-vigil-signature": signBody(secrets.secret ?? "", body),
      },
      body,
      secrets,
      net,
    });
  },
};
