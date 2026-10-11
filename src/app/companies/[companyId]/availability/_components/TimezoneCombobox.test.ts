import { describe, expect, it } from "vitest";
import { ALL_TIMEZONES } from "./TimezoneCombobox";

describe("ALL_TIMEZONES", () => {
  it("includes UTC even though Intl.supportedValuesOf('timeZone') omits it", () => {
    // Regression: on current Node/Chromium runtimes,
    // Intl.supportedValuesOf("timeZone") does not return "UTC", although the
    // server accepts it and it's a common schedule zone. Without this, a
    // team lead could never select UTC from the combobox.
    expect(ALL_TIMEZONES).toContain("UTC");
  });

  it("has no duplicate entries", () => {
    expect(new Set(ALL_TIMEZONES).size).toBe(ALL_TIMEZONES.length);
  });
});
