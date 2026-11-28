import { act, fireEvent, render, renderHook, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { AnalyticsViewDefinition, SavedAnalyticsView } from "@climate-twin/contracts";
import { api, notifyAuthorizationChange } from "../../api";
import { queryClient } from "../../data/queryClient";
import { I18nProvider } from "../../i18n";
import { analyticsStateFromLocation, writeAnalyticsStateToLocation } from "./explorerState";
import { analyticsViewDefinition, explorerAnalyticsRequest, savedViewLocation } from "./explorerViews";
import { useExplorerWindow } from "./useExplorerWindow";
import { SavedAnalyticsViews } from "./SavedAnalyticsViews";
import { AnalyticsRangeControls } from "./AnalyticsRangeControls";

const scope = { houseId: "house-main", dataMode: "live" as const };
const interval = { start: "2026-10-01T00:00:00.000Z", end: "2026-10-02T00:00:00.000Z", ...scope };
const definition: AnalyticsViewDefinition = {
  metric: "temperature", sensorIds: ["sensor-01"], range: { kind: "absolute", start: interval.start, end: interval.end },
  resolution: "auto", aggregation: "default", qualityPreset: "reliable", weatherObservationsVisible: false, weatherForecastVisible: false,
};
beforeEach(() => { vi.restoreAllMocks(); queryClient.clear(); window.history.replaceState(null, "", "/"); });

describe("saved and selected explorer intervals", () => {
  it("round-trips exact ranges through the URL, request and saved definition", () => {
    const state = savedViewLocation({ definition, ...scope, range: "24h", metricIds: ["temperature"], sensorIds: ["sensor-01"] })!;
    writeAnalyticsStateToLocation(state, "push", "temperature");
    const restored = analyticsStateFromLocation(["temperature"], ["sensor-01"], scope);
    expect(analyticsViewDefinition(restored)).toEqual(definition);
    const request = explorerAnalyticsRequest({ ...scope, sensorIds: ["sensor-01"], timeZone: "Europe/Helsinki", state: restored, requestId: "selected-range" });
    expect(request.range).toEqual({ start: interval.start, end: interval.end, timezone: "Europe/Helsinki" });
    expect(request.include).toContain("distribution");
    expect(analyticsStateFromLocation(["temperature"], ["sensor-01"], { ...scope, houseId: "another-home" }).absoluteRange).toBeUndefined();
    expect(analyticsStateFromLocation(["temperature"], ["sensor-01"], { ...scope, dataMode: "demo" }).absoluteRange).toBeUndefined();
    writeAnalyticsStateToLocation({ ...restored, absoluteRange: undefined }, "push", "temperature");
    expect(new URLSearchParams(window.location.search).has("from")).toBe(false);
  });

  it("preserves a valid custom resolution through saved views and refresh", () => {
    const state = savedViewLocation({ definition: { ...definition, resolution: "2m" }, ...scope, range: "24h", metricIds: ["temperature"], sensorIds: ["sensor-01"] })!;
    writeAnalyticsStateToLocation(state, "push", "temperature");
    expect(analyticsStateFromLocation(["temperature"], ["sensor-01"], scope).resolution).toBe("2m");
  });

  it("rejects a saved sensor that is no longer visible instead of expanding to all sensors", () => {
    expect(savedViewLocation({ definition, ...scope, range: "24h", metricIds: ["temperature"], sensorIds: [] })).toBeNull();
  });

  it("fences a previous Home's interval and brush before the next render's effects", () => {
    const { result, rerender } = renderHook(({ houseId }) => useExplorerWindow({ houseId, dataMode: "live", initial: interval }), { initialProps: { houseId: "house-main" } });
    act(() => { result.current.setBrush(true); result.current.setBrushSelection(interval); });
    rerender({ houseId: "another-home" });
    expect(result.current.absoluteRange).toBeUndefined();
    expect(result.current.brush).toBe(false);
    expect(result.current.brushSelection).toBeNull();
  });

  it("keeps date edits local until applied, preserves them after validation failure, and supports Cancel", async () => {
    const user = userEvent.setup();
    const apply = vi.fn();
    render(<I18nProvider><AnalyticsRangeControls window={interval} identity="test" absolute={false} brush={false} selection={null} onBrush={vi.fn()} onApply={apply} onReset={vi.fn()} /></I18nProvider>);
    await user.click(screen.getByText("Choose an interval"));
    const start = screen.getByLabelText("Start (UTC)");
    const end = screen.getByLabelText("End (UTC)");
    await user.clear(end); await user.type(end, "2026-09-30T00:00");
    await user.click(screen.getByRole("button", { name: "Apply interval" }));
    expect(apply).not.toHaveBeenCalled();
    expect(screen.getByRole("alert")).toBeTruthy();
    await user.click(screen.getByRole("button", { name: "Cancel" }));
    expect(start).toHaveValue("2026-10-01T00:00");
    expect(end).toHaveValue("2026-10-02T00:00");
    await user.click(screen.getByRole("button", { name: "Apply interval" }));
    expect(apply).toHaveBeenCalledWith({ kind: "absolute", start: interval.start, end: interval.end });
  });

  it("preserves native date input across a clock-driven parent update", () => {
    const props = { window: interval, identity: "24h", absolute: false, brush: false, selection: null,
      onBrush: vi.fn(), onApply: vi.fn(), onReset: vi.fn() };
    const { rerender } = render(<I18nProvider><AnalyticsRangeControls {...props} /></I18nProvider>);
    fireEvent.input(screen.getByLabelText("Start (UTC)"), { target: { value: "2026-10-01T12:00" } });
    rerender(<I18nProvider><AnalyticsRangeControls {...props} window={{ ...interval, end: "2026-10-02T00:01:00.000Z" }} /></I18nProvider>);
    expect(screen.getByLabelText("Start (UTC)")).toHaveValue("2026-10-01T12:00");
  });
});

describe("private saved-view form state", () => {
  it("drops the old account's names and selection on authorization change", async () => {
    const view: SavedAnalyticsView = { id: "view-a", ...scope, name: "Private bedroom view", revision: 1, definition,
      createdAt: interval.start, updatedAt: interval.start };
    let account = "first";
    vi.spyOn(api, "savedAnalyticsViews").mockImplementation(async () => ({ views: account === "first" ? [view] : [] }));
    const user = userEvent.setup();
    render(<I18nProvider><SavedAnalyticsViews {...scope} readOnly={false} definition={definition} onApply={() => true} /></I18nProvider>);
    await user.click(screen.getByText("Saved views"));
    await waitFor(() => expect(screen.getByRole("option", { name: view.name })).toBeTruthy());
    await user.selectOptions(screen.getByLabelText("Saved view"), view.id);
    expect(screen.getByLabelText("View name")).toHaveValue(view.name);
    act(() => { account = "second"; notifyAuthorizationChange("changed"); });
    await user.click(screen.getByText("Saved views"));
    await waitFor(() => expect(screen.getByLabelText("View name")).toHaveValue(""));
    expect(screen.queryByRole("option", { name: view.name })).toBeNull();
  });
});
