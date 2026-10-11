import { Prisma } from "@prisma/client";
import { DateTime } from "luxon";
import { withCompanyLock } from "@/lib/concurrency/companyLock";
import {
  findActiveWindow,
  isAnyWindowActiveAt,
  type WindowSpec,
} from "@/lib/domain/availability";
import { PENDING_RETRY_INTERVAL_MS } from "@/lib/domain/constants";
import type { AssignmentExplanation } from "@/lib/domain/explanation";
import { type CandidateAgent, selectCandidate } from "@/lib/domain/fairness";
import {
  ACTIVE_TICKET_STATUSES,
  isTerminalStatus,
} from "@/lib/domain/ticketStatus";
import { minutesToTimeString } from "@/lib/domain/time";
import { prisma } from "@/lib/prisma";
import {
  AssignmentServiceUnavailableError,
  CompanyNotFoundError,
  TicketCompanyMismatchError,
  TicketNotFoundError,
  TicketTerminalError,
} from "@/lib/services/errors";

const TRANSACTION_TIMEOUT_MS = 5000;

export interface AssignTicketInput {
  companyId: string;
  ticketId: string;
}

export interface AssignedOutcome {
  status: "assigned";
  ticketId: string;
  assignee: { id: string; name: string; email: string };
  assignedAt: Date;
  idempotentReplay: boolean;
  explanation: AssignmentExplanation;
}

export type PendingReason =
  | "NO_AVAILABLE_AGENT"
  | "ALL_AVAILABLE_AGENTS_AT_CAPACITY";

export interface PendingOutcome {
  status: "pending";
  ticketId: string;
  reason: PendingReason;
  message: string;
  nextRetryAt: Date;
  availableAgentCount: number;
}

export type AssignmentOutcome = AssignedOutcome | PendingOutcome;

type Tx = Prisma.TransactionClient;

export interface AssignTicketOptions {
  /** Overridable for tests; production callers keep the real current time. */
  now?: DateTime;
  /** Test-only: overrides the transaction's execution budget (production default 5000ms). */
  transactionTimeoutMs?: number;
  /** Test-only: injects a delay inside the transaction to force it past its budget. */
  simulateDelayMs?: number;
  /**
   * Test-only: skips the company queue so concurrent callers race past each
   * other, to exercise the assignment-uniqueness backstop (implementation.md
   * §3). Production callers always go through the queue.
   */
  bypassQueueForTest?: boolean;
}

export async function assignTicket(
  input: AssignTicketInput,
  options: AssignTicketOptions = {},
): Promise<AssignmentOutcome> {
  if (options.bypassQueueForTest) {
    return runAssignment(input, options);
  }
  try {
    return await withCompanyLock(input.companyId, () =>
      runAssignment(input, options),
    );
  } catch (error) {
    if (error instanceof Error && error.name === "CompanyLockTimeoutError") {
      throw new AssignmentServiceUnavailableError(
        `Timed out waiting for the company queue: ${input.companyId}`,
      );
    }
    throw error;
  }
}

async function runAssignment(
  input: AssignTicketInput,
  options: AssignTicketOptions,
): Promise<AssignmentOutcome> {
  const decisionTime = options.now ?? DateTime.now();
  const transactionTimeoutMs =
    options.transactionTimeoutMs ?? TRANSACTION_TIMEOUT_MS;
  try {
    const result = await prisma.$transaction(
      async (tx) => {
        if (options.simulateDelayMs) {
          await new Promise((resolve) =>
            setTimeout(resolve, options.simulateDelayMs),
          );
        }
        return evaluateAndWrite(tx, input, decisionTime);
      },
      { timeout: transactionTimeoutMs, maxWait: transactionTimeoutMs },
    );
    if (result.kind === "terminal") {
      // Thrown after the transaction committed, so the pending-row cleanup
      // evaluateAndWrite already performed is preserved rather than rolled back.
      throw new TicketTerminalError(input.ticketId);
    }
    return result.outcome;
  } catch (error) {
    if (isUniqueConstraintViolation(error)) {
      const replay = await replayExisting(input.ticketId);
      if (replay) {
        return replay;
      }
    }
    if (isTransactionTimeout(error)) {
      throw new AssignmentServiceUnavailableError(
        `Transaction exceeded its execution budget for ticket ${input.ticketId}`,
      );
    }
    throw error;
  }
}

