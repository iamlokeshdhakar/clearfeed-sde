import type { TicketStatus } from "@prisma/client";
import { prisma } from "@/lib/prisma";

function randomSuffix(): string {
  return Math.random().toString(36).slice(2);
}

export async function createCompany(
  overrides: Partial<{
    name: string;
    supportTimezone: string;
    maxActiveTicketsPerAgent: number;
  }> = {},
) {
  return prisma.company.create({
    data: {
      name: overrides.name ?? `Test Co ${randomSuffix()}`,
      supportTimezone: overrides.supportTimezone ?? "UTC",
      maxActiveTicketsPerAgent: overrides.maxActiveTicketsPerAgent ?? 3,
    },
  });
}

export async function createAgent(
  companyId: string,
  overrides: Partial<{
    name: string;
    email: string;
    removedAt: Date | null;
  }> = {},
) {
  return prisma.agent.create({
    data: {
      companyId,
      name: overrides.name ?? "Test Agent",
      email: overrides.email ?? `agent-${randomSuffix()}@example.com`,
      removedAt: overrides.removedAt ?? null,
    },
  });
}

export async function createWindow(
  companyId: string,
  agentIds: string[],
  spec: {
    dayOfWeek: number;
    startMinute: number;
    endMinute: number;
    timezone: string;
  },
) {
  const window = await prisma.availabilityWindow.create({
    data: { companyId, ...spec },
  });
  if (agentIds.length > 0) {
    await prisma.availabilityWindowAgent.createMany({
      data: agentIds.map((agentId) => ({ windowId: window.id, agentId })),
    });
  }
  return window;
}

export async function createTicket(
  companyId: string,
  overrides: Partial<{ status: TicketStatus; assigneeId: string | null }> = {},
) {
  return prisma.ticket.create({
    data: {
      companyId,
      status: overrides.status ?? "OPEN",
      assigneeId: overrides.assigneeId ?? null,
    },
  });
}

export async function cleanupCompany(companyId: string): Promise<void> {
  const tickets = await prisma.ticket.findMany({
    where: { companyId },
    select: { id: true },
  });
  const ticketIds = tickets.map((t) => t.id);
  await prisma.pendingAssignment.deleteMany({
    where: { ticketId: { in: ticketIds } },
  });
  await prisma.assignment.deleteMany({
    where: { ticketId: { in: ticketIds } },
  });
  await prisma.ticket.deleteMany({ where: { companyId } });
  await prisma.availabilityWindow.deleteMany({ where: { companyId } });
  await prisma.requiredSupportHours.deleteMany({ where: { companyId } });
  await prisma.agent.deleteMany({ where: { companyId } });
  await prisma.company.delete({ where: { id: companyId } });
}
