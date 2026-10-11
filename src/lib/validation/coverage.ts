import { DateTime } from "luxon";
import { z } from "zod";

export const coverageQuerySchema = z.object({
  week_start: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/, { error: "must be YYYY-MM-DD" })
    .refine((value) => DateTime.fromISO(value).isValid, {
      error: "invalid calendar date",
    })
    .optional(),
});

export type CoverageQueryInput = z.infer<typeof coverageQuerySchema>;
