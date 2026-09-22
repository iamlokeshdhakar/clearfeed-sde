import { DateTime } from "luxon";
import { PENDING_RETRY_INTERVAL_MS } from "@/lib/domain/constants";
import { prisma } from "@/lib/prisma";
import { assignTicket } from "@/lib/services/assignmentService";
import { TicketTerminalError } from "@/lib/services/errors";

export const RETRY_INTERVAL_MS = PENDING_RETRY_INTERVAL_MS;
export const BATCH_LIMIT = 100;

export interface RetrySweepOptions {
  /** Overridable for tests; production sweeps use the real current time. */
  now?: DateTime;
  limit?: number;
  /** Integration tests bypass the due-time filter to exercise a retry without waiting. */
  bypassAgeFilter?: boolean;
}

export interface RetrySweepResult {
  processed: number;
  assigned: number;
  pending: number;
  terminalRemoved: number;
  errored: number;
}

/**
 * Reads up to `limit` due pending rows, oldest `lastAttemptedAt` first, and
 * retries each through the shared assignment service. A row whose retry
 * throws (other than a terminal ticket, whose row `assignTicket` already
 * removed) is backed off behind the next sweep window instead of being left
 * as the oldest due row, so it cannot crowd out later, still-retryable
 * tickets indefinitely.
 */
export async function runRetrySweep(
  options: RetrySweepOptions = {},
): Promise<RetrySweepResult> {
  const now = options.now ?? DateTime.now();
  const limit = options.limit ?? BATCH_LIMIT;
  const sweepDate = now.toJSDate();
  const dueThreshold = new Date(sweepDate.getTime() - RETRY_INTERVAL_MS);

  const rows = await prisma.pendingAssignment.findMany({
    where: options.bypassAgeFilter
      ? {}
      : { lastAttemptedAt: { lte: dueThreshold } },
    orderBy: { lastAttemptedAt: "asc" },
    take: limit,
    include: { ticket: { select: { companyId: true } } },
  });

  const result: RetrySweepResult = {
    processed: 0,
    assigned: 0,
    pending: 0,
    terminalRemoved: 0,
    errored: 0,
  };

  for (const row of rows) {
    result.processed++;
    try {
      const outcome = await assignTicket(
        { companyId: row.ticket.companyId, ticketId: row.ticketId },
        { now },
      );
      if (outcome.status === "assigned") {
        result.assigned++;
      } else {
        result.pending++;
      }
    } catch (error) {
      if (error instanceof TicketTerminalError) {
        result.terminalRemoved++;
        console.log(
          `[retry-worker] ticket ${row.ticketId} is terminal; pending row already removed`,
        );
        continue;
      }
      result.errored++;
      console.error(
        `[retry-worker] retry failed for ticket ${row.ticketId}`,
        error,
      );
      try {
        await prisma.pendingAssignment.update({
          where: { ticketId: row.ticketId },
          data: { lastAttemptedAt: sweepDate, attemptCount: { increment: 1 } },
        });
      } catch (backoffError) {
        // The row may have been resolved concurrently (e.g. a direct API
        // call assigned or replayed it); nothing left to back off.
        console.error(
          `[retry-worker] could not back off ticket ${row.ticketId}`,
          backoffError,
        );
      }
    }
  }

  return result;
}
