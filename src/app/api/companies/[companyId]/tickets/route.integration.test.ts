import { afterEach, describe, expect, it } from "vitest";
import {
  cleanupCompany,
  createAgent,
  createCompany,
  createTicket,
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

describe("GET /api/companies/:companyId/tickets", () => {
  it("returns 404 for an unknown company", async () => {
    const response = await GET(
      new Request("http://localhost"),
      params("missing"),
    );
    expect(response.status).toBe(404);
  });

  it("lists tickets with their assignee, when assigned", async () => {
    const company = await makeCompany();
    const agent = await createAgent(company.id, { name: "Priya" });
    const assigned = await createTicket(company.id, {
      status: "OPEN",
      assigneeId: agent.id,
    });
    const unassigned = await createTicket(company.id, { status: "OPEN" });

    const response = await GET(
      new Request("http://localhost"),
      params(company.id),
    );
    expect(response.status).toBe(200);
    const json = await response.json();
    expect(json.tickets).toHaveLength(2);

    const assignedDto = json.tickets.find(
      (t: { id: string }) => t.id === assigned.id,
    );
    expect(assignedDto.assignee).toEqual({ id: agent.id, name: "Priya" });

    const unassignedDto = json.tickets.find(
      (t: { id: string }) => t.id === unassigned.id,
    );
    expect(unassignedDto.assignee).toBeNull();
  });
});
