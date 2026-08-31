import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { MeasurementSample, Sensor } from "@climate-twin/contracts";
import { describe, expect, it, vi } from "vitest";
import { createDemoState } from "../domain";
import { I18nProvider } from "../i18n";
import { seriesStateKey, type SeriesLoadState } from "../useClimateData";
import { ElectricityHistory } from "./ElectricityHistory";

const MINUTE = 60_000;
const HOUR = 3_600_000;

function powerSensor(base: Sensor, id: string, name: string): Sensor {
  return { ...base, id, name, measurementEntityIds: { power: `sensor.${id}_power` } };
}

function powerSamples(sensorId: string, from: number, to: number, stepMs: number): MeasurementSample[] {
  const samples: MeasurementSample[] = [];
  for (let at = from; at <= to; at += stepMs) {
    samples.push({
      sensorId,
      metric: "power",
      value: 50,
      canonicalUnit: "W",
      timestamp: new Date(at).toISOString(),
      source: "tp-link",
      quality: "good",
    });
  }
  return samples;
}

function readyState(overrides: Partial<SeriesLoadState> = {}): SeriesLoadState {
  return {
    status: "ready",
    error: null,
    forecastError: null,
    requestedFrom: new Date(0).toISOString(),
    requestedTo: new Date().toISOString(),
    loadedFrom: null,
    loadedTo: null,
    partial: false,
    truncated: false,
    ...overrides,
  };
}

function renderHistory(
  sensors: Sensor[],
  history: Record<string, MeasurementSample[]>,
  seriesStates?: Record<string, SeriesLoadState>,
) {
  const demo = createDemoState();
  const state = {
    ...demo,
    sensors,
    latestMeasurements: {},
    measurementHistory: Object.fromEntries(
      Object.entries(history).map(([sensorId, samples]) => [sensorId, { power: samples }]),
    ),
  };
  render(<I18nProvider>
    <ElectricityHistory
      state={state}
      sensors={sensors}
      metric="power"
      onMetric={vi.fn()}
      units="metric"
      range="6h"
      onRange={vi.fn()}
      timeZone="UTC"
      onLoadSeries={vi.fn()}
      {...(seriesStates ? { seriesStates } : {})}
    />
  </I18nProvider>);
}

describe("ElectricityHistory combined coverage", () => {
  it("keeps intervals covered by a change-plus-heartbeat reporter instead of dropping them", async () => {
    const user = userEvent.setup();
    const now = Date.now();
    const from = now - 6 * HOUR;
    const base = createDemoState().sensors[0]!;
    const sensors = [
      powerSensor(base, "dense-1", "Dator"),
      powerSensor(base, "heartbeat-1", "Kylskap"),
    ];
    // The heartbeat plug reports every 11 minutes, so many 5-minute chart
    // buckets hold no sample from it even though its value never lapsed.
    const history = {
      "dense-1": powerSamples("dense-1", from + MINUTE, now, MINUTE),
      "heartbeat-1": powerSamples("heartbeat-1", from + MINUTE, now, 11 * MINUTE),
    };
    renderHistory(sensors, history);

    expect(screen.queryByText("Combined totals are shown only where every selected sensor reported.")).toBeNull();
    expect(screen.queryByText("No data yet")).toBeNull();

    await user.click(screen.getByText("Show exact data"));
    const rows = within(screen.getByRole("table")).getAllByRole("row").length - 1;
    // A 6h window at 5-minute buckets holds ~72 complete intervals.
    expect(rows).toBeGreaterThan(65);
  });

  it("excludes a source without samples and says so instead of blanking the chart", () => {
    const now = Date.now();
    const from = now - 6 * HOUR;
    const base = createDemoState().sensors[0]!;
    const sensors = [
      powerSensor(base, "offline-1", "Offline plug"),
      powerSensor(base, "ok-1", "OK 1"),
      powerSensor(base, "ok-2", "OK 2"),
    ];
    const history = {
      "offline-1": [],
      "ok-1": powerSamples("ok-1", from + MINUTE, now, MINUTE),
      "ok-2": powerSamples("ok-2", from + MINUTE, now, MINUTE),
    };
    renderHistory(sensors, history, {
      [seriesStateKey("offline-1", "power")]: readyState(),
      [seriesStateKey("ok-1", "power")]: readyState(),
      [seriesStateKey("ok-2", "power")]: readyState(),
    });

    expect(screen.queryByText("No data yet")).toBeNull();
    expect(screen.getByText("1 selected sources have no data in this range and are left out of the combined view.")).not.toBeNull();
    expect(screen.getByText("2 of 3 sensors combined")).not.toBeNull();
  });

  it("surfaces server-side truncation of a loaded series", () => {
    const now = Date.now();
    const from = now - 6 * HOUR;
    const base = createDemoState().sensors[0]!;
    const sensors = [powerSensor(base, "dense-1", "Dator")];
    const history = { "dense-1": powerSamples("dense-1", from + MINUTE, now, MINUTE) };
    renderHistory(sensors, history, {
      [seriesStateKey("dense-1", "power")]: readyState({ partial: true, truncated: true }),
    });

    expect(screen.getByText("Some history in this range could not be loaded; the chart may be missing older values.")).not.toBeNull();
  });
});
