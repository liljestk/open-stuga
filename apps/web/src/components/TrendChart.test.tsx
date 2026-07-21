import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { createDemoState } from "../domain";
import { I18nProvider } from "../i18n";
import { definitionFor } from "../measurements";
import { timelineValueDomain, TrendChart } from "./TrendChart";

describe("TrendChart", () => {
  it("auto-scales the vertical axis to the visible values", () => {
    const definition = definitionFor(createDemoState().measurementDefinitions, "power");

    const domain = timelineValueDomain(definition, [150, 155, 160]);

    expect(domain).not.toBeNull();
    expect(domain!.min).toBeCloseTo(149);
    expect(domain!.max).toBeCloseTo(161);
    expect(domain!.max).toBeLessThan(definition.displayMax!);
  });

  it("gives a flat series readable padding without crossing a physical boundary", () => {
    const definition = definitionFor(createDemoState().measurementDefinitions, "power");

    expect(timelineValueDomain(definition, [155.5])).toEqual({ min: 147.725, max: 163.275 });
    expect(timelineValueDomain(definition, [0])).toEqual({ min: 0, max: 3 });
  });

  it("does not emit React duplicate-key warnings when observed and forecast points share one timestamp", () => {
    const state = createDemoState();
    const sensor = state.sensors[0]!;
    const definition = definitionFor(state.measurementDefinitions, "temperature");
    const timestamp = new Date().toISOString();
    const observed = {
      ...state.latestMeasurements[sensor.id]!.temperature!,
      timestamp,
      value: 21,
    };
    const forecast = {
      sensorId: sensor.id,
      metric: definition.id,
      timestamp,
      value: 21.5,
      low: 21,
      high: 22,
    };
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => undefined);

    try {
      const { container } = render(
        <I18nProvider>
          <TrendChart
            sensor={sensor} history={[observed]} forecast={[forecast]}
            definition={definition} units="metric" range="24h" onRange={vi.fn()}
          />
        </I18nProvider>,
      );

      expect(screen.getByRole("group", { name: /Temperature history and forecast/ })).not.toBeNull();
      expect(container.querySelectorAll(".chart-points [tabindex]")).toHaveLength(0);
      expect(screen.getByRole("group", { name: /Temperature history and forecast/ }).getAttribute("aria-describedby")).toBeTruthy();
      expect(screen.queryByRole("table")).toBeNull();
      expect(container.querySelector("tbody")).toBeNull();
      fireEvent.click(screen.getByText("Show exact data", { selector: "summary" }));
      expect(screen.getByRole("table", { name: /Temperature history and forecast/ })).not.toBeNull();
      expect(container.querySelector("tbody")).not.toBeNull();
      const duplicateKeyWarnings = consoleError.mock.calls.filter((call) => (
        call.some((part) => /same key|unique key/i.test(String(part)))
      ));
      expect(duplicateKeyWarnings).toEqual([]);
    } finally {
      consoleError.mockRestore();
    }
  });
});
