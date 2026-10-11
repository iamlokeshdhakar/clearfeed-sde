import { NextResponse } from "next/server";
import { ApiError, apiErrorResponse, zodErrorDetails } from "@/lib/api/errors";
import {
  deleteAvailabilityWindow,
  updateAvailabilityWindow,
} from "@/lib/services/availabilityService";
import {
  InvalidAgentReferenceError,
  WindowNotFoundError,
} from "@/lib/services/errors";
import { updateAvailabilityWindowSchema } from "@/lib/validation/availability";

interface RouteParams {
  params: Promise<{ windowId: string }>;
}

export async function PATCH(
  request: Request,
  { params }: RouteParams,
): Promise<NextResponse> {
  const { windowId } = await params;

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return apiErrorResponse(
      new ApiError("VALIDATION_FAILED", "Request body must be valid JSON"),
    );
  }

  const parsed = updateAvailabilityWindowSchema.safeParse(body);
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
    const window = await updateAvailabilityWindow(windowId, parsed.data);
    return NextResponse.json({ window });
  } catch (error) {
    if (error instanceof WindowNotFoundError) {
      return apiErrorResponse(new ApiError("WINDOW_NOT_FOUND", error.message));
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

export async function DELETE(
  _request: Request,
  { params }: RouteParams,
): Promise<NextResponse> {
  const { windowId } = await params;
  try {
    await deleteAvailabilityWindow(windowId);
    return new NextResponse(null, { status: 204 });
  } catch (error) {
    if (error instanceof WindowNotFoundError) {
      return apiErrorResponse(new ApiError("WINDOW_NOT_FOUND", error.message));
    }
    throw error;
  }
}
