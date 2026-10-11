import type { TicketStatus } from "@prisma/client";

export const ACTIVE_TICKET_STATUSES: TicketStatus[] = [
  "OPEN",
  "IN_PROGRESS",
  "WAITING",
];
export const TERMINAL_TICKET_STATUSES: TicketStatus[] = ["RESOLVED", "CLOSED"];

export function isTerminalStatus(status: TicketStatus): boolean {
  return TERMINAL_TICKET_STATUSES.includes(status);
}

export function isActiveStatus(status: TicketStatus): boolean {
  return ACTIVE_TICKET_STATUSES.includes(status);
}
