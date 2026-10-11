import { readFileSync } from "node:fs";
import path from "node:path";
import "dotenv/config";
import type { TicketStatus } from "@prisma/client";
import { timeStringToMinutes } from "../src/lib/domain/time";
import { prisma } from "../src/lib/prisma";

interface SeedRequiredHours {
  daysOfWeek: number[];
  startTime: string;
  endTime: string;
}

interface SeedAgent {
  key: string;
  name: string;
  email: string;
  removed?: boolean;
}

interface SeedWindow {
  daysOfWeek: number[];
  startTime: string;
  endTime: string;
  timezone: string;
  agentKeys: string[];
}

interface SeedTicket {
  status: TicketStatus;
  assigneeKey?: string;
  /** When set, also creates a matching Assignment row this many hours ago. */
  assignedHoursAgo?: number;
}

interface SeedCompany {
  name: string;
  supportTimezone: string;
  maxActiveTicketsPerAgent: number;
  requiredSupportHours: SeedRequiredHours[];
  agents: SeedAgent[];
  windows: SeedWindow[];
  tickets: SeedTicket[];
}

interface SeedData {
  companies: SeedCompany[];
}

function loadSeedData(): SeedData {
  const dataPath = path.join(__dirname, "seed-data.json");
  return JSON.parse(readFileSync(dataPath, "utf-8"));
}

async function reset() {
  await prisma.pendingAssignment.deleteMany();
  await prisma.assignment.deleteMany();
  await prisma.ticket.deleteMany();
  await prisma.availabilityWindowAgent.deleteMany();
  await prisma.availabilityWindow.deleteMany();
  await prisma.requiredSupportHours.deleteMany();
  await prisma.agent.deleteMany();
  await prisma.company.deleteMany();
}

async function seedCompany(spec: SeedCompany) {
  const company = await prisma.company.create({
    data: {
      name: spec.name,
      supportTimezone: spec.supportTimezone,
      maxActiveTicketsPerAgent: spec.maxActiveTicketsPerAgent,
    },
  });

  for (const hours of spec.requiredSupportHours) {
    await prisma.requiredSupportHours.createMany({
      data: hours.daysOfWeek.map((dayOfWeek) => ({
        companyId: company.id,
        dayOfWeek,
        startMinute: timeStringToMinutes(hours.startTime),
        endMinute: timeStringToMinutes(hours.endTime),
      })),
    });
  }

  const agentIdByKey = new Map<string, string>();
  for (const agentSpec of spec.agents) {
    const agent = await prisma.agent.create({
      data: {
        companyId: company.id,
        name: agentSpec.name,
        email: agentSpec.email,
        removedAt: agentSpec.removed ? new Date() : null,
      },
    });
    agentIdByKey.set(agentSpec.key, agent.id);
  }

  function resolveAgentId(key: string): string {
    const id = agentIdByKey.get(key);
    if (!id) {
      throw new Error(`Unknown agent key "${key}" in company "${spec.name}"`);
    }
    return id;
  }

  for (const windowSpec of spec.windows) {
    const startMinute = timeStringToMinutes(windowSpec.startTime);
    const endMinute = timeStringToMinutes(windowSpec.endTime);
    const agentIds = windowSpec.agentKeys.map(resolveAgentId);

    for (const dayOfWeek of windowSpec.daysOfWeek) {
      const window = await prisma.availabilityWindow.create({
        data: {
          companyId: company.id,
          dayOfWeek,
          startMinute,
          endMinute,
          timezone: windowSpec.timezone,
        },
      });
      if (agentIds.length > 0) {
        await prisma.availabilityWindowAgent.createMany({
          data: agentIds.map((agentId) => ({ windowId: window.id, agentId })),
        });
      }
    }
  }

  // Tracks how many assigned tickets each agent has already been given while
  // seeding, so history rows can record a plausible pre-assignment count.
  const assignedCountByAgent = new Map<string, number>();

  for (const ticketSpec of spec.tickets) {
    const assigneeId = ticketSpec.assigneeKey
      ? resolveAgentId(ticketSpec.assigneeKey)
      : null;
    const assignedAt =
      assigneeId && ticketSpec.assignedHoursAgo !== undefined
        ? new Date(Date.now() - ticketSpec.assignedHoursAgo * 60 * 60 * 1000)
        : null;

    const ticket = await prisma.ticket.create({
      data: {
        companyId: company.id,
        status: ticketSpec.status,
        assigneeId,
        assignedAt,
      },
    });

    if (assigneeId && assignedAt) {
      const activeTickets = assignedCountByAgent.get(assigneeId) ?? 0;
      assignedCountByAgent.set(assigneeId, activeTickets + 1);
      const agentSpec = spec.agents.find(
        (a) => agentIdByKey.get(a.key) === assigneeId,
      );

      await prisma.assignment.create({
        data: {
          ticketId: ticket.id,
          agentId: assigneeId,
          assignedAt,
          explanation: {
            selected_agent: { id: assigneeId, name: agentSpec?.name ?? "" },
            eligibility: {
              window: {
                id: "seed",
                day: 1,
                local: "09:00-17:00",
                timezone: spec.supportTimezone,
              },
              active_tickets: activeTickets,
              limit: spec.maxActiveTicketsPerAgent,
            },
            decided_by: "ONLY_ELIGIBLE_AGENT",
          },
        },
      });
    }
  }

  return company;
}

async function main() {
  await reset();
  const data = loadSeedData();

  console.log("Seeded companies:");
  for (const companySpec of data.companies) {
    const company = await seedCompany(companySpec);
    console.log(`  ${company.name} (${company.id})`);
  }
}

main()
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
