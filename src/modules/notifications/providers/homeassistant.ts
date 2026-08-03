import {
  httpDeliver,
  requireHttpUrl,
  truncate,
  type ChannelProvider,
} from "./types";

/**
 * Home Assistant, by calling a service in the `notify` domain with a
 * long-lived access token.
 *
 * The domain is fixed and the service is a field. That is not a
 * limitation dressed up as a decision: `POST /api/services/{domain}/
 * {service}` will call ANY service in the instance, and a notification
 * channel that can call `homeassistant.stop` or unlock a door is a
 * remote-control channel wearing a notification label. Pinning the
 * domain to `notify` means the worst a compromised or mistyped channel
 * can do is send a notification, which is what it is for.
 *
 * http is allowed - a Home Assistant instance is almost always on the
 * operator's own network - and the egress policy still refuses metadata
 * and link-local space.
 *
 * The response is the list of states the call changed, which is not a
 * message id, so no receipt is claimed.
 */

const SERVICE_PATTERN = /^[a-z0-9_]{1,64}$/;

export const homeassistantProvider: ChannelProvider = {
  id: "homeassistant",
  label: "Home Assistant",
  kind: "push",
  blurb: "Call a notify service on your own Home Assistant instance.",
  docsUrl: "https://developers.home-assistant.io/docs/api/rest/",
  apiVersion: "REST API (POST /api/services/notify/{service})",
  prerequisite:
    "A Home Assistant long-lived access token, and the name of a service in the notify domain.",
  capabilities: {
    native: true,
    lifecycle: false,
    duplicateSuppression: false,
    receipt: false,
  },
  fields: [
    {
      key: "baseUrl",
      label: "Instance URL",
      type: "url",
      required: true,
      placeholder: "http://homeassistant.local:8123",
      help: "Your Home Assistant base URL, without /api.",
    },
    {
      key: "service",
      label: "Notify service",
      type: "text",
      required: true,
      placeholder: "mobile_app_pixel_9",
      help: "The part after notify. in Developer Tools, Actions - for example persistent_notification or a mobile_app_ service.",
    },
    {
      key: "target",
      label: "Target",
      type: "text",
      placeholder: "optional",
      help: "Passed through as the service's target, for services that route by one.",
    },
    {
      key: "accessToken",
      label: "Long-lived access token",
      type: "password",
      secret: true,
      required: true,
      help: "Your Home Assistant profile, Security, Long-lived access tokens.",
    },
  ],
  check(config, secrets) {
    const urlError = requireHttpUrl(config.baseUrl ?? "", "The instance URL");
    if (urlError) return urlError;
    if (!SERVICE_PATTERN.test(config.service ?? "")) {
      return "A service name may only contain lower-case letters, digits and _.";
    }
    if (!secrets.accessToken) return "An access token is required.";
    return null;
  },
  destinationSummary(config) {
    try {
      return `Home Assistant notify.${config.service} on ${new URL(config.baseUrl ?? "").host}`;
    } catch {
      return `Home Assistant notify.${config.service ?? ""}`.trim();
    }
  },
  async deliver({ config, secrets, message, net }) {
    const base = (config.baseUrl ?? "").replace(/\/+$/, "");
    return httpDeliver({
      url: `${base}/api/services/notify/${encodeURIComponent(config.service ?? "")}`,
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${secrets.accessToken}`,
      },
      body: JSON.stringify({
        title: truncate(message.title, 200),
        message: truncate(message.text || message.title, 2_000),
        ...(config.target ? { target: config.target } : {}),
        ...(message.url ? { data: { url: message.url } } : {}),
      }),
      secrets,
      net,
    });
  },
};
