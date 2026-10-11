import { describe, expect, it } from "vitest";
import {
  HH_MM_PATTERN,
  minutesToTimeString,
  timeStringToMinutes,
} from "./time";

describe("timeStringToMinutes", () => {
  it("parses midnight as 0", () => {
    expect(timeStringToMinutes("00:00")).toBe(0);
  });

  it("parses the last minute of the day", () => {
    expect(timeStringToMinutes("23:59")).toBe(23 * 60 + 59);
  });

  it("parses an ordinary mid-day time", () => {
    expect(timeStringToMinutes("09:30")).toBe(9 * 60 + 30);
  });

  it("parses a single-digit hour with its required leading zero", () => {
    expect(timeStringToMinutes("05:00")).toBe(5 * 60);
  });

  it.each([
    "24:00", // hour out of range
    "12:60", // minute out of range
    "9:00", // missing leading zero
    "09:5", // missing leading zero on minute
    "09-00", // wrong separator
    "abc",
    "",
    "9:00:00",
  ])("throws for an invalid time string %j", (value) => {
    expect(() => timeStringToMinutes(value)).toThrow(/Invalid HH:mm/);
  });
});

describe("minutesToTimeString", () => {
  it("formats 0 as midnight", () => {
    expect(minutesToTimeString(0)).toBe("00:00");
  });

  it("formats 1439 as the last minute of the day", () => {
    expect(minutesToTimeString(23 * 60 + 59)).toBe("23:59");
  });

  it("pads single-digit hours and minutes", () => {
    expect(minutesToTimeString(5 * 60 + 3)).toBe("05:03");
  });
});

describe("timeStringToMinutes / minutesToTimeString round trip", () => {
  it.each([
    "00:00",
    "09:30",
    "17:00",
    "22:00",
    "23:59",
  ])("round-trips %s", (value) => {
    expect(minutesToTimeString(timeStringToMinutes(value))).toBe(value);
  });
});

describe("HH_MM_PATTERN", () => {
  it.each(["00:00", "09:30", "23:59"])("matches valid time %s", (value) => {
    expect(HH_MM_PATTERN.test(value)).toBe(true);
  });

  it.each([
    "24:00",
    "12:60",
    "9:00",
    "",
  ])("rejects invalid time %j", (value) => {
    expect(HH_MM_PATTERN.test(value)).toBe(false);
  });
});
