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

  it("keeps transport controls together and explains an empty event recording", () => {
    const view = renderControls();
    const transport = view.container.querySelector<HTMLElement>(".replay-transport")!;
    const playback = view.container.querySelector<HTMLElement>(".replay-playback-controls")!;
    const timeline = view.container.querySelector<HTMLElement>(".timeline-field")!;

    expect(within(transport).getByRole("heading", { level: 3, name: "Replay" })).not.toBeNull();
    expect(playback.contains(screen.getByRole("button", { name: "Play replay" }))).toBe(true);
    expect(playback.contains(screen.getByRole("button", { name: "Previous frame" }))).toBe(true);
    expect(timeline.contains(screen.getByRole("button", { name: "Previous frame" }))).toBe(false);
    expect(screen.getByText("No auto-tagged events in this recording.")).not.toBeNull();
    expect(screen.queryByRole("button", { name: "Previous detected event" })).toBeNull();
    expect(screen.queryByLabelText("Auto-tagged events")).toBeNull();
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
    const events = screen.getByLabelText("Auto-tagged events");
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

    const events = screen.getByLabelText("Auto-tagged events");
    fireEvent.click(within(events).getByRole("button", { name: /Temperature fell 2\.0°C in Living room/ }));

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
    const onTimestamp = vi.fn();
    renderControls("Europe/Helsinki", {
      timestamp: min,
      events: [
        climateEvent({ id: "before", timestamp: min - 1 }),
        atMinimum,
        climateEvent({ id: "after", timestamp: max + 1 }),
      ],
      sensors: demo.sensors,
      definitions: demo.measurementDefinitions,
      onTimestamp,
    });

    const events = screen.getByLabelText("Auto-tagged events");
    expect(within(events).getAllByRole("button")).toHaveLength(1);
    expect(events.querySelector('[data-replay-event-id="inside"]')).not.toBeNull();
    expect(events.querySelector('[data-replay-event-id="before"]')).toBeNull();
    expect(events.querySelector('[data-replay-event-id="after"]')).toBeNull();
    const timelineEvents = document.querySelector<HTMLElement>(".replay-event-ticks")!;
    expect(within(timelineEvents).getAllByRole("button")).toHaveLength(1);
    const timelineEvent = within(timelineEvents).getByRole("button", { name: /Temperature fell 2\.0°C in Living room/ });
    fireEvent.click(timelineEvent);
    expect(onTimestamp).toHaveBeenCalledWith(min);
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

  it("keeps the history window opt-in and reports range, resolution, and load changes", () => {
    const onWindowFrom = vi.fn();
    const onWindowTo = vi.fn();
    const onResolution = vi.fn();
    const onLoadWindow = vi.fn();
    renderControls("Europe/Helsinki", {
      windowFrom: "2026-07-12T08:15",
      windowTo: "2026-07-14T22:30",
      resolutionSeconds: null,
      sampleCount: 12_345,
      partial: true,
      onWindowFrom,
      onWindowTo,
      onResolution,
      onLoadWindow,
    });

    const form = screen.getByRole("form", { name: "History window" });
    expect((within(form).getByLabelText("From") as HTMLInputElement).value).toBe("2026-07-12T08:15");
    expect((within(form).getByLabelText("To") as HTMLInputElement).value).toBe("2026-07-14T22:30");
    expect((within(form).getByLabelText("Resolution") as HTMLSelectElement).value).toBe("raw");
    expect(within(form).getByText("12,345 samples loaded")).not.toBeNull();
    expect(within(form).getByText("Partial recording loaded")).not.toBeNull();

    fireEvent.change(within(form).getByLabelText("From"), { target: { value: "2026-07-11T10:00" } });
    fireEvent.change(within(form).getByLabelText("To"), { target: { value: "2026-07-13T10:00" } });
    fireEvent.change(within(form).getByLabelText("Resolution"), { target: { value: "300" } });
    fireEvent.change(within(form).getByLabelText("Resolution"), { target: { value: "raw" } });
    fireEvent.change(within(form).getByLabelText("Resolution"), { target: { value: "custom" } });
    fireEvent.change(within(form).getByLabelText("Custom seconds"), { target: { value: "37" } });
    fireEvent.click(within(form).getByRole("button", { name: "Load recording" }));

    expect(onWindowFrom).toHaveBeenCalledWith("2026-07-11T10:00");
    expect(onWindowTo).toHaveBeenCalledWith("2026-07-13T10:00");
    expect(onResolution.mock.calls).toEqual([[300], [null], [30], [37]]);
    expect(onLoadWindow).toHaveBeenCalledTimes(1);
  });

  it("exposes loading, partial, and failed recording states accessibly", () => {
    renderControls("Europe/Helsinki", {
      windowFrom: "2026-07-12T08:15:00",
      windowTo: "2026-07-14T22:30:00",
      loading: true,
      partial: true,
      loadError: "The archive could not be reached",
      onWindowFrom: vi.fn(),
      onWindowTo: vi.fn(),
      onResolution: vi.fn(),
      onLoadWindow: vi.fn(),
    });

    const form = screen.getByRole("form", { name: "History window" });
    expect(form.getAttribute("aria-busy")).toBe("true");
    expect((within(form).getByRole("button", { name: "Loading recording…" }) as HTMLButtonElement).disabled).toBe(true);
    expect(within(form).getByText("Loading recording…", { selector: "p" }).getAttribute("role")).toBe("status");
    expect(within(form).getByText("Partial recording loaded").getAttribute("role")).toBe("status");
    expect(within(form).getByRole("alert").textContent).toContain("The archive could not be reached");
  });

  it("steps raw frames by one second and bucketed frames by their resolution", () => {
    const rawTimestamp = vi.fn();
    const raw = renderControls("Europe/Helsinki", { resolutionSeconds: null, onTimestamp: rawTimestamp });
    fireEvent.click(screen.getByRole("button", { name: "Next frame" }));
    expect(rawTimestamp).toHaveBeenLastCalledWith(timestamp + 1_000);
    raw.unmount();

    const onTimestamp = vi.fn();
    const onPlaying = vi.fn();
    const onActive = vi.fn();
    renderControls("Europe/Helsinki", { resolutionSeconds: 300, onTimestamp, onPlaying, onActive });
    fireEvent.click(screen.getByRole("button", { name: "Previous frame" }));
    fireEvent.click(screen.getByRole("button", { name: "Next frame" }));

    expect(onTimestamp.mock.calls).toEqual([[timestamp - 300_000], [timestamp + 300_000]]);
    expect(onPlaying).toHaveBeenNthCalledWith(1, false);
    expect(onActive).toHaveBeenNthCalledWith(1, true);
  });

  it("seeks to the previous and next detected events", () => {
    const previous = climateEvent({ id: "previous", timestamp: timestamp - 30 * 60_000 });
    const next = climateEvent({ id: "next", timestamp: timestamp + 30 * 60_000 });
    const onTimestamp = vi.fn();
    const onEventSelect = vi.fn();
    renderControls("Europe/Helsinki", {
      events: [previous, next],
      sensors: demo.sensors,
      definitions: demo.measurementDefinitions,
      onTimestamp,
      onEventSelect,
    });

    fireEvent.click(screen.getByRole("button", { name: "Previous detected event" }));
    fireEvent.click(screen.getByRole("button", { name: "Next detected event" }));

    expect(onTimestamp.mock.calls).toEqual([[previous.timestamp], [next.timestamp]]);
    expect(onEventSelect.mock.calls).toEqual([[previous], [next]]);
  });

  it("renders structurally available significance and automatic tags", () => {
    const annotated = {
      ...climateEvent(),
      significance: "major",
      autoTags: ["temperature", "drop", "major"],
    } as ReplayClimateEvent;
    renderControls("Europe/Helsinki", {
      events: [annotated],
      sensors: demo.sensors,
      definitions: demo.measurementDefinitions,
    });

    const event = screen.getByRole("button", { name: /Significance: major\. Auto tag: temperature\. Auto tag: drop\. Auto tag: major/ });
    expect(within(event).getByText("major")).not.toBeNull();
    expect(within(event).getByText("#temperature")).not.toBeNull();
    expect(within(event).getByText("#drop")).not.toBeNull();
    expect(within(event).getByText("#major")).not.toBeNull();
  });
});
