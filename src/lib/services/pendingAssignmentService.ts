import { PENDING_RETRY_INTERVAL_MS } from "@/lib/domain/constants";
import { prisma } from "@/lib/prisma";
import { CompanyNotFoundError } from "@/lib/services/errors";

export interface PendingAssignmentDTO {
  ticket_id: string;
  reason: string;
  first_requested_at: string;
  last_attempted_at: string;
  attempt_count: number;
  next_retry_at: string;
}

export async function listPendingAssignments(
  companyId: string,
): Promise<PendingAssignmentDTO[]> {
  const company = await prisma.company.findUnique({ where: { id: companyId } });
  if (!company) {
    throw new CompanyNotFoundError(companyId);
  }

  const rows = await prisma.pendingAssignment.findMany({
    where: { ticket: { companyId } },
    orderBy: { lastAttemptedAt: "asc" },
  });

  return rows.map((row) => ({
    ticket_id: row.ticketId,
    reason: row.reasonCode,
    first_requested_at: row.firstRequestedAt.toISOString(),
    last_attempted_at: row.lastAttemptedAt.toISOString(),
    attempt_count: row.attemptCount,
    next_retry_at: new Date(
      row.lastAttemptedAt.getTime() + PENDING_RETRY_INTERVAL_MS,
    ).toISOString(),
  }));
}
