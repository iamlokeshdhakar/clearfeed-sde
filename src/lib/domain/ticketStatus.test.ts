import type { TicketStatus } from "@prisma/client";
import { describe, expect, it } from "vitest";
import {
  ACTIVE_TICKET_STATUSES,
  isActiveStatus,
  isTerminalStatus,
  TERMINAL_TICKET_STATUSES,
} from "./ticketStatus";

const ALL_STATUSES: TicketStatus[] = [
  "OPEN",
  "IN_PROGRESS",
  "WAITING",
  "RESOLVED",
  "CLOSED",
];

describe("isActiveStatus", () => {
  it.each(ACTIVE_TICKET_STATUSES)("is true for %s", (status) => {
    expect(isActiveStatus(status)).toBe(true);
  });

  it.each(TERMINAL_TICKET_STATUSES)("is false for %s", (status) => {
    expect(isActiveStatus(status)).toBe(false);
  });
});

describe("isTerminalStatus", () => {
  it.each(TERMINAL_TICKET_STATUSES)("is true for %s", (status) => {
    expect(isTerminalStatus(status)).toBe(true);
  });

  it.each(ACTIVE_TICKET_STATUSES)("is false for %s", (status) => {
    expect(isTerminalStatus(status)).toBe(false);
  });
});

describe("active/terminal status sets", () => {
  it("are mutually exclusive", () => {
    const overlap = ACTIVE_TICKET_STATUSES.filter((status) =>
      (TERMINAL_TICKET_STATUSES as TicketStatus[]).includes(status),
    );
    expect(overlap).toEqual([]);
  });

  it("together cover every ticket status", () => {
    const covered = new Set([
      ...ACTIVE_TICKET_STATUSES,
      ...TERMINAL_TICKET_STATUSES,
    ]);
    for (const status of ALL_STATUSES) {
      expect(covered.has(status)).toBe(true);
    }
    expect(covered.size).toBe(ALL_STATUSES.length);
  });
});
