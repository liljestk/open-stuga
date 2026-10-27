import type {
  House,
  MeasurementSample,
  Sensor,
  WeatherWarning,
} from "@climate-twin/contracts";

import { type HomeInsightInput } from "../src/analytics/home-monitoring/model.js";

export const NOW = "2026-07-14T12:00:00.000Z";

export const NOW_MS = Date.parse(NOW);

export const house: House = {
  id: "house-1",
  propertyId: "property-1",
  name: "Pine House",
  timezone: "Europe/Helsinki",
  floors: [{
    id: "floor-1",
    name: "Ground floor",
    width: 100,
    height: 100,
    elevation: 0,
    walls: [],
    rooms: [],
  }],
  createdAt: "2026-01-01T00:00:00.000Z",
  updatedAt: "2026-01-01T00:00:00.000Z",
};

export function sensor(id: string, room: string, overrides: Partial<Sensor> = {}): Sensor {
  return {
    id,
    houseId: house.id,
    floorId: "floor-1",
    name: `${room} sensor`,
    room,
    model: "Tapo T315",
    x: 10,
    y: 10,
    z: 1.2,
    tags: [],
    enabled: true,
    ...overrides,
  };
}

export function sample(
  target: Sensor,
  metric: string,
  value: number,
  minutesAgo: number,
  overrides: Partial<MeasurementSample> = {},
): MeasurementSample {
  const units: Record<string, string> = { temperature: "\u00b0C", humidity: "%", co2: "ppm" };
  return {
    sensorId: target.id,
    metric,
    value,
    canonicalUnit: units[metric] ?? "",
    timestamp: new Date(NOW_MS - minutesAgo * 60_000).toISOString(),
    source: "tp-link",
    quality: "good",
    ...overrides,
  };
}

export function baseInput(overrides: Partial<HomeInsightInput> = {}): HomeInsightInput {
  return {
    house,
    sensors: [],
    latestMeasurements: {},
    referenceTime: NOW,
    ...overrides,
  };
}

export function warning(overrides: Partial<WeatherWarning> = {}): WeatherWarning {
  return {
    id: "wind-warning",
    event: "Strong wind",
    headline: "Strong wind warning",
    description: "Strong gusts expected",
    severity: "severe",
    urgency: "immediate",
    certainty: "likely",
    effectiveAt: "2026-07-14T10:00:00.000Z",
    onsetAt: "2026-07-14T10:00:00.000Z",
    expiresAt: "2026-07-14T14:00:00.000Z",
    areas: ["Uusimaa"],
    web: null,
    ...overrides,
  };
}
