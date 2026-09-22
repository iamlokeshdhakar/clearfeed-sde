import type {
  Agent,
  AvailabilityWindow,
  AvailabilityWindowAgent,
} from "@prisma/client";
import { Prisma } from "@prisma/client";
import { minutesToTimeString, timeStringToMinutes } from "@/lib/domain/time";
import { prisma } from "@/lib/prisma";
import {
  CompanyNotFoundError,
  InvalidAgentReferenceError,
  WindowNotFoundError,
} from "@/lib/services/errors";
import type {
  CreateAvailabilityWindowInput,
  UpdateAvailabilityWindowInput,
} from "@/lib/validation/availability";

type WindowWithAgents = AvailabilityWindow & {
  agents: (AvailabilityWindowAgent & { agent: Agent })[];
};

export interface WindowAgentDTO {
  id: string;
  name: string;
  is_stale: boolean;
}

export interface WindowDTO {
  id: string;
  day_of_week: number;
  start_time: string;
  end_time: string;
  timezone: string;
  agents: WindowAgentDTO[];
}

function toWindowDTO(window: WindowWithAgents): WindowDTO {
  return {
    id: window.id,
    day_of_week: window.dayOfWeek,
    start_time: minutesToTimeString(window.startMinute),
    end_time: minutesToTimeString(window.endMinute),
    timezone: window.timezone,
    agents: window.agents.map((membership) => ({
      id: membership.agent.id,
      name: membership.agent.name,
      is_stale: membership.agent.removedAt !== null,
    })),
  };
}

async function assertValidAgents(
  companyId: string,
  agentIds: string[],
): Promise<void> {
  const validAgents = await prisma.agent.findMany({
    where: { id: { in: agentIds }, companyId, removedAt: null },
    select: { id: true },
  });
  const validIds = new Set(validAgents.map((agent) => agent.id));
  const invalid = agentIds.filter((id) => !validIds.has(id));
  if (invalid.length > 0) {
    throw new InvalidAgentReferenceError(invalid);
  }
}

export async function listAvailabilityWindows(
  companyId: string,
): Promise<WindowDTO[]> {
  const company = await prisma.company.findUnique({ where: { id: companyId } });
  if (!company) {
    throw new CompanyNotFoundError(companyId);
  }
  const windows = await prisma.availabilityWindow.findMany({
    where: { companyId },
    include: { agents: { include: { agent: true } } },
    orderBy: [{ dayOfWeek: "asc" }, { startMinute: "asc" }],
  });
  return windows.map(toWindowDTO);
}

export async function createAvailabilityWindows(
  companyId: string,
  input: CreateAvailabilityWindowInput,
): Promise<WindowDTO[]> {
  const company = await prisma.company.findUnique({ where: { id: companyId } });
  if (!company) {
    throw new CompanyNotFoundError(companyId);
  }
  await assertValidAgents(companyId, input.agent_ids);

  const startMinute = timeStringToMinutes(input.start_time);
  const endMinute = timeStringToMinutes(input.end_time);

  const windows = await prisma.$transaction(async (tx) => {
    const created: WindowWithAgents[] = [];
    for (const dayOfWeek of input.days_of_week) {
      const window = await tx.availabilityWindow.create({
        data: {
          companyId,
          dayOfWeek,
          startMinute,
          endMinute,
          timezone: input.timezone,
          agents: {
            createMany: {
              data: input.agent_ids.map((agentId) => ({ agentId })),
            },
          },
        },
        include: { agents: { include: { agent: true } } },
      });
      created.push(window);
    }
    return created;
  });

  return windows.map(toWindowDTO);
}

export async function updateAvailabilityWindow(
  windowId: string,
  input: UpdateAvailabilityWindowInput,
): Promise<WindowDTO> {
  const window = await prisma.availabilityWindow.findUnique({
    where: { id: windowId },
  });
  if (!window) {
    throw new WindowNotFoundError(windowId);
  }
  await assertValidAgents(window.companyId, input.agent_ids);

  const startMinute = timeStringToMinutes(input.start_time);
  const endMinute = timeStringToMinutes(input.end_time);

  const updated = await prisma.$transaction(async (tx) => {
    await tx.availabilityWindowAgent.deleteMany({ where: { windowId } });
    return tx.availabilityWindow.update({
      where: { id: windowId },
      data: {
        startMinute,
        endMinute,
        timezone: input.timezone,
        agents: {
          createMany: { data: input.agent_ids.map((agentId) => ({ agentId })) },
        },
      },
      include: { agents: { include: { agent: true } } },
    });
  });

  return toWindowDTO(updated);
}

export async function deleteAvailabilityWindow(
  windowId: string,
): Promise<void> {
  try {
    await prisma.availabilityWindow.delete({ where: { id: windowId } });
  } catch (error) {
    if (
      error instanceof Prisma.PrismaClientKnownRequestError &&
      error.code === "P2025"
    ) {
      throw new WindowNotFoundError(windowId);
    }
    throw error;
  }
}
