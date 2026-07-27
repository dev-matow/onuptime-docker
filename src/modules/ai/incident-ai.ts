import { formatDateTime, formatDuration } from "@/lib/format";
import type { IncidentDetail } from "@/modules/incidents/service";

import { generateText } from "./client";

/**
 * Prompt-building is deliberately dumb string assembly from data we
 * already hold — no user-controlled instructions are concatenated into
 * the system prompt, only into the clearly-delimited incident record.
 */
function renderTimeline(detail: IncidentDetail): string {
  return [...detail.timeline]
    .reverse()
    .map((event) => {
      const author = event.authorName ?? "System";
      const status = event.status ? ` [status → ${event.status}]` : "";
      return `- ${formatDateTime(event.createdAt)} — ${author}${status}: ${event.message}`;
    })
    .join("\n");
}

function renderIncident(detail: IncidentDetail): string {
  const { incident, monitor } = detail;
  const duration = incident.resolvedAt
    ? formatDuration(
        incident.resolvedAt.getTime() - incident.startedAt.getTime(),
      )
    : "ongoing";

  return [
    `Title: ${incident.title}`,
    `Severity: ${incident.severity}`,
    `Status: ${incident.status}`,
    `Source: ${incident.source === "monitor" ? `automatic (monitor: ${monitor?.name ?? "deleted"})` : "reported manually"}`,
    `Started: ${formatDateTime(incident.startedAt)}`,
    `Duration: ${duration}`,
    "",
    "Timeline (oldest first):",
    renderTimeline(detail),
  ].join("\n");
}

const POSTMORTEM_SYSTEM = `You write incident postmortems for an engineering team using Vigil, an uptime monitoring and incident management tool. You are given the incident record and its timeline.

Write a blameless postmortem in Markdown with these sections:
## Summary
## Impact
## Timeline
## Root cause
## What went well / what went poorly
## Action items

Rules:
- Ground every statement in the provided timeline; where the record is silent, write "To be filled in" rather than inventing facts. Never fabricate metrics, customer counts, or causes.
- Root cause: if the timeline doesn't establish one, list the open questions the team should answer instead.
- Action items: concrete and checkable, as a Markdown task list.
- Blameless: describe systems and processes, never fault individuals.
- Keep it under 500 words. No preamble — start directly with the first heading.`;

export async function draftPostmortem(detail: IncidentDetail): Promise<string> {
  return generateText({
    system: POSTMORTEM_SYSTEM,
    prompt: `Write the postmortem for this incident:\n\n${renderIncident(detail)}`,
    maxTokens: 8192,
  });
}

const STATUS_UPDATE_SYSTEM = `You draft public status-page updates during live incidents for an engineering team. You are given the incident record and timeline.

Write ONE short update (2–3 sentences) suitable for a public status page:
- Plain language, calm and factual. No internal jargon, hostnames, URLs, or names of people.
- State what is known, what customers may experience, and what happens next.
- Never promise timelines the timeline data doesn't support.
- Respond with the update text only — no quotes, no preamble.`;

export async function suggestStatusUpdate(
  detail: IncidentDetail,
): Promise<string> {
  return generateText({
    system: STATUS_UPDATE_SYSTEM,
    prompt: `Draft the next public update for this incident:\n\n${renderIncident(detail)}`,
    maxTokens: 1024,
  });
}
