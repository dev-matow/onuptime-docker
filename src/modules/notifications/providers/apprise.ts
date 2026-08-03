import {
  httpDeliver,
  parseJsonBody,
  requireHttpUrl,
  truncate,
  type ChannelMessage,
  type ChannelProvider,
} from "./types";

/**
 * The Apprise bridge - the one entry in this registry that is NOT a
 * Vigil provider, and the docs, the editor and the generated facts all
 * say so in those words.
 *
 * What this is: an HTTP call to an Apprise API server **the customer
 * runs**, which then forwards to whatever that server is configured
 * for. What it is not: a Vigil integration with any of those services.
 * Vigil has not implemented, pinned, versioned or tested a single
 * Apprise backend, and none of them is counted anywhere as a Vigil
 * provider. The twenty-five native providers are the ones in this
 * directory with `native: true`; everything reachable through here is
 * "additional services through your own Apprise server", which is a
 * different sentence on purpose.
 *
 * There is no managed Apprise, no shared relay and no instance of
 * anything run by the people who sell Vigil. If the URL points at
 * somebody else's server, that is the operator's decision and their
 * credentials go there, not here.
 *
 * Two modes, both documented by apprise-api:
 *
 *  - **Saved configuration** (`POST /notify/{key}`): the Apprise URLs -
 *    which embed third-party credentials - live on the customer's own
 *    server, and Vigil stores none of them. This is the mode to prefer
 *    and the reason it is listed first.
 *  - **Inline URLs** (`POST /notify`): Vigil holds the Apprise URLs.
 *    They are a secret field, sealed and redacted like every other
 *    credential, because `slack://TokenA/TokenB/TokenC` is a token.
 *
 * apprise-api ships no authentication of its own; operators front it
 * with a reverse proxy. The optional Authorization field is how that
 * proxy's credential gets sent, and it is a secret like any other.
 */

/** Apprise's four message types. */
const TYPE: Record<ChannelMessage["severity"], string> = {
  critical: "failure",
  warning: "warning",
  ok: "success",
  info: "info",
};

const KEY_PATTERN = /^[A-Za-z0-9_-]{1,64}$/;

export const appriseProvider: ChannelProvider = {
  id: "apprise",
  label: "Apprise (your own server)",
  kind: "bridge",
  blurb:
    "Forward to an Apprise API server you run. Not a Vigil integration with the services behind it.",
  docsUrl: "https://github.com/caronc/apprise-api#readme",
  apiVersion: "apprise-api (POST /notify, POST /notify/{key})",
  prerequisite:
    "An Apprise API server you host, reachable from Vigil. Vigil runs no Apprise server and has not tested the services yours forwards to.",
  capabilities: {
    native: false,
    lifecycle: false,
    duplicateSuppression: false,
    receipt: false,
  },
  fields: [
    {
      key: "serverUrl",
      label: "Apprise server URL",
      type: "url",
      required: true,
      placeholder: "http://apprise.internal:8000",
      help: "Your own apprise-api instance. Vigil does not host one.",
    },
    {
      key: "configKey",
      label: "Saved configuration key",
      type: "text",
      placeholder: "ops",
      help: "Preferred. The {KEY} you saved URLs under on your Apprise server, so the third-party tokens stay there and never reach Vigil.",
    },
    {
      key: "tag",
      label: "Tag",
      type: "text",
      placeholder: "optional",
      help: "Limits a saved configuration to the tagged URLs. Comma to OR, space to AND.",
    },
    {
      key: "urls",
      label: "Apprise URLs",
      type: "textarea",
      secret: true,
      placeholder: "mailto://user:pass@example.com, discord://id/token",
      help: "Only if you are not using a saved configuration key. These embed credentials, so they are stored encrypted - but keeping them on your Apprise server instead is better.",
    },
    {
      key: "authorization",
      label: "Authorization header",
      type: "password",
      secret: true,
      placeholder: "optional, e.g. Basic dXNlcjpwYXNz",
      help: "apprise-api has no auth of its own. If yours sits behind a proxy that needs one, put the whole header value here.",
    },
  ],
  check(config, secrets) {
    const urlError = requireHttpUrl(
      config.serverUrl ?? "",
      "The Apprise server URL",
    );
    if (urlError) return urlError;
    const hasKey = Boolean(config.configKey);
    const hasUrls = Boolean(secrets.urls);
    if (!hasKey && !hasUrls) {
      return "Give a saved configuration key, or the Apprise URLs to notify.";
    }
    if (hasKey && hasUrls) {
      return "Use a saved configuration key or inline URLs, not both.";
    }
    if (hasKey && !KEY_PATTERN.test(config.configKey ?? "")) {
      return "A configuration key may only contain letters, digits, - and _.";
    }
    if (config.tag && !hasKey) {
      return "A tag only applies to a saved configuration key.";
    }
    return null;
  },
  destinationSummary(config) {
    let host = "Apprise";
    try {
      host = new URL(config.serverUrl ?? "").host;
    } catch {
      /* an unparsable URL cannot be saved; check() refuses it first */
    }
    return config.configKey
      ? `Apprise ${config.configKey} on ${host}`
      : `Apprise on ${host}`;
  },
  async deliver({ config, secrets, message, net }) {
    const base = (config.serverUrl ?? "").replace(/\/+$/, "");
    const key = config.configKey;
    const headers: Record<string, string> = {
      "content-type": "application/json",
    };
    if (secrets.authorization) headers.authorization = secrets.authorization;

    return httpDeliver({
      url: key ? `${base}/notify/${encodeURIComponent(key)}` : `${base}/notify`,
      headers,
      body: JSON.stringify({
        title: truncate(message.title, 250),
        body: truncate(
          [message.text, message.url].filter(Boolean).join("\n") ||
            message.title,
          4_000,
        ),
        type: TYPE[message.severity],
        format: "text",
        ...(key ? {} : { urls: secrets.urls }),
        ...(key && config.tag ? { tag: config.tag } : {}),
      }),
      secrets,
      net,
      bodyProblem: (raw) => {
        const parsed = parseJsonBody<{ error?: unknown }>(raw);
        return parsed && typeof parsed.error === "string" && parsed.error
          ? "The Apprise server reported an error"
          : null;
      },
    });
  },
};
