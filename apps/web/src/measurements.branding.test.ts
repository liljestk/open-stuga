import { describe, expect, it } from "vitest";
import type { MeasurementDefinition, MeasurementColorScale } from "@climate-twin/contracts";
import { BUILTIN_MEASUREMENTS, measurementColor, measurementComparisonColor } from "./measurements";

function channels(color: string): number[] {
  return color.match(/\d+/g)?.map(Number) ?? [];
}

function definition(colorScale: MeasurementColorScale): MeasurementDefinition {
  return BUILTIN_MEASUREMENTS.find((item) => item.colorScale === colorScale) ?? {
    ...BUILTIN_MEASUREMENTS[0]!,
    id: "custom",
    colorScale,
    builtin: false,
  };
}

describe("Stuga measurement ramps", () => {
  it.each([
    ["thermal", "rgb(33 102 172)", "rgb(242 235 221)", "rgb(181 65 34)"],
    ["humidity", "rgb(216 240 246)", "rgb(42 132 184)", "rgb(18 61 117)"],
    ["air-quality", "rgb(231 241 248)", "rgb(210 155 0)", "rgb(140 45 4)"],
    ["sequential", "rgb(231 224 243)", "rgb(123 106 181)", "rgb(63 40 95)"],
  ] as const)("keeps the %s endpoints and midpoint stable", (scale, low, middle, high) => {
    const item = definition(scale);
    expect(measurementColor(0, 0, 100, item)).toBe(low);
    expect(measurementColor(50, 0, 100, item)).toBe(middle);
    expect(measurementColor(100, 0, 100, item)).toBe(high);
  });

  it("orders outside temperature against indoor temperature on the same thermal domain", () => {
    const thermal = definition("thermal");
    const colderOutside = measurementComparisonColor(thermal, [21], 5)!;
    const warmerOutside = measurementComparisonColor(thermal, [21], 28)!;
    const indoorOnColdDomain = measurementColor(21, colderOutside.domain.min, colderOutside.domain.max, thermal);
    const indoorOnWarmDomain = measurementColor(21, warmerOutside.domain.min, warmerOutside.domain.max, thermal);
    const warmth = (color: string) => {
      const [red = 0, , blue = 0] = channels(color);
      return red - blue;
    };

    expect(warmth(colderOutside.color)).toBeLessThan(warmth(indoorOnColdDomain));
    expect(warmth(warmerOutside.color)).toBeGreaterThan(warmth(indoorOnWarmDomain));
  });

  it("orders outside humidity against indoor humidity on the same humidity domain", () => {
    const humidity = definition("humidity");
    const drierOutside = measurementComparisonColor(humidity, [45], 30)!;
    const wetterOutside = measurementComparisonColor(humidity, [45], 80)!;
    const indoorOnDryDomain = measurementColor(45, drierOutside.domain.min, drierOutside.domain.max, humidity);
    const indoorOnWetDomain = measurementColor(45, wetterOutside.domain.min, wetterOutside.domain.max, humidity);
    const lightness = (color: string) => channels(color).reduce((sum, channel) => sum + channel, 0);

    expect(lightness(drierOutside.color)).toBeGreaterThan(lightness(indoorOnDryDomain));
    expect(lightness(wetterOutside.color)).toBeLessThan(lightness(indoorOnWetDomain));
  });
});
