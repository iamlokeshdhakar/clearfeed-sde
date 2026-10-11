export interface ApiErrorDetail {
  field: string;
  message: string;
}

export class ApiClientError extends Error {
  status: number;
  code: string;
  details: ApiErrorDetail[];

  constructor(
    status: number,
    code: string,
    message: string,
    details: ApiErrorDetail[],
  ) {
    super(message);
    this.status = status;
    this.code = code;
    this.details = details;
  }
}

interface ErrorBody {
  error?: { code?: string; message?: string; details?: ApiErrorDetail[] };
}

export async function apiRequest<T>(
  input: string,
  init?: RequestInit,
): Promise<T> {
  const response = await fetch(input, init);

  if (!response.ok) {
    let body: ErrorBody = {};
    try {
      body = await response.json();
    } catch {
      // Non-JSON error body; fall back to the status text below.
    }
    throw new ApiClientError(
      response.status,
      body.error?.code ?? "UNKNOWN_ERROR",
      body.error?.message ?? response.statusText,
      body.error?.details ?? [],
    );
  }

  if (response.status === 204) {
    return undefined as T;
  }
  return response.json();
}
