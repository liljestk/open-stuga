import type { WeatherWarning } from "@climate-twin/contracts";
import { describe, expect, it } from "vitest";
import { homeRelevantWeatherWarnings, isHomeRelevantWeatherWarning } from "./weatherWarningRelevance";

function warning(event: string, headline = event): WeatherWarning {
  return {
    id: event,
    event,
    headline,
    description: "",
    severity: "moderate",
    urgency: "expected",
    certainty: "likely",
    effectiveAt: null,
    onsetAt: null,
    expiresAt: null,
    areas: [],
    web: null,
  };
}

describe("home weather warning relevance", () => {
  it.each([
    ["UV advisory", false],
    ["Strong ultraviolet radiation", false],
    ["Pedestrian weather warning", false],
    ["Road weather warning", false],
    ["Traffic weather warning", false],
    ["Heat wave warning", true],
    ["Wildfire warning", true],
    ["Wind warning", true],
    ["New provider hazard category", true],
  ])("classifies %s", (event, expected) => {
    expect(isHomeRelevantWeatherWarning(warning(event))).toBe(expected);
  });

  it("also checks the official headline and preserves source order", () => {
    const warnings = [
      warning("Weather advisory", "High ultraviolet radiation"),
      warning("Weather warning", "Strong wind near the coast"),
      warning("Weather warning", "Forest fire danger"),
    ];

    expect(homeRelevantWeatherWarnings(warnings).map((item) => item.headline)).toEqual([
      "Strong wind near the coast",
      "Forest fire danger",
    ]);
  });
});
