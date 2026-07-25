/**
 * Incident lifecycle rules, kept free of I/O so they can be unit-tested
 * and shared between server actions and the worker.
 *
 * Statuses move freely between the three active states; `resolved` is
 * terminal — reopening history would corrupt the public record, so a
 * regression gets a new incident instead.
 */
export const INCIDENT_STATUSES = [
  "investigating",
  "identified",
  "monitoring",
  "resolved",
] as const;

export type IncidentStatus = (typeof INCIDENT_STATUSES)[number];

export const INCIDENT_SEVERITIES = ["critical", "major", "minor"] as const;

export type IncidentSeverity = (typeof INCIDENT_SEVERITIES)[number];

export function isActiveStatus(status: IncidentStatus): boolean {
  return status !== "resolved";
}

export function canTransition(
  from: IncidentStatus,
  to: IncidentStatus,
): boolean {
  if (from === "resolved") return false;
  if (from === to) return false;
  return INCIDENT_STATUSES.includes(to);
}

export function allowedTransitions(
  from: IncidentStatus,
): readonly IncidentStatus[] {
  if (from === "resolved") return [];
  return INCIDENT_STATUSES.filter((status) => status !== from);
}
