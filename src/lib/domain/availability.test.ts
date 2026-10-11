import { DateTime } from "luxon";
import { describe, expect, it } from "vitest";
import {
  findActiveWindow,
  isAnyWindowActiveAt,
  isWindowActiveAt,
  type WindowSpec,
} from "./availability";

/** Monday of a fixed reference week, at the given zone. */
function monday(zone: string): DateTime {
  return DateTime.fromObject(
    { weekYear: 2026, weekNumber: 10, weekday: 1 },
    { zone },
  ).startOf("day");
}

describe("isWindowActiveAt", () => {
  const daytime: WindowSpec = {
    id: "w1",
    dayOfWeek: 1,
    startMinute: 9 * 60,
    endMinute: 17 * 60,
    timezone: "America/New_York",
  };

  it("is active exactly at the start minute", () => {
    const at = monday("America/New_York").set({ hour: 9, minute: 0 });
    expect(isWindowActiveAt(daytime, at)).toBe(true);
  });

  it("is inactive exactly at the end minute", () => {
    const at = monday("America/New_York").set({ hour: 17, minute: 0 });
    expect(isWindowActiveAt(daytime, at)).toBe(false);
  });

  it("is inactive before the start minute", () => {
    const at = monday("America/New_York").set({ hour: 8, minute: 59 });
    expect(isWindowActiveAt(daytime, at)).toBe(false);
  });

  it("is active one minute before the end", () => {
    const at = monday("America/New_York").set({ hour: 16, minute: 59 });
    expect(isWindowActiveAt(daytime, at)).toBe(true);
  });

  it("is inactive on a different weekday", () => {
    const at = monday("America/New_York")
      .plus({ days: 1 })
      .set({ hour: 10, minute: 0 });
    expect(isWindowActiveAt(daytime, at)).toBe(false);
  });

  describe("overnight windows (start later than end)", () => {
    const overnight: WindowSpec = {
      id: "w2",
      dayOfWeek: 1, // Monday 22:00 -> Tuesday 06:00
      startMinute: 22 * 60,
      endMinute: 6 * 60,
      timezone: "America/New_York",
    };

    it("is active late on the start day", () => {
      const at = monday("America/New_York").set({ hour: 23, minute: 0 });
      expect(isWindowActiveAt(overnight, at)).toBe(true);
    });

    it("is active early on the following day, before the end minute", () => {
      const at = monday("America/New_York")
        .plus({ days: 1 })
        .set({ hour: 5, minute: 59 });
      expect(isWindowActiveAt(overnight, at)).toBe(true);
    });

    it("is inactive at exactly the end minute on the following day", () => {
      const at = monday("America/New_York")
        .plus({ days: 1 })
        .set({ hour: 6, minute: 0 });
      expect(isWindowActiveAt(overnight, at)).toBe(false);
    });

    it("is inactive in the middle of the start day, before the start minute", () => {
      const at = monday("America/New_York").set({ hour: 12, minute: 0 });
      expect(isWindowActiveAt(overnight, at)).toBe(false);
    });

    it("is inactive two days after the start day", () => {
      const at = monday("America/New_York")
        .plus({ days: 2 })
        .set({ hour: 1, minute: 0 });
      expect(isWindowActiveAt(overnight, at)).toBe(false);
    });
  });

  describe("Sunday-to-Monday wrap", () => {
    const sundayOvernight: WindowSpec = {
      id: "w3",
      dayOfWeek: 7,
      startMinute: 22 * 60,
      endMinute: 6 * 60,
      timezone: "America/New_York",
    };

    it("is active late Sunday", () => {
      const sunday = monday("America/New_York").minus({ days: 1 });
      const at = sunday.set({ hour: 23, minute: 0 });
      expect(isWindowActiveAt(sundayOvernight, at)).toBe(true);
    });

    it("is active early Monday, before the end minute", () => {
      const at = monday("America/New_York").set({ hour: 5, minute: 0 });
      expect(isWindowActiveAt(sundayOvernight, at)).toBe(true);
    });

    it("is inactive Monday after the end minute", () => {
      const at = monday("America/New_York").set({ hour: 7, minute: 0 });
      expect(isWindowActiveAt(sundayOvernight, at)).toBe(false);
    });
  });

  it("evaluates in the window's own timezone, independent of the instant's source zone", () => {
    const kolkataWindow: WindowSpec = {
      id: "w4",
      dayOfWeek: 1,
      startMinute: 9 * 60,
      endMinute: 17 * 60,
      timezone: "Asia/Kolkata",
    };
    // 09:30 in Asia/Kolkata (UTC+5:30) on Monday of the reference week.
    const at = monday("Asia/Kolkata").set({ hour: 9, minute: 30 });
    expect(isWindowActiveAt(kolkataWindow, at)).toBe(true);
    // The same instant, viewed from New York, is still inside the window
    // because evaluation always converts into the window's authored zone.
    expect(
      isWindowActiveAt(kolkataWindow, at.setZone("America/New_York")),
    ).toBe(true);
  });
});

describe("isAnyWindowActiveAt", () => {
  const windows: WindowSpec[] = [
    {
      id: "a",
      dayOfWeek: 1,
      startMinute: 9 * 60,
      endMinute: 12 * 60,
      timezone: "UTC",
    },
    {
      id: "b",
      dayOfWeek: 1,
      startMinute: 14 * 60,
      endMinute: 18 * 60,
      timezone: "UTC",
    },
  ];

  it("is true when any window is active", () => {
    const at = monday("UTC").set({ hour: 15, minute: 0 });
    expect(isAnyWindowActiveAt(windows, at)).toBe(true);
  });

  it("is false when no window is active", () => {
    const at = monday("UTC").set({ hour: 13, minute: 0 });
    expect(isAnyWindowActiveAt(windows, at)).toBe(false);
  });
});

describe("findActiveWindow", () => {
  it("returns null when nothing is active", () => {
    const windows: WindowSpec[] = [
      {
        id: "a",
        dayOfWeek: 1,
        startMinute: 9 * 60,
        endMinute: 12 * 60,
        timezone: "UTC",
      },
    ];
    const at = monday("UTC").set({ hour: 13, minute: 0 });
    expect(findActiveWindow(windows, at)).toBeNull();
  });

  it("deterministically picks the lowest (dayOfWeek, startMinute, id) among overlapping active windows", () => {
    const windows: WindowSpec[] = [
      {
        id: "z",
        dayOfWeek: 1,
        startMinute: 8 * 60,
        endMinute: 18 * 60,
        timezone: "UTC",
      },
      {
        id: "a",
        dayOfWeek: 1,
        startMinute: 8 * 60,
        endMinute: 18 * 60,
        timezone: "UTC",
      },
    ];
    const at = monday("UTC").set({ hour: 10, minute: 0 });
    expect(findActiveWindow(windows, at)?.id).toBe("a");
  });

  it("prefers the window with the earlier start minute when both are active", () => {
    const windows: WindowSpec[] = [
      {
        id: "late",
        dayOfWeek: 1,
        startMinute: 9 * 60,
        endMinute: 18 * 60,
        timezone: "UTC",
      },
      {
        id: "early",
        dayOfWeek: 1,
        startMinute: 8 * 60,
        endMinute: 18 * 60,
        timezone: "UTC",
      },
    ];
    const at = monday("UTC").set({ hour: 10, minute: 0 });
    expect(findActiveWindow(windows, at)?.id).toBe("early");
  });
});
