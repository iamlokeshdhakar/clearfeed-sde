import { afterEach, describe, expect, it } from "vitest";
import { prisma } from "@/lib/prisma";
import {
  cleanupCompany,
  createAgent,
  createCompany,
} from "@/lib/testing/fixtures";
import { GET, POST } from "./route";

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

function postRequest(body: unknown): Request {
  return new Request("http://localhost/api/companies/x/availability-windows", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

describe("GET /api/companies/:companyId/availability-windows", () => {
  it("returns 404 for an unknown company", async () => {
    const response = await GET(
      new Request("http://localhost"),
      params("missing"),
    );
    expect(response.status).toBe(404);
    const json = await response.json();
    expect(json.error.code).toBe("COMPANY_NOT_FOUND");
  });

  it("lists windows with stale-agent flags", async () => {
    const company = await makeCompany();
    const active = await createAgent(company.id, { name: "Active" });
    const removed = await createAgent(company.id, {
      name: "Removed",
      removedAt: new Date(),
    });

    await POST(
      postRequest({
        days_of_week: [1],
        start_time: "09:00",
        end_time: "17:00",
        timezone: "UTC",
        agent_ids: [active.id],
      }),
      params(company.id),
    );
    // Directly seed a stale membership (create would reject a removed agent).
    const window = await prisma.availabilityWindow.create({
      data: {
        companyId: company.id,
        dayOfWeek: 2,
        startMinute: 0,
        endMinute: 60,
        timezone: "UTC",
      },
    });
    await prisma.availabilityWindowAgent.create({
      data: { windowId: window.id, agentId: removed.id },
    });

    const response = await GET(
      new Request("http://localhost"),
      params(company.id),
    );
    expect(response.status).toBe(200);
    const json = await response.json();
    expect(json.windows).toHaveLength(2);
    const staleWindow = json.windows.find(
      (w: { id: string }) => w.id === window.id,
    );
    expect(staleWindow.agents[0].is_stale).toBe(true);
  });
});

describe("POST /api/companies/:companyId/availability-windows", () => {
  it("creates one row per selected weekday", async () => {
    const company = await makeCompany();
    const agent = await createAgent(company.id);

    const response = await POST(
      postRequest({
        days_of_week: [1, 3, 5],
        start_time: "09:00",
        end_time: "17:00",
        timezone: "America/New_York",
        agent_ids: [agent.id],
      }),
      params(company.id),
    );

    expect(response.status).toBe(201);
    const json = await response.json();
    expect(json.windows).toHaveLength(3);
    expect(
      json.windows.map((w: { day_of_week: number }) => w.day_of_week).sort(),
    ).toEqual([1, 3, 5]);
    expect(json.windows[0].agents[0].id).toBe(agent.id);
  });

  it("rejects equal start and end times with 422", async () => {
    const company = await makeCompany();
    const agent = await createAgent(company.id);

    const response = await POST(
      postRequest({
        days_of_week: [1],
        start_time: "09:00",
        end_time: "09:00",
        timezone: "UTC",
        agent_ids: [agent.id],
      }),
      params(company.id),
    );

    expect(response.status).toBe(422);
    const json = await response.json();
    expect(json.error.code).toBe("VALIDATION_FAILED");
  });

  it("rejects an unknown IANA timezone with 422", async () => {
    const company = await makeCompany();
    const agent = await createAgent(company.id);

    const response = await POST(
      postRequest({
        days_of_week: [1],
        start_time: "09:00",
        end_time: "17:00",
        timezone: "Not/AZone",
        agent_ids: [agent.id],
      }),
      params(company.id),
    );

    expect(response.status).toBe(422);
    const json = await response.json();
    expect(
      json.error.details.some((d: { field: string }) => d.field === "timezone"),
    ).toBe(true);
  });

  it("rejects an agent that does not belong to the company", async () => {
    const companyA = await makeCompany();
    const companyB = await makeCompany();
    const foreignAgent = await createAgent(companyB.id);

    const response = await POST(
      postRequest({
        days_of_week: [1],
        start_time: "09:00",
        end_time: "17:00",
        timezone: "UTC",
        agent_ids: [foreignAgent.id],
      }),
      params(companyA.id),
    );

    expect(response.status).toBe(422);
    const json = await response.json();
    expect(json.error.code).toBe("VALIDATION_FAILED");
  });

  it("rejects a removed agent", async () => {
    const company = await makeCompany();
    const removed = await createAgent(company.id, { removedAt: new Date() });

    const response = await POST(
      postRequest({
        days_of_week: [1],
        start_time: "09:00",
        end_time: "17:00",
        timezone: "UTC",
        agent_ids: [removed.id],
      }),
      params(company.id),
    );

    expect(response.status).toBe(422);
  });

  it("rejects an empty agent list", async () => {
    const company = await makeCompany();
    const response = await POST(
      postRequest({
        days_of_week: [1],
        start_time: "09:00",
        end_time: "17:00",
        timezone: "UTC",
        agent_ids: [],
      }),
      params(company.id),
    );
    expect(response.status).toBe(422);
  });

  it("rejects a request missing a required field", async () => {
    const company = await makeCompany();
    const agent = await createAgent(company.id);
    const response = await POST(
      postRequest({
        days_of_week: [1],
        end_time: "17:00",
        timezone: "UTC",
        agent_ids: [agent.id],
      }),
      params(company.id),
    );
    expect(response.status).toBe(422);
    const json = await response.json();
    expect(
      json.error.details.some(
        (d: { field: string }) => d.field === "start_time",
      ),
    ).toBe(true);
  });

  it("rejects an empty days_of_week list", async () => {
    const company = await makeCompany();
    const agent = await createAgent(company.id);
    const response = await POST(
      postRequest({
        days_of_week: [],
        start_time: "09:00",
        end_time: "17:00",
        timezone: "UTC",
        agent_ids: [agent.id],
      }),
      params(company.id),
    );
    expect(response.status).toBe(422);
  });

  it("accepts a valid overnight window", async () => {
    const company = await makeCompany();
    const agent = await createAgent(company.id);

    const response = await POST(
      postRequest({
        days_of_week: [1],
        start_time: "22:00",
        end_time: "06:00",
        timezone: "UTC",
        agent_ids: [agent.id],
      }),
      params(company.id),
    );

    expect(response.status).toBe(201);
    const json = await response.json();
    expect(json.windows[0].start_time).toBe("22:00");
    expect(json.windows[0].end_time).toBe("06:00");
  });
});
