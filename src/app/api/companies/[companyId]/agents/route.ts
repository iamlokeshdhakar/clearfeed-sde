import { NextResponse } from "next/server";
import { ApiError, apiErrorResponse } from "@/lib/api/errors";
import { listAgents } from "@/lib/services/agentService";
import { CompanyNotFoundError } from "@/lib/services/errors";

interface RouteParams {
  params: Promise<{ companyId: string }>;
}

export async function GET(
  _request: Request,
  { params }: RouteParams,
): Promise<NextResponse> {
  const { companyId } = await params;
  try {
    const agents = await listAgents(companyId);
    return NextResponse.json({ agents });
  } catch (error) {
    if (error instanceof CompanyNotFoundError) {
      return apiErrorResponse(new ApiError("COMPANY_NOT_FOUND", error.message));
    }
    throw error;
  }
}
