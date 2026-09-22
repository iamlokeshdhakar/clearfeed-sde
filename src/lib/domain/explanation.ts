import type { DecidedBy } from "./fairness";

export interface AssignmentExplanationWindow {
  id: string;
  day: number;
  local: string;
  timezone: string;
}

export interface AssignmentExplanation {
  selected_agent: { id: string; name: string };
  eligibility: {
    window: AssignmentExplanationWindow;
    active_tickets: number;
    limit: number;
  };
  decided_by: DecidedBy;
}
