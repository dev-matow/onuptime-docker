import { describe, expect, it } from "vitest";

import {
  renderIncidentOpenedEmail,
  renderIncidentResolvedEmail,
} from "@/modules/notifications/email-templates";

describe("renderIncidentOpenedEmail", () => {
  it("renders subject, plain text and HTML with the incident link", () => {
    const email = renderIncidentOpenedEmail({
      monitorName: "API Gateway",
      monitorUrl: "https://api.example.com",
      failureThreshold: 3,
      incidentUrl: "https://vigil.example/incidents/abc",
    });

    expect(email.subject).toBe("[Vigil] API Gateway is down");
    expect(email.text).toContain("API Gateway (https://api.example.com)");
    expect(email.text).toContain("3 checks");
    expect(email.text).toContain("https://vigil.example/incidents/abc");
    expect(email.html).toContain("https://vigil.example/incidents/abc");
    expect(email.html).toContain("API Gateway is down");
  });

  it("uses a singular check label at threshold 1", () => {
    const email = renderIncidentOpenedEmail({
      monitorName: "Checkout",
      monitorUrl: "https://checkout.example",
      failureThreshold: 1,
      incidentUrl: "https://vigil.example/incidents/x",
    });
    expect(email.text).toContain("1 check");
    expect(email.text).not.toContain("1 checks");
  });

  it("escapes HTML in the monitor name to prevent injection", () => {
    const email = renderIncidentOpenedEmail({
      monitorName: '<script>alert("x")</script>',
      monitorUrl: "https://x.example",
      failureThreshold: 2,
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
