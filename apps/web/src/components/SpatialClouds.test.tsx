import { render, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { MeasurementDefinition, MeasurementSample, Sensor } from "@climate-twin/contracts";
import { createDemoState } from "../domain";
import { I18nProvider } from "../i18n";
import { definitionFor } from "../measurements";
import { createCloudLobes, estimateFieldFlows, interpolateHeat, MAX_SPATIAL_FIELD_CELLS } from "../spatialField";
import styles from "../styles.css?raw";
import { BuildingScene } from "./BuildingScene";
import { FloorPlan } from "./FloorPlan";

const REFERENCE_TIME_MS = Date.parse("2026-07-14T10:00:00.000Z");
const MAX_SAMPLE_AGE_MS = 15 * 60_000;

function samplesFor(
  sensors: Sensor[],
  definition: MeasurementDefinition,
  valueFor: (sensor: Sensor, index: number) => number,
): Record<string, MeasurementSample> {
  return Object.fromEntries(sensors.map((sensor, index) => [sensor.id, {
    sensorId: sensor.id,
    metric: definition.id,
    value: valueFor(sensor, index),
    canonicalUnit: definition.unit,
    timestamp: "2026-07-14T10:00:00.000Z",
    source: "mock" as const,
    quality: "good" as const,
  }]));
}

function renderFloor(
  sensors: Sensor[],
  samples: Record<string, MeasurementSample>,
  definition: MeasurementDefinition,
) {
  const state = createDemoState();
  const floor = state.houses[0]!.floors.find((item) => item.id === sensors[0]?.floorId)
    ?? state.houses[0]!.floors[0]!;
  return render(
    <I18nProvider>
      <FloorPlan
        floor={floor} sensors={sensors} samples={samples} observations={[]} definition={definition}
        units="metric" viewMode="plan" selectedSensorId={null} editing={false} observationPlacement={false}
        referenceTimeMs={REFERENCE_TIME_MS} maxSampleAgeMs={MAX_SAMPLE_AGE_MS}
        onSensorSelect={vi.fn()} onSensorMove={vi.fn()} onFloorChange={vi.fn()}
        onObservationPoint={vi.fn()} onCancelObservationPlacement={vi.fn()}
      />
    </I18nProvider>,
  );
}

function renderBuilding(
  sensors: Sensor[],
  samples: Record<string, MeasurementSample>,
  definition: MeasurementDefinition,
) {
  const state = createDemoState();
  const house = state.houses[0]!;
  return render(
    <I18nProvider>
      <BuildingScene
        house={house} sensors={sensors} samples={samples} observations={[]} definition={definition}
        units="metric" activeFloorId={house.floors[0]!.id} selectedSensorId={null}
        onFloorSelect={vi.fn()} onSensorSelect={vi.fn()}
      />
    </I18nProvider>,
  );
}

function expectHighToLowFlowLabels(container: HTMLElement, selector: string) {
  const paths = [...container.querySelectorAll<SVGPathElement>(selector)];
  expect(paths.length).toBeGreaterThan(0);
  paths.forEach((path) => {
    const flow = path.parentElement;
    const label = flow?.getAttribute("aria-label") ?? "";
    const values = label.match(/-?\d+(?:\.\d+)?/g)?.map(Number) ?? [];
    expect(flow?.getAttribute("role")).toBe("img");
    expect(label).toMatch(/estimated gradient/i);
    expect(values.length).toBeGreaterThanOrEqual(3);
    expect(values[0]).toBeGreaterThan(values[1]!);
    expect(values[2]).toBeGreaterThan(0);
    expect(path.getAttribute("marker-end")).toMatch(/^url\(#/);
  });
}

function setReducedMotion(matches: boolean) {
  vi.stubGlobal("matchMedia", vi.fn().mockImplementation((media: string) => ({
    matches,
    media,
    onchange: null,
    addListener: vi.fn(),
    removeListener: vi.fn(),
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
    dispatchEvent: vi.fn(),
  })));
}

afterEach(() => vi.unstubAllGlobals());

describe("estimated spatial clouds and flows", () => {
  it("renders layered 2D clouds and accessible high-to-low flow estimates", () => {
    const state = createDemoState();
    const floor = state.houses[0]!.floors[0]!;
    const sensors = state.sensors.filter((sensor) => sensor.floorId === floor.id);
    const definition = definitionFor(state.measurementDefinitions, "temperature");
    const samples = samplesFor(sensors, definition, (sensor) => 34 - sensor.x / 50);
    const { container } = renderFloor(sensors, samples, definition);

    expect(container.querySelectorAll(".heat-cloud-lobe").length).toBeGreaterThan(1);
    expectHighToLowFlowLabels(container, ".flow-path");
  });

  it("renders 3D clouds with within-floor and vertical flow cues", () => {
    const state = createDemoState();
    const definition = definitionFor(state.measurementDefinitions, "temperature");
    const groundId = state.houses[0]!.floors[0]!.id;
    const samples = samplesFor(state.sensors, definition, (sensor) =>
      sensor.floorId === groundId ? 34 - sensor.x / 50 : 26 - sensor.x / 60);
    const { container } = renderBuilding(state.sensors, samples, definition);

    expect(container.querySelectorAll(".building-cloud-lobe").length).toBeGreaterThan(1);
    expectHighToLowFlowLabels(container, ".building-flow-path");
    const verticalFlows = [...container.querySelectorAll<SVGGElement>(".vertical-gradient")];
    expect(verticalFlows.length).toBeGreaterThan(0);
    verticalFlows.forEach((flow) => {
      expect(flow.getAttribute("role")).toBe("img");
      expect(flow.getAttribute("aria-label")).not.toBe("");
      expect(flow.querySelector("line")?.getAttribute("marker-end")).toMatch(/^url\(#/);
    });
  });

  it("renders no clouds or flow cues for a non-spatial measurement", () => {
    const state = createDemoState();
    const definition: MeasurementDefinition = {
      id: "voc_index", labels: { en: "VOC index", fi: "VOC-indeksi" }, unit: "index", precision: 0,
      validMin: 0, validMax: 500, displayMin: 0, displayMax: 500, interpolationDelta: 10,
      colorScale: "sequential", builtin: false, enabled: true,
      spatialInterpolation: false, forecastSupported: false,
    };
    const samples = samplesFor(state.sensors, definition, (sensor) => 80 + sensor.x / 5);
    const floorSensors = state.sensors.filter((sensor) => sensor.floorId === state.houses[0]!.floors[0]!.id);
    const floorView = renderFloor(floorSensors, samples, definition);

    expect(floorView.container.querySelectorAll(".heat-cloud-lobe, .flow-path")).toHaveLength(0);
    floorView.unmount();

    const buildingView = renderBuilding(state.sensors, samples, definition);
    expect(buildingView.container.querySelectorAll(
      ".building-cloud-lobe, .building-flow-path, .vertical-gradient",
    )).toHaveLength(0);
  });

  it("keeps a single local cloud but does not invent a vector from one sample", () => {
    const state = createDemoState();
    const definition = definitionFor(state.measurementDefinitions, "temperature");
    const sensor = state.sensors[0]!;
    const samples = samplesFor([sensor], definition, () => 23);
    const { container } = renderFloor([sensor], samples, definition);

    expect(container.querySelectorAll(".heat-cloud-lobe")).toHaveLength(1);
    expect(container.querySelectorAll(".flow-path")).toHaveLength(0);
  });

  it("excludes stale, aged, and future-skewed readings while retaining quality-aware markers", () => {
    const state = createDemoState();
    const definition = definitionFor(state.measurementDefinitions, "temperature");
    const floorId = state.houses[0]!.floors[0]!.id;
    const sensors = state.sensors.filter((sensor) => sensor.floorId === floorId).slice(0, 4);
    const samples = samplesFor(sensors, definition, (_, index) => 22 + index * 2);
    samples[sensors[0]!.id] = { ...samples[sensors[0]!.id]!, quality: "estimated" };
    samples[sensors[1]!.id] = { ...samples[sensors[1]!.id]!, timestamp: "2026-07-14T09:00:00.000Z" };
    samples[sensors[2]!.id] = { ...samples[sensors[2]!.id]!, timestamp: "2026-07-14T10:02:00.000Z" };
    samples[sensors[3]!.id] = { ...samples[sensors[3]!.id]!, quality: "stale" };

    const { container } = renderFloor(sensors, samples, definition);

    expect(container.querySelectorAll(".heat-cloud-lobe")).toHaveLength(1);
    expect(container.querySelectorAll(".flow-path")).toHaveLength(0);
    expect(container.querySelectorAll(".sensor-marker")).toHaveLength(4);
    expect(container.querySelectorAll(".sensor-marker.estimated")).toHaveLength(1);
    expect(container.querySelectorAll(".sensor-marker.stale")).toHaveLength(3);
    expect(container.querySelector(".sensor-marker.estimated")?.getAttribute("aria-label")).toMatch(/estimated data/i);
    [...container.querySelectorAll(".sensor-marker.stale")].forEach((marker) => {
      expect(marker.getAttribute("aria-label")).toMatch(/stale data/i);
    });
  });

  it("keeps two-sensor clouds local and only emits vectors inside observed coverage", () => {
    const state = createDemoState();
    const definition = definitionFor(state.measurementDefinitions, "temperature");
    const sensors = state.sensors.filter((sensor) => sensor.floorId === state.houses[0]!.floors[0]!.id).slice(0, 2);
    const samples = samplesFor(sensors, definition, (_, index) => index ? 31 : 18);
    const field = interpolateHeat(sensors, samples, definition, 1000, 620, 25, {
      referenceTimeMs: REFERENCE_TIME_MS, maxSampleAgeMs: MAX_SAMPLE_AGE_MS,
    });
    const clouds = createCloudLobes(field, definition);
    const flows = estimateFieldFlows(field, definition);

    expect(clouds).toHaveLength(2);
    expect(flows.length).toBeGreaterThan(0);
    flows.forEach((flow) => {
      const nearest = Math.min(...field.anchors.map((anchor) => Math.hypot(anchor.x - flow.from.x, anchor.y - flow.from.y)));
      expect(nearest).toBeLessThan(field.coverageRadius);
    });
  });

  it("does not extrapolate clustered sensors across an unobserved floor", () => {
    const state = createDemoState();
    const definition = definitionFor(state.measurementDefinitions, "temperature");
    const source = state.sensors.slice(0, 3);
    const sensors = source.map((sensor, index) => ({ ...sensor, x: 55 + index * 18, y: 48 + index * 15 }));
    const samples = samplesFor(sensors, definition, (_, index) => 18 + index * 7);
    const field = interpolateHeat(sensors, samples, definition, 1000, 600, 25, {
      referenceTimeMs: REFERENCE_TIME_MS, maxSampleAgeMs: MAX_SAMPLE_AGE_MS,
    });
    const clouds = createCloudLobes(field, definition, 11);
    const flows = estimateFieldFlows(field, definition, 7);

    expect(clouds.length).toBeGreaterThan(0);
    expect(Math.max(...clouds.map((cloud) => cloud.x))).toBeLessThan(500);
    [...clouds.map((cloud) => ({ x: cloud.x, y: cloud.y })), ...flows.flatMap((flow) => [flow.from, flow.to])]
      .forEach((point) => {
        const nearest = Math.min(...field.anchors.map((anchor) => Math.hypot(anchor.x - point.x, anchor.y - point.y)));
        expect(nearest).toBeLessThanOrEqual(field.coverageRadius);
      });
  });

  it.each(["co2", "custom particulate"])("supports spatial %s measurements without metric-specific field code", (kind) => {
    const state = createDemoState();
    const definition: MeasurementDefinition = kind === "co2"
      ? definitionFor(state.measurementDefinitions, "co2")
      : {
        id: "pm25", labels: { en: "PM2.5" }, unit: "ug/m3", precision: 1,
        validMin: 0, validMax: 500, displayMin: 0, displayMax: 100, interpolationDelta: 2,
        colorScale: "sequential", builtin: false, enabled: true,
        spatialInterpolation: true, forecastSupported: false,
      };
    const sensors = state.sensors.filter((sensor) => sensor.floorId === state.houses[0]!.floors[0]!.id).slice(0, 3);
    const samples = samplesFor(sensors, definition, (_, index) => kind === "co2" ? 550 + index * 350 : 4 + index * 12);
    const { container } = renderFloor(sensors, samples, definition);

    expect(container.querySelectorAll(".heat-cloud-lobe").length).toBeGreaterThan(1);
    expect(container.querySelectorAll(".flow-path").length).toBeGreaterThan(0);
  });

  it("caps interpolation work for extreme resolutions and aspect ratios", () => {
    const state = createDemoState();
    const definition = definitionFor(state.measurementDefinitions, "temperature");
    const sensors = state.sensors.slice(0, 3);
    const field = interpolateHeat(sensors, samplesFor(sensors, definition, (_, index) => 18 + index * 4), definition, 1, 1_000_000, 100_000);

    expect(field.cells.length).toBeLessThanOrEqual(MAX_SPATIAL_FIELD_CELLS);
    expect(field.cells.length).toBe(field.columns * field.rows);
    expect(field.columns).toBeGreaterThanOrEqual(4);
    expect(field.rows).toBeGreaterThanOrEqual(4);
  });

  it("uses a theme-aware vector cue and keeps the airflow disclaimer visible on narrow screens", () => {
    expect(styles).toMatch(/\.flow-path\s*\{[^}]*stroke:\s*var\(--pine\)/s);
    const mobile = styles.slice(styles.indexOf("@media (max-width: 680px)"), styles.indexOf("@media (prefers-reduced-motion"));
    expect(mobile).toMatch(/\.flow-legend\s*\{[^}]*display:\s*flex/s);
    expect(mobile).not.toMatch(/\.flow-legend\s*\{[^}]*display:\s*none/s);
    expect(contrastRatio("#79c7ad", "#19241f")).toBeGreaterThanOrEqual(3);
  });

  it("omits animated particles when reduced motion is preferred", async () => {
    setReducedMotion(true);
    const state = createDemoState();
    const definition = definitionFor(state.measurementDefinitions, "temperature");
    const groundId = state.houses[0]!.floors[0]!.id;
    const samples = samplesFor(state.sensors, definition, (sensor) =>
      sensor.floorId === groundId ? 34 - sensor.x / 50 : 26 - sensor.x / 60);
    const floorSensors = state.sensors.filter((sensor) => sensor.floorId === groundId);
    const floorView = renderFloor(floorSensors, samples, definition);
    const buildingView = renderBuilding(state.sensors, samples, definition);

    await waitFor(() => {
      expect(floorView.container.querySelectorAll(".flow-path").length).toBeGreaterThan(0);
      expect(buildingView.container.querySelectorAll(".building-flow-path").length).toBeGreaterThan(0);
      expect(buildingView.container.querySelectorAll(".vertical-gradient").length).toBeGreaterThan(0);
      expect(document.querySelectorAll(
        ".flow-particle, .building-flow-particle, .vertical-flow-particle",
      )).toHaveLength(0);
    });
  });
});

function contrastRatio(foreground: string, background: string): number {
  const luminance = (color: string) => {
    const channels = [color.slice(1, 3), color.slice(3, 5), color.slice(5, 7)]
      .map((channel) => parseInt(channel, 16) / 255)
      .map((value) => value <= .04045 ? value / 12.92 : ((value + .055) / 1.055) ** 2.4);
    return .2126 * channels[0]! + .7152 * channels[1]! + .0722 * channels[2]!;
  };
  const foregroundLuminance = luminance(foreground);
  const backgroundLuminance = luminance(background);
  return (Math.max(foregroundLuminance, backgroundLuminance) + .05)
    / (Math.min(foregroundLuminance, backgroundLuminance) + .05);
}
