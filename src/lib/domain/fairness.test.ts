import { describe, expect, it } from "vitest";
import {
  type CandidateAgent,
  decideBy,
  rankCandidates,
  selectCandidate,
} from "./fairness";

function agent(
  id: string,
  activeCount: number,
  lastAssignedAt: Date | null,
): CandidateAgent {
  return { id, activeCount, lastAssignedAt };
}

describe("rankCandidates", () => {
  it("prefers fewer active tickets", () => {
    const ranked = rankCandidates([agent("b", 2, null), agent("a", 1, null)]);
    expect(ranked.map((c) => c.id)).toEqual(["a", "b"]);
  });

  it("ranks never-assigned ahead of previously-assigned when active counts tie", () => {
    const ranked = rankCandidates([
      agent("assigned", 1, new Date("2026-01-01T00:00:00Z")),
      agent("never", 1, null),
    ]);
    expect(ranked.map((c) => c.id)).toEqual(["never", "assigned"]);
  });

  it("prefers the least-recently assigned when active counts tie and both were assigned", () => {
    const ranked = rankCandidates([
      agent("recent", 1, new Date("2026-01-02T00:00:00Z")),
      agent("older", 1, new Date("2026-01-01T00:00:00Z")),
    ]);
    expect(ranked.map((c) => c.id)).toEqual(["older", "recent"]);
  });

  it("falls back to agent ID ascending when everything else ties", () => {
    const ranked = rankCandidates([agent("z", 0, null), agent("a", 0, null)]);
    expect(ranked.map((c) => c.id)).toEqual(["a", "z"]);
  });

  it("falls back to agent ID ascending when both were assigned at the exact same time", () => {
    const sameTime = new Date("2026-01-01T00:00:00Z");
    const ranked = rankCandidates([
      agent("z", 0, sameTime),
      agent("a", 0, sameTime),
    ]);
    expect(ranked.map((c) => c.id)).toEqual(["a", "z"]);
  });
});

describe("decideBy", () => {
  it("is ONLY_ELIGIBLE_AGENT when there is no runner-up", () => {
    expect(decideBy(agent("a", 0, null), undefined)).toBe(
      "ONLY_ELIGIBLE_AGENT",
    );
  });

  it("is FEWEST_ACTIVE_TICKETS when active counts differ", () => {
    expect(decideBy(agent("a", 0, null), agent("b", 1, null))).toBe(
      "FEWEST_ACTIVE_TICKETS",
    );
  });

  it("is NEVER_ASSIGNED when the winner has never been assigned and the runner-up has", () => {
    expect(
      decideBy(
        agent("a", 1, null),
        agent("b", 1, new Date("2026-01-01T00:00:00Z")),
      ),
    ).toBe("NEVER_ASSIGNED");
  });

  it("is LEAST_RECENTLY_ASSIGNED when both were assigned at different times", () => {
    expect(
      decideBy(
        agent("a", 1, new Date("2026-01-01T00:00:00Z")),
        agent("b", 1, new Date("2026-01-02T00:00:00Z")),
      ),
    ).toBe("LEAST_RECENTLY_ASSIGNED");
  });

  it("is AGENT_ID_TIEBREAK when both were never assigned", () => {
    expect(decideBy(agent("a", 1, null), agent("b", 1, null))).toBe(
      "AGENT_ID_TIEBREAK",
    );
  });

  it("is AGENT_ID_TIEBREAK when both were assigned at the exact same time", () => {
    const sameTime = new Date("2026-01-01T00:00:00Z");
    expect(decideBy(agent("a", 1, sameTime), agent("b", 1, sameTime))).toBe(
      "AGENT_ID_TIEBREAK",
    );
  });
});

describe("selectCandidate", () => {
  it("returns null for an empty candidate list", () => {
    expect(selectCandidate([])).toBeNull();
  });

  it("returns the winner and the deciding rule", () => {
    const result = selectCandidate([agent("b", 1, null), agent("a", 0, null)]);
    expect(result?.winner.id).toBe("a");
    expect(result?.decidedBy).toBe("FEWEST_ACTIVE_TICKETS");
  });

  it("reports ONLY_ELIGIBLE_AGENT for a single candidate", () => {
    const result = selectCandidate([agent("solo", 3, null)]);
    expect(result?.winner.id).toBe("solo");
    expect(result?.decidedBy).toBe("ONLY_ELIGIBLE_AGENT");
  });
});
