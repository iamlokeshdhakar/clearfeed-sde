import { Info } from "luxon";
import { z } from "zod";
import { HH_MM_PATTERN } from "@/lib/domain/time";

const timeString = z
  .string()
  .regex(HH_MM_PATTERN, { error: "must be in HH:mm format" });

const isoWeekday = z
  .number()
  .int()
  .min(1, { error: "day of week must be 1-7" })
  .max(7, { error: "day of week must be 1-7" });

const timezone = z.string().refine((tz) => Info.isValidIANAZone(tz), {
  error: "unknown timezone",
});

const agentIds = z
  .array(z.string().min(1))
  .min(1, { error: "select at least one agent" });

export const createAvailabilityWindowSchema = z
  .object({
    days_of_week: z
      .array(isoWeekday)
      .min(1, { error: "select at least one day" }),
    start_time: timeString,
    end_time: timeString,
    timezone,
    agent_ids: agentIds,
  })
  .refine((data) => data.start_time !== data.end_time, {
    error: "start and end time must not be equal",
    path: ["end_time"],
  });

export const updateAvailabilityWindowSchema = z
  .object({
    start_time: timeString,
    end_time: timeString,
    timezone,
    agent_ids: agentIds,
  })
  .refine((data) => data.start_time !== data.end_time, {
    error: "start and end time must not be equal",
    path: ["end_time"],
  });

export type CreateAvailabilityWindowInput = z.infer<
  typeof createAvailabilityWindowSchema
>;
export type UpdateAvailabilityWindowInput = z.infer<
  typeof updateAvailabilityWindowSchema
>;
