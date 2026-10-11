import { DateTime } from "luxon";
import { afterEach, describe, expect, it } from "vitest";
import { withCompanyLock } from "@/lib/concurrency/companyLock";
import { prisma } from "@/lib/prisma";
import { assignTicket } from "@/lib/services/assignmentService";
import {
  AssignmentServiceUnavailableError,
  CompanyNotFoundError,
  TicketCompanyMismatchError,
  TicketNotFoundError,
  TicketTerminalError,
} from "@/lib/services/errors";
import {
  cleanupCompany,
  createAgent,
  createCompany,
  createTicket,
  createWindow,
} from "@/lib/testing/fixtures";

// A Monday, always active for a window spanning the full day in UTC.
const MONDAY_NOON = DateTime.fromObject(
  { weekYear: 2026, weekNumber: 10, weekday: 1 },
  { zone: "UTC" },
).set({ hour: 12, minute: 0 });

const FULL_DAY_WINDOW = {
  dayOfWeek: 1,
  startMinute: 0,
  endMinute: 24 * 60 - 1,
  timezone: "UTC",
};

const companyIds: string[] = [];

async function makeCompany(overrides?: Parameters<typeof createCompany>[0]) {
  const company = await createCompany(overrides);
  companyIds.push(company.id);
  return company;
}

afterEach(async () => {
  while (companyIds.length > 0) {
    const id = companyIds.pop();
    if (id) {
      await cleanupCompany(id);
    }
  }
});

