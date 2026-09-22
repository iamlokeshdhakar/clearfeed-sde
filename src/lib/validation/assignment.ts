import { z } from "zod";

export const assignmentRequestSchema = z.object({
  company_id: z.string().min(1, { error: "company_id is required" }),
  ticket_id: z.string().min(1, { error: "ticket_id is required" }),
});

export type AssignmentRequestInput = z.infer<typeof assignmentRequestSchema>;
