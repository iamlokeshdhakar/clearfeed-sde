import { NextResponse } from "next/server";
import { ApiError, apiErrorResponse, zodErrorDetails } from "@/lib/api/errors";
import { getCoverage } from "@/lib/services/coverageService";
import { CompanyNotFoundError } from "@/lib/services/errors";
import { coverageQuerySchema } from "@/lib/validation/coverage";

interface RouteParams {
  params: Promise<{ companyId: string }>;
}

export async function GET(
  request: Request,
  { params }: RouteParams,
): Promise<NextResponse> {
  const { companyId } = await params;
  const url = new URL(request.url);
  const weekStart = url.searchParams.get("week_start") ?? undefined;

  const parsed = coverageQuerySchema.safeParse({ week_start: weekStart });
  if (!parsed.success) {
    return apiErrorResponse(
      new ApiError(
        "VALIDATION_FAILED",
        "Invalid coverage query",
        zodErrorDetails(parsed.error),
      ),
    );
  }

  try {
    const coverage = await getCoverage(companyId, parsed.data.week_start);
    return NextResponse.json(coverage);
  } catch (error) {
    if (error instanceof CompanyNotFoundError) {
      return apiErrorResponse(new ApiError("COMPANY_NOT_FOUND", error.message));
    }
    throw error;
  }
}