type EvaluationResult =
  | { kind: "outcome"; outcome: AssignmentOutcome }
  | { kind: "terminal" };

async function evaluateAndWrite(
  tx: Tx,
  { companyId, ticketId }: AssignTicketInput,
  now: DateTime,
): Promise<EvaluationResult> {
  const existing = await tx.ticket.findFirst({
    where: { id: ticketId, companyId },
    include: { assignment: { include: { agent: true } } },
  });

  if (existing?.assignment) {
    await tx.pendingAssignment.deleteMany({ where: { ticketId } });
    return {
      kind: "outcome",
      outcome: toAssignedOutcome(existing.assignment, true),
    };
  }

  if (!existing) {
    const company = await tx.company.findUnique({ where: { id: companyId } });
    if (!company) {
      throw new CompanyNotFoundError(companyId);
    }
    const ticket = await tx.ticket.findUnique({ where: { id: ticketId } });
    if (!ticket) {
      throw new TicketNotFoundError(ticketId);
    }
    throw new TicketCompanyMismatchError(ticketId, companyId);
  }

  const company = await tx.company.findUniqueOrThrow({
    where: { id: companyId },
  });

  if (isTerminalStatus(existing.status)) {
    await tx.pendingAssignment.deleteMany({ where: { ticketId } });
    return { kind: "terminal" };
  }

  const agents = await tx.agent.findMany({
    where: { companyId, removedAt: null },
    include: { windowMemberships: { include: { window: true } } },
  });

  const activeCounts = await tx.ticket.groupBy({
    by: ["assigneeId"],
    where: {
      companyId,
      status: { in: ACTIVE_TICKET_STATUSES },
      assigneeId: { not: null },
    },
    _count: { _all: true },
  });
  const activeCountByAgent = new Map(
    activeCounts.map((row) => [row.assigneeId as string, row._count._all]),
  );

  const lastAssigned = await tx.assignment.groupBy({
    by: ["agentId"],
    where: { agent: { companyId } },
    _max: { assignedAt: true },
  });
  const lastAssignedByAgent = new Map(
    lastAssigned.map((row) => [row.agentId, row._max.assignedAt]),
  );

  const windowsByAgent = new Map<string, WindowSpec[]>();
  for (const agent of agents) {
    windowsByAgent.set(
      agent.id,
      agent.windowMemberships.map((membership) => ({
        id: membership.window.id,
        dayOfWeek: membership.window.dayOfWeek,
        startMinute: membership.window.startMinute,
        endMinute: membership.window.endMinute,
        timezone: membership.window.timezone,
      })),
    );
  }

  let availableAgentCount = 0;
  const candidates: CandidateAgent[] = [];
  for (const agent of agents) {
    const windows = windowsByAgent.get(agent.id) ?? [];
    if (!isAnyWindowActiveAt(windows, now)) {
      continue;
    }
    availableAgentCount++;
    const activeCount = activeCountByAgent.get(agent.id) ?? 0;
    if (activeCount >= company.maxActiveTicketsPerAgent) {
      continue;
    }
    candidates.push({
      id: agent.id,
      activeCount,
      lastAssignedAt: lastAssignedByAgent.get(agent.id) ?? null,
    });
  }

  const selection = selectCandidate(candidates);
  const decisionDate = now.toJSDate();

  if (!selection) {
    const reason: PendingReason =
      availableAgentCount === 0
        ? "NO_AVAILABLE_AGENT"
        : "ALL_AVAILABLE_AGENTS_AT_CAPACITY";
    const pending = await tx.pendingAssignment.upsert({
      where: { ticketId },
      create: {
        ticketId,
        reasonCode: reason,
        firstRequestedAt: decisionDate,
        lastAttemptedAt: decisionDate,
        attemptCount: 1,
      },
      update: {
        reasonCode: reason,
        lastAttemptedAt: decisionDate,
        attemptCount: { increment: 1 },
      },
    });
    return {
      kind: "outcome",
      outcome: {
        status: "pending",
        ticketId,
        reason,
        message:
          reason === "NO_AVAILABLE_AGENT"
            ? "No agents are currently available."
            : `${availableAgentCount} agent${availableAgentCount === 1 ? " is" : "s are"} available, all at the ${company.maxActiveTicketsPerAgent}-ticket limit.`,
        nextRetryAt: new Date(
          pending.lastAttemptedAt.getTime() + PENDING_RETRY_INTERVAL_MS,
        ),
        availableAgentCount,
      },
    };
  }

  const winnerAgent = agents.find((agent) => agent.id === selection.winner.id);
  if (!winnerAgent) {
    throw new Error(
      `Selected agent ${selection.winner.id} vanished from the candidate set`,
    );
  }
  const winnerWindows = windowsByAgent.get(winnerAgent.id) ?? [];
  const activeWindow = findActiveWindow(winnerWindows, now);
  if (!activeWindow) {
    throw new Error(
      `Selected agent ${winnerAgent.id} has no active window at decision time`,
    );
  }

  const explanation: AssignmentExplanation = {
    selected_agent: { id: winnerAgent.id, name: winnerAgent.name },
    eligibility: {
      window: {
        id: activeWindow.id,
        day: activeWindow.dayOfWeek,
        local: `${minutesToTimeString(activeWindow.startMinute)}-${minutesToTimeString(activeWindow.endMinute)}`,
        timezone: activeWindow.timezone,
      },
      active_tickets: selection.winner.activeCount,
      limit: company.maxActiveTicketsPerAgent,
    },
    decided_by: selection.decidedBy,
  };

  await tx.ticket.update({
    where: { id: ticketId },
    data: { assigneeId: winnerAgent.id, assignedAt: decisionDate },
  });
  const assignment = await tx.assignment.create({
    data: {
      ticketId,
      agentId: winnerAgent.id,
      assignedAt: decisionDate,
      explanation: explanation as unknown as Prisma.InputJsonValue,
    },
    include: { agent: true },
  });
  await tx.pendingAssignment.deleteMany({ where: { ticketId } });

  return { kind: "outcome", outcome: toAssignedOutcome(assignment, false) };
}

