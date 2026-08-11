import { render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createDemoState } from "../domain";
import { I18nProvider } from "../i18n";
import { useHomePerformanceQuery } from "../data/analytics/homePerformanceQuery";
import { HomePerformancePanel } from "./HomePerformancePanel";

vi.mock("../data/analytics/homePerformanceQuery", () => ({
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

  it("does not expose or trigger refresh for a read-only viewer", () => {
    const state = createDemoState();
    const refresh = vi.fn();
    vi.mocked(useHomePerformanceQuery).mockReturnValue({
      data: undefined,
      error: null,
      isFetching: false,
      isLoading: false,
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
});
