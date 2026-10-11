import { DateTime } from "luxon";
import { PENDING_RETRY_INTERVAL_MS } from "@/lib/domain/constants";
import { prisma } from "@/lib/prisma";
import { assignTicket } from "@/lib/services/assignmentService";
import { TicketTerminalError } from "@/lib/services/errors";

export const RETRY_INTERVAL_MS = PENDING_RETRY_INTERVAL_MS;
export const BATCH_LIMIT = 100;

export interface RetrySweepOptions {
  /**
   * The sweep clock: used only for due-row selection (`lastAttemptedAt`
   * threshold) and for stamping backoff on a failed row. Overridable for
   * tests; production sweeps use the real current time.
   *
   * This is deliberately NOT forwarded to `assignTicket` — see
   * `decisionNowForTest` below for why.
   */
  now?: DateTime;
  limit?: number;
  /** Integration tests bypass the due-time filter to exercise a retry without waiting. */
  bypassAgeFilter?: boolean;
  /**
   * Test-only: overrides the decision time `assignTicket` uses for each row,
   * called fresh per row. Production sweeps never set this, so each
   * `assignTicket` call captures the real current time after acquiring that
   * row's company lock, as it normally does.
   *
   * A batch can process up to `limit` rows sequentially, and a row may wait
   * on a company lock, so a later row can be evaluated well after the sweep
   * started. Stamping every row with the sweep-start time (as this used to
   * do) could assign an agent who is actually off-shift by then, or skip one
   * who has just come on shift. Tests that need a fixed clock for a
   * single-row sweep can pass a constant function; tests that need to
   * simulate a shift boundary crossing mid-batch can advance the returned
   * time on each call.
   */
  decisionNowForTest?: () => DateTime;
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
 *
 * `now` (the sweep clock) only drives due-row selection and backoff
 * bookkeeping. Each row's actual assignment decision is made with its own
 * fresh `assignTicket` call, captured after that row acquires its company
 * lock — not with the sweep-start time — since rows later in a large batch
 * can be evaluated well after the sweep began.
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
        options.decisionNowForTest ? { now: options.decisionNowForTest() } : {},
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
