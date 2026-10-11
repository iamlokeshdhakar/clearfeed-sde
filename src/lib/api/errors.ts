import { NextResponse } from "next/server";
import type { ZodError } from "zod";

export type ApiErrorCode =
  | "VALIDATION_FAILED"
  | "COMPANY_NOT_FOUND"
  | "TICKET_NOT_FOUND"
  | "AGENT_NOT_FOUND"
  | "WINDOW_NOT_FOUND"
  | "TICKET_COMPANY_MISMATCH"
  | "TICKET_TERMINAL"
  | "SERVICE_UNAVAILABLE";

const STATUS_BY_CODE: Record<ApiErrorCode, number> = {
  VALIDATION_FAILED: 422,
  COMPANY_NOT_FOUND: 404,
  TICKET_NOT_FOUND: 404,
  AGENT_NOT_FOUND: 404,
  WINDOW_NOT_FOUND: 404,
  TICKET_COMPANY_MISMATCH: 422,
  TICKET_TERMINAL: 409,
  SERVICE_UNAVAILABLE: 503,
};

export interface ApiErrorDetail {
  field: string;
  message: string;
}

export class ApiError extends Error {
  code: ApiErrorCode;
  details: ApiErrorDetail[];

  constructor(
    code: ApiErrorCode,
    message: string,
    details: ApiErrorDetail[] = [],
  ) {
    super(message);
    this.code = code;
    this.details = details;
  }
}

export function zodErrorDetails(error: ZodError): ApiErrorDetail[] {
  return error.issues.map((issue) => ({
    field: issue.path.length > 0 ? issue.path.join(".") : "(root)",
    message: issue.message,
  }));
}

export function apiErrorResponse(error: ApiError): NextResponse {
  const status = STATUS_BY_CODE[error.code];
  const headers: Record<string, string> = {};
  if (error.code === "SERVICE_UNAVAILABLE") {
    headers["Retry-After"] = "5";
  }
  return NextResponse.json(
    {
      error: {
        code: error.code,
        message: error.message,
        details: error.details,
      },
    },
    { status, headers },
  );
}
