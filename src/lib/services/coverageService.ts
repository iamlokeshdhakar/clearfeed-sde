import { DateTime } from "luxon";
import type { WindowSpec } from "@/lib/domain/availability";
import {
  type CoverageResult,
  type CoverageWindowInput,
  computeCoverage,
} from "@/lib/domain/coverage";
import { prisma } from "@/lib/prisma";
import { CompanyNotFoundError } from "@/lib/services/errors";

export async function getCoverage(
  companyId: string,
  weekStartDate?: string,
): Promise<CoverageResult> {
  const company = await prisma.company.findUnique({ where: { id: companyId } });
  if (!company) {
    throw new CompanyNotFoundError(companyId);
  }

  const requiredHoursRows = await prisma.requiredSupportHours.findMany({
    where: { companyId },
  });
  const requiredHours: WindowSpec[] = requiredHoursRows.map((row) => ({
    id: row.id,
    dayOfWeek: row.dayOfWeek,
    startMinute: row.startMinute,
    endMinute: row.endMinute,
    timezone: company.supportTimezone,
  }));

  const windowRows = await prisma.availabilityWindow.findMany({
    where: { companyId },
    include: { agents: { where: { agent: { removedAt: null } } } },
  });
  const windows: CoverageWindowInput[] = windowRows.map((window) => ({
    window: {
      id: window.id,
      dayOfWeek: window.dayOfWeek,
      startMinute: window.startMinute,
      endMinute: window.endMinute,
      timezone: window.timezone,
    },
    agentIds: window.agents.map((membership) => membership.agentId),
  }));

  const referenceInstant = weekStartDate
    ? DateTime.fromISO(weekStartDate, { zone: company.supportTimezone })
    : DateTime.now().setZone(company.supportTimezone);

  return computeCoverage({
    companyTimezone: company.supportTimezone,
    requiredHours,
    windows,
    referenceInstant,
  });
}
