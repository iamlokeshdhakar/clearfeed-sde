import { NextResponse } from "next/server";
import { ApiError, apiErrorResponse } from "@/lib/api/errors";
import { CompanyNotFoundError } from "@/lib/services/errors";
import { listPendingAssignments } from "@/lib/services/pendingAssignmentService";

interface RouteParams {
  params: Promise<{ companyId: string }>;
}

export async function GET(
  _request: Request,
  { params }: RouteParams,
): Promise<NextResponse> {
  const { companyId } = await params;
  try {
    const pending = await listPendingAssignments(companyId);
    return NextResponse.json({ pending });
  } catch (error) {
    if (error instanceof CompanyNotFoundError) {
      return apiErrorResponse(new ApiError("COMPANY_NOT_FOUND", error.message));
    }
    throw error;
  }
}
