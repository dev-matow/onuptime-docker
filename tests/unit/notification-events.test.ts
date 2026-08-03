import { describe, expect, it } from "vitest";

import {
  classifyEvent,
  EVENT_CLASS_IDS,
  EVENT_CLASSES,
  eventSeverity,
} from "@/modules/notifications/events";
import { WEBHOOK_EVENTS } from "@/modules/notifications/webhook";

describe("classifyEvent", () => {
  it("maps every routable event to exactly one declared class", () => {
    for (const event of WEBHOOK_EVENTS) {
      const cls = classifyEvent(event, "http");
      expect(EVENT_CLASS_IDS, `${event} -> ${cls}`).toContain(cls);
    }
  });

  it("carves expiry monitors out of the monitor class, exclusively", () => {
    expect(classifyEvent("monitor.down", "http")).toBe("monitor");
    expect(classifyEvent("monitor.down", "tls-expiry")).toBe("expiry");
    expect(classifyEvent("monitor.down", "domain-expiry")).toBe("expiry");
    expect(classifyEvent("monitor.up", "domain-expiry")).toBe("expiry");
    // No monitor type means no expiry claim.
    expect(classifyEvent("monitor.up", null)).toBe("monitor");
  });

  it("classes incidents, recovery results and probe quorum", () => {
    expect(classifyEvent("incident.opened")).toBe("incident");
    expect(classifyEvent("incident.updated")).toBe("incident");
    expect(classifyEvent("incident.resolved")).toBe("incident");
  });

  it("fails closed for non-routable events", () => {
    expect(classifyEvent("webhook.test")).toBe("none");
    expect(classifyEvent("recovery.execute")).toBe("none");
    expect(EVENT_CLASS_IDS).not.toContain("none");
  });
});

describe("eventSeverity", () => {
  it("grades the alarm-worthy events critical and recoveries ok", () => {
    expect(eventSeverity("monitor.down")).toBe("critical");
    expect(eventSeverity("incident.opened")).toBe("critical");
    expect(eventSeverity("monitor.up")).toBe("ok");
    expect(eventSeverity("incident.resolved")).toBe("ok");
    expect(eventSeverity("webhook.test")).toBe("info");
  });
});

describe("EVENT_CLASSES", () => {
  it("declares unique ids with operator-readable labels", () => {
    expect(new Set(EVENT_CLASS_IDS).size).toBe(EVENT_CLASSES.length);
    for (const cls of EVENT_CLASSES) {
      expect(cls.label.length).toBeGreaterThan(3);
      expect(cls.description.length).toBeGreaterThan(10);
    }
  });
});
