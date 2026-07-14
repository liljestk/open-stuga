import { act, fireEvent, render, screen, within } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import type { ClimateState } from "../domain";
import { createDemoState } from "../domain";
import { I18nProvider } from "../i18n";
import { TwinDashboard } from "./TwinDashboard";

function renderDashboard(state: ClimateState) {
  const house = state.houses[0]!;
  const floor = house.floors[0]!;
  const sensor = state.sensors.find((item) => item.houseId === house.id && item.enabled)!;
  const props = {
    house, floor, houseId: house.id, floorId: floor.id,
    metric: "temperature" as const, units: "metric" as const, viewMode: "plan" as const,
    selectedSensorId: sensor.id, saveState: "idle" as const, scenario: "normal" as const,
    onHouse: vi.fn(), onFloor: vi.fn(), onMetric: vi.fn(), onViewMode: vi.fn(),
    onSensorSelect: vi.fn(), onSensorMove: vi.fn(), onSensorUpdate: vi.fn(),
    onFloorChange: vi.fn(), onSaveLayout: vi.fn(), onLoadSeries: vi.fn(), onRunScenario: vi.fn(),
    onCreateObservation: vi.fn().mockResolvedValue(state.observations[0]!),
    onCreateStaticParameter: vi.fn().mockResolvedValue(state.staticParameters[0]!),
  };
  const view = render(<I18nProvider><TwinDashboard state={state} {...props} /></I18nProvider>);
  return {
    ...view,
    sensor,
    rerenderState(nextState: ClimateState) {
      view.rerender(<I18nProvider><TwinDashboard state={nextState} {...props} /></I18nProvider>);
    },
  };
}

describe("TwinDashboard replay timing", () => {
  it("starts first play at the beginning and advances at the selected minutes-per-second rate", () => {
    vi.useFakeTimers();
    const view = renderDashboard(createDemoState());
    try {
      const slider = screen.getByRole("slider", { name: /Replay time/ }) as HTMLInputElement;
      const minimum = Number(slider.min);
      expect(Number(slider.value)).toBe(Number(slider.max));

      fireEvent.click(screen.getByRole("button", { name: "Play replay" }));
      expect(screen.getByRole("button", { name: "Pause replay" })).not.toBeNull();
      expect(Number(slider.value)).toBe(minimum);

      act(() => vi.advanceTimersByTime(1_000));
      expect(Number(slider.value)).toBe(minimum + 4 * 60_000);

      const speed = screen.getByLabelText("Replay speed") as HTMLSelectElement;
      expect(within(speed).getByRole("option", { name: "4 min/s" })).not.toBeNull();
      fireEvent.change(speed, { target: { value: "12" } });
      act(() => vi.advanceTimersByTime(1_000));
      expect(Number(slider.value)).toBe(minimum + 16 * 60_000);
    } finally {
      view.unmount();
      vi.useRealTimers();
    }
  });

  it("keeps a first play request pending until history is available", () => {
    vi.useFakeTimers();
    const demo = createDemoState();
    const emptyState: ClimateState = { ...demo, measurementHistory: {} };
    const view = renderDashboard(emptyState);
    try {
      const slider = screen.getByRole("slider", { name: /Replay time/ }) as HTMLInputElement;
      fireEvent.click(screen.getByRole("button", { name: "Play replay" }));
      const pendingTimestamp = Number(slider.value);

      expect(screen.getByRole("button", { name: "Play replay" })).not.toBeNull();
      act(() => vi.advanceTimersByTime(1_000));
      expect(Number(slider.value)).toBe(pendingTimestamp);

      const history = demo.measurementHistory[view.sensor.id]!.temperature!;
      const loadedState: ClimateState = {
        ...emptyState,
        measurementHistory: { [view.sensor.id]: { temperature: history } },
      };
      view.rerenderState(loadedState);

      const minimum = Number(slider.min);
      expect(screen.getByRole("button", { name: "Pause replay" })).not.toBeNull();
      expect(Number(slider.value)).toBe(minimum);
      act(() => vi.advanceTimersByTime(1_000));
      expect(Number(slider.value)).toBe(minimum + 4 * 60_000);
    } finally {
      view.unmount();
      vi.useRealTimers();
    }
  });
});
