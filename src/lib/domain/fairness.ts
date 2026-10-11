export type DecidedBy =
  | "FEWEST_ACTIVE_TICKETS"
  | "NEVER_ASSIGNED"
  | "LEAST_RECENTLY_ASSIGNED"
  | "AGENT_ID_TIEBREAK"
  | "ONLY_ELIGIBLE_AGENT";

export interface CandidateAgent {
  id: string;
  activeCount: number;
  /** null means the agent has never received an assignment. */
  lastAssignedAt: Date | null;
}

/**
 * PRD §4.4 fairness order: fewest active tickets, then least-recently
 * assigned (never-assigned ranks first), then agent ID ascending as the
 * final deterministic tie-break.
 */
export function compareCandidates(
  a: CandidateAgent,
  b: CandidateAgent,
): number {
  if (a.activeCount !== b.activeCount) {
    return a.activeCount - b.activeCount;
  }
  if (a.lastAssignedAt === null && b.lastAssignedAt !== null) {
    return -1;
  }
  if (a.lastAssignedAt !== null && b.lastAssignedAt === null) {
    return 1;
  }
  if (a.lastAssignedAt !== null && b.lastAssignedAt !== null) {
    const diff = a.lastAssignedAt.getTime() - b.lastAssignedAt.getTime();
    if (diff !== 0) {
      return diff;
    }
  }
  return a.id.localeCompare(b.id);
}

export function rankCandidates(candidates: CandidateAgent[]): CandidateAgent[] {
  return [...candidates].sort(compareCandidates);
}

/**
 * Identifies which fairness rule separated the winner from the runner-up,
 * for the assignment explanation (implementation.md §2).
 */
export function decideBy(
  winner: CandidateAgent,
  runnerUp: CandidateAgent | undefined,
): DecidedBy {
  if (!runnerUp) {
    return "ONLY_ELIGIBLE_AGENT";
  }
  if (winner.activeCount !== runnerUp.activeCount) {
    return "FEWEST_ACTIVE_TICKETS";
  }
  if (winner.lastAssignedAt === null && runnerUp.lastAssignedAt !== null) {
    return "NEVER_ASSIGNED";
  }
  if (
    winner.lastAssignedAt !== null &&
    runnerUp.lastAssignedAt !== null &&
    winner.lastAssignedAt.getTime() !== runnerUp.lastAssignedAt.getTime()
  ) {
    return "LEAST_RECENTLY_ASSIGNED";
  }
  return "AGENT_ID_TIEBREAK";
}

export interface SelectionResult {
  winner: CandidateAgent;
  decidedBy: DecidedBy;
}

export function selectCandidate(
  candidates: CandidateAgent[],
): SelectionResult | null {
  if (candidates.length === 0) {
    return null;
  }
  const ranked = rankCandidates(candidates);
  const [winner, runnerUp] = ranked;
  return { winner, decidedBy: decideBy(winner, runnerUp) };
}
