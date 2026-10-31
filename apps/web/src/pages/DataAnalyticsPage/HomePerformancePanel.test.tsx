import { fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createDemoState } from "../../domain";
import { I18nProvider } from "../../i18n";
import { useHomePerformanceQuery } from "../../data/analytics/homePerformanceQuery";
import { HomePerformancePanel } from "./HomePerformancePanel";

vi.mock("../../data/analytics/homePerformanceQuery", () => ({
  useHomePerformanceQuery: vi.fn(),
}));

afterEach(() => vi.clearAllMocks());

describe("HomePerformancePanel", () => {
  beforeEach(() => localStorage.setItem("climate-twin-locale", "en"));

  it("keeps a settled failure visible during a background retry", () => {
    const state = createDemoState();
    const queryResult = (overrides: Record<string, unknown>) => ({
      data: undefined,
      error: null,
      isFetching: false,
      isLoading: false,
      refetch: vi.fn(),
      refresh: vi.fn(),
      ...overrides,
    }) as unknown as ReturnType<typeof useHomePerformanceQuery>;

    vi.mocked(useHomePerformanceQuery).mockReturnValue(queryResult({
      error: new Error("The request could not be completed"),
    }));

    const panel = () => <I18nProvider><HomePerformancePanel
      house={state.houses[0]!}
      definitions={state.measurementDefinitions}
      dataMode="real"
      refreshRevision={0}
    /></I18nProvider>;
    const view = render(panel());

    expect(screen.getByText(/Evidence unavailable for: The request could not be completed/)).not.toBeNull();
    expect(screen.queryByText("Calculating Home performance")).toBeNull();

    vi.mocked(useHomePerformanceQuery).mockReturnValue(queryResult({
      isFetching: true,
      isLoading: true,
    }));
    view.rerender(panel());

    expect(screen.getByText(/Evidence unavailable for: The request could not be completed/)).not.toBeNull();
    expect(screen.queryByText("Calculating Home performance")).toBeNull();
  });

  it("re-reads the saved artifact without computing for a read-only viewer", () => {
    const state = createDemoState();
    const refresh = vi.fn();
    const refetch = vi.fn();
    vi.mocked(useHomePerformanceQuery).mockReturnValue({
      data: undefined,
      error: null,
      isFetching: false,
      isLoading: false,
      refetch,
      refresh,
    } as unknown as ReturnType<typeof useHomePerformanceQuery>);
    const panel = (refreshRevision: number) => <I18nProvider><HomePerformancePanel
      house={state.houses[0]!}
      definitions={state.measurementDefinitions}
      dataMode="real"
      refreshRevision={refreshRevision}
      canRefresh={false}
    /></I18nProvider>;
    const view = render(panel(0));

    expect(screen.queryByRole("button", { name: "Refresh" })).toBeNull();
    view.rerender(panel(1));
    expect(refetch).toHaveBeenCalledOnce();
    expect(refresh).not.toHaveBeenCalled();
  });

  it("does not enqueue analysis when bootstrap only resolves the data mode", () => {
    const state = createDemoState();
    const refresh = vi.fn();
    vi.mocked(useHomePerformanceQuery).mockReturnValue({
      data: undefined,
      error: null,
      isFetching: false,
      isLoading: false,
      refetch: vi.fn(),
      refresh,
    } as unknown as ReturnType<typeof useHomePerformanceQuery>);
    const panel = (dataMode: "real" | "unknown") => <I18nProvider><HomePerformancePanel
      house={state.houses[0]!}
      definitions={state.measurementDefinitions}
      dataMode={dataMode}
      refreshRevision={0}
    /></I18nProvider>;
    const view = render(panel("unknown"));

    view.rerender(panel("real"));
    expect(refresh).not.toHaveBeenCalled();
  });

  it("explains the energy regression and the rooms left out of comfort exposure", () => {
    const state = createDemoState();
    const result = {
      status: "ready", generatedAt: "2026-01-31T00:00:00.000Z", from: "2026-01-01T00:00:00.000Z", to: "2026-01-31T00:00:00.000Z",
      warnings: [],
      exposure: {
        state: "ready", guideRangePercent: 90, observedHours: 720, temperatureDegreeHours: 12,
        humidityOutsideGuideHours: 0, co2AboveGuideHours: 0, worstRoom: null, rooms: [], excludedRooms: ["Sauna"],
      },
      recovery: { state: "unavailable", episodeCount: 0, medianHalfLifeMinutes: null },
      openingEffectiveness: { state: "unavailable", evaluatedEvents: 0, effectiveEvents: 0, medianClearanceMinutes: null, bestOpeningLabel: null },
      energy: {
        state: "ready", energyKwh: 900, heatingDegreeHours: 9000, energyPerHeatingDegreeHour: 0.08,
        comparisonChangePercent: 12, source: "heating-meter", heatingBaseTemperatureC: 17, indexMethod: "regression",
        baseLoadKwhPerDay: 6, heatingSlopeInterval: { low: 0.07, high: 0.09 }, comparisonInterval: { lowPercent: -3, highPercent: 27 },
      },
      maintenance: {
        state: "unavailable", evaluatedActions: 0, improvedActions: 0, improvementPercent: null,
        linkedEvaluatedActions: 0, completedWithoutMeasurement: 0, recurringObservations: 0,
      },
      sensorHealth: { state: "ready", monitoredSensors: 1, healthySensors: 1, coveragePercent: 100, issues: [] },
      limitations: [],
      provenance: { truthClass: "derived", algorithmVersion: "home-performance-v4.0.0", sourceIds: [], archiveStates: [] },
    };
    vi.mocked(useHomePerformanceQuery).mockReturnValue({
      data: { result },
      error: null,
      isFetching: false,
      isLoading: false,
      refetch: vi.fn(),
      refresh: vi.fn(),
    } as unknown as ReturnType<typeof useHomePerformanceQuery>);

    render(<I18nProvider><HomePerformancePanel
      house={state.houses[0]!}
      definitions={state.measurementDefinitions}
      dataMode="real"
      refreshRevision={0}
    /></I18nProvider>);

    expect(screen.getByText(/Base load 6 kWh a day plus 0\.08 kWh per heating degree-hour below 17 °C \(90% interval 0\.07–0\.09\)/)).not.toBeNull();
    expect(screen.getByText(/The heating slope changed 12% between the two halves of the period \(90% interval -3% to 27%\)/)).not.toBeNull();
    expect(screen.getByText(/Left out of comfort exposure: Sauna\./)).not.toBeNull();
  });

  it("keeps the local Recalculate button as the explicit compute action", () => {
    const state = createDemoState();
    const refresh = vi.fn();
    const refetch = vi.fn();
    vi.mocked(useHomePerformanceQuery).mockReturnValue({
      data: undefined,
      error: null,
      isFetching: false,
      isLoading: false,
      recalculating: false,
      refetch,
      refresh,
    } as unknown as ReturnType<typeof useHomePerformanceQuery>);

    render(<I18nProvider><HomePerformancePanel
      house={state.houses[0]!}
      definitions={state.measurementDefinitions}
      dataMode="real"
      refreshRevision={0}
    /></I18nProvider>);
    fireEvent.click(screen.getByRole("button", { name: "Recalculate" }));

    expect(refresh).toHaveBeenCalledOnce();
    expect(refetch).not.toHaveBeenCalled();
  });
});
