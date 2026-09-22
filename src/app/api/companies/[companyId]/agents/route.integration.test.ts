import { afterEach, describe, expect, it } from "vitest";
import {
  cleanupCompany,
  createAgent,
  createCompany,
  createTicket,
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

describe("GET /api/companies/:companyId/agents", () => {
  it("returns 404 for an unknown company", async () => {
    const response = await GET(
      new Request("http://localhost"),
      params("missing"),
    );
    expect(response.status).toBe(404);
  });

  it("reports active ticket counts, availability, and removal status", async () => {
    const company = await makeCompany();
    const available = await createAgent(company.id, { name: "Available" });
    const removed = await createAgent(company.id, {
      name: "Removed",
      removedAt: new Date(),
    });
    // Full-week window so "is_available_now" is deterministic regardless of real time.
    for (const dayOfWeek of [1, 2, 3, 4, 5, 6, 7]) {
      await createWindow(company.id, [available.id], {
        dayOfWeek,
        startMinute: 0,
        endMinute: 24 * 60 - 1,
        timezone: "UTC",
      });
    }
    await createTicket(company.id, {
      assigneeId: available.id,
      status: "OPEN",
    });
    await createTicket(company.id, {
      assigneeId: available.id,
      status: "WAITING",
    });
    await createTicket(company.id, {
      assigneeId: available.id,
      status: "RESOLVED",
    });

    const response = await GET(
      new Request("http://localhost"),
      params(company.id),
    );
    expect(response.status).toBe(200);
    const json = await response.json();

    const availableDto = json.agents.find(
      (a: { id: string }) => a.id === available.id,
    );
    expect(availableDto.active_ticket_count).toBe(2);
    expect(availableDto.is_available_now).toBe(true);
    expect(availableDto.removed_at).toBeNull();

    const removedDto = json.agents.find(
      (a: { id: string }) => a.id === removed.id,
    );
    expect(removedDto.is_available_now).toBe(false);
    expect(removedDto.removed_at).not.toBeNull();
  });
});
