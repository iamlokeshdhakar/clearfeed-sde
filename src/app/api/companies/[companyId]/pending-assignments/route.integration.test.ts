import { afterEach, describe, expect, it } from "vitest";
import { prisma } from "@/lib/prisma";
import {
  cleanupCompany,
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

describe("GET /api/companies/:companyId/pending-assignments", () => {
  it("returns 404 for an unknown company", async () => {
    const response = await GET(
      new Request("http://localhost"),
      params("missing"),
    );
    expect(response.status).toBe(404);
  });

  it("returns an empty list when nothing is pending", async () => {
    const company = await makeCompany();
    const response = await GET(
      new Request("http://localhost"),
      params(company.id),
    );
    expect(response.status).toBe(200);
    const json = await response.json();
    expect(json.pending).toEqual([]);
  });

  it("lists pending rows for the company, oldest first, with a computed next_retry_at", async () => {
    const company = await makeCompany();
    const ticketA = await createTicket(company.id);
    const ticketB = await createTicket(company.id);
    const older = new Date(Date.now() - 20 * 60 * 1000);
    const newer = new Date(Date.now() - 5 * 60 * 1000);
    await prisma.pendingAssignment.create({
      data: {
        ticketId: ticketA.id,
        reasonCode: "NO_AVAILABLE_AGENT",
        firstRequestedAt: older,
        lastAttemptedAt: older,
        attemptCount: 3,
      },
    });
    await prisma.pendingAssignment.create({
      data: {
        ticketId: ticketB.id,
        reasonCode: "ALL_AVAILABLE_AGENTS_AT_CAPACITY",
        firstRequestedAt: newer,
        lastAttemptedAt: newer,
        attemptCount: 1,
      },
    });

    const response = await GET(
      new Request("http://localhost"),
      params(company.id),
    );
    expect(response.status).toBe(200);
    const json = await response.json();
    expect(json.pending).toHaveLength(2);
    expect(json.pending[0].ticket_id).toBe(ticketA.id);
    expect(json.pending[0].reason).toBe("NO_AVAILABLE_AGENT");
    expect(json.pending[0].attempt_count).toBe(3);
    expect(new Date(json.pending[0].next_retry_at).getTime()).toBe(
      older.getTime() + 5 * 60 * 1000,
    );
    expect(json.pending[1].ticket_id).toBe(ticketB.id);
  });
});
