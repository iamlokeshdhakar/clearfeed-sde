import { afterEach, describe, expect, it } from "vitest";
import { prisma } from "@/lib/prisma";
import {
  cleanupCompany,
  createAgent,
  createCompany,
  createWindow,
} from "@/lib/testing/fixtures";
import { DELETE, PATCH } from "./route";

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

function params(windowId: string) {
  return { params: Promise.resolve({ windowId }) };
}

function patchRequest(body: unknown): Request {
  return new Request("http://localhost/api/availability-windows/x", {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

describe("PATCH /api/availability-windows/:windowId", () => {
  it("replaces the window's times, timezone, and agents", async () => {
    const company = await makeCompany();
    const original = await createAgent(company.id, { name: "Original" });
    const replacement = await createAgent(company.id, { name: "Replacement" });
    const window = await createWindow(company.id, [original.id], {
      dayOfWeek: 1,
      startMinute: 9 * 60,
      endMinute: 17 * 60,
      timezone: "UTC",
    });

    const response = await PATCH(
      patchRequest({
        start_time: "10:00",
        end_time: "18:00",
        timezone: "Europe/London",
        agent_ids: [replacement.id],
      }),
      params(window.id),
    );

    expect(response.status).toBe(200);
    const json = await response.json();
    expect(json.window.start_time).toBe("10:00");
    expect(json.window.end_time).toBe("18:00");
    expect(json.window.timezone).toBe("Europe/London");
    expect(json.window.agents.map((a: { id: string }) => a.id)).toEqual([
      replacement.id,
    ]);

    const memberships = await prisma.availabilityWindowAgent.findMany({
      where: { windowId: window.id },
    });
    expect(memberships).toHaveLength(1);
    expect(memberships[0].agentId).toBe(replacement.id);
  });

  it("returns 404 WINDOW_NOT_FOUND for an unknown window", async () => {
    const response = await PATCH(
      patchRequest({
        start_time: "09:00",
        end_time: "17:00",
        timezone: "UTC",
        agent_ids: ["missing"],
      }),
      params("missing"),
    );
    expect(response.status).toBe(404);
    const json = await response.json();
    expect(json.error.code).toBe("WINDOW_NOT_FOUND");
  });

  it("rejects an agent that does not belong to the window's company", async () => {
    const companyA = await makeCompany();
    const companyB = await makeCompany();
    const agentA = await createAgent(companyA.id);
    const agentB = await createAgent(companyB.id);
    const window = await createWindow(companyA.id, [agentA.id], {
      dayOfWeek: 1,
      startMinute: 0,
      endMinute: 60,
      timezone: "UTC",
    });

    const response = await PATCH(
      patchRequest({
        start_time: "09:00",
        end_time: "17:00",
        timezone: "UTC",
        agent_ids: [agentB.id],
      }),
      params(window.id),
    );

    expect(response.status).toBe(422);
  });

  it("rejects equal start and end times", async () => {
    const company = await makeCompany();
    const agent = await createAgent(company.id);
    const window = await createWindow(company.id, [agent.id], {
      dayOfWeek: 1,
      startMinute: 0,
      endMinute: 60,
      timezone: "UTC",
    });

    const response = await PATCH(
      patchRequest({
        start_time: "09:00",
        end_time: "09:00",
        timezone: "UTC",
        agent_ids: [agent.id],
      }),
      params(window.id),
    );

    expect(response.status).toBe(422);
    const json = await response.json();
    expect(json.error.code).toBe("VALIDATION_FAILED");
  });

  it("rejects an unknown IANA timezone", async () => {
    const company = await makeCompany();
    const agent = await createAgent(company.id);
    const window = await createWindow(company.id, [agent.id], {
      dayOfWeek: 1,
      startMinute: 0,
      endMinute: 60,
      timezone: "UTC",
    });

    const response = await PATCH(
      patchRequest({
        start_time: "09:00",
        end_time: "17:00",
        timezone: "Not/AZone",
        agent_ids: [agent.id],
      }),
      params(window.id),
    );

    expect(response.status).toBe(422);
    const json = await response.json();
    expect(
      json.error.details.some((d: { field: string }) => d.field === "timezone"),
    ).toBe(true);
  });

  it("rejects a request missing a required field", async () => {
    const company = await makeCompany();
    const agent = await createAgent(company.id);
    const window = await createWindow(company.id, [agent.id], {
      dayOfWeek: 1,
      startMinute: 0,
      endMinute: 60,
      timezone: "UTC",
    });

    const response = await PATCH(
      patchRequest({
        end_time: "17:00",
        timezone: "UTC",
        agent_ids: [agent.id],
      }),
      params(window.id),
    );

    expect(response.status).toBe(422);
    const json = await response.json();
    expect(
      json.error.details.some(
        (d: { field: string }) => d.field === "start_time",
      ),
    ).toBe(true);
  });
});

describe("DELETE /api/availability-windows/:windowId", () => {
  it("deletes the window and its memberships", async () => {
    const company = await makeCompany();
    const agent = await createAgent(company.id);
    const window = await createWindow(company.id, [agent.id], {
      dayOfWeek: 1,
      startMinute: 0,
      endMinute: 60,
      timezone: "UTC",
    });

    const response = await DELETE(
      new Request("http://localhost"),
      params(window.id),
    );
    expect(response.status).toBe(204);

    const found = await prisma.availabilityWindow.findUnique({
      where: { id: window.id },
    });
    expect(found).toBeNull();
    const memberships = await prisma.availabilityWindowAgent.findMany({
      where: { windowId: window.id },
    });
    expect(memberships).toHaveLength(0);
  });

  it("returns 404 WINDOW_NOT_FOUND for an unknown window", async () => {
    const response = await DELETE(
      new Request("http://localhost"),
      params("missing"),
    );
    expect(response.status).toBe(404);
    const json = await response.json();
    expect(json.error.code).toBe("WINDOW_NOT_FOUND");
  });
});
