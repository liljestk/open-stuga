import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { createDemoState } from "../domain";
import { I18nProvider } from "../i18n";
import { definitionFor } from "../measurements";
import { RoomComparisonChart } from "./RoomComparisonChart";

describe("RoomComparisonChart", () => {
  it("uses line and point patterns and exposes exact values without point tab stops", async () => {
    const user = userEvent.setup();
    const state = createDemoState();
    const house = state.houses[0]!;
    const sensors = state.sensors.filter((sensor) => sensor.houseId === house.id);
    const definition = definitionFor(state.measurementDefinitions, "temperature");
    const { container } = render(
      <I18nProvider>
        <RoomComparisonChart
          sensors={sensors} selectedSensorId={sensors[0]!.id} history={state.measurementHistory}
          definition={definition} units="metric" range="24h" weather={null} alerts={[]}
          observations={[]} warnings={[]} timeZone={house.timezone} onRange={vi.fn()} onLoadSeries={vi.fn()}
        />
      </I18nProvider>,
    );

    const second = sensors[1]!;
    await user.click(screen.getByRole("button", { name: second.room.trim() || second.name }));
    const patternedLine = container.querySelector('.comparison-line[stroke-dasharray="12 6"]');
    expect(patternedLine).not.toBeNull();
    expect(container.querySelector(".comparison-points rect")).not.toBeNull();
    expect(container.querySelectorAll(".comparison-points [tabindex]")).toHaveLength(0);
    expect(screen.getByRole("img", { name: /Comparison chart for Temperature/i }).getAttribute("aria-describedby")).toBeTruthy();

    expect(screen.queryByRole("table")).toBeNull();
    expect(container.querySelector("tbody")).toBeNull();
    await user.click(screen.getByText("Show exact data", { selector: "summary" }));
    expect(screen.getByRole("table", { name: /Comparison chart for Temperature/i })).not.toBeNull();
    expect(container.querySelector("tbody")).not.toBeNull();
  });
});
