import { fireEvent, render, screen, within } from "@testing-library/react";
import type { ComponentProps } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createDemoState } from "../domain";
import { I18nProvider } from "../i18n";
import type { ReplayClimateEvent } from "../replayEvents";
import { ReplayControls } from "./ReplayControls";

const min = Date.parse("2026-07-14T20:30:00.000Z");
const timestamp = Date.parse("2026-07-14T21:30:00.000Z");
const max = Date.parse("2026-07-14T22:30:00.000Z");
const demo = createDemoState();
const livingSensor = demo.sensors.find((sensor) => sensor.id === "sensor-living")!;
const bathroomSensor = demo.sensors.find((sensor) => sensor.id === "sensor-bathroom")!;

type ReplayControlsProps = ComponentProps<typeof ReplayControls>;

function climateEvent(overrides: Partial<ReplayClimateEvent> = {}): ReplayClimateEvent {
  return {
    id: "climate:temperature:drop:sensor-living:2026-07-14T21:30:00.000Z",
    kind: "climate",
    timestamp,
    sensorId: livingSensor.id,
    metric: "temperature",
    direction: "drop",
    before: 22,
    after: 20,
    delta: -2,
    score: 4 / 3,
    ...overrides,
  };
}

function renderControls(timeZone = "Europe/Helsinki", overrides: Partial<ReplayControlsProps> = {}) {
  const onActive = overrides.onActive ?? vi.fn();
  const onPlaying = overrides.onPlaying ?? vi.fn();
  const onTimestamp = overrides.onTimestamp ?? vi.fn();
  const onSpeed = overrides.onSpeed ?? vi.fn();
  const view = render(
    <I18nProvider>
      <ReplayControls
        active playing={false} timestamp={timestamp} min={min} max={max} speed={4} timeZone={timeZone}
        {...overrides}
        onActive={onActive} onPlaying={onPlaying} onTimestamp={onTimestamp} onSpeed={onSpeed}
      />
    </I18nProvider>,
  );
  return { ...view, onActive, onPlaying, onTimestamp, onSpeed };
}

afterEach(() => localStorage.clear());

