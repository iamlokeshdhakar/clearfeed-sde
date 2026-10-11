export interface CompanySummary {
  id: string;
  name: string;
  support_timezone: string;
}

export interface WindowAgentDTO {
  id: string;
  name: string;
  is_stale: boolean;
}

export interface AvailabilityWindowDTO {
  id: string;
  day_of_week: number;
  start_time: string;
  end_time: string;
  timezone: string;
  agents: WindowAgentDTO[];
}

export interface AgentDTO {
  id: string;
  name: string;
  email: string;
  active_ticket_count: number;
  is_available_now: boolean;
  removed_at: string | null;
}

export interface CoverageIntervalDTO {
  day_of_week: number;
  start: string;
  end: string;
}

export interface CoveredIntervalDTO extends CoverageIntervalDTO {
  agent_ids: string[];
}

export interface GapIntervalDTO extends CoverageIntervalDTO {
  duration_minutes: number;
}

export interface CoverageResultDTO {
  timezone: string;
  week_start: string;
  week_end: string;
  required: CoverageIntervalDTO[];
  covered: CoveredIntervalDTO[];
  gaps: GapIntervalDTO[];
  total_gap_minutes: number;
}

export interface TicketSummaryDTO {
  id: string;
  status: string;
  assignee: { id: string; name: string } | null;
  assigned_at: string | null;
}

export interface PendingAssignmentDTO {
  ticket_id: string;
  reason: string;
  first_requested_at: string;
  last_attempted_at: string;
  attempt_count: number;
  next_retry_at: string;
}

export type DecidedBy =
  | "FEWEST_ACTIVE_TICKETS"
  | "NEVER_ASSIGNED"
  | "LEAST_RECENTLY_ASSIGNED"
  | "AGENT_ID_TIEBREAK"
  | "ONLY_ELIGIBLE_AGENT";

export interface AssignmentExplanationDTO {
  selected_agent: { id: string; name: string };
  eligibility: {
    window: { id: string; day: number; local: string; timezone: string };
    active_tickets: number;
    limit: number;
  };
  decided_by: DecidedBy;
}

export interface AssignedResultDTO {
  status: "assigned";
  ticket_id: string;
  assignee: { id: string; name: string; email: string };
  assigned_at: string;
  idempotent_replay: boolean;
  explanation: AssignmentExplanationDTO;
}

export interface PendingResultDTO {
  status: "pending";
  ticket_id: string;
  reason: string;
  message: string;
  next_retry_at: string;
  available_agent_count: number;
}

export type AssignmentResultDTO = AssignedResultDTO | PendingResultDTO;
