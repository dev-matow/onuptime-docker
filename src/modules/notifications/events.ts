import type { WebhookEvent } from "./webhook";

/**
 * Event routing: a channel subscribes to classes, not raw events.
 *
 * Classes rather than the event list itself because the operator
 * question is "tell this room about outages" and "tell the on-call
 * pager about recovery", not a nine-checkbox matrix. Each event belongs
 * to exactly one class, so no channel can receive the same logical
 * event twice through two subscriptions - that exclusivity is what
 * makes "one event, one message per channel" checkable.
 *
 * Certificate and domain expiry are a carve-out of monitor down/up
 * rather than new events: an expiry monitor that crosses its threshold
 * goes down like any other monitor, but the operator who wants outage
 * pages at 3am usually wants expiry warnings somewhere quieter. The
 * carve-out is by monitor kind, and it is exclusive - an expiry
 * monitor's down event is class "expiry", never class "monitor".
 */

export interface EventClass {
  id: string;
  label: string;
  description: string;
}

export const EVENT_CLASSES: readonly EventClass[] = [
  {
    id: "monitor",
    label: "Monitor down / up",
    description: "A monitor fails its checks or comes back.",
  },
  {
    id: "incident",
    label: "Incident lifecycle",
    description: "An incident opens, is updated, or resolves.",
  },
  {
    id: "expiry",
    label: "Certificate / domain expiry",
    description: "A TLS certificate or domain registration nears expiry.",
  },
];

export const EVENT_CLASS_IDS: readonly string[] = EVENT_CLASSES.map(
  (c) => c.id,
);

/** Monitor kinds whose down/up events are expiry warnings, not outages. */
const EXPIRY_MONITOR_TYPES = new Set(["tls-expiry", "domain-expiry"]);

/**
 * Which class an event belongs to. `monitorType` matters only for
 * monitor down/up, where it decides outage versus expiry.
 */
export function classifyEvent(
  event: WebhookEvent,
  monitorType?: string | null,
): string {
  if (event === "monitor.down" || event === "monitor.up") {
    return monitorType && EXPIRY_MONITOR_TYPES.has(monitorType)
      ? "expiry"
      : "monitor";
  }
  if (event.startsWith("incident.")) return "incident";
  // Tests and recovery triggers are not routable events; callers never
  // pass them here, and an unknown future event failing closed (no
  // class, so no channel matches) beats failing loud on the check path.
  return "none";
}

/**
 * How urgent a message renders on providers with a priority scale, and
 * which accent color card-based providers use.
 */
export type MessageSeverity = "critical" | "warning" | "ok" | "info";

export function eventSeverity(event: WebhookEvent): MessageSeverity {
  switch (event) {
    case "monitor.down":
    case "incident.opened":
      return "critical";
    case "incident.updated":
    // Late work is a warning and not an alert. It is somebody's
    // deadline, not an outage, and a channel that pages at the same
    // volume for both is one whose pages stop being read.
      return "warning";
    case "monitor.up":
    case "incident.resolved":
      return "ok";
    default:
      return "info";
  }
}
