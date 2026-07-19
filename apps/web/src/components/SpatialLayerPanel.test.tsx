import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { I18nProvider } from "../i18n";
import type { UseSpatialLayersResult } from "../useSpatialLayers";
import { SpatialLayerPanel } from "./SpatialLayerPanel";

const preferenceKey = "stuga-spatial-layer-panel";

function layerState(overrides: Partial<UseSpatialLayersResult> = {}): UseSpatialLayersResult {
  return {
    available: true,
    loading: false,
    refreshing: false,
    historyLoading: false,
    error: null,
    streamState: "idle",
    engines: [{
      id: "scalar",
      version: "1",
      title: "Climate",
      maturity: "stable",
      supportedScopes: ["house"],
      requiredMetrics: [],
      layerIds: ["climate.temperature"],
    }],
    health: [],
    topology: null,
    snapshots: [],
    history: [],
    selectedLayerIds: ["climate.temperature"],
    staleLayerIds: [],
    setLayerSelected: vi.fn(),
    refresh: vi.fn(async () => undefined),
    ...overrides,
  };
}

function panel(layers = layerState()) {
  return <I18nProvider><SpatialLayerPanel layers={layers} timeZone="Europe/Helsinki" compact /></I18nProvider>;
}

describe("SpatialLayerPanel disclosure", () => {
  beforeEach(() => {
    localStorage.clear();
  });

  it("keeps the specialist controls collapsed by default and persists the chosen density", async () => {
    const first = render(panel());
    const details = first.container.querySelector<HTMLDetailsElement>("details.spatial-layer-panel")!;
    const summary = first.container.querySelector("summary.spatial-layer-heading")!;

    expect(details.open).toBe(false);

    fireEvent.click(summary);
    expect(details.open).toBe(true);
    await waitFor(() => expect(localStorage.getItem(preferenceKey)).toBe("expanded"));
    expect(screen.getByRole("button", { name: "Refresh environmental layers" })).not.toBeNull();

    first.unmount();
    const second = render(panel());
    const restored = second.container.querySelector<HTMLDetailsElement>("details.spatial-layer-panel")!;
    expect(restored.open).toBe(true);

    fireEvent.click(second.container.querySelector("summary.spatial-layer-heading")!);
    expect(restored.open).toBe(false);
    await waitFor(() => expect(localStorage.getItem(preferenceKey)).toBe("collapsed"));
  });

  it("keeps layer selection and refresh available when expanded", () => {
    localStorage.setItem(preferenceKey, "expanded");
    const layers = layerState();
    render(panel(layers));

    fireEvent.click(screen.getByRole("button", { name: "Temperature Stable" }));
    expect(layers.setLayerSelected).toHaveBeenCalledWith("climate.temperature", false);

    fireEvent.click(screen.getByRole("button", { name: "Refresh environmental layers" }));
    expect(layers.refresh).toHaveBeenCalledOnce();
  });

  it("stays out of the overview when the optional engine is unavailable", () => {
    const view = render(panel(layerState({ available: false })));
    expect(view.container.childElementCount).toBe(0);
  });

  it("toggles the two view layers independently and exposes data-improvement guidance", () => {
    localStorage.setItem(preferenceKey, "expanded");
    const onToggle = vi.fn();
    render(<I18nProvider><SpatialLayerPanel
      layers={layerState()}
      timeZone="Europe/Helsinki"
      visualization={{
        selected: ["sensor-coverage"],
        mode: "plan",
        coverage: {
          regions: [],
          recommendations: [],
          freshTemperatureSensors: 1,
          pairedHumiditySensors: 0,
          staleOrMissingSensors: 1,
          enabledSensors: 2,
          coverageScore: .24,
          support: "low",
        },
        airflow: {
          temperatureSensors: 1,
          humiditySensors: 0,
          tracerSensors: 0,
          windDriven: false,
          doorOpenings: 0,
          windowOpenings: 0,
          ventOpenings: 0,
          counterflowOpenings: 0,
          pressureAssumed: true,
          support: "low",
          divergenceRms: 0,
        },
        suggestions: [{ id: "refresh", code: "refresh-sensor", layer: "sensor-coverage", roomName: "Bedroom" }],
        onToggle,
      }}
    /></I18nProvider>);

    fireEvent.click(screen.getByRole("button", { name: /air movement estimate/i }));
    expect(onToggle).toHaveBeenCalledWith("air-movement", true);
    fireEvent.click(screen.getByRole("button", { name: /sensor support/i }));
    expect(onToggle).toHaveBeenCalledWith("sensor-coverage", false);
    expect(screen.getByText(/restore fresh temperature readings.*bedroom/i)).not.toBeNull();
    expect(screen.getByText("2D slice")).not.toBeNull();
  });
});
