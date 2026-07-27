import { describe, expect, it } from "vitest";

import {
  describeFailureWindow,
  renderIncidentOpenedEmail,
  renderIncidentResolvedEmail,
} from "@/modules/notifications/email-templates";

describe("renderIncidentOpenedEmail", () => {
  it("renders subject, plain text and HTML with the incident link", () => {
    const email = renderIncidentOpenedEmail({
      monitorName: "API Gateway",
      monitorUrl: "https://api.example.com",
      failureWindowSeconds: 180,
      incidentUrl: "https://vigil.example/incidents/abc",
    });

    expect(email.subject).toBe("[Vigil] API Gateway is down");
    expect(email.text).toContain("API Gateway (https://api.example.com)");
    expect(email.text).toContain("failing for 3 minutes");
    expect(email.text).toContain("https://vigil.example/incidents/abc");
    expect(email.html).toContain("https://vigil.example/incidents/abc");
    expect(email.html).toContain("API Gateway is down");
  });

  it("says so plainly when the window is zero", () => {
    const email = renderIncidentOpenedEmail({
      monitorName: "Checkout",
      monitorUrl: "https://checkout.example",
      failureWindowSeconds: 0,
      incidentUrl: "https://vigil.example/incidents/x",
    });
    expect(email.text).toContain("from its first failed check");
  });

  it("uses singular units at exactly one minute", () => {
    const email = renderIncidentOpenedEmail({
      monitorName: "Checkout",
      monitorUrl: "https://checkout.example",
      failureWindowSeconds: 60,
      incidentUrl: "https://vigil.example/incidents/x",
    });
    expect(email.text).toContain("for 1 minute");
    expect(email.text).not.toContain("1 minutes");
  });

  it("escapes HTML in the monitor name to prevent injection", () => {
    const email = renderIncidentOpenedEmail({
      monitorName: '<script>alert("x")</script>',
      monitorUrl: "https://x.example",
      failureWindowSeconds: 120,
      incidentUrl: "https://vigil.example/incidents/x",
    });
    expect(email.html).not.toContain("<script>");
    expect(email.html).toContain("&lt;script&gt;");
  });
});

describe("renderIncidentResolvedEmail", () => {
  it("renders the recovery message and link", () => {
    const email = renderIncidentResolvedEmail({
      monitorName: "API Gateway",
      monitorUrl: "https://api.example.com",
      incidentUrl: "https://vigil.example/incidents/abc",
    });

    expect(email.subject).toBe("[Vigil] API Gateway recovered");
    expect(email.text).toContain("is responding again");
    expect(email.html).toContain("API Gateway recovered");
    expect(email.html).toContain("https://vigil.example/incidents/abc");
  });
});

describe("describeFailureWindow", () => {
  // It is spliced after "has been failing" in email and after "had been
  // failing" on the public status page, so it has to read as a clause
  // in both. "had been failing on its first failed check" is not a
  // sentence — and migration 0010 gives a window of 0 to every 1.9.x
  // monitor that had failureThreshold: 1.
  it("composes with both tenses at a zero window", () => {
    const clause = describeFailureWindow(0);
    expect(`X has been failing ${clause}`).toBe(
      "X has been failing from its first failed check",
    );
    expect(`X had been failing ${clause}`).toBe(
      "X had been failing from its first failed check",
    );
  });

  it("pluralizes seconds", () => {
    expect(describeFailureWindow(1)).toBe("for 1 second");
    expect(describeFailureWindow(45)).toBe("for 45 seconds");
  });

  it("pluralizes minutes and hours", () => {
    expect(describeFailureWindow(60)).toBe("for 1 minute");
    expect(describeFailureWindow(180)).toBe("for 3 minutes");
    expect(describeFailureWindow(3600)).toBe("for 1 hour");
    expect(describeFailureWindow(7200)).toBe("for 2 hours");
  });
});
