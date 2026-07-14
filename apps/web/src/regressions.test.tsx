import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import type { ReactNode } from "react";
import type { MeasurementDefinition, MeasurementSample, Sensor } from "@climate-twin/contracts";
import styles from "./styles.css?raw";
import { AppShell } from "./components/AppShell";
import { FloorPlan } from "./components/FloorPlan";
import { TrendChart } from "./components/TrendChart";
import { createDemoState, type ClimateState } from "./domain";
import { I18nProvider } from "./i18n";
import { definitionFor } from "./measurements";
import { AlertsPage } from "./pages/AlertsPage";
import { TwinDashboard } from "./pages/TwinDashboard";

function withI18n(node: ReactNode) {
  return <I18nProvider>{node}</I18nProvider>;
}

function samplesFor(state: ClimateState, definition: MeasurementDefinition, sensors: Sensor[] = state.sensors) {
  return Object.fromEntries(sensors.flatMap((sensor) => {
    const sample = state.latestMeasurements[sensor.id]?.[definition.id];
    return sample ? [[sensor.id, sample]] : [];
  })) as Record<string, MeasurementSample>;
}

describe("frontend regressions", () => {
  it("keeps an in-progress temperature threshold stable when units change", async () => {
    const user = userEvent.setup();
    const state = createDemoState();
    const onCreateRule = vi.fn().mockResolvedValue(undefined);
    const view = render(withI18n(
      <AlertsPage state={state} units="metric" onCreateRule={onCreateRule} onAcknowledge={vi.fn()} />,
    ));

    await user.click(screen.getByRole("button", { name: "New rule" }));
    await user.type(screen.getByLabelText("Rule name"), "Cold room");
    await user.selectOptions(screen.getByLabelText("Metric"), "temperature");
    const threshold = screen.getByLabelText(/^Threshold/) as HTMLInputElement;
    expect(Number(threshold.value)).toBe(20);
    await user.clear(threshold);
    await user.type(threshold, "23.5");

    view.rerender(withI18n(
      <AlertsPage state={state} units="imperial" onCreateRule={onCreateRule} onAcknowledge={vi.fn()} />,
    ));
    expect(Number((screen.getByLabelText(/^Threshold/) as HTMLInputElement).value)).toBeCloseTo(74.3, 5);

    await user.click(screen.getByRole("button", { name: "Create rule" }));
    expect(onCreateRule).toHaveBeenCalledOnce();
    const submitted = onCreateRule.mock.calls[0]![0];
    expect(submitted.metric).toBe("temperature");
    expect(submitted.threshold).toBeCloseTo(23.5, 5);
  });

  it("exposes alert-rule severity as text in the rules list", () => {
    render(withI18n(
      <AlertsPage state={createDemoState()} units="metric" onCreateRule={vi.fn()} onAcknowledge={vi.fn()} />,
    ));

    const rules = screen.getByRole("heading", { name: "Rules" }).closest("section");
    expect(rules).not.toBeNull();
    expect(within(rules!).getByText(/Warning/)).not.toBeNull();
  });

  it("removes the closed mobile navigation from interaction and restores it when opened", async () => {
    const user = userEvent.setup();
    const view = render(withI18n(
      <AppShell page="twin" onPage={vi.fn()} connection="offline" units="metric" onUnits={vi.fn()} lastUpdated={null}>
        <p>Content</p>
      </AppShell>,
    ));
    const navigation = screen.getByLabelText("Primary navigation");
    const isInertInMarkup = navigation.hasAttribute("inert") || navigation.getAttribute("aria-hidden") === "true";
    const mobileCss = styles.slice(styles.indexOf("@media (max-width: 900px)"), styles.indexOf("@media (prefers-reduced-motion"));
    const isHiddenInMobileCss = /\.sidebar\s*\{[^}]*\bvisibility\s*:\s*hidden\b[^}]*\}/s.test(mobileCss)
      && /\.sidebar\.sidebar-open\s*\{[^}]*\bvisibility\s*:\s*visible\b[^}]*\}/s.test(mobileCss);
    expect(isInertInMarkup || isHiddenInMobileCss).toBe(true);

    const opener = screen.getByRole("button", { name: "Open navigation" });
    expect(opener.getAttribute("aria-expanded")).toBe("false");
    expect(opener.getAttribute("aria-controls")).toBe(navigation.id);
    await user.click(opener);
    expect(navigation.hasAttribute("inert")).toBe(false);
    expect(navigation.getAttribute("aria-hidden")).not.toBe("true");
    expect(opener.getAttribute("aria-expanded")).toBe("true");
    await waitFor(() => expect(document.activeElement).toBe(within(navigation).getByRole("button", { name: "Close navigation" })));

    await user.keyboard("{Escape}");
    await waitFor(() => expect(document.activeElement).toBe(opener));
    view.unmount();
  });

  it("supports keyboard placement of observations and walls on the floor map", async () => {
    const user = userEvent.setup();
    const state = createDemoState();
    const floor = state.houses[0]!.floors[0]!;
    const sensors = state.sensors.filter((sensor) => sensor.floorId === floor.id);
    const definition = definitionFor(state.measurementDefinitions, "temperature");
    const samples = samplesFor(state, definition, sensors);
    const onObservationPoint = vi.fn();
    const observationView = render(withI18n(
      <FloorPlan
        floor={floor} sensors={sensors} samples={samples} observations={state.observations}
        definition={definition} units="metric" viewMode="plan" selectedSensorId={null} editing={false}
        observationPlacement onSensorSelect={vi.fn()} onSensorMove={vi.fn()} onFloorChange={vi.fn()}
        onObservationPoint={onObservationPoint} onCancelObservationPlacement={vi.fn()}
      />,
    ));
    const observationMap = screen.getByRole("group", { name: /Temperature map for Ground floor/i });
    expect(observationMap.getAttribute("tabindex")).toBe("0");
    observationMap.focus();
    await user.keyboard("{Enter}");
    expect(onObservationPoint).toHaveBeenCalledOnce();
    expect(onObservationPoint.mock.calls[0]![0].x).toBeGreaterThanOrEqual(0);
    expect(onObservationPoint.mock.calls[0]![0].x).toBeLessThanOrEqual(floor.width);
    expect(onObservationPoint.mock.calls[0]![0].y).toBeGreaterThanOrEqual(0);
    expect(onObservationPoint.mock.calls[0]![0].y).toBeLessThanOrEqual(floor.height);
    observationView.unmount();

    const onFloorChange = vi.fn();
    render(withI18n(
      <FloorPlan
        floor={floor} sensors={sensors} samples={samples} observations={state.observations}
        definition={definition} units="metric" viewMode="plan" selectedSensorId={null} editing
        observationPlacement={false} onSensorSelect={vi.fn()} onSensorMove={vi.fn()} onFloorChange={onFloorChange}
        onObservationPoint={vi.fn()} onCancelObservationPlacement={vi.fn()}
      />,
    ));
    await user.click(screen.getByRole("button", { name: "Draw wall" }));
    const wallMap = screen.getByRole("group", { name: /Temperature map for Ground floor/i });
    wallMap.focus();
    await user.keyboard("{Enter}{ArrowRight}{Enter}");
    expect(onFloorChange).toHaveBeenCalledOnce();
    const changedFloor = onFloorChange.mock.calls[0]![0];
    const wall = changedFloor.walls.at(-1);
    expect(wall.from).not.toEqual(wall.to);
  });

  it("rejects unsafe or oversized floor-plan uploads before reading them", () => {
    const state = createDemoState();
    const floor = state.houses[0]!.floors[0]!;
    const definition = definitionFor(state.measurementDefinitions, "temperature");
    const onFloorChange = vi.fn();
    render(withI18n(
      <FloorPlan
        floor={floor} sensors={[]} samples={{}} observations={[]} definition={definition} units="metric"
        viewMode="plan" selectedSensorId={null} editing observationPlacement={false}
        onSensorSelect={vi.fn()} onSensorMove={vi.fn()} onFloorChange={onFloorChange}
        onObservationPoint={vi.fn()} onCancelObservationPlacement={vi.fn()}
      />,
    ));
    const input = screen.getByLabelText("Upload floor plan");

    fireEvent.change(input, { target: { files: [new File(["<svg/>"] , "plan.svg", { type: "image/svg+xml" })] } });
    expect(screen.getByRole("alert").textContent).toMatch(/valid PNG, JPG or WEBP/i);

    const oversized = new File([new Uint8Array(10 * 1024 * 1024 + 1)], "plan.png", { type: "image/png" });
    fireEvent.change(input, { target: { files: [oversized] } });
    expect(screen.getByRole("alert").textContent).toMatch(/10 MiB or smaller/i);
    expect(onFloorChange).not.toHaveBeenCalled();
  });

  it("uses group semantics for an interactive trend and has no clock-only live region", () => {
    const state = createDemoState();
    const sensor = state.sensors[0]!;
    const floor = state.houses[0]!.floors.find((item) => item.id === sensor.floorId)!;
    const definition = definitionFor(state.measurementDefinitions, "temperature");
    const view = render(withI18n(
      <>
        <TrendChart
          sensor={sensor} history={state.measurementHistory[sensor.id]?.temperature ?? []}
          forecast={state.measurementForecasts[sensor.id]?.temperature ?? []}
          definition={definition} units="metric" range="24h" onRange={vi.fn()}
        />
        <FloorPlan
          floor={floor} sensors={[sensor]} samples={samplesFor(state, definition, [sensor])} observations={[]}
          definition={definition} units="metric" viewMode="plan" selectedSensorId={sensor.id} editing={false}
          observationPlacement={false} onSensorSelect={vi.fn()} onSensorMove={vi.fn()} onFloorChange={vi.fn()}
          onObservationPoint={vi.fn()} onCancelObservationPlacement={vi.fn()}
        />
      </>,
    ));

    const chart = screen.getByRole("group", { name: /Temperature history and forecast for/i });
    expect(chart.tagName.toLowerCase()).toBe("svg");
    expect(screen.queryByRole("img", { name: /Temperature history and forecast for/i })).toBeNull();
    expect(within(chart).getAllByRole("img").length).toBeGreaterThan(0);
    expect(view.container.querySelector(".floor-plan-wrap [aria-live]")).toBeNull();
  });

  it("keeps CO2 in ppm under imperial display and localizes registry labels in the selector and inspector", () => {
    const state = createDemoState();
    const house = state.houses[0]!;
    const floor = house.floors[0]!;
    const sensor = state.sensors.find((item) => item.houseId === house.id && item.floorId === floor.id)!;
    const co2Sample = state.latestMeasurements[sensor.id]!.co2!;
    const dashboard = (units: "metric" | "imperial") => (
      <TwinDashboard
        state={state} house={house} floor={floor} houseId={house.id} floorId={floor.id}
        metric="co2" units={units} viewMode="plan" selectedSensorId={sensor.id}
        saveState="idle" scenario="normal" onHouse={vi.fn()} onFloor={vi.fn()} onMetric={vi.fn()}
        onViewMode={vi.fn()} onSensorSelect={vi.fn()} onSensorMove={vi.fn()} onFloorChange={vi.fn()}
        onSensorUpdate={vi.fn()} onSaveLayout={vi.fn()} onLoadSeries={vi.fn()} onRunScenario={vi.fn()}
        onCreateObservation={vi.fn().mockResolvedValue(state.observations[0]!)}
        onCreateStaticParameter={vi.fn().mockResolvedValue(state.staticParameters[0]!)}
      />
    );

    localStorage.setItem("climate-twin-locale", "en");
    const view = render(withI18n(dashboard("metric")));
    const metricPicker = screen.getByRole("combobox", { name: "Metric" });
    expect(within(metricPicker).getByRole("option", { name: /Carbon dioxide.*ppm/ })).not.toBeNull();
    let measurements = screen.getByRole("list", { name: "Available measurements" });
    let co2Item = within(measurements).getByText("Carbon dioxide").closest("[role=listitem]") as HTMLElement;
    expect(within(co2Item).getByText(`${co2Sample.value.toFixed(0)} ppm`)).not.toBeNull();

    view.rerender(withI18n(dashboard("imperial")));
    measurements = screen.getByRole("list", { name: "Available measurements" });
    co2Item = within(measurements).getByText("Carbon dioxide").closest("[role=listitem]") as HTMLElement;
    expect(within(co2Item).getByText(`${co2Sample.value.toFixed(0)} ppm`)).not.toBeNull();
    expect(co2Item.textContent).not.toMatch(/[Â°%]/);
    view.unmount();

    localStorage.setItem("climate-twin-locale", "fi");
    render(withI18n(dashboard("imperial")));
    const finnishPicker = screen.getByRole("combobox", { name: "Mittari" });
    expect(within(finnishPicker).getByRole("option", { name: /Hiilidioksidi.*ppm/ })).not.toBeNull();
    expect(within(screen.getByRole("list", { name: "Saatavilla olevat mittaukset" })).getByText("Hiilidioksidi")).not.toBeNull();
  });

  it("renders custom non-spatial measurements at sensor markers without a heat field or legend", () => {
    const state = createDemoState();
    const floor = state.houses[0]!.floors[0]!;
    const sensors = state.sensors.filter((sensor) => sensor.floorId === floor.id).slice(0, 2);
    const definition: MeasurementDefinition = {
      id: "voc_index", labels: { en: "VOC index", fi: "VOC-indeksi" }, unit: "index", precision: 0,
      validMin: 0, validMax: 500, displayMin: 0, displayMax: 500, interpolationDelta: 10,
      colorScale: "sequential", builtin: false, enabled: true,
      spatialInterpolation: false, forecastSupported: false,
    };
    const samples = Object.fromEntries(sensors.map((sensor, index) => [sensor.id, {
      sensorId: sensor.id, metric: definition.id, value: 80 + index * 40, canonicalUnit: definition.unit,
      timestamp: "2026-07-14T08:00:00.000Z", source: "mock" as const, quality: "good" as const,
    }])) as Record<string, MeasurementSample>;
    const view = render(withI18n(
      <FloorPlan
        floor={floor} sensors={sensors} samples={samples} observations={[]} definition={definition} units="imperial"
        viewMode="plan" selectedSensorId={sensors[0]!.id} editing={false} observationPlacement={false}
        referenceTimeMs={Date.parse("2026-07-14T08:00:00.000Z")}
        onSensorSelect={vi.fn()} onSensorMove={vi.fn()} onFloorChange={vi.fn()}
        onObservationPoint={vi.fn()} onCancelObservationPlacement={vi.fn()}
      />,
    ));

    expect(view.container.querySelectorAll(".sensor-marker")).toHaveLength(sensors.length);
    expect(view.container.querySelectorAll(".heat-field rect")).toHaveLength(0);
    expect(view.container.querySelector(".heat-legend")).toBeNull();
    expect(screen.getByRole("group", { name: /VOC index map for/i })).not.toBeNull();
    expect(screen.getByRole("button", { name: /VOC index, 80 index/i })).not.toBeNull();
  });

  it("explains unsupported forecasts without rendering a predicted line or confidence band", () => {
    const state = createDemoState();
    const sensor = state.sensors[0]!;
    const definition: MeasurementDefinition = {
      id: "voc_index", labels: { en: "VOC index", fi: "VOC-indeksi" }, unit: "index", precision: 0,
      validMin: 0, validMax: 500, displayMin: 0, displayMax: 500, interpolationDelta: 10,
      colorScale: "sequential", builtin: false, enabled: true,
      spatialInterpolation: false, forecastSupported: false,
    };
    const timestamp = new Date().toISOString();
    const view = render(withI18n(
      <TrendChart
        sensor={sensor}
        history={[{ sensorId: sensor.id, metric: definition.id, value: 82, canonicalUnit: definition.unit, timestamp, source: "mock", quality: "good" }]}
        forecast={[{ sensorId: sensor.id, metric: definition.id, value: 95, low: 80, high: 110, timestamp }]}
        definition={definition} units="metric" range="24h" onRange={vi.fn()}
      />,
    ));

    expect(screen.getByText("Forecasts are not available for VOC index.")).not.toBeNull();
    expect(view.container.querySelector(".chart-line.predicted")).toBeNull();
    expect(view.container.querySelector(".confidence-area")).toBeNull();
    expect(view.container.querySelector(".chart-legend .predicted")).toBeNull();
  });

  it("loads durable history once for every enabled house sensor when replay starts", async () => {
    const user = userEvent.setup();
    const state = createDemoState();
    const house = state.houses[0]!;
    const floor = house.floors[0]!;
    const houseSensors = state.sensors.filter((sensor) => sensor.houseId === house.id && sensor.enabled);
    const onLoadSeries = vi.fn();
    render(withI18n(
      <TwinDashboard
        state={state} house={house} floor={floor} houseId={house.id} floorId={floor.id}
        metric="temperature" units="metric" viewMode="plan" selectedSensorId={houseSensors[0]!.id}
        saveState="idle" scenario="normal" onHouse={vi.fn()} onFloor={vi.fn()} onMetric={vi.fn()}
        onViewMode={vi.fn()} onSensorSelect={vi.fn()} onSensorMove={vi.fn()} onFloorChange={vi.fn()}
        onSensorUpdate={vi.fn()} onSaveLayout={vi.fn()} onLoadSeries={onLoadSeries} onRunScenario={vi.fn()}
        onCreateObservation={vi.fn().mockResolvedValue(state.observations[0]!)}
        onCreateStaticParameter={vi.fn().mockResolvedValue(state.staticParameters[0]!)}
      />,
    ));

    await user.click(screen.getByRole("button", { name: "Play replay" }));
    await waitFor(() => {
      expect(new Set(onLoadSeries.mock.calls.map(([sensorId]) => sensorId))).toEqual(new Set(houseSensors.map((sensor) => sensor.id)));
    });
    expect(onLoadSeries).toHaveBeenCalledTimes(houseSensors.length);
  });

  it.each(["warning", "critical"])("keeps dark-mode %s badge contrast at WCAG AA", (severity) => {
    const darkMedia = "@media (prefers-color-scheme: dark)";
    const baseEnd = styles.indexOf(darkMedia);
    const darkStart = styles.indexOf("{", baseEnd) + 1;
    const darkEnd = styles.lastIndexOf("}");
    const baseCss = styles.slice(0, baseEnd);
    const darkCss = styles.slice(darkStart, darkEnd);
    const variables = {
      ...declarationsFor(baseCss, ":root"),
      ...declarationsFor(darkCss, ":root"),
    };
    const badge = {
      ...declarationsFor(baseCss, `.status-badge.${severity}`),
      ...declarationsFor(darkCss, `.status-badge.${severity}`),
    };
    const foreground = resolveVariable(badge.color, variables);
    const background = resolveVariable(badge.background ?? badge["background-color"], variables);
    expect(contrastRatio(foreground, background)).toBeGreaterThanOrEqual(4.5);
  });
});

