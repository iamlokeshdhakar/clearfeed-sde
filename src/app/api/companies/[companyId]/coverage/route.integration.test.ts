import { afterEach, describe, expect, it } from "vitest";
import { prisma } from "@/lib/prisma";
import {
  cleanupCompany,
  createAgent,
  createCompany,
  createWindow,
} from "@/lib/testing/fixtures";
import { GET } from "./route";

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

function params(companyId: string) {
  return { params: Promise.resolve({ companyId }) };
}

describe("GET /api/companies/:companyId/coverage", () => {
  it("returns 404 for an unknown company", async () => {
    const response = await GET(
      new Request("http://localhost/x"),
      params("missing"),
    );
    expect(response.status).toBe(404);
  });

  it("returns 422 for a malformed week_start", async () => {
    const company = await makeCompany();
    const response = await GET(
      new Request("http://localhost/x?week_start=not-a-date"),
      params(company.id),
    );
    expect(response.status).toBe(422);
  });

  it("returns full coverage with no gaps when a window covers all required hours", async () => {
    const company = await makeCompany({ supportTimezone: "UTC" });
    const agent = await createAgent(company.id);
    await prisma.requiredSupportHours.create({
      data: {
        companyId: company.id,
        dayOfWeek: 1,
        startMinute: 9 * 60,
        endMinute: 17 * 60,
      },
    });
    await createWindow(company.id, [agent.id], {
      dayOfWeek: 1,
      startMinute: 9 * 60,
      endMinute: 17 * 60,
      timezone: "UTC",
    });

    const response = await GET(
      new Request("http://localhost/x?week_start=2026-03-02"),
      params(company.id),
    );
    expect(response.status).toBe(200);
    const json = await response.json();
    expect(json.timezone).toBe("UTC");
    expect(json.gaps).toEqual([]);
    expect(json.total_gap_minutes).toBe(0);
    expect(json.covered).toHaveLength(1);
    expect(json.covered[0].agent_ids).toEqual([agent.id]);
  });

  it("reports a gap when required hours are uncovered", async () => {
    const company = await makeCompany({ supportTimezone: "UTC" });
    await prisma.requiredSupportHours.create({
      data: {
        companyId: company.id,
        dayOfWeek: 1,
        startMinute: 9 * 60,
        endMinute: 17 * 60,
      },
    });

    const response = await GET(
      new Request("http://localhost/x?week_start=2026-03-02"),
      params(company.id),
    );
    const json = await response.json();
    expect(json.total_gap_minutes).toBe(8 * 60);
  });

  it("excludes a removed agent's window from coverage", async () => {
    const company = await makeCompany({ supportTimezone: "UTC" });
    const removed = await createAgent(company.id, { removedAt: new Date() });
    await prisma.requiredSupportHours.create({
      data: {
        companyId: company.id,
        dayOfWeek: 1,
        startMinute: 9 * 60,
        endMinute: 17 * 60,
      },
    });
    await createWindow(company.id, [removed.id], {
      dayOfWeek: 1,
      startMinute: 9 * 60,
      endMinute: 17 * 60,
      timezone: "UTC",
    });

    const response = await GET(
      new Request("http://localhost/x?week_start=2026-03-02"),
      params(company.id),
    );
    const json = await response.json();
    expect(json.covered).toEqual([]);
    expect(json.total_gap_minutes).toBe(8 * 60);
  });

  it("creates no slot for a spring-forward hour that never occurs, through the real API and database", async () => {
    // 2026-03-08 is the US spring-forward Sunday: 02:00 -> 03:00 America/New_York.
    const company = await makeCompany({ supportTimezone: "America/New_York" });
    await prisma.requiredSupportHours.create({
      data: {
        companyId: company.id,
        dayOfWeek: 7,
        startMinute: 60,
        endMinute: 4 * 60,
      },
    });

    const response = await GET(
      new Request("http://localhost/x?week_start=2026-03-08"),
      params(company.id),
    );
    expect(response.status).toBe(200);
    const json = await response.json();
    // A normal day would have 180 required minutes (01:00-04:00); the clock
    // skips an hour, so only 120 real minutes actually elapse.
    expect(json.total_gap_minutes).toBe(120);
  });

  it("reports the uncovered pass of a repeated fall-back hour as a gap, through the real API and database", async () => {
    // 2026-11-01 is the US fall-back Sunday: 02:00 -> 01:00 America/New_York.
    const company = await makeCompany({ supportTimezone: "America/New_York" });
    const agent = await createAgent(company.id);
    await prisma.requiredSupportHours.create({
      data: {
        companyId: company.id,
        dayOfWeek: 7,
        startMinute: 60,
        endMinute: 2 * 60,
      },
    });
    // Authored in UTC, active only 05:00-06:00 UTC: exactly the first (EDT)
    // real pass of local 01:00-02:00, not the second (EST) pass.
    await createWindow(company.id, [agent.id], {
      dayOfWeek: 7,
      startMinute: 5 * 60,
      endMinute: 6 * 60,
      timezone: "UTC",
    });

    const response = await GET(
      new Request("http://localhost/x?week_start=2026-11-01"),
      params(company.id),
    );
    expect(response.status).toBe(200);
    const json = await response.json();
    expect(json.total_gap_minutes).toBe(60);
    const coveredMinutes = json.covered.reduce(
      (sum: number, interval: { start: string; end: string }) =>
        sum +
        (new Date(interval.end).getTime() -
          new Date(interval.start).getTime()) /
          60000,
      0,
    );
    expect(coveredMinutes).toBe(60);
  });
});
