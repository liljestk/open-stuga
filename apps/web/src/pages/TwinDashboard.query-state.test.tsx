import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { useState } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Metric } from "@climate-twin/contracts";

import { createDemoState, type ClimateState, type ViewMode } from "../domain";
import { I18nProvider } from "../i18n";
import { TwinDashboard } from "./TwinDashboard";
import {
  defaultTwinDashboardQuerySelection,
  readTwinDashboardQuerySelection,
  twinDashboardLocation,
  type TwinDashboardQueryOptions,
} from "./TwinDashboard/queryState";

const options: TwinDashboardQueryOptions = {
  floorIds: ["ground", "upper"],
  metricIds: ["temperature", "humidity"],
  sensors: [
    { id: "ground-main", floorId: "ground" },
    { id: "ground-secondary", floorId: "ground" },
    { id: "upper-main", floorId: "upper" },
  ],
  defaultFloorId: "ground",
  defaultMetric: "temperature",
};

function DashboardHarness({ state }: Readonly<{ state: ClimateState }>) {
  const house = state.houses[0]!;
  const [floorId, setFloorId] = useState(house.floors[0]!.id);
  const [metric, setMetric] = useState<Metric>("temperature");
  const [viewMode, setViewMode] = useState<ViewMode>("plan");
  const [selectedSensorId, setSelectedSensorId] = useState<string | null>(
    state.sensors.find((sensor) => sensor.houseId === house.id && sensor.floorId === floorId)?.id ?? null,
  );
  const floor = house.floors.find((candidate) => candidate.id === floorId) ?? house.floors[0]!;

  return <I18nProvider>
    <output data-testid="selection">{[floorId, metric, viewMode, selectedSensorId].join("|")}</output>
    <TwinDashboard
      state={state}
      house={house}
      floor={floor}
      houseId={house.id}
      floorId={floorId}
      metric={metric}
      units="metric"
      viewMode={viewMode}
      selectedSensorId={selectedSensorId}
      saveState="idle"
      scenario="normal"
      dataMode="demo"
      onHouse={vi.fn()}
      onFloor={setFloorId}
      onMetric={setMetric}
      onViewMode={setViewMode}
      onSensorSelect={setSelectedSensorId}
      onSensorMove={vi.fn()}
      onSensorUpdate={vi.fn(async (sensorId) => state.sensors.find((sensor) => sensor.id === sensorId)!)}
      onFloorChange={vi.fn()}
      onSaveLayout={vi.fn()}
      onLoadSeries={vi.fn()}
      onRunScenario={vi.fn()}
      onCreateObservation={vi.fn().mockResolvedValue(state.observations[0]!)}
      onCreateStaticParameter={vi.fn().mockResolvedValue(state.staticParameters[0]!)}
    />
  </I18nProvider>;
}

afterEach(() => {
  window.history.replaceState({}, "", "/");
});

