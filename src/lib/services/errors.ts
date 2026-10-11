export class CompanyNotFoundError extends Error {
  companyId: string;
  constructor(companyId: string) {
    super(`Company not found: ${companyId}`);
    this.name = "CompanyNotFoundError";
    this.companyId = companyId;
  }
}

export class TicketNotFoundError extends Error {
  ticketId: string;
  constructor(ticketId: string) {
    super(`Ticket not found: ${ticketId}`);
    this.name = "TicketNotFoundError";
    this.ticketId = ticketId;
  }
}

export class TicketCompanyMismatchError extends Error {
  ticketId: string;
  companyId: string;
  constructor(ticketId: string, companyId: string) {
    super(`Ticket ${ticketId} does not belong to company ${companyId}`);
    this.name = "TicketCompanyMismatchError";
    this.ticketId = ticketId;
    this.companyId = companyId;
  }
}

export class TicketTerminalError extends Error {
  ticketId: string;
  constructor(ticketId: string) {
    super(
      `Ticket ${ticketId} is terminal and has no saved assignment to replay`,
    );
    this.name = "TicketTerminalError";
    this.ticketId = ticketId;
  }
}

export class AssignmentServiceUnavailableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AssignmentServiceUnavailableError";
  }
}

export class WindowNotFoundError extends Error {
  windowId: string;
  constructor(windowId: string) {
    super(`Availability window not found: ${windowId}`);
    this.name = "WindowNotFoundError";
    this.windowId = windowId;
  }
}

export class InvalidAgentReferenceError extends Error {
  agentIds: string[];
  constructor(agentIds: string[]) {
    super(
      `Agent IDs do not belong to this company or are removed: ${agentIds.join(", ")}`,
    );
    this.name = "InvalidAgentReferenceError";
    this.agentIds = agentIds;
  }
}
