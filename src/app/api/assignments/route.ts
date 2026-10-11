import { NextResponse } from "next/server";
import { ApiError, apiErrorResponse, zodErrorDetails } from "@/lib/api/errors";
import { assignTicket } from "@/lib/services/assignmentService";
import {
  AssignmentServiceUnavailableError,
  CompanyNotFoundError,
  TicketCompanyMismatchError,
  TicketNotFoundError,
  TicketTerminalError,
} from "@/lib/services/errors";
import { assignmentRequestSchema } from "@/lib/validation/assignment";

export async function POST(request: Request): Promise<NextResponse> {
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return apiErrorResponse(
      new ApiError("VALIDATION_FAILED", "Request body must be valid JSON"),
    );
  }

  const parsed = assignmentRequestSchema.safeParse(body);
  if (!parsed.success) {
    return apiErrorResponse(
      new ApiError(
        "VALIDATION_FAILED",
        "Invalid assignment request",
        zodErrorDetails(parsed.error),
      ),
    );
  }

  try {
    const outcome = await assignTicket({
      companyId: parsed.data.company_id,
      ticketId: parsed.data.ticket_id,
    });

    if (outcome.status === "assigned") {
      return NextResponse.json({
        status: "assigned",
        ticket_id: outcome.ticketId,
        assignee: outcome.assignee,
        assigned_at: outcome.assignedAt.toISOString(),
        idempotent_replay: outcome.idempotentReplay,
        explanation: outcome.explanation,
      });
    }

    return NextResponse.json({
      status: "pending",
      ticket_id: outcome.ticketId,
      reason: outcome.reason,
      message: outcome.message,
      next_retry_at: outcome.nextRetryAt.toISOString(),
      available_agent_count: outcome.availableAgentCount,
    });
  } catch (error) {
    if (error instanceof CompanyNotFoundError) {
      return apiErrorResponse(new ApiError("COMPANY_NOT_FOUND", error.message));
    }
    if (error instanceof TicketNotFoundError) {
      return apiErrorResponse(new ApiError("TICKET_NOT_FOUND", error.message));
    }
    if (error instanceof TicketCompanyMismatchError) {
      return apiErrorResponse(
        new ApiError("TICKET_COMPANY_MISMATCH", error.message),
      );
    }
    if (error instanceof TicketTerminalError) {
      return apiErrorResponse(new ApiError("TICKET_TERMINAL", error.message));
    }
    if (error instanceof AssignmentServiceUnavailableError) {
      return apiErrorResponse(
        new ApiError("SERVICE_UNAVAILABLE", error.message),
      );
    }
    throw error;
  }
}