describe("ReplayControls time and speed labels", () => {
  it("uses the house timezone and includes dates when its calendar day changes", () => {
    const view = renderControls();
    const expected = (value: number) => new Intl.DateTimeFormat("en", {
      dateStyle: "medium",
      timeStyle: "short",
      timeZone: "Europe/Helsinki",
    }).format(value);
    const labels = Array.from(view.container.querySelectorAll(".timeline-labels time"));

    expect(labels.map((label) => label.textContent)).toEqual([expected(min), expected(max)]);
    expect(screen.getByText(`Replaying ${expected(timestamp)}`)).not.toBeNull();
  });

  it("falls back to the browser timezone when a configured timezone is invalid", () => {
    expect(() => renderControls("Not/A_Timezone")).not.toThrow();
    expect(screen.getByText(/^Replaying /)).not.toBeNull();
    expect(document.querySelectorAll(".timeline-labels time")).toHaveLength(2);
  });

  it("names visible events with local dates, display units, and percentage-point humidity deltas", () => {
    const temperatureDrop = climateEvent();
    const humidityRise = climateEvent({
      id: "climate:humidity:rise:sensor-bathroom:2026-07-14T21:00:00.000Z",
      timestamp: Date.parse("2026-07-14T21:00:00.000Z"),
      sensorId: bathroomSensor.id,
      metric: "humidity",
      direction: "rise",
      before: 50,
      after: 62,
      delta: 12,
      score: 1.5,
    });
    renderControls("Europe/Helsinki", {
      events: [temperatureDrop, humidityRise],
      sensors: demo.sensors,
      definitions: demo.measurementDefinitions,
      units: "imperial",
    });
    const eventTime = (value: number) => new Intl.DateTimeFormat("en", {
      month: "short",
      day: "numeric",
      hour: "2-digit",
      minute: "2-digit",
      timeZone: "Europe/Helsinki",
    }).format(value);
    const temperatureDescription = "Temperature fell 3.6°F in Living room";
    const humidityDescription = "Humidity rose 12 percentage points in Bathroom";
    const events = screen.getByLabelText("Major changes");
    const temperatureButton = within(events).getByRole("button", {
      name: `Replay from ${eventTime(temperatureDrop.timestamp)}: ${temperatureDescription}`,
    });
    const humidityButton = within(events).getByRole("button", {
      name: `Replay from ${eventTime(humidityRise.timestamp)}: ${humidityDescription}`,
    });

    expect(within(events).getAllByRole("button")).toHaveLength(2);
    expect(within(temperatureButton).getByText(temperatureDescription)).not.toBeNull();
    expect(within(humidityButton).getByText(humidityDescription)).not.toBeNull();
    expect(within(temperatureButton).getByText(eventTime(temperatureDrop.timestamp), { selector: "time" })).not.toBeNull();
    expect(within(humidityButton).getByText(eventTime(humidityRise.timestamp), { selector: "time" })).not.toBeNull();
    expect(temperatureButton.getAttribute("aria-current")).toBe("time");
    expect(humidityButton.hasAttribute("aria-current")).toBe(false);
  });

  it("pauses, activates, seeks, and reports the selected event in order", () => {
    const event = climateEvent();
    const calls: Array<[string, boolean | number | string]> = [];
    const onPlaying = vi.fn((value: boolean) => calls.push(["playing", value]));
    const onActive = vi.fn((value: boolean) => calls.push(["active", value]));
    const onTimestamp = vi.fn((value: number) => calls.push(["timestamp", value]));
    const onEventSelect = vi.fn((value: ReplayClimateEvent) => calls.push(["event", value.id]));
    renderControls("Europe/Helsinki", {
      playing: true,
      events: [event],
      sensors: demo.sensors,
      definitions: demo.measurementDefinitions,
      onPlaying,
      onActive,
      onTimestamp,
      onEventSelect,
    });

    fireEvent.click(screen.getByRole("button", { name: /Temperature fell 2\.0°C in Living room/ }));

    expect(calls).toEqual([
      ["playing", false],
      ["active", true],
      ["timestamp", event.timestamp],
      ["event", event.id],
    ]);
    expect(onPlaying).toHaveBeenCalledWith(false);
    expect(onActive).toHaveBeenCalledWith(true);
    expect(onTimestamp).toHaveBeenCalledWith(event.timestamp);
    expect(onEventSelect).toHaveBeenCalledWith(event);
  });

  it("filters event buttons and visual ticks to the inclusive replay range", () => {
    const atMinimum = climateEvent({ id: "inside", timestamp: min });
    renderControls("Europe/Helsinki", {
      timestamp: min,
      events: [
        climateEvent({ id: "before", timestamp: min - 1 }),
        atMinimum,
        climateEvent({ id: "after", timestamp: max + 1 }),
      ],
      sensors: demo.sensors,
      definitions: demo.measurementDefinitions,
    });

    const events = screen.getByLabelText("Major changes");
    expect(within(events).getAllByRole("button")).toHaveLength(1);
    expect(events.querySelector('[data-replay-event-id="inside"]')).not.toBeNull();
    expect(events.querySelector('[data-replay-event-id="before"]')).toBeNull();
    expect(events.querySelector('[data-replay-event-id="after"]')).toBeNull();
    expect(document.querySelectorAll(".replay-event-ticks i")).toHaveLength(1);
  });

  it("localizes every speed option", () => {
    localStorage.setItem("climate-twin-locale", "fi");
    renderControls();
    const select = screen.getByLabelText("Toistonopeus");

    expect(within(select).getByRole("option", { name: "1 minuutti sekunnissa" })).not.toBeNull();
    expect(within(select).getByRole("option", { name: "4 minuuttia sekunnissa" })).not.toBeNull();
    expect(within(select).getByRole("option", { name: "12 minuuttia sekunnissa" })).not.toBeNull();
    expect(within(select).getByRole("option", { name: "48 minuuttia sekunnissa" })).not.toBeNull();
  });
});
