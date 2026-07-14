import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import type { AlertEvent, IntegrationStatus, MeasurementSample, Sensor } from "@climate-twin/contracts";
import { I18nProvider } from "../i18n";
import { BUILTIN_MEASUREMENTS } from "../measurements";
import { createDemoState } from "../domain";
import { buildRoomComforts, RoomComfortBoard } from "./RoomComfortBoard";
import { buildMoistureAdvice, dewPointCelsius } from "./MoistureCoach";
import { buildHomeActivityEvents } from "./HomeActivityTimeline";
import { HomePulsePanel } from "./HomePulsePanel";

const now = Date.parse("2026-07-14T12:00:00.000Z");
const sensor: Sensor = {
  id: "sensor-room",
  houseId: "house",
  floorId: "floor",
  name: "Desk sensor",
  room: "Office",
  model: "T315",
  x: 1,
  y: 1,
  z: 1.4,
  tags: [],
  enabled: true,
};

function sample(metric: string, value: number, timestamp = "2026-07-14T11:55:00.000Z"): MeasurementSample {
  return { sensorId: sensor.id, metric, value, canonicalUnit: metric === "temperature" ? "°C" : metric === "humidity" ? "%" : "ppm", timestamp, source: "mock", quality: "good" };
}

const integration: IntegrationStatus = {
  homeAssistant: { configured: false, connected: false, lastEventAt: null, mappedEntities: 0, error: null },
  tpLink: { configured: false, connected: false, lastPollAt: null, mappedDevices: 0, discoveredDevices: 0, hubModel: null, error: null },
  webhook: { configured: false, lastDeliveryAt: null, error: null },
  mock: { enabled: true, intervalMs: 2_000, mode: "demo", activatedAt: null },
  weather: { policy: "automatic", availableProviders: ["fmi", "open-meteo"], provider: "fmi", configuredHouses: 0, lastSuccessAt: null, error: null },
};

