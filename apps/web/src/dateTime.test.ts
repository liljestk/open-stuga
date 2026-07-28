import { describe, expect, it } from "vitest";
import { formatInTimeZone, getDateTimeFormatter, twentyFourHourInputLocale } from "./dateTime";

describe("24-hour date and time formatting", () => {
  it("uses 00–23 hours even for English locales", () => {
    const late = formatInTimeZone("2026-07-28T23:05:06.000Z", "en-US", "UTC", {
      dateStyle: "medium",
      timeStyle: "short",
    });
    const midnight = formatInTimeZone("2026-07-28T00:05:06.000Z", "en-US", "UTC", {
      hour: "2-digit",
      minute: "2-digit",
    });

    expect(late).toContain("23:05");
    expect(midnight).toBe("00:05");
    expect(`${late} ${midnight}`).not.toMatch(/\b(?:AM|PM)\b/i);
  });

  it("overrides a caller-provided 12-hour preference", () => {
    const formatter = getDateTimeFormatter("en-US", {
      hour: "2-digit",
      minute: "2-digit",
      hour12: true,
      timeZone: "UTC",
    });

    expect(formatter.format(new Date("2026-07-28T23:05:00.000Z"))).toBe("23:05");
  });

  it("gives native time controls a 24-hour regional locale", () => {
    expect(twentyFourHourInputLocale("en-US")).toBe("en-GB");
    expect(twentyFourHourInputLocale("fi")).toBe("fi-FI");
    expect(twentyFourHourInputLocale("sv")).toBe("sv-SE");
  });
});
