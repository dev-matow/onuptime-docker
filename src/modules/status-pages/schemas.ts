import { z } from "zod";

export const createStatusPageSchema = z.object({
  name: z.string().trim().min(1, "Name is required").max(100),
  slug: z
    .string()
    .trim()
    .min(3, "Slug must be at least 3 characters")
    .max(63)
    .regex(
      /^[a-z0-9]+(-[a-z0-9]+)*$/,
      "Lowercase letters, numbers and dashes only",
    ),
});

export const updateStatusPageSchema = z.object({
  statusPageId: z.uuid(),
  name: z.string().trim().min(1, "Name is required").max(100),
  slug: z
    .string()
    .trim()
    .min(3, "Slug must be at least 3 characters")
    .max(63)
    .regex(
      /^[a-z0-9]+(-[a-z0-9]+)*$/,
      "Lowercase letters, numbers and dashes only",
    ),
  published: z.boolean(),
  showBranding: z.boolean().default(true),
  visibility: z.enum(["public", "private", "password"]).default("public"),
  /**
   * New shared password for `password` visibility. Empty string keeps
   * the existing password; required the first time password protection
   * is turned on.
   */
  password: z.string().min(1).max(200).optional().or(z.literal("")),
});

export const statusPageMonitorsSchema = z.object({
  statusPageId: z.uuid(),
  monitors: z
    .array(
      z.object({
        monitorId: z.uuid(),
        displayName: z.string().trim().max(100).nullish(),
      }),
    )
    .max(50),
});

export type CreateStatusPageInput = z.infer<typeof createStatusPageSchema>;
export type UpdateStatusPageInput = z.infer<typeof updateStatusPageSchema>;
export type StatusPageMonitorsInput = z.infer<typeof statusPageMonitorsSchema>;
