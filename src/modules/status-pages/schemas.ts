import { z } from "zod";

export const updateStatusPageSchema = z.object({
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
});

export const statusPageMonitorsSchema = z.object({
  monitors: z
    .array(
      z.object({
        monitorId: z.uuid(),
        displayName: z.string().trim().max(100).nullish(),
      }),
    )
    .max(50),
});

export type UpdateStatusPageInput = z.infer<typeof updateStatusPageSchema>;
export type StatusPageMonitorsInput = z.infer<typeof statusPageMonitorsSchema>;