function declarationsFor(source: string, selector: string) {
  const result: Record<string, string> = {};
  let previousClose = -1;
  let open = source.indexOf("{");
  while (open !== -1) {
    const close = source.indexOf("}", open + 1);
    if (close === -1) break;
    const header = source.slice(previousClose + 1, open);
    if (header.includes(selector)) {
      for (const declaration of source.slice(open + 1, close).split(";")) {
        const colon = declaration.indexOf(":");
        if (colon === -1) continue;
        result[declaration.slice(0, colon).trim()] = declaration.slice(colon + 1).trim();
      }
    }
    previousClose = close;
    open = source.indexOf("{", open + 1);
  }
  return result;
}

function resolveVariable(value: string | undefined, variables: Record<string, string>): string {
  if (!value) throw new Error("Expected a CSS color declaration");
  const match = value.match(/^var\((--[^,)]+)/);
  return match ? resolveVariable(variables[match[1]!], variables) : value;
}

function contrastRatio(foreground: string, background: string) {
  const luminance = (color: string) => {
    const normalized = color.startsWith("#")
      ? color.length === 4
        ? color.slice(1).split("").map((channel) => parseInt(channel + channel, 16))
        : [color.slice(1, 3), color.slice(3, 5), color.slice(5, 7)].map((channel) => parseInt(channel, 16))
      : color.match(/[\d.]+/g)?.slice(0, 3).map(Number) ?? [];
    const channels = normalized;
    if (channels.length !== 3) throw new Error(`Expected an RGB color, received ${color}`);
    const linear = channels.map((channel) => {
      const value = channel / 255;
      return value <= .04045 ? value / 12.92 : ((value + .055) / 1.055) ** 2.4;
    });
    return .2126 * linear[0]! + .7152 * linear[1]! + .0722 * linear[2]!;
  };
  const foregroundLuminance = luminance(foreground);
  const backgroundLuminance = luminance(background);
  return (Math.max(foregroundLuminance, backgroundLuminance) + .05)
    / (Math.min(foregroundLuminance, backgroundLuminance) + .05);
}
