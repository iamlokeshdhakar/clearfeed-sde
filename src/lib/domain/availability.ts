import type { DateTime } from "luxon";

export interface WindowSpec {
  id: string;
  dayOfWeek: number;
  startMinute: number;
  endMinute: number;
  timezone: string;
}

/**
 * Weekdays are Monday = 1 through Sunday = 7 (Luxon's `weekday`), matching
 * PRD §4.1's start-inclusive/end-exclusive rule and the overnight wrap rule.
 */
export function isWindowActiveAt(w: WindowSpec, at: DateTime): boolean {
  const local = at.setZone(w.timezone);
  const minute = local.hour * 60 + local.minute;
  if (w.startMinute < w.endMinute) {
    return (
      local.weekday === w.dayOfWeek &&
      minute >= w.startMinute &&
      minute < w.endMinute
    );
  }
  const nextDay = (w.dayOfWeek % 7) + 1;
  return (
    (local.weekday === w.dayOfWeek && minute >= w.startMinute) ||
    (local.weekday === nextDay && minute < w.endMinute)
  );
}

export function isAnyWindowActiveAt(
  windows: WindowSpec[],
  at: DateTime,
): boolean {
  return windows.some((w) => isWindowActiveAt(w, at));
}

/**
 * Deterministically picks the active window to record in an assignment's
 * explanation when several of an agent's windows are active at once.
 */
export function findActiveWindow(
  windows: WindowSpec[],
  at: DateTime,
): WindowSpec | null {
  const active = windows.filter((w) => isWindowActiveAt(w, at));
  if (active.length === 0) {
    return null;
  }
  return active.sort(
    (a, b) =>
      a.dayOfWeek - b.dayOfWeek ||
      a.startMinute - b.startMinute ||
      a.id.localeCompare(b.id),
  )[0];
}
