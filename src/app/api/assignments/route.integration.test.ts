import { afterEach, describe, expect, it } from "vitest";
import { prisma } from "@/lib/prisma";
import {
  cleanupCompany,
  createAgent,
  createCompany,
  createTicket,
  createWindow,
} from "@/lib/testing/fixtures";
import { POST } from "./route";

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

function postRequest(body: unknown): Request {
  return new Request("http://localhost/api/assignments", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

// Full-day window covering "now" for every test, so the pure assignment
// logic (already covered by service-level tests) doesn't gate route tests.
const FULL_WEEK_WINDOWS = [1, 2, 3, 4, 5, 6, 7].map((dayOfWeek) => ({
  dayOfWeek,
  startMinute: 0,
  endMinute: 24 * 60 - 1,
  timezone: "UTC",
}));

async function coverAllWeek(companyId: string, agentId: string) {
  for (const spec of FULL_WEEK_WINDOWS) {
    await createWindow(companyId, [agentId], spec);
  }
}

describe("POST /api/assignments", () => {
  it("returns 200 with an assigned outcome", async () => {
    const company = await makeCompany();
    const agent = await createAgent(company.id);
    await coverAllWeek(company.id, agent.id);
    const ticket = await createTicket(company.id);

    const response = await POST(
      postRequest({ company_id: company.id, ticket_id: ticket.id }),
    );
    expect(response.status).toBe(200);
    const json = await response.json();
    expect(json.status).toBe("assigned");
    expect(json.assignee.id).toBe(agent.id);
    expect(json.idempotent_replay).toBe(false);
  });

  it("returns 200 with a pending outcome when no agent is available", async () => {
    const company = await makeCompany();
    await createAgent(company.id);
    const ticket = await createTicket(company.id);

    const response = await POST(
      postRequest({ company_id: company.id, ticket_id: ticket.id }),
    );
    expect(response.status).toBe(200);
    const json = await response.json();
    expect(json.status).toBe("pending");
    expect(json.reason).toBe("NO_AVAILABLE_AGENT");
  });

  it("returns 422 VALIDATION_FAILED for a missing field", async () => {
    const response = await POST(postRequest({ company_id: "cmp_1" }));
    expect(response.status).toBe(422);
    const json = await response.json();
    expect(json.error.code).toBe("VALIDATION_FAILED");
    expect(
      json.error.details.some(
        (d: { field: string }) => d.field === "ticket_id",
      ),
    ).toBe(true);
  });

  it("returns 422 VALIDATION_FAILED for malformed JSON", async () => {
    const response = await POST(
      new Request("http://localhost/api/assignments", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: "{not json",
      }),
    );
    expect(response.status).toBe(422);
  });

  it("returns 404 COMPANY_NOT_FOUND", async () => {
    const response = await POST(
      postRequest({ company_id: "missing", ticket_id: "missing" }),
    );
    expect(response.status).toBe(404);
    const json = await response.json();
    expect(json.error.code).toBe("COMPANY_NOT_FOUND");
  });

  it("returns 404 TICKET_NOT_FOUND", async () => {
    const company = await makeCompany();
    const response = await POST(
      postRequest({ company_id: company.id, ticket_id: "missing" }),
    );
    expect(response.status).toBe(404);
    const json = await response.json();
    expect(json.error.code).toBe("TICKET_NOT_FOUND");
  });

  it("returns 422 TICKET_COMPANY_MISMATCH", async () => {
    const companyA = await makeCompany();
    const companyB = await makeCompany();
    const ticket = await createTicket(companyB.id);

    const response = await POST(
      postRequest({ company_id: companyA.id, ticket_id: ticket.id }),
    );
    expect(response.status).toBe(422);
    const json = await response.json();
    expect(json.error.code).toBe("TICKET_COMPANY_MISMATCH");
  });

  it("returns 409 TICKET_TERMINAL", async () => {
    const company = await makeCompany();
    const ticket = await createTicket(company.id, { status: "CLOSED" });

    const response = await POST(
      postRequest({ company_id: company.id, ticket_id: ticket.id }),
    );
    expect(response.status).toBe(409);
    const json = await response.json();
    expect(json.error.code).toBe("TICKET_TERMINAL");
  });

  it("replays an idempotent assignment on repeated calls", async () => {
    const company = await makeCompany();
    const agent = await createAgent(company.id);
    await coverAllWeek(company.id, agent.id);
    const ticket = await createTicket(company.id);

    await POST(postRequest({ company_id: company.id, ticket_id: ticket.id }));
    const second = await POST(
      postRequest({ company_id: company.id, ticket_id: ticket.id }),
    );
    const json = await second.json();

    expect(second.status).toBe(200);
    expect(json.idempotent_replay).toBe(true);

    const assignments = await prisma.assignment.findMany({
      where: { ticketId: ticket.id },
    });
    expect(assignments).toHaveLength(1);
  });
});
