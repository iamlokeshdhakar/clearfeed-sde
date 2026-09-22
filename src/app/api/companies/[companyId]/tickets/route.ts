import { NextResponse } from "next/server";
import { ApiError, apiErrorResponse } from "@/lib/api/errors";
import { assignTicket } from "@/lib/services/assignmentService";
import { CompanyNotFoundError } from "@/lib/services/errors";
import {
  createTicket,
  deleteTicket,
  listTickets,
} from "@/lib/services/ticketService";

interface RouteParams {
  params: Promise<{ companyId: string }>;
}

export async function GET(
  _request: Request,
  { params }: RouteParams,
): Promise<NextResponse> {
  const { companyId } = await params;
  try {
    const tickets = await listTickets(companyId);
    return NextResponse.json({ tickets });
  } catch (error) {
    if (error instanceof CompanyNotFoundError) {
      return apiErrorResponse(new ApiError("COMPANY_NOT_FOUND", error.message));
    }
    throw error;
  }
}

export async function POST(
  request: Request,
  { params }: RouteParams,
): Promise<NextResponse> {
  const { companyId } = await params;
  let body: {
    custom_id?: string;
    status?: "OPEN" | "IN_PROGRESS" | "WAITING" | "RESOLVED" | "CLOSED";
    assign_immediately?: boolean;
  } = {};

  try {
    body = await request.json();
  } catch {
    // optional body
  }

  try {
    const ticket = await createTicket({
      companyId,
      customId: body.custom_id,
      status: body.status,
    });

    let assignmentOutcome = null;
    if (body.assign_immediately) {
      assignmentOutcome = await assignTicket({
        companyId,
        ticketId: ticket.id,
      });
    }

    return NextResponse.json({
      ticket,
      assignment_outcome: assignmentOutcome,
    });
  } catch (error) {
    if (error instanceof CompanyNotFoundError) {
      return apiErrorResponse(new ApiError("COMPANY_NOT_FOUND", error.message));
    }
    throw error;
  }
}

export async function DELETE(
  request: Request,
  { params }: RouteParams,
): Promise<NextResponse> {
  const { companyId } = await params;
  const url = new URL(request.url);
  const ticketId = url.searchParams.get("ticketId");

  if (!ticketId) {
    return apiErrorResponse(
      new ApiError("VALIDATION_FAILED", "ticketId query parameter is required"),
    );
  }

  try {
    await deleteTicket(companyId, ticketId);
    return NextResponse.json({ success: true, ticketId });
  } catch (error) {
    if (error instanceof CompanyNotFoundError) {
      return apiErrorResponse(new ApiError("COMPANY_NOT_FOUND", error.message));
    }
    throw error;
  }
}