describe("TwinDashboard query state", () => {
  it("validates values, keeps unrelated parameters, and omits defaults", () => {
    expect(readTwinDashboardQuerySelection(
      "?floor=upper&metric=humidity&view=isometric&sensor=upper-main&range=7d",
      options,
    )).toEqual({
      floorId: "upper",
      metric: "humidity",
      viewMode: "isometric",
      selectedSensorId: "upper-main",
      range: "7d",
    });

    expect(readTwinDashboardQuerySelection(
      "?floor=missing&metric=co2&view=orbit&sensor=upper-main&range=30d",
      options,
    )).toEqual(defaultTwinDashboardQuerySelection(options));

    expect(twinDashboardLocation(
      "https://stugu.test/properties/property/homes/home?keep=1&floor=upper&metric=humidity&view=isometric&sensor=upper-main&range=7d#readings",
      defaultTwinDashboardQuerySelection(options),
      options,
    )).toBe("/properties/property/homes/home?keep=1#readings");

    expect(twinDashboardLocation(
      "https://stugu.test/properties/property/homes/home?keep=1#readings",
      {
        floorId: "ground",
        metric: "humidity",
        viewMode: "isometric",
        selectedSensorId: "ground-secondary",
        range: "7d",
      },
      options,
    )).toBe("/properties/property/homes/home?keep=1&metric=humidity&view=isometric&range=7d&sensor=ground-secondary#readings");
  });

  it("restores every selection on load and popstate while preserving unrelated query state", async () => {
    const state = createDemoState();
    window.history.replaceState({}, "", "/properties/property-pine/homes/house-pine?keep=one&floor=floor-upper&metric=humidity&view=isometric&sensor=sensor-bathroom&range=7d#readings");

    render(<DashboardHarness state={state} />);

    await waitFor(() => expect(screen.getByTestId("selection")).toHaveTextContent(
      "floor-upper|humidity|isometric|sensor-bathroom",
    ));
    expect(screen.getByRole("button", { name: "Hide live home view" })).toHaveAttribute("aria-expanded", "true");
    expect(screen.getByLabelText("Floor")).toHaveValue("floor-upper");
    expect(new URLSearchParams(window.location.search).get("keep")).toBe("one");
    fireEvent.click(screen.getByText("Open analysis tools"));
    expect(await screen.findByRole("button", { name: "7 days" })).toHaveAttribute("aria-pressed", "true");

    window.history.pushState({}, "", "/properties/property-pine/homes/house-pine?keep=two&range=6h#readings");
    fireEvent(window, new PopStateEvent("popstate"));

    const defaultSensorId = state.sensors.find((sensor) => (
      sensor.houseId === state.houses[0]!.id && sensor.floorId === state.houses[0]!.floors[0]!.id && sensor.enabled
    ))!.id;
    await waitFor(() => expect(screen.getByTestId("selection")).toHaveTextContent(
      `floor-ground|temperature|plan|${defaultSensorId}`,
    ));
    await waitFor(() => expect(screen.getByRole("button", { name: "6 hours" })).toHaveAttribute("aria-pressed", "true"));
    expect(new URLSearchParams(window.location.search).get("keep")).toBe("two");

    fireEvent.click(screen.getByRole("button", { name: "24 hours" }));
    await waitFor(() => expect(new URLSearchParams(window.location.search).has("range")).toBe(false));
    expect(new URLSearchParams(window.location.search).get("keep")).toBe("two");
    expect(window.location.hash).toBe("#readings");
  });

  it("writes floor, metric, view, sensor, and range controls without dropping route context", async () => {
    window.history.replaceState({}, "", "/properties/property-pine/homes/house-pine?keep=context#live");
    render(<DashboardHarness state={createDemoState()} />);

    fireEvent.click(screen.getByRole("button", { name: "Open live home view" }));
    fireEvent.change(await screen.findByLabelText("Floor"), { target: { value: "floor-upper" } });
    await waitFor(() => expect(new URLSearchParams(window.location.search).get("floor")).toBe("floor-upper"));
    expect(new URLSearchParams(window.location.search).has("sensor")).toBe(false);

    fireEvent.change(screen.getByLabelText("Metric"), { target: { value: "humidity" } });
    fireEvent.keyDown(await screen.findByRole("button", { name: /^Bathroom,/ }), { key: "Enter" });
    await waitFor(() => expect(screen.getByTestId("selection")).toHaveTextContent("sensor-bathroom"));
    fireEvent.click(screen.getByRole("button", { name: "3D building" }));
    fireEvent.click(screen.getByText("Open analysis tools"));
    fireEvent.click(await screen.findByRole("button", { name: "7 days" }));

    await waitFor(() => {
      const params = new URLSearchParams(window.location.search);
      expect(params.get("floor")).toBe("floor-upper");
      expect(params.get("metric")).toBe("humidity");
      expect(params.get("view")).toBe("isometric");
      expect(params.get("sensor")).toBe("sensor-bathroom");
      expect(params.get("range")).toBe("7d");
      expect(params.get("keep")).toBe("context");
    });
    expect(window.location.hash).toBe("#live");
  });

  it("returns focus to the Home heading when the primary live-view launcher is unavailable", async () => {
    const demo = createDemoState();
    const state: ClimateState = {
      ...demo,
      readings: {},
      latestMeasurements: {},
      measurementHistory: {},
    };
    window.history.replaceState({}, "", "/properties/property-pine/homes/house-pine?view=isometric");
    render(<DashboardHarness state={state} />);

    const hideLiveView = await screen.findByRole("button", { name: "Hide live home view" });
    hideLiveView.focus();
    fireEvent.click(hideLiveView);

    await waitFor(() => expect(screen.getByRole("heading", { level: 1 })).toHaveFocus());
  });
});
