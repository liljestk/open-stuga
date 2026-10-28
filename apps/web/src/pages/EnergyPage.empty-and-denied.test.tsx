import { useRef, useState } from "react";
import { useSeriesQueries } from "../data/bootstrap/useSeriesQueries";
import type { LiveTelemetryContext } from "../data/bootstrap/pipelineTypes";
import type { SeriesLoadState } from "../useClimateData";
import { fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { api, ApiRequestError } from "../api";
import { queryClient } from "../data/queryClient";
import { createDemoState } from "../domain";
import { I18nProvider } from "../i18n";
import { ElectricityHistory } from "./ElectricityHistory";
import { EnergyPage } from "./EnergyPage";

const deniedMessage = "You do not have permission to view this electricity data.";
const denied = () => new ApiRequestError(403, "FORBIDDEN", "Server detail must not become untranslated UI copy");

afterEach(() => {
  queryClient.clear();
  vi.restoreAllMocks();
  window.history.replaceState(null, "", "/");
});

describe("electricity empty and denied states", () => {
  it("shows empty consumption, not permanent loading, when only a Property price is available", async () => {
    const state = createDemoState();
    const house = state.houses[0]!;
    state.sensors = []; state.latestMeasurements = {}; state.measurementHistory = {};
    const now = Date.now();
    vi.spyOn(api, "houseElectricityPrice").mockResolvedValue({ current: {
      startAt: new Date(now - 60_000).toISOString(), endAt: new Date(now + 3_600_000).toISOString(),
      effectivePriceCentsPerKwh: 10, effectivePriceEurPerKwh: 0.1, fetchedAt: new Date(now).toISOString(),
    } });
    const summary = vi.spyOn(api, "houseEnergySummary");
    render(<I18nProvider><EnergyPage state={state} house={house} units="metric" onOpenAlerts={vi.fn()} /></I18nProvider>);
    const card = (await screen.findByText("Consumption · 24 hours")).closest("article")!;
    expect(within(card).getByText("No stored usage for this interval yet")).toBeInTheDocument();
    expect(within(card).queryByText("Calculating from stored history…")).not.toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "Connect electricity data" })).toBeInTheDocument();
    expect(summary).not.toHaveBeenCalled();
  });

  it.each(["Home", "Property"])("explains denied %s price access", async (scope) => {
    const state = createDemoState();
    const house = state.houses[0]!;
    state.sensors = []; state.latestMeasurements = {}; state.measurementHistory = {};
    if (scope === "Property") state.houses = [];
    vi.spyOn(api, "houseElectricityPrice").mockRejectedValue(denied());
    vi.spyOn(api, "propertyElectricity").mockRejectedValue(denied());
    render(<I18nProvider><EnergyPage state={state} house={scope === "Home" ? house : null}
      propertyId={house.propertyId} units="metric" onOpenAlerts={vi.fn()} /></I18nProvider>);
    expect(await screen.findByText(deniedMessage)).toBeInTheDocument();
    expect(screen.queryByText("Could not load the property electricity price.")).not.toBeInTheDocument();
    expect(screen.queryByText(/Server detail/)).not.toBeInTheDocument();
  });

  it("passes denied price History access from its request into the chart", async () => {
    const state = createDemoState();
    const house = state.houses[0]!;
    state.sensors = []; state.latestMeasurements = {}; state.measurementHistory = {};
    window.history.replaceState(null, "", "/electricity?metric=electricity_price");
    const now = Date.now();
    vi.spyOn(api, "houseElectricityPrice").mockImplementation(async (_houseId, query) => {
      if (query?.from) throw denied();
      return { current: { startAt: new Date(now - 60_000).toISOString(), endAt: new Date(now + 3_600_000).toISOString(),
        effectivePriceCentsPerKwh: 10, effectivePriceEurPerKwh: 0.1, fetchedAt: new Date(now).toISOString() } };
    });
    render(<I18nProvider><EnergyPage state={state} house={house} units="metric" onOpenAlerts={vi.fn()} /></I18nProvider>);
    expect(await screen.findByText(deniedMessage)).toBeInTheDocument();
    expect(within(screen.getByRole("alert")).getByText(deniedMessage)).toBeInTheDocument();
  });
  it("preserves raw power denial through the loader, then clears it for a generic retry failure", async () => {
    const initial = createDemoState();
    const sensor = { ...initial.sensors[0]!, measurementEntityIds: { power: "fixture.power" } };
    initial.sensors = [sensor]; initial.latestMeasurements = {}; initial.measurementHistory = {};
    const request = vi.spyOn(api, "measurementHistoryPage").mockRejectedValue(denied());
    function RawHistory() {
      const [state, setState] = useState(initial);
      const [seriesStates, setSeriesStates] = useState<Record<string, SeriesLoadState>>({});
      const context = {
        activeSeriesTelemetryBuffers: useRef(new Set()), apiAvailable: useRef(true),
        seriesCommitSequence: useRef(0), seriesCommitVersions: useRef(new Map()),
        seriesLoadVersions: useRef(new Map()), setSeriesStates, setState,
      } as unknown as LiveTelemetryContext;
      const { loadSeries } = useSeriesQueries(context);
      return <I18nProvider><ElectricityHistory state={state} sensors={[sensor]} metric="power"
        onMetric={vi.fn()} units="metric" range="24h" onRange={vi.fn()} timeZone="UTC"
        onLoadSeries={loadSeries} seriesStates={seriesStates} /></I18nProvider>;
    }
    render(<RawHistory />);
    expect(await screen.findByText(deniedMessage)).toBeInTheDocument();
    expect(request).toHaveBeenCalledTimes(1);
    request.mockRejectedValue(new Error("Temporarily offline"));
    fireEvent.click(screen.getByRole("button", { name: "Try again" }));
    expect(await screen.findByText("History could not be refreshed. The last received values remain visible.")).toBeInTheDocument();
    expect(screen.queryByText(deniedMessage)).not.toBeInTheDocument();
    expect(request).toHaveBeenCalledTimes(2);
  });
  it("explains denied consumption History access instead of a transient load failure", async () => {
    const state = createDemoState();
    const sensor = { ...state.sensors[0]!, measurementEntityIds: { power: "fixture.power" } };
    state.sensors = [sensor]; state.latestMeasurements = {}; state.measurementHistory = {};
    vi.spyOn(api, "analyticsQuery").mockRejectedValue(denied());
    render(<I18nProvider><ElectricityHistory state={state} sensors={[sensor]} metric="energy"
      onMetric={vi.fn()} units="metric" range="24h" onRange={vi.fn()} timeZone="UTC" /></I18nProvider>);
    expect(await screen.findByText(deniedMessage)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Try again" })).toBeInTheDocument();
  });
});
