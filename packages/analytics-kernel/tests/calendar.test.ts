import { describe, expect, it } from "vitest";
import { addLocalDays, daysInMonth, localDate, localDateStart, validLocalDate, zonedParts } from "../src/index.js";

const hour = 3_600_000;

describe("local calendar", () => {
  it("resolves local midnights across daylight-saving changes", () => {
    const springStart = localDateStart({ year: 2026, month: 3, day: 29 }, "Europe/Helsinki")!;
    const springNext = localDateStart({ year: 2026, month: 3, day: 30 }, "Europe/Helsinki")!;
    expect(new Date(springStart).toISOString()).toBe("2026-03-28T22:00:00.000Z");
    expect(springNext - springStart).toBe(23 * hour);
    const autumnStart = localDateStart({ year: 2026, month: 10, day: 25 }, "Europe/Helsinki")!;
    const autumnNext = localDateStart({ year: 2026, month: 10, day: 26 }, "Europe/Helsinki")!;
    expect(autumnNext - autumnStart).toBe(25 * hour);
  });

  it("reads and steps civil dates without time-zone drift", () => {
    expect(localDate(Date.parse("2026-10-24T21:30:00Z"), "Europe/Helsinki")).toEqual({ year: 2026, month: 10, day: 25 });
    expect(zonedParts(Date.parse("2026-01-01T00:00:05Z"), "UTC")).toEqual([2026, 1, 1, 0, 0, 5]);
    expect(addLocalDays({ year: 2028, month: 2, day: 28 }, 1)).toEqual({ year: 2028, month: 2, day: 29 });
    expect(daysInMonth(2027, 2)).toBe(28);
    expect(validLocalDate({ year: 2027, month: 2, day: 29 })).toBe(false);
    expect(localDateStart({ year: 2027, month: 2, day: 29 }, "UTC")).toBeNull();
  });
});
