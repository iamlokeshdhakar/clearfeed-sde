import { prisma } from "@/lib/prisma";
import { CompanyNotFoundError } from "@/lib/services/errors";

export interface TicketSummaryDTO {
  id: string;
  status: string;
  assignee: { id: string; name: string } | null;
  assigned_at: string | null;
}

export async function listTickets(
  companyId: string,
): Promise<TicketSummaryDTO[]> {
  const company = await prisma.company.findUnique({ where: { id: companyId } });
  if (!company) {
    throw new CompanyNotFoundError(companyId);
  }

  const tickets = await prisma.ticket.findMany({
    where: { companyId },
    include: { assignee: true },
    orderBy: { id: "asc" },
  });

  return tickets.map((ticket) => ({
    id: ticket.id,
    status: ticket.status as string,
    assignee: ticket.assignee
      ? { id: ticket.assignee.id, name: ticket.assignee.name }
      : null,
    assigned_at: ticket.assignedAt ? ticket.assignedAt.toISOString() : null,
  }));
}

export interface CreateTicketInput {
  companyId: string;
  customId?: string;
  status?: "OPEN" | "IN_PROGRESS" | "WAITING" | "RESOLVED" | "CLOSED";
}

export async function createTicket(
  input: CreateTicketInput,
): Promise<TicketSummaryDTO> {
  const company = await prisma.company.findUnique({
    where: { id: input.companyId },
  });
  if (!company) {
    throw new CompanyNotFoundError(input.companyId);
  }

  const ticketId =
    input.customId && input.customId.trim() !== ""
      ? input.customId.trim()
      : `tkt_rev_${Math.random().toString(36).substring(2, 7)}`;

  const ticket = await prisma.ticket.create({
    data: {
      id: ticketId,
      companyId: input.companyId,
      status: input.status ?? "OPEN",
    },
    include: { assignee: true },
  });

  return {
    id: ticket.id,
    status: ticket.status as string,
    assignee: ticket.assignee
      ? { id: ticket.assignee.id, name: ticket.assignee.name }
      : null,
    assigned_at: ticket.assignedAt ? ticket.assignedAt.toISOString() : null,
  };
}

export async function deleteTicket(
  companyId: string,
  ticketId: string,
): Promise<void> {
  const ticket = await prisma.ticket.findFirst({
    where: { id: ticketId, companyId },
  });
  if (!ticket) return;

  await prisma.pendingAssignment.deleteMany({
    where: { ticketId },
  });
  await prisma.assignment.deleteMany({
    where: { ticketId },
  });
  await prisma.ticket.delete({
    where: { id: ticketId },
  });
}
