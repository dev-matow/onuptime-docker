import {
  alertKey,
  httpDeliver,
  isResolution,
  parseJsonBody,
  truncate,
  type ChannelMessage,
  type ChannelProvider,
} from "./types";

/**
 * PagerDuty Events API v2.
 *
 * The first provider here with a lifecycle rather than a message feed,
 * and the reason `alertKey` exists. A pager integration is only worth
 * anything if the second alert about one outage joins the first and the
 * recovery closes both, so every event carries a `dedup_key` derived
 * from the cause - the incident id where there is one, the monitor id
 * otherwise. `monitor.down` and `incident.opened` for the same outage
 * therefore land on ONE PagerDuty alert, and `incident.resolved` or
 * `monitor.up` resolves it.
 *
 * Vigil does not send `acknowledge`. Acknowledging is a statement that
 * a human has picked the alert up, and nothing in Vigil knows that; a
 * monitor that is still failing has not been acknowledged by anyone.
 * Sending it would put a false fact in an on-call record. The action is
 * in the API and deliberately unused, which is worth being explicit
 * about rather than leaving as an omission.
 *
 * A resolve for a key with no open alert is accepted and does nothing,
 * which is why recovery needs no state on this side.
 *
 * Service region is a field because the EU region is a different HOST,
 * not a different path: an EU account posting to the US endpoint gets a
 * routing-key rejection and no clue why.
 */

const REGIONS: Record<string, string> = {
  us: "https://events.pagerduty.com/v2/enqueue",
  eu: "https://events.eu.pagerduty.com/v2/enqueue",
};

/** Vigil's four severities onto PagerDuty's four. `ok` never reaches a
 * payload - a resolution carries none - but the map is total so a new
 * severity cannot fall through it. */
const SEVERITY: Record<ChannelMessage["severity"], string> = {
  critical: "critical",
  warning: "warning",
  ok: "info",
  info: "info",
};

/** PagerDuty requires a `source`: where the problem is, not who noticed
 * it. The monitor is that; the organization is the honest fallback. */
function eventSource(message: ChannelMessage): string {
  const data = message.data as { monitor?: { name?: unknown; url?: unknown } };
  if (typeof data?.monitor?.name === "string" && data.monitor.name) {
    return truncate(data.monitor.name, 200);
  }
  if (typeof data?.monitor?.url === "string" && data.monitor.url) {
    return truncate(data.monitor.url, 200);
  }
  return `vigil/${message.organizationId}`;
}

/**
 * The exact event body PagerDuty receives. Exported because the
 * contract test asserts on it, and a test that rebuilt the body itself
 * would be asserting on its own copy.
 */
export function pagerdutyEventBody(
  message: ChannelMessage,
  rowId: string,
  routingKey: string,
): Record<string, unknown> {
  const dedupKey = alertKey(message, rowId);
  if (isResolution(message)) {
    return {
      routing_key: routingKey,
      event_action: "resolve",
      dedup_key: dedupKey,
    };
  }
  return {
    routing_key: routingKey,
    event_action: "trigger",
    dedup_key: dedupKey,
    client: "Vigil",
    ...(message.url ? { client_url: message.url } : {}),
    payload: {
      summary: truncate(message.title, 1_024),
      source: eventSource(message),
      severity: SEVERITY[message.severity],
      timestamp: message.timestamp,
      class: message.event,
      ...(message.text
        ? { custom_details: { detail: truncate(message.text, 4_000) } }
        : {}),
    },
  };
}

export const pagerdutyProvider: ChannelProvider = {
  id: "pagerduty",
  label: "PagerDuty",
  kind: "incident",
  blurb: "Trigger and resolve PagerDuty alerts on your own service.",
  docsUrl: "https://developer.pagerduty.com/docs/events-api-v2",
  apiVersion: "Events API v2",
  prerequisite:
    "A PagerDuty service with an Events API v2 integration, and its integration key.",
  capabilities: {
    native: true,
    lifecycle: true,
    duplicateSuppression: true,
    receipt: true,
  },
  fields: [
    {
      key: "routingKey",
      label: "Integration key",
      type: "password",
      secret: true,
      required: true,
      placeholder: "32 hexadecimal characters",
      help: "PagerDuty: your service, Integrations, add an Events API v2 integration, copy its Integration Key.",
    },
    {
      key: "region",
      label: "Service region",
      type: "select",
      required: true,
      options: [
        { value: "us", label: "United States (events.pagerduty.com)" },
        { value: "eu", label: "European Union (events.eu.pagerduty.com)" },
      ],
      help: "Must match your PagerDuty account's region, or the key is rejected.",
    },
  ],
  check(config, secrets) {
    if (!/^[A-Za-z0-9]{20,64}$/.test(secrets.routingKey ?? "")) {
      return "The integration key does not look like a PagerDuty routing key.";
    }
    if (!REGIONS[config.region ?? ""]) {
      return "Pick the service region your PagerDuty account is in.";
    }
    return null;
  },
  destinationSummary(config) {
    return `PagerDuty service (${config.region === "eu" ? "EU" : "US"})`;
  },
  async deliver({ config, secrets, message, rowId, net }) {
    return httpDeliver({
      url: REGIONS[config.region ?? "us"] ?? REGIONS.us!,
      headers: { "content-type": "application/json" },
      body: JSON.stringify(
        pagerdutyEventBody(message, rowId, secrets.routingKey ?? ""),
      ),
      secrets,
      net,
      messageId: (raw) => {
        const parsed = parseJsonBody<{ dedup_key?: unknown }>(raw);
        return typeof parsed?.dedup_key === "string" ? parsed.dedup_key : null;
      },
    });
  },
};