async function replayExisting(
  ticketId: string,
): Promise<AssignedOutcome | null> {
  const assignment = await prisma.assignment.findUnique({
    where: { ticketId },
    include: { agent: true },
  });
  if (!assignment) {
    return null;
  }
  await prisma.pendingAssignment.deleteMany({ where: { ticketId } });
  return toAssignedOutcome(assignment, true);
}

function toAssignedOutcome(
  assignment: {
    ticketId: string;
    assignedAt: Date;
    explanation: Prisma.JsonValue;
    agent: { id: string; name: string; email: string };
  },
  idempotentReplay: boolean,
): AssignedOutcome {
  return {
    status: "assigned",
    ticketId: assignment.ticketId,
    assignee: {
      id: assignment.agent.id,
      name: assignment.agent.name,
      email: assignment.agent.email,
    },
    assignedAt: assignment.assignedAt,
    idempotentReplay,
    explanation: assignment.explanation as unknown as AssignmentExplanation,
  };
}

function isUniqueConstraintViolation(error: unknown): boolean {
  return (
    error instanceof Prisma.PrismaClientKnownRequestError &&
    error.code === "P2002"
  );
}

function isTransactionTimeout(error: unknown): boolean {
  return (
    error instanceof Prisma.PrismaClientKnownRequestError &&
    (error.code === "P2028" || /timed? ?out/i.test(error.message))
  );
}