describe("assignTicket", () => {
  it("assigns the only eligible agent and records an explanation", async () => {
    const company = await makeCompany({ maxActiveTicketsPerAgent: 3 });
    const agent = await createAgent(company.id, { name: "Priya" });
    await createWindow(company.id, [agent.id], FULL_DAY_WINDOW);
    const ticket = await createTicket(company.id);

    const outcome = await assignTicket(
      { companyId: company.id, ticketId: ticket.id },
      { now: MONDAY_NOON },
    );

    expect(outcome.status).toBe("assigned");
    if (outcome.status !== "assigned") throw new Error("unreachable");
    expect(outcome.assignee.id).toBe(agent.id);
    expect(outcome.idempotentReplay).toBe(false);
    expect(outcome.explanation.decided_by).toBe("ONLY_ELIGIBLE_AGENT");
    expect(outcome.explanation.selected_agent.name).toBe("Priya");
    expect(outcome.explanation.eligibility.limit).toBe(3);

    const updatedTicket = await prisma.ticket.findUniqueOrThrow({
      where: { id: ticket.id },
    });
    expect(updatedTicket.assigneeId).toBe(agent.id);
  });

  it("replays the same decision on repeated calls without extra writes", async () => {
    const company = await makeCompany();
    const agent = await createAgent(company.id);
    await createWindow(company.id, [agent.id], FULL_DAY_WINDOW);
    const ticket = await createTicket(company.id);

    const first = await assignTicket(
      { companyId: company.id, ticketId: ticket.id },
      { now: MONDAY_NOON },
    );
    const second = await assignTicket(
      { companyId: company.id, ticketId: ticket.id },
      { now: MONDAY_NOON.plus({ hours: 1 }) },
    );

    expect(first.status).toBe("assigned");
    expect(second.status).toBe("assigned");
    if (first.status !== "assigned" || second.status !== "assigned")
      throw new Error("unreachable");
    expect(second.idempotentReplay).toBe(true);
    expect(second.assignedAt.getTime()).toBe(first.assignedAt.getTime());

    const assignments = await prisma.assignment.findMany({
      where: { ticketId: ticket.id },
    });
    expect(assignments).toHaveLength(1);
  });

  it("returns NO_AVAILABLE_AGENT when no agent is available", async () => {
    const company = await makeCompany();
    await createAgent(company.id);
    const ticket = await createTicket(company.id);

    const outcome = await assignTicket(
      { companyId: company.id, ticketId: ticket.id },
      { now: MONDAY_NOON },
    );

    expect(outcome.status).toBe("pending");
    if (outcome.status !== "pending") throw new Error("unreachable");
    expect(outcome.reason).toBe("NO_AVAILABLE_AGENT");
    expect(outcome.availableAgentCount).toBe(0);
  });

  it("returns ALL_AVAILABLE_AGENTS_AT_CAPACITY when available agents are at the limit", async () => {
    const company = await makeCompany({ maxActiveTicketsPerAgent: 1 });
    const agent = await createAgent(company.id);
    await createWindow(company.id, [agent.id], FULL_DAY_WINDOW);
    // Fill the agent to capacity with an existing active ticket.
    await createTicket(company.id, { status: "OPEN", assigneeId: agent.id });
    const ticket = await createTicket(company.id);

    const outcome = await assignTicket(
      { companyId: company.id, ticketId: ticket.id },
      { now: MONDAY_NOON },
    );

    expect(outcome.status).toBe("pending");
    if (outcome.status !== "pending") throw new Error("unreachable");
    expect(outcome.reason).toBe("ALL_AVAILABLE_AGENTS_AT_CAPACITY");
    expect(outcome.availableAgentCount).toBe(1);
  });

  it("treats a zero active-ticket limit as valid config and leaves the ticket pending", async () => {
    const company = await makeCompany({ maxActiveTicketsPerAgent: 0 });
    const agent = await createAgent(company.id);
    await createWindow(company.id, [agent.id], FULL_DAY_WINDOW);
    const ticket = await createTicket(company.id);

    const outcome = await assignTicket(
      { companyId: company.id, ticketId: ticket.id },
      { now: MONDAY_NOON },
    );

    expect(outcome.status).toBe("pending");
    if (outcome.status !== "pending") throw new Error("unreachable");
    // The agent is available but immediately at (0 >= 0) capacity.
    expect(outcome.reason).toBe("ALL_AVAILABLE_AGENTS_AT_CAPACITY");
    expect(outcome.availableAgentCount).toBe(1);
  });

  it("returns NO_AVAILABLE_AGENT for a company with no agents at all", async () => {
    const company = await makeCompany();
    const ticket = await createTicket(company.id);

    const outcome = await assignTicket(
      { companyId: company.id, ticketId: ticket.id },
      { now: MONDAY_NOON },
    );

    expect(outcome.status).toBe("pending");
    if (outcome.status !== "pending") throw new Error("unreachable");
    expect(outcome.reason).toBe("NO_AVAILABLE_AGENT");
    expect(outcome.availableAgentCount).toBe(0);
  });

  it("upserts a single pending row across repeated unsuccessful attempts", async () => {
    const company = await makeCompany();
    await createAgent(company.id);
    const ticket = await createTicket(company.id);

    await assignTicket(
      { companyId: company.id, ticketId: ticket.id },
      { now: MONDAY_NOON },
    );
    await assignTicket(
      { companyId: company.id, ticketId: ticket.id },
      { now: MONDAY_NOON.plus({ minutes: 10 }) },
    );

    const rows = await prisma.pendingAssignment.findMany({
      where: { ticketId: ticket.id },
    });
    expect(rows).toHaveLength(1);
    expect(rows[0].attemptCount).toBe(2);
    expect(rows[0].firstRequestedAt.getTime()).toBe(
      MONDAY_NOON.toJSDate().getTime(),
    );
  });

  it("does not assign to an unsuccessful attempt's ticket, and does not affect workload", async () => {
    const company = await makeCompany();
    await createAgent(company.id);
    const ticket = await createTicket(company.id);

    await assignTicket(
      { companyId: company.id, ticketId: ticket.id },
      { now: MONDAY_NOON },
    );

    const updated = await prisma.ticket.findUniqueOrThrow({
      where: { id: ticket.id },
    });
    expect(updated.assigneeId).toBeNull();
    const assignments = await prisma.assignment.findMany({
      where: { ticketId: ticket.id },
    });
    expect(assignments).toHaveLength(0);
  });

  it("prefers the eligible agent with the fewest active tickets", async () => {
    const company = await makeCompany({ maxActiveTicketsPerAgent: 5 });
    const busy = await createAgent(company.id, { name: "Busy" });
    const free = await createAgent(company.id, { name: "Free" });
    await createWindow(company.id, [busy.id, free.id], FULL_DAY_WINDOW);
    await createTicket(company.id, { assigneeId: busy.id });
    await createTicket(company.id, { assigneeId: busy.id });
    const ticket = await createTicket(company.id);

    const outcome = await assignTicket(
      { companyId: company.id, ticketId: ticket.id },
      { now: MONDAY_NOON },
    );

    expect(outcome.status).toBe("assigned");
    if (outcome.status !== "assigned") throw new Error("unreachable");
    expect(outcome.assignee.id).toBe(free.id);
    expect(outcome.explanation.decided_by).toBe("FEWEST_ACTIVE_TICKETS");
  });

  it("never considers agents from a different company", async () => {
    const companyA = await makeCompany();
    const companyB = await makeCompany();
    await createAgent(companyB.id); // eligible agent, wrong company
    const windowlessAgentA = await createAgent(companyA.id);
    await createWindow(companyB.id, [], FULL_DAY_WINDOW);
    const ticket = await createTicket(companyA.id);
    void windowlessAgentA;

    const outcome = await assignTicket(
      { companyId: companyA.id, ticketId: ticket.id },
      { now: MONDAY_NOON },
    );

    expect(outcome.status).toBe("pending");
    if (outcome.status !== "pending") throw new Error("unreachable");
    expect(outcome.reason).toBe("NO_AVAILABLE_AGENT");
  });

  it("excludes a removed agent even though a stale window membership remains", async () => {
    const company = await makeCompany();
    const removed = await createAgent(company.id, { removedAt: new Date() });
    await createWindow(company.id, [removed.id], FULL_DAY_WINDOW);
    const ticket = await createTicket(company.id);

    const outcome = await assignTicket(
      { companyId: company.id, ticketId: ticket.id },
      { now: MONDAY_NOON },
    );

    expect(outcome.status).toBe("pending");
    if (outcome.status !== "pending") throw new Error("unreachable");
    expect(outcome.reason).toBe("NO_AVAILABLE_AGENT");
  });

  it("throws CompanyNotFoundError for an unknown company", async () => {
    await expect(
      assignTicket(
        { companyId: "does-not-exist", ticketId: "also-missing" },
        { now: MONDAY_NOON },
      ),
    ).rejects.toBeInstanceOf(CompanyNotFoundError);
  });

  it("throws TicketNotFoundError for an unknown ticket", async () => {
    const company = await makeCompany();
    await expect(
      assignTicket(
        { companyId: company.id, ticketId: "does-not-exist" },
        { now: MONDAY_NOON },
      ),
    ).rejects.toBeInstanceOf(TicketNotFoundError);
  });

  it("throws TicketCompanyMismatchError when the ticket belongs to another company", async () => {
    const companyA = await makeCompany();
    const companyB = await makeCompany();
    const ticket = await createTicket(companyB.id);

    await expect(
      assignTicket(
        { companyId: companyA.id, ticketId: ticket.id },
        { now: MONDAY_NOON },
      ),
    ).rejects.toBeInstanceOf(TicketCompanyMismatchError);
  });

  it("throws TicketTerminalError and deletes any pending row for a terminal ticket with no assignment", async () => {
    const company = await makeCompany();
    const ticket = await createTicket(company.id, { status: "RESOLVED" });
    // Simulate a leftover pending row from before the ticket was resolved.
    await prisma.pendingAssignment.create({
      data: { ticketId: ticket.id, reasonCode: "NO_AVAILABLE_AGENT" },
    });

    await expect(
      assignTicket(
        { companyId: company.id, ticketId: ticket.id },
        { now: MONDAY_NOON },
      ),
    ).rejects.toBeInstanceOf(TicketTerminalError);

    const rows = await prisma.pendingAssignment.findMany({
      where: { ticketId: ticket.id },
    });
    expect(rows).toHaveLength(0);
  });

  it("replays a terminal ticket's saved assignment instead of throwing", async () => {
    const company = await makeCompany();
    const agent = await createAgent(company.id);
    await createWindow(company.id, [agent.id], FULL_DAY_WINDOW);
    const ticket = await createTicket(company.id);
    await assignTicket(
      { companyId: company.id, ticketId: ticket.id },
      { now: MONDAY_NOON },
    );
    await prisma.ticket.update({
      where: { id: ticket.id },
      data: { status: "CLOSED" },
    });

    const outcome = await assignTicket(
      { companyId: company.id, ticketId: ticket.id },
      { now: MONDAY_NOON },
    );

    expect(outcome.status).toBe("assigned");
    if (outcome.status !== "assigned") throw new Error("unreachable");
    expect(outcome.idempotentReplay).toBe(true);
  });

  it("serializes concurrent calls for the same ticket into exactly one assignment", async () => {
    const company = await makeCompany();
    const agent = await createAgent(company.id);
    await createWindow(company.id, [agent.id], FULL_DAY_WINDOW);
    const ticket = await createTicket(company.id);

    const outcomes = await Promise.all(
      Array.from({ length: 5 }, () =>
        assignTicket(
          { companyId: company.id, ticketId: ticket.id },
          { now: MONDAY_NOON },
        ),
      ),
    );

    for (const outcome of outcomes) {
      expect(outcome.status).toBe("assigned");
      if (outcome.status !== "assigned") throw new Error("unreachable");
      expect(outcome.assignee.id).toBe(agent.id);
    }
    const assignments = await prisma.assignment.findMany({
      where: { ticketId: ticket.id },
    });
    expect(assignments).toHaveLength(1);
  });

  it("replays the winning decision when two transactions race past the queue (uniqueness backstop)", async () => {
    // The company queue normally prevents this race entirely; bypassing it
    // here is the only way to exercise the defensive uniqueness-conflict
    // backstop described in implementation.md §3.
    const company = await makeCompany();
    const agent = await createAgent(company.id);
    await createWindow(company.id, [agent.id], FULL_DAY_WINDOW);
    const ticket = await createTicket(company.id);

    const [a, b] = await Promise.all([
      assignTicket(
        { companyId: company.id, ticketId: ticket.id },
        { now: MONDAY_NOON, bypassQueueForTest: true, simulateDelayMs: 100 },
      ),
      assignTicket(
        { companyId: company.id, ticketId: ticket.id },
        { now: MONDAY_NOON, bypassQueueForTest: true, simulateDelayMs: 100 },
      ),
    ]);

    expect(a.status).toBe("assigned");
    expect(b.status).toBe("assigned");
    if (a.status !== "assigned" || b.status !== "assigned")
      throw new Error("unreachable");
    expect(a.assignee.id).toBe(b.assignee.id);
    expect(a.assignedAt.getTime()).toBe(b.assignedAt.getTime());

    const assignments = await prisma.assignment.findMany({
      where: { ticketId: ticket.id },
    });
    expect(assignments).toHaveLength(1);
  });

  it("counts an agent with two overlapping active windows as a single candidate", async () => {
    const company = await makeCompany({ maxActiveTicketsPerAgent: 5 });
    const agent = await createAgent(company.id);
    await createWindow(company.id, [agent.id], {
      dayOfWeek: 1,
      startMinute: 0,
      endMinute: 18 * 60,
      timezone: "UTC",
    });
    await createWindow(company.id, [agent.id], {
      dayOfWeek: 1,
      startMinute: 6 * 60,
      endMinute: 24 * 60 - 1,
      timezone: "UTC",
    });
    const ticket = await createTicket(company.id);

    const outcome = await assignTicket(
      { companyId: company.id, ticketId: ticket.id },
      { now: MONDAY_NOON },
    );

    expect(outcome.status).toBe("assigned");
    if (outcome.status !== "assigned") throw new Error("unreachable");
    // Only one candidate despite two active windows for the same agent.
    expect(outcome.explanation.decided_by).toBe("ONLY_ELIGIBLE_AGENT");
  });

  it("does not exceed shared capacity when different tickets compete for one remaining slot", async () => {
    const company = await makeCompany({ maxActiveTicketsPerAgent: 1 });
    const agent = await createAgent(company.id);
    await createWindow(company.id, [agent.id], FULL_DAY_WINDOW);
    const ticketA = await createTicket(company.id);
    const ticketB = await createTicket(company.id);

    const [outcomeA, outcomeB] = await Promise.all([
      assignTicket(
        { companyId: company.id, ticketId: ticketA.id },
        { now: MONDAY_NOON },
      ),
      assignTicket(
        { companyId: company.id, ticketId: ticketB.id },
        { now: MONDAY_NOON },
      ),
    ]);

    const statuses = [outcomeA.status, outcomeB.status].sort();
    expect(statuses).toEqual(["assigned", "pending"]);

    const activeAssignedCount = await prisma.ticket.count({
      where: { companyId: company.id, assigneeId: agent.id },
    });
    expect(activeAssignedCount).toBe(1);
  });

  it("times out past the 2-second queue wait without starting work, while a later caller still waits for the real holder", async () => {
    const company = await makeCompany();
    const agent = await createAgent(company.id);
    await createWindow(company.id, [agent.id], FULL_DAY_WINDOW);
    const timedOutTicket = await createTicket(company.id);
    const laterTicket = await createTicket(company.id);

    const holdMs = 2200;
    const holderStart = Date.now();
    const holder = withCompanyLock(
      company.id,
      () => new Promise((resolve) => setTimeout(resolve, holdMs)),
    );

    const timedOutStart = Date.now();
    await expect(
      assignTicket(
        { companyId: company.id, ticketId: timedOutTicket.id },
        { now: MONDAY_NOON },
      ),
    ).rejects.toBeInstanceOf(AssignmentServiceUnavailableError);
    const timedOutElapsed = Date.now() - timedOutStart;
    expect(timedOutElapsed).toBeGreaterThanOrEqual(1990);
    expect(timedOutElapsed).toBeLessThan(holdMs);

    const stillUnassigned = await prisma.ticket.findUniqueOrThrow({
      where: { id: timedOutTicket.id },
    });
    expect(stillUnassigned.assigneeId).toBeNull();

    const laterOutcome = await assignTicket(
      { companyId: company.id, ticketId: laterTicket.id },
      { now: MONDAY_NOON },
    );
    const laterElapsed = Date.now() - holderStart;
    expect(laterElapsed).toBeGreaterThanOrEqual(holdMs);
    expect(laterOutcome.status).toBe("assigned");

    await holder;
  }, 10000);

  it("rolls back all writes and returns 503 when the transaction exceeds its execution budget", async () => {
    const company = await makeCompany();
    const agent = await createAgent(company.id);
    await createWindow(company.id, [agent.id], FULL_DAY_WINDOW);
    const ticket = await createTicket(company.id);

    await expect(
      assignTicket(
        { companyId: company.id, ticketId: ticket.id },
        { now: MONDAY_NOON, transactionTimeoutMs: 100, simulateDelayMs: 300 },
      ),
    ).rejects.toBeInstanceOf(AssignmentServiceUnavailableError);

    // Nothing from the aborted transaction should have persisted.
    const updated = await prisma.ticket.findUniqueOrThrow({
      where: { id: ticket.id },
    });
    expect(updated.assigneeId).toBeNull();
    const assignments = await prisma.assignment.findMany({
      where: { ticketId: ticket.id },
    });
    expect(assignments).toHaveLength(0);
    const pending = await prisma.pendingAssignment.findMany({
      where: { ticketId: ticket.id },
    });
    expect(pending).toHaveLength(0);

    // The company lock must still be released so a later call proceeds normally.
    const outcome = await assignTicket(
      { companyId: company.id, ticketId: ticket.id },
      { now: MONDAY_NOON },
    );
    expect(outcome.status).toBe("assigned");
  });

  it("rolls back a partially-written pending upsert when the transaction times out mid-evaluation", async () => {
    const company = await makeCompany();
    await createAgent(company.id); // no window: evaluation reaches the pending-upsert branch
    const ticket = await createTicket(company.id);

    await expect(
      assignTicket(
        { companyId: company.id, ticketId: ticket.id },
        { now: MONDAY_NOON, transactionTimeoutMs: 50, simulateDelayMs: 300 },
      ),
    ).rejects.toBeInstanceOf(AssignmentServiceUnavailableError);

    const pending = await prisma.pendingAssignment.findMany({
      where: { ticketId: ticket.id },
    });
    expect(pending).toHaveLength(0);
  });
});