describe("decision layer", () => {
  it("prioritizes an alerted room and rejects implausible future samples", () => {
    const alert: AlertEvent = { id: "alert", ruleId: "rule", sensorId: sensor.id, metric: "humidity", value: 72, threshold: 65, severity: "warning", startedAt: "2026-07-14T11:50:00.000Z", acknowledgedAt: null, resolvedAt: null };
    const comforts = buildRoomComforts({
      sensors: [sensor],
      latestMeasurements: { [sensor.id]: { temperature: sample("temperature", 22), humidity: sample("humidity", 67), co2: sample("co2", 950) } },
      measurementHistory: { [sensor.id]: { temperature: [sample("temperature", 21, "2026-07-14T10:00:00.000Z"), sample("temperature", 22)] } },
      alerts: [alert],
      now,
    });
    expect(comforts[0]).toMatchObject({ room: "Office", state: "attention", temperature: 22, humidity: 67 });

    const future = buildRoomComforts({
      sensors: [sensor],
      latestMeasurements: { [sensor.id]: { temperature: sample("temperature", 22, "2026-07-15T12:00:00.000Z") } },
      measurementHistory: {},
      alerts: [],
      now,
    });
    expect(future[0]?.state).toBe("offline");
  });

  it("compares dew point instead of relative humidity for ventilation guidance", () => {
    expect(dewPointCelsius(22, 65)).toBeCloseTo(15.1, 1);
    const advice = buildMoistureAdvice({
      sensors: [sensor],
      latestMeasurements: { [sensor.id]: { temperature: sample("temperature", 22), humidity: sample("humidity", 65) } },
      conditions: { timestamp: "2026-07-14T11:50:00.000Z", temperatureC: 12, dewPointC: 7, relativeHumidityPercent: 72 },
      now,
    });
    expect(advice).toMatchObject({ kind: "ventilate", room: "Office", reason: "drier-outside", elevatedMoisture: true });

    expect(buildMoistureAdvice({
      sensors: [sensor],
      latestMeasurements: { [sensor.id]: { temperature: sample("temperature", 22), humidity: sample("humidity", 65) } },
      conditions: { timestamp: "2026-07-14T11:50:00.000Z", temperatureC: 12, dewPointC: 7 },
      weatherStale: true,
      now,
    }).kind).toBe("limited");
  });

  it("sorts alerts, observations, and weather into one activity feed", () => {
    const events = buildHomeActivityEvents({
      sensors: [sensor],
      alerts: [{ id: "alert", ruleId: "rule", sensorId: sensor.id, metric: "humidity", value: 72, threshold: 65, severity: "warning", startedAt: "2026-07-14T10:00:00.000Z", acknowledgedAt: null, resolvedAt: null }],
      observations: [{ id: "observation", houseId: "house", floorId: "floor", sensorId: null, kind: "maintenance", severity: "info", note: "Filter changed", x: 1, y: 1, occurredAt: "2026-07-14T11:00:00.000Z", createdAt: "2026-07-14T11:00:00.000Z" }],
      warnings: [{ id: "warning", event: "Wind", headline: "Strong gusts", description: "", severity: "moderate", urgency: "", certainty: "", effectiveAt: "2026-07-14T09:00:00.000Z", onsetAt: null, expiresAt: null, areas: [], web: null }],
      integration,
    });
    expect(events.map((event) => event.kind)).toEqual(["observation", "alert", "weather"]);
    expect(events[1]).toMatchObject({ sensorId: sensor.id, floorId: sensor.floorId });
  });

  it("opens the representative sensor from a room card", () => {
    const onOpenRoom = vi.fn();
    render(<I18nProvider><RoomComfortBoard sensors={[sensor]} latestMeasurements={{ [sensor.id]: { temperature: sample("temperature", 22), humidity: sample("humidity", 45), co2: sample("co2", 700) } }} measurementHistory={{}} definitions={BUILTIN_MEASUREMENTS} alerts={[]} units="metric" now={now} onOpenRoom={onOpenRoom} /></I18nProvider>);
    fireEvent.click(screen.getByRole("button", { name: "Open Office. Status: Comfortable" }));
    expect(onOpenRoom).toHaveBeenCalledWith("floor", "sensor-room");
  });

  it("localizes generated Home Pulse guidance and evidence in Finnish", () => {
    localStorage.setItem("climate-twin-locale", "fi");
    const state = createDemoState();
    const house = state.houses[0]!;
    const roomSensor = state.sensors.find((candidate) => candidate.houseId === house.id)!;
    const humidity = (value: number, timestamp: string): MeasurementSample => ({
      sensorId: roomSensor.id,
      metric: "humidity",
      value,
      canonicalUnit: "%",
      timestamp,
      source: "mock",
      quality: "good",
    });
    const latestHumidity = humidity(70.5, "2026-07-14T11:55:00.000Z");

    render(<I18nProvider><HomePulsePanel
      house={house}
      sensors={[roomSensor]}
      latestMeasurements={{ [roomSensor.id]: { humidity: latestHumidity } }}
      measurementHistory={{ [roomSensor.id]: { humidity: [
        humidity(68, "2026-07-14T10:50:00.000Z"),
        humidity(69, "2026-07-14T11:20:00.000Z"),
        latestHumidity,
      ] } }}
      alerts={[]}
      alertRules={[]}
      weather={null}
      referenceTime={now}
      onOpenTarget={vi.fn()}
    /></I18nProvider>);

    expect(screen.getByText(`Huoneen ${roomSensor.room} ilmankosteus on koholla`)).not.toBeNull();
    expect(screen.getByText("Viimeisin suhteellinen ilmankosteus on 70,5 %.")).not.toBeNull();
    expect(screen.getByText("Viimeisin ilmankosteus")).not.toBeNull();
    expect(screen.queryByText(/Humidity is elevated/)).toBeNull();
  });
});
