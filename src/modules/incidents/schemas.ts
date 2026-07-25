import { z } from "zod";

import { INCIDENT_SEVERITIES, INCIDENT_STATUSES } from "./lifecycle";

export const createIncidentSchema = z.object({
  title: z.string().trim().min(1, "Title is required").max(150),
  severity: z.enum(INCIDENT_SEVERITIES),
  message: z.string().trim().max(2_000).optional(),
});

export const statusChangeSchema = z.object({
  status: z.enum(INCIDENT_STATUSES),
  message: z.string().trim().min(1, "An update message is required").max(2_000),
});

export const incidentUpdateSchema = z.object({
  message: z.string().trim().min(1, "Update cannot be empty").max(2_000),
  /** Internal notes stay off the public status page. */
  internal: z.boolean().default(false),
});

export const severityChangeSchema = z.object({
  severity: z.enum(INCIDENT_SEVERITIES),
});

export const postmortemSchema = z.object({
  content: z.string().trim().min(1).max(20_000),
});

export type CreateIncidentInput = z.infer<typeof createIncidentSchema>;
export type StatusChangeInput = z.infer<typeof statusChangeSchema>;
