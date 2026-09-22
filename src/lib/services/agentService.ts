import { DateTime } from "luxon";
import {
  isAnyWindowActiveAt,
  type WindowSpec,
} from "@/lib/domain/availability";
import { ACTIVE_TICKET_STATUSES } from "@/lib/domain/ticketStatus";
import { prisma } from "@/lib/prisma";
import { CompanyNotFoundError } from "@/lib/services/errors";

export interface AgentDTO {
  id: string;
  name: string;
  email: string;
  active_ticket_count: number;
  is_available_now: boolean;
  removed_at: string | null;
}

export async function listAgents(companyId: string): Promise<AgentDTO[]> {
  const company = await prisma.company.findUnique({ where: { id: companyId } });
  if (!company) {
    throw new CompanyNotFoundError(companyId);
  }

  const agents = await prisma.agent.findMany({
    where: { companyId },
    include: { windowMemberships: { include: { window: true } } },
    orderBy: { name: "asc" },
  });

  const activeCounts = await prisma.ticket.groupBy({
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

  const now = DateTime.now();

  return agents.map((agent) => {
    const windows: WindowSpec[] = agent.windowMemberships.map((membership) => ({
      id: membership.window.id,
      dayOfWeek: membership.window.dayOfWeek,
      startMinute: membership.window.startMinute,
      endMinute: membership.window.endMinute,
      timezone: membership.window.timezone,
    }));
    return {
      id: agent.id,
      name: agent.name,
      email: agent.email,
      active_ticket_count: activeCountByAgent.get(agent.id) ?? 0,
      is_available_now:
        agent.removedAt === null && isAnyWindowActiveAt(windows, now),
      removed_at: agent.removedAt ? agent.removedAt.toISOString() : null,
    };
  });
}
