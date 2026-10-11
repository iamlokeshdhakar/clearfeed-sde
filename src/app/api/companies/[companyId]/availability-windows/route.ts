import { NextResponse } from "next/server";
import { ApiError, apiErrorResponse, zodErrorDetails } from "@/lib/api/errors";
import {
  createAvailabilityWindows,
  listAvailabilityWindows,
} from "@/lib/services/availabilityService";
import {
  CompanyNotFoundError,
  InvalidAgentReferenceError,
} from "@/lib/services/errors";
import { createAvailabilityWindowSchema } from "@/lib/validation/availability";

interface RouteParams {
  params: Promise<{ companyId: string }>;
}

export async function GET(
  _request: Request,
  { params }: RouteParams,
): Promise<NextResponse> {
  const { companyId } = await params;
  try {
    const windows = await listAvailabilityWindows(companyId);
    return NextResponse.json({ windows });
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

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return apiErrorResponse(
      new ApiError("VALIDATION_FAILED", "Request body must be valid JSON"),
    );
  }

  const parsed = createAvailabilityWindowSchema.safeParse(body);
  if (!parsed.success) {
    return apiErrorResponse(
      new ApiError(
        "VALIDATION_FAILED",
        "Invalid availability window",
        zodErrorDetails(parsed.error),
      ),
    );
  }

  try {
    const windows = await createAvailabilityWindows(companyId, parsed.data);
    return NextResponse.json({ windows }, { status: 201 });
  } catch (error) {
    if (error instanceof CompanyNotFoundError) {
      return apiErrorResponse(new ApiError("COMPANY_NOT_FOUND", error.message));
    }
    if (error instanceof InvalidAgentReferenceError) {
      return apiErrorResponse(
        new ApiError("VALIDATION_FAILED", error.message, [
          {
            field: "agent_ids",
            message: "must belong to this company and be non-removed",
          },
        ]),
      );
    }
    throw error;
  }
}
