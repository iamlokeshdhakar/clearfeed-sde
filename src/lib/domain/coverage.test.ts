import { DateTime } from "luxon";
import { describe, expect, it } from "vitest";
import type { WindowSpec } from "./availability";
import { computeCoverage } from "./coverage";

/** Monday 00:00 of a fixed non-DST reference week, in UTC. */
const REFERENCE_MONDAY = DateTime.fromObject(
  { weekYear: 2026, weekNumber: 10, weekday: 1 },
  { zone: "UTC" },
).startOf("day");

function requiredMonUtc(startHour: number, endHour: number): WindowSpec[] {
  return [
    {
      id: "required",
      dayOfWeek: 1,
      startMinute: startHour * 60,
      endMinute: endHour * 60,
      timezone: "UTC",
    },
  ];
}

describe("computeCoverage", () => {
  it("produces one covered interval and no gaps for full coverage", () => {
    const windows = [
      {
        window: {
          id: "w1",
          dayOfWeek: 1,
          startMinute: 9 * 60,
          endMinute: 17 * 60,
          timezone: "UTC",
        },
        agentIds: ["agent-x"],
      },
    ];
    const result = computeCoverage({
      companyTimezone: "UTC",
      requiredHours: requiredMonUtc(9, 17),
      windows,
      referenceInstant: REFERENCE_MONDAY,
    });

    expect(result.required).toHaveLength(1);
    expect(result.covered).toHaveLength(1);
    expect(result.covered[0].agent_ids).toEqual(["agent-x"]);
    expect(result.gaps).toEqual([]);
    expect(result.total_gap_minutes).toBe(0);
  });

  it("reports a gap for the uncovered portion of required hours", () => {
    const windows = [
      {
        window: {
          id: "w1",
          dayOfWeek: 1,
          startMinute: 9 * 60,
          endMinute: 13 * 60,
          timezone: "UTC",
        },
        agentIds: ["agent-x"],
      },
    ];
    const result = computeCoverage({
      companyTimezone: "UTC",
      requiredHours: requiredMonUtc(9, 17),
      windows,
      referenceInstant: REFERENCE_MONDAY,
    });

    expect(result.covered).toHaveLength(1);
    expect(result.gaps).toHaveLength(1);
    expect(result.gaps[0].duration_minutes).toBe(4 * 60);
    expect(result.total_gap_minutes).toBe(4 * 60);
  });

  it("splits into separate covered intervals on an agent handoff", () => {
    const windows = [
      {
        window: {
          id: "w1",
          dayOfWeek: 1,
          startMinute: 9 * 60,
          endMinute: 13 * 60,
          timezone: "UTC",
        },
        agentIds: ["agent-x"],
      },
      {
        window: {
          id: "w2",
          dayOfWeek: 1,
          startMinute: 13 * 60,
          endMinute: 17 * 60,
          timezone: "UTC",
        },
        agentIds: ["agent-y"],
      },
    ];
    const result = computeCoverage({
      companyTimezone: "UTC",
      requiredHours: requiredMonUtc(9, 17),
      windows,
      referenceInstant: REFERENCE_MONDAY,
    });

    expect(result.gaps).toEqual([]);
    expect(result.covered).toHaveLength(2);
    expect(result.covered[0].agent_ids).toEqual(["agent-x"]);
    expect(result.covered[1].agent_ids).toEqual(["agent-y"]);
  });

  it("merges overlapping agents into one sorted covered set", () => {
    const windows = [
      {
        window: {
          id: "w1",
          dayOfWeek: 1,
          startMinute: 9 * 60,
          endMinute: 17 * 60,
          timezone: "UTC",
        },
        agentIds: ["agent-y"],
      },
      {
        window: {
          id: "w2",
          dayOfWeek: 1,
          startMinute: 9 * 60,
          endMinute: 17 * 60,
          timezone: "UTC",
        },
        agentIds: ["agent-x"],
      },
    ];
    const result = computeCoverage({
      companyTimezone: "UTC",
      requiredHours: requiredMonUtc(9, 17),
      windows,
      referenceInstant: REFERENCE_MONDAY,
    });

    expect(result.covered).toHaveLength(1);
    expect(result.covered[0].agent_ids).toEqual(["agent-x", "agent-y"]);
  });

  it("converts a window authored in another timezone into the company timezone", () => {
    // Asia/Kolkata is UTC+5:30, so 14:30-22:30 there is 09:00-17:00 UTC.
    const windows = [
      {
        window: {
          id: "w1",
          dayOfWeek: 1,
          startMinute: 14 * 60 + 30,
          endMinute: 22 * 60 + 30,
          timezone: "Asia/Kolkata",
        },
        agentIds: ["agent-x"],
      },
    ];
    const result = computeCoverage({
      companyTimezone: "UTC",
      requiredHours: requiredMonUtc(9, 17),
      windows,
      referenceInstant: REFERENCE_MONDAY,
    });

    expect(result.gaps).toEqual([]);
    expect(result.covered).toHaveLength(1);
    expect(result.covered[0].agent_ids).toEqual(["agent-x"]);
  });

  it("resolves the requested reference week, including past and future weeks", () => {
    const pastResult = computeCoverage({
      companyTimezone: "UTC",
      requiredHours: requiredMonUtc(9, 17),
      windows: [],
      referenceInstant: DateTime.fromISO("2020-03-15T00:00:00Z"),
    });
    const futureResult = computeCoverage({
      companyTimezone: "UTC",
      requiredHours: requiredMonUtc(9, 17),
      windows: [],
      referenceInstant: DateTime.fromISO("2030-03-15T00:00:00Z"),
    });

    expect(DateTime.fromISO(pastResult.week_start).weekday).toBe(1);
    expect(DateTime.fromISO(futureResult.week_start).weekday).toBe(1);
    expect(pastResult.week_start < futureResult.week_start).toBe(true);
    // No windows at all: the whole required range is a gap.
    expect(pastResult.total_gap_minutes).toBe(8 * 60);
  });

  it("creates no slot for a spring-forward hour that never occurs", () => {
    // 2026-03-08 is the US spring-forward Sunday: 02:00 -> 03:00 America/New_York.
    const referenceInstant = DateTime.fromISO("2026-03-08T00:00:00", {
      zone: "America/New_York",
    });
    const requiredHours: WindowSpec[] = [
      {
        id: "required",
        dayOfWeek: 7,
        startMinute: 1 * 60,
        endMinute: 4 * 60,
        timezone: "America/New_York",
      },
    ];

    const result = computeCoverage({
      companyTimezone: "America/New_York",
      requiredHours,
      windows: [],
      referenceInstant,
    });

    // A normal day would have 180 required minutes (01:00-04:00); the clock
    // skips an hour, so only 120 real minutes actually elapse.
    expect(result.total_gap_minutes).toBe(120);
  });

  it("doubles elapsed minutes across a fall-back repeated hour", () => {
    // 2026-11-01 is the US fall-back Sunday: 02:00 -> 01:00 America/New_York.
    const referenceInstant = DateTime.fromISO("2026-11-01T00:00:00", {
      zone: "America/New_York",
    });
    const requiredHours: WindowSpec[] = [
      {
        id: "required",
        dayOfWeek: 7,
        startMinute: 30,
        endMinute: 2 * 60 + 30,
        timezone: "America/New_York",
      },
    ];

    const result = computeCoverage({
      companyTimezone: "America/New_York",
      requiredHours,
      windows: [],
      referenceInstant,
    });

    // A normal day would have 120 required minutes (00:30-02:30); the 01:00
    // hour happens twice, so 180 real minutes elapse.
    expect(result.total_gap_minutes).toBe(180);
  });

  it("reports the uncovered pass of a repeated hour as a gap when only one pass is covered", () => {
    const referenceInstant = DateTime.fromISO("2026-11-01T00:00:00", {
      zone: "America/New_York",
    });
    const requiredHours: WindowSpec[] = [
      {
        id: "required",
        dayOfWeek: 7,
        startMinute: 1 * 60,
        endMinute: 2 * 60,
        timezone: "America/New_York",
      },
    ];
    // Authored in UTC, this window is active only during 05:00-06:00 UTC,
    // which is exactly the *first* (EDT) real pass of local 01:00-02:00.
    const windows = [
      {
        window: {
          id: "w1",
          dayOfWeek: 7,
          startMinute: 5 * 60,
          endMinute: 6 * 60,
          timezone: "UTC",
        },
        agentIds: ["agent-x"],
      },
    ];

    const result = computeCoverage({
      companyTimezone: "America/New_York",
      requiredHours,
      windows,
      referenceInstant,
    });

    expect(result.total_gap_minutes).toBe(60);
    const coveredMinutes = result.covered.reduce(
      (sum, interval) =>
        sum +
        DateTime.fromISO(interval.end).diff(
          DateTime.fromISO(interval.start),
          "minutes",
        ).minutes,
      0,
    );
    expect(coveredMinutes).toBe(60);
  });
});
