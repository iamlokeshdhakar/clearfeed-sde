import type { DateTime } from "luxon";
import {
  isAnyWindowActiveAt,
  isWindowActiveAt,
  type WindowSpec,
} from "./availability";

export interface CoverageWindowInput {
  window: WindowSpec;
  /** Non-removed agent IDs covering this window (already filtered by the caller). */
  agentIds: string[];
}

export interface CoverageInterval {
  day_of_week: number;
  start: string;
  end: string;
}

export interface CoveredInterval extends CoverageInterval {
  agent_ids: string[];
}

export interface GapInterval extends CoverageInterval {
  duration_minutes: number;
}

export interface CoverageResult {
  timezone: string;
  week_start: string;
  week_end: string;
  required: CoverageInterval[];
  covered: CoveredInterval[];
  gaps: GapInterval[];
  total_gap_minutes: number;
}

export interface ComputeCoverageParams {
  companyTimezone: string;
  requiredHours: WindowSpec[];
  windows: CoverageWindowInput[];
  /** The instant whose containing week is resolved; pass the real "now" when no week was requested. */
  referenceInstant: DateTime;
}

export function computeCoverage(params: ComputeCoverageParams): CoverageResult {
  const { companyTimezone, requiredHours, windows, referenceInstant } = params;

  const weekStart = referenceInstant.setZone(companyTimezone).startOf("week");
  const weekEnd = weekStart.plus({ weeks: 1 });
  const totalMinutes = Math.round(weekEnd.diff(weekStart, "minutes").minutes);

  const toISO = (idx: number) =>
    weekStart.plus({ minutes: idx }).toISO() as string;
  const dayOfWeekAt = (idx: number) => weekStart.plus({ minutes: idx }).weekday;

  const required: CoverageInterval[] = [];
  const covered: CoveredInterval[] = [];
  const gaps: GapInterval[] = [];
  let totalGapMinutes = 0;

  let reqStart: number | null = null;
  let covStart: number | null = null;
  let covKey: string | null = null;
  let gapStart: number | null = null;

  const closeRequired = (endIdx: number) => {
    if (reqStart !== null) {
      required.push({
        day_of_week: dayOfWeekAt(reqStart),
        start: toISO(reqStart),
        end: toISO(endIdx),
      });
      reqStart = null;
    }
  };
  const closeCovered = (endIdx: number) => {
    if (covStart !== null && covKey !== null) {
      covered.push({
        day_of_week: dayOfWeekAt(covStart),
        start: toISO(covStart),
        end: toISO(endIdx),
        agent_ids: covKey.length > 0 ? covKey.split(",") : [],
      });
      covStart = null;
      covKey = null;
    }
  };
  const closeGap = (endIdx: number) => {
    if (gapStart !== null) {
      const duration = endIdx - gapStart;
      gaps.push({
        day_of_week: dayOfWeekAt(gapStart),
        start: toISO(gapStart),
        end: toISO(endIdx),
        duration_minutes: duration,
      });
      totalGapMinutes += duration;
      gapStart = null;
    }
  };

  for (let i = 0; i < totalMinutes; i++) {
    const instant = weekStart.plus({ minutes: i });
    const isRequired = isAnyWindowActiveAt(requiredHours, instant);

    if (!isRequired) {
      closeCovered(i);
      closeGap(i);
      closeRequired(i);
      continue;
    }

    if (reqStart === null) {
      reqStart = i;
    }

    const coveringIds = new Set<string>();
    for (const { window, agentIds } of windows) {
      if (isWindowActiveAt(window, instant)) {
        for (const id of agentIds) {
          coveringIds.add(id);
        }
      }
    }
    const sortedIds = Array.from(coveringIds).sort();

    if (sortedIds.length === 0) {
      closeCovered(i);
      if (gapStart === null) {
        gapStart = i;
      }
    } else {
      closeGap(i);
      const key = sortedIds.join(",");
      if (covKey !== key) {
        closeCovered(i);
        covStart = i;
        covKey = key;
      }
    }
  }

  closeCovered(totalMinutes);
  closeGap(totalMinutes);
  closeRequired(totalMinutes);

  return {
    timezone: companyTimezone,
    week_start: weekStart.toISO() as string,
    week_end: weekEnd.toISO() as string,
    required,
    covered,
    gaps,
    total_gap_minutes: totalGapMinutes,
  };
}
