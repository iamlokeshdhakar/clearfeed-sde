import { DateTime } from "luxon";
import { afterEach, describe, expect, it } from "vitest";
import { withCompanyLock } from "@/lib/concurrency/companyLock";
import { prisma } from "@/lib/prisma";
import { runRetrySweep } from "@/lib/retry/batchProcessor";
import { assignTicket } from "@/lib/services/assignmentService";
import {
  cleanupCompany,
  createAgent,
  createCompany,
  createTicket,
  createWindow,
} from "@/lib/testing/fixtures";

const FULL_DAY_WINDOW = {
  dayOfWeek: 1,
  startMinute: 0,
  endMinute: 24 * 60 - 1,
  timezone: "UTC",
};
const MONDAY_NOON = DateTime.fromObject(
  { weekYear: 2026, weekNumber: 10, weekday: 1 },
  { zone: "UTC" },
).set({ hour: 12, minute: 0 });

const companyIds: string[] = [];

async function makeCompany(overrides?: Parameters<typeof createCompany>[0]) {
  const company = await createCompany(overrides);
  companyIds.push(company.id);
  return company;
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function createPendingRow(
  ticketId: string,
  overrides: Partial<{
    firstRequestedAt: Date;
    lastAttemptedAt: Date;
    attemptCount: number;
  }> = {},
) {
  const now = new Date();
  return prisma.pendingAssignment.create({
    data: {
      ticketId,
      reasonCode: "NO_AVAILABLE_AGENT",
      firstRequestedAt: overrides.firstRequestedAt ?? now,
      lastAttemptedAt: overrides.lastAttemptedAt ?? now,
      attemptCount: overrides.attemptCount ?? 1,
    },
  });
}

afterEach(async () => {
  while (companyIds.length > 0) {
    const id = companyIds.pop();
    if (id) {
      await cleanupCompany(id);
    }
  }
});

describe("runRetrySweep", () => {
  it("only processes rows due by the 5-minute threshold, unless bypassed", async () => {
    const company = await makeCompany();
    const agent = await createAgent(company.id);
    await createWindow(company.id, [agent.id], FULL_DAY_WINDOW);
    const ticket = await createTicket(company.id);
    await createPendingRow(ticket.id, { lastAttemptedAt: new Date() });

    const notYetDue = await runRetrySweep({ now: MONDAY_NOON });
    expect(notYetDue.processed).toBe(0);

    const bypassed = await runRetrySweep({
      now: MONDAY_NOON,
      bypassAgeFilter: true,
      decisionNowForTest: () => MONDAY_NOON,
    });
    expect(bypassed.processed).toBe(1);
    expect(bypassed.assigned).toBe(1);
  });

  it("assigns a ticket that has become eligible since it was last attempted", async () => {
    const company = await makeCompany();
    const agent = await createAgent(company.id);
    await createWindow(company.id, [agent.id], FULL_DAY_WINDOW);
    const ticket = await createTicket(company.id);
    const old = new Date(MONDAY_NOON.minus({ minutes: 10 }).toJSDate());
    await createPendingRow(ticket.id, {
      firstRequestedAt: old,
      lastAttemptedAt: old,
      attemptCount: 3,
    });

    const result = await runRetrySweep({
      now: MONDAY_NOON,
      decisionNowForTest: () => MONDAY_NOON,
    });
    expect(result.assigned).toBe(1);

    const updatedTicket = await prisma.ticket.findUniqueOrThrow({
      where: { id: ticket.id },
    });
    expect(updatedTicket.assigneeId).toBe(agent.id);
    const rows = await prisma.pendingAssignment.findMany({
      where: { ticketId: ticket.id },
    });
    expect(rows).toHaveLength(0);
  });

  it("replays an already-assigned ticket found mid-sweep and removes its leftover pending row", async () => {
    const company = await makeCompany();
    const agent = await createAgent(company.id);
    await createWindow(company.id, [agent.id], FULL_DAY_WINDOW);
    const ticket = await createTicket(company.id);
    await assignTicket(
      { companyId: company.id, ticketId: ticket.id },
      { now: MONDAY_NOON },
    );

    // A leftover pending row for a ticket that already has a saved
    // decision (e.g. from a race before the assignment committed).
    const old = new Date(MONDAY_NOON.minus({ minutes: 10 }).toJSDate());
    await createPendingRow(ticket.id, {
      firstRequestedAt: old,
      lastAttemptedAt: old,
    });

    const result = await runRetrySweep({ now: MONDAY_NOON });
    expect(result.assigned).toBe(1);

    const assignments = await prisma.assignment.findMany({
      where: { ticketId: ticket.id },
    });
    expect(assignments).toHaveLength(1);
    const rows = await prisma.pendingAssignment.findMany({
      where: { ticketId: ticket.id },
    });
    expect(rows).toHaveLength(0);
  });

  it("deletes a terminal ticket's pending row and never reselects it", async () => {
    const company = await makeCompany();
    const ticket = await createTicket(company.id, { status: "RESOLVED" });
    await createPendingRow(ticket.id);

    const first = await runRetrySweep({ bypassAgeFilter: true });
    expect(first.terminalRemoved).toBe(1);

    const rows = await prisma.pendingAssignment.findMany({
      where: { ticketId: ticket.id },
    });
    expect(rows).toHaveLength(0);

    const second = await runRetrySweep({ bypassAgeFilter: true });
    expect(second.processed).toBe(0);
  });

  it("backs off a row whose retry throws a non-terminal error instead of leaving it as the oldest due row", async () => {
    const company = await makeCompany();
    const ticket = await createTicket(company.id);
    const old = new Date(Date.now() - 60 * 60 * 1000);
    await createPendingRow(ticket.id, {
      firstRequestedAt: old,
      lastAttemptedAt: old,
      attemptCount: 1,
    });

    const holder = withCompanyLock(company.id, () => delay(2500));

    const result = await runRetrySweep({ bypassAgeFilter: true });
    expect(result.errored).toBe(1);

    const row = await prisma.pendingAssignment.findUniqueOrThrow({
      where: { ticketId: ticket.id },
    });
    expect(row.attemptCount).toBe(2);
    expect(row.firstRequestedAt.getTime()).toBe(old.getTime());
    expect(row.lastAttemptedAt.getTime()).toBeGreaterThan(old.getTime());

    await holder;
  });

  it("assigns a genuinely eligible ticket within a bounded number of sweeps despite poison rows crowding a small batch", async () => {
    const terminalCompany = await makeCompany();
    const poisonCompany = await makeCompany();
    const eligibleCompany = await makeCompany();
    const agent = await createAgent(eligibleCompany.id);
    await createWindow(eligibleCompany.id, [agent.id], FULL_DAY_WINDOW);

    const oldest = new Date(Date.now() - 60 * 60 * 1000);
    const older = new Date(oldest.getTime() + 1000);
    const newest = new Date(older.getTime() + 1000);

    const terminal1 = await createTicket(terminalCompany.id, {
      status: "RESOLVED",
    });
    const terminal2 = await createTicket(terminalCompany.id, {
      status: "RESOLVED",
    });
    await createPendingRow(terminal1.id, { lastAttemptedAt: oldest });
    await createPendingRow(terminal2.id, { lastAttemptedAt: oldest });

    const errorTicket = await createTicket(poisonCompany.id);
    await createPendingRow(errorTicket.id, { lastAttemptedAt: older });

    const eligibleTicket = await createTicket(eligibleCompany.id);
    await createPendingRow(eligibleTicket.id, { lastAttemptedAt: newest });

    const holder = withCompanyLock(poisonCompany.id, () => delay(6000));

    const sweep1 = await runRetrySweep({
      bypassAgeFilter: true,
      limit: 3,
      decisionNowForTest: () => MONDAY_NOON,
    });
    expect(sweep1.terminalRemoved).toBe(2);
    expect(sweep1.errored).toBe(1);

    await runRetrySweep({
      bypassAgeFilter: true,
      limit: 3,
      decisionNowForTest: () => MONDAY_NOON,
    });

    const updated = await prisma.ticket.findUniqueOrThrow({
      where: { id: eligibleTicket.id },
    });
    expect(updated.assigneeId).toBe(agent.id);

    await holder;
  }, 15000);

  it("evaluates each row's own decision time instead of stamping the whole batch with the sweep-start time", async () => {
    // Two companies, two shifts that don't overlap: agentEarly only covers
    // 11:30-12:15, agentLate only covers 12:15-13:00. A row processed at
    // 12:00 must go to agentEarly; the same row processed at 12:30 must go
    // to agentLate instead - the two outcomes are mutually exclusive, so
    // this only passes if each row really gets its own decision time.
    const earlyCompany = await makeCompany();
    const agentEarly = await createAgent(earlyCompany.id);
    await createWindow(earlyCompany.id, [agentEarly.id], {
      dayOfWeek: 1,
      startMinute: 11 * 60 + 30,
      endMinute: 12 * 60 + 15,
      timezone: "UTC",
    });

    const lateCompany = await makeCompany();
    const agentLate = await createAgent(lateCompany.id);
    await createWindow(lateCompany.id, [agentLate.id], {
      dayOfWeek: 1,
      startMinute: 12 * 60 + 15,
      endMinute: 13 * 60,
      timezone: "UTC",
    });

    const earlyTicket = await createTicket(earlyCompany.id);
    const lateTicket = await createTicket(lateCompany.id);
    // lastAttemptedAt order decides processing order: earlyTicket first.
    await createPendingRow(earlyTicket.id, {
      lastAttemptedAt: new Date(MONDAY_NOON.minus({ minutes: 5 }).toMillis()),
    });
    await createPendingRow(lateTicket.id, {
      lastAttemptedAt: new Date(MONDAY_NOON.minus({ minutes: 4 }).toMillis()),
    });

    // Simulates the batch taking 30 minutes to reach the second row (e.g.
    // company-lock contention): the first row is decided at 12:00, the
    // second at 12:30, well past the 12:15 shift change.
    let calls = 0;
    const decisionTimes = [MONDAY_NOON, MONDAY_NOON.plus({ minutes: 30 })];
    const decisionNowForTest = () => decisionTimes[calls++];

    const result = await runRetrySweep({
      bypassAgeFilter: true,
      decisionNowForTest,
    });
    expect(result.assigned).toBe(2);

    const updatedEarly = await prisma.ticket.findUniqueOrThrow({
      where: { id: earlyTicket.id },
    });
    expect(updatedEarly.assigneeId).toBe(agentEarly.id);

    const updatedLate = await prisma.ticket.findUniqueOrThrow({
      where: { id: lateTicket.id },
    });
    expect(updatedLate.assigneeId).toBe(agentLate.id);
  });

  it("processes oldest lastAttemptedAt first, up to the batch limit", async () => {
    const company = await makeCompany();
    const now = Date.now();
    const tickets = await Promise.all([
      createTicket(company.id, { status: "RESOLVED" }),
      createTicket(company.id, { status: "RESOLVED" }),
      createTicket(company.id, { status: "RESOLVED" }),
    ]);
    await createPendingRow(tickets[0].id, {
      lastAttemptedAt: new Date(now - 3000),
    });
    await createPendingRow(tickets[1].id, {
      lastAttemptedAt: new Date(now - 2000),
    });
    await createPendingRow(tickets[2].id, {
      lastAttemptedAt: new Date(now - 1000),
    });

    const result = await runRetrySweep({ bypassAgeFilter: true, limit: 2 });
    expect(result.processed).toBe(2);

    const remaining = await prisma.pendingAssignment.findMany({
      where: { ticketId: tickets[2].id },
    });
    expect(remaining).toHaveLength(1);
  });
});
