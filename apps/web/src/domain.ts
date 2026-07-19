import type {
  AppSession,
  AreaEquipment,
  AlertEvent,
  AlertRule,
  Floor,
  ForecastPoint,
  House,
  IntegrationStatus,
  MaintenanceTask,
  ManualObservation,
  MeasurementDefinition,
  MeasurementForecastPoint,
  MeasurementSample,
  Metric,
  MockScenario,
  Property,
  PropertyArea,
  PropertyNote,
  Reading,
  Sensor,
  SensorSnapshot,
  StaticParameter,
  UnitSystem,
} from "@climate-twin/contracts";
import {
  BUILTIN_MEASUREMENTS,
  definitionFor,
  formatMeasurement,
  fromDisplayValue,
  measurementValue,
  readingSamples,
  type LatestMeasurements,
  type MeasurementForecasts,
  type MeasurementHistory,
} from "./measurements";

export type ViewMode = "plan" | "isometric";
export type AppPage = "overview" | "properties" | "people" | "twin" | "activity" | "maintenance" | "outdoor" | "energy" | "sensors" | "alerts" | "integrations" | "developer";
export type TimeRange = "6h" | "24h" | "7d";

export interface ClimateState {
  session: AppSession;
  properties: Property[];
  propertyAreas: PropertyArea[];
  areaEquipment: AreaEquipment[];
  propertyNotes: PropertyNote[];
  measurementDefinitions: MeasurementDefinition[];
  latestMeasurements: LatestMeasurements;
  measurementHistory: MeasurementHistory;
  measurementForecasts: MeasurementForecasts;
  houses: House[];
  sensors: Sensor[];
  readings: Record<string, Reading>;
  history: Record<string, Reading[]>;
  forecasts: Record<string, ForecastPoint[]>;
  alertRules: AlertRule[];
  alerts: AlertEvent[];
  observations: ManualObservation[];
  maintenanceTasks: MaintenanceTask[];
  staticParameters: StaticParameter[];
  integration: IntegrationStatus;
  scenarios: MockScenario[];
}

export const DEMO_HOUSE_ID = "house-pine";
export const DEMO_PROPERTY_ID = "property-pine";
export const DEMO_GROUND_ID = "floor-ground";
export const DEMO_UPPER_ID = "floor-upper";

const now = new Date();

const groundFloor: Floor = {
  id: DEMO_GROUND_ID,
  name: "Ground floor",
  type: "ground",
  width: 1000,
  height: 640,
  elevation: 0,
  ceilingHeight: 2.8,
  wallHeight: 2.8,
  walls: [
    { id: "g-o1", from: { x: 50, y: 45 }, to: { x: 950, y: 45 } },
    { id: "g-o2", from: { x: 950, y: 45 }, to: { x: 950, y: 590 } },
    { id: "g-o3", from: { x: 950, y: 590 }, to: { x: 50, y: 590 } },
    { id: "g-o4", from: { x: 50, y: 590 }, to: { x: 50, y: 45 } },
    { id: "g-i1", from: { x: 535, y: 45 }, to: { x: 535, y: 360 } },
    { id: "g-i2", from: { x: 535, y: 360 }, to: { x: 950, y: 360 } },
    { id: "g-i3", from: { x: 250, y: 410 }, to: { x: 250, y: 590 } },
    { id: "g-i4", from: { x: 535, y: 360 }, to: { x: 535, y: 590 } },
  ],
  rooms: [
    { id: "r-living", name: "Living room", kind: "living", points: [{ x: 50, y: 45 }, { x: 535, y: 45 }, { x: 535, y: 410 }, { x: 50, y: 410 }] },
    { id: "r-kitchen", name: "Kitchen", kind: "kitchen", points: [{ x: 535, y: 45 }, { x: 950, y: 45 }, { x: 950, y: 360 }, { x: 535, y: 360 }] },
    { id: "r-entry", name: "Entry", kind: "entry", points: [{ x: 50, y: 410 }, { x: 250, y: 410 }, { x: 250, y: 590 }, { x: 50, y: 590 }] },
    { id: "r-hall", name: "Hall", kind: "hall", points: [{ x: 250, y: 410 }, { x: 535, y: 410 }, { x: 535, y: 590 }, { x: 250, y: 590 }] },
    { id: "r-utility", name: "Utility", kind: "utility", points: [{ x: 535, y: 360 }, { x: 950, y: 360 }, { x: 950, y: 590 }, { x: 535, y: 590 }] },
  ],
};

const upperFloor: Floor = {
  id: DEMO_UPPER_ID,
  name: "Upper floor",
  type: "upper",
  width: 1000,
  height: 640,
  elevation: 3,
  ceilingHeight: 2.6,
  wallHeight: 2.6,
  walls: [
    { id: "u-o1", from: { x: 50, y: 45 }, to: { x: 950, y: 45 } },
    { id: "u-o2", from: { x: 950, y: 45 }, to: { x: 950, y: 590 } },
    { id: "u-o3", from: { x: 950, y: 590 }, to: { x: 50, y: 590 } },
    { id: "u-o4", from: { x: 50, y: 590 }, to: { x: 50, y: 45 } },
    { id: "u-i1", from: { x: 370, y: 45 }, to: { x: 370, y: 390 } },
    { id: "u-i2", from: { x: 700, y: 45 }, to: { x: 700, y: 390 } },
    { id: "u-i3", from: { x: 50, y: 390 }, to: { x: 950, y: 390 } },
  ],
  rooms: [
    { id: "r-bedroom", name: "Main bedroom", kind: "bedroom", points: [{ x: 50, y: 45 }, { x: 370, y: 45 }, { x: 370, y: 390 }, { x: 50, y: 390 }] },
    { id: "r-bathroom", name: "Bathroom", kind: "bathroom", points: [{ x: 370, y: 45 }, { x: 700, y: 45 }, { x: 700, y: 390 }, { x: 370, y: 390 }] },
    { id: "r-office", name: "Office", kind: "office", points: [{ x: 700, y: 45 }, { x: 950, y: 45 }, { x: 950, y: 390 }, { x: 700, y: 390 }] },
    { id: "r-uphall", name: "Upstairs hall", kind: "hall", points: [{ x: 50, y: 390 }, { x: 950, y: 390 }, { x: 950, y: 590 }, { x: 50, y: 590 }] },
  ],
};

const sensorSeeds = [
  ["sensor-living", DEMO_GROUND_ID, "Living room", "Living room", 250, 220, 21.7, 43, 720],
  ["sensor-kitchen", DEMO_GROUND_ID, "Kitchen", "Kitchen", 740, 205, 22.8, 47, 840],
  ["sensor-entry", DEMO_GROUND_ID, "Entry", "Entry", 145, 500, 19.4, 51, 520],
  ["sensor-hall", DEMO_GROUND_ID, "Hall", "Hall", 390, 500, 20.5, 46, 680],
  ["sensor-utility", DEMO_GROUND_ID, "Utility room", "Utility", 750, 475, 20.2, 58, 610],
  ["sensor-bedroom", DEMO_UPPER_ID, "Main bedroom", "Main bedroom", 200, 220, 20.4, 45, 980],
  ["sensor-bathroom", DEMO_UPPER_ID, "Bathroom", "Bathroom", 535, 210, 22.1, 68, 820],
  ["sensor-office", DEMO_UPPER_ID, "Office", "Office", 820, 220, 21.5, 42, 1_050],
  ["sensor-uphall", DEMO_UPPER_ID, "Upstairs hall", "Upstairs hall", 460, 485, 20.9, 48, 700],
  ["sensor-guest", DEMO_UPPER_ID, "Guest room", "Guest room", 795, 500, 19.9, 50, 620],
] as const;

export function createDemoState(): ClimateState {
  const propertyCreatedAt = new Date(now.getTime() - 86400000 * 30).toISOString();
  const houses: House[] = [{
    id: DEMO_HOUSE_ID,
    propertyId: DEMO_PROPERTY_ID,
    name: "Pine House",
    timezone: "Europe/Helsinki",
    floors: [groundFloor, upperFloor],
    createdAt: propertyCreatedAt,
    updatedAt: now.toISOString(),
  }];
  const sensors: Sensor[] = sensorSeeds.map(([id, floorId, name, room, x, y]) => ({
    id,
    houseId: DEMO_HOUSE_ID,
    floorId,
    name,
    roomId: (floorId === DEMO_GROUND_ID ? groundFloor : upperFloor).rooms
      .find((candidate) => candidate.name === room)?.id ?? null,
    room,
    model: id === "sensor-living" ? "Tapo T315" : "Tapo T310",
    x,
    y,
    z: floorId === DEMO_UPPER_ID ? 4.4 : 1.4,
    temperatureEntityId: `sensor.${id.slice(7)}_temperature`,
    humidityEntityId: `sensor.${id.slice(7)}_humidity`,
    measurementEntityIds: {
      temperature: `sensor.${id.slice(7)}_temperature`,
      humidity: `sensor.${id.slice(7)}_humidity`,
      co2: `sensor.${id.slice(7)}_co2`,
    },
    batteryEntityId: `sensor.${id.slice(7)}_battery`,
    tags: [],
    enabled: true,
  }));
  const readings: Record<string, Reading> = {};
  const history: Record<string, Reading[]> = {};
  const forecasts: Record<string, ForecastPoint[]> = {};
  const latestMeasurements: LatestMeasurements = {};
  const measurementHistory: MeasurementHistory = {};
  const measurementForecasts: MeasurementForecasts = {};

  sensorSeeds.forEach(([id, , , , , , baseTemperature, baseHumidity, baseCo2], sensorIndex) => {
    const points: Reading[] = [];
    for (let index = 72; index >= 0; index -= 1) {
      const timestamp = new Date(now.getTime() - index * 20 * 60 * 1000);
      const wave = Math.sin((timestamp.getTime() / 3600000 + sensorIndex * 0.6) * 0.7);
      const shower = id === "sensor-bathroom" && index < 14 && index > 7 ? (14 - Math.abs(index - 10.5) * 2) : 0;
      const occupancy = (id === "sensor-bedroom" || id === "sensor-office") && index < 24 ? Math.max(0, 140 - index * 5) : 0;
      const temperature = round(baseTemperature + wave * 0.45 + sensorIndex * 0.015);
      const humidity = round(baseHumidity + wave * 1.8 + shower);
      const co2 = Math.round(baseCo2 + wave * 55 + occupancy);
      points.push({
        sensorId: id,
        timestamp: timestamp.toISOString(),
        temperature,
        humidity,
        measurements: { temperature, humidity, co2 },
        battery: 86 - sensorIndex * 2,
        source: "mock",
        quality: "good",
      });
    }
    history[id] = points;
    readings[id] = points.at(-1)!;
    const samples = points.flatMap((reading) => readingSamples(reading, BUILTIN_MEASUREMENTS));
    measurementHistory[id] = Object.fromEntries(BUILTIN_MEASUREMENTS.map((definition) => [
      definition.id,
      samples.filter((sample) => sample.metric === definition.id),
    ]));
    latestMeasurements[id] = Object.fromEntries(BUILTIN_MEASUREMENTS.flatMap((definition) => {
      const sample = measurementHistory[id]?.[definition.id]?.at(-1);
      return sample ? [[definition.id, sample]] : [];
    }));
    forecasts[id] = Array.from({ length: 13 }, (_, forecastIndex) => {
      const timestamp = new Date(now.getTime() + forecastIndex * 30 * 60 * 1000);
      const wave = Math.sin((timestamp.getTime() / 3600000 + sensorIndex * 0.6) * 0.7);
      const temperature = round(baseTemperature + wave * 0.4);
      const humidity = round(baseHumidity + wave * 1.6);
      const co2 = Math.round(baseCo2 + wave * 45);
      const temperatureLow = round(temperature - 0.45 - forecastIndex * 0.025);
      const temperatureHigh = round(temperature + 0.45 + forecastIndex * 0.025);
      const humidityLow = round(humidity - 2 - forecastIndex * 0.15);
      const humidityHigh = round(humidity + 2 + forecastIndex * 0.15);
      return {
        sensorId: id,
        timestamp: timestamp.toISOString(),
        temperature,
        humidity,
        temperatureLow,
        temperatureHigh,
        humidityLow,
        humidityHigh,
        measurements: {
          temperature: { value: temperature, low: temperatureLow, high: temperatureHigh },
          humidity: { value: humidity, low: humidityLow, high: humidityHigh },
          co2: { value: co2, low: co2 - 70 - forecastIndex * 3, high: co2 + 70 + forecastIndex * 3 },
        },
      };
    });
    measurementForecasts[id] = Object.fromEntries(BUILTIN_MEASUREMENTS.map((definition) => [
      definition.id,
      forecasts[id]!.flatMap((point) => {
        const measurement = point.measurements?.[definition.id];
        return measurement ? [{ sensorId: id, metric: definition.id, timestamp: point.timestamp, ...measurement }] : [];
      }),
    ]));
  });

  return {
    session: {
      authenticated: true,
      principal: { type: "demo", email: "owner@example.test" },
      tenant: { id: "demo", name: "Demo", role: "owner" },
      availableTenants: [{ id: "demo", name: "Demo", role: "owner" }],
      readOnly: false,
      grants: [],
    },
    properties: [{ id: DEMO_PROPERTY_ID, name: "Pine Estate", description: "Demonstration property", location: null, createdAt: propertyCreatedAt, updatedAt: now.toISOString() }],
    propertyAreas: [],
    areaEquipment: [],
    propertyNotes: [],
    measurementDefinitions: BUILTIN_MEASUREMENTS,
    latestMeasurements,
    measurementHistory,
    measurementForecasts,
    houses,
    sensors,
    readings,
    history,
    forecasts,
    alertRules: [{
      id: "rule-high-humidity",
      name: "Sustained high humidity",
      sensorId: null,
      metric: "humidity",
      operator: "gte",
      threshold: 65,
      durationSeconds: 900,
      severity: "warning",
      enabled: true,
      webhookEnabled: true,
      telegramEnabled: false,
    }],
    alerts: [{
      id: "alert-bathroom",
      ruleId: "rule-high-humidity",
      sensorId: "sensor-bathroom",
      metric: "humidity",
      value: 68,
      threshold: 65,
      severity: "warning",
      startedAt: new Date(now.getTime() - 18 * 60 * 1000).toISOString(),
      acknowledgedAt: null,
      resolvedAt: null,
    }],
    observations: [{
      id: "observation-seal",
      houseId: DEMO_HOUSE_ID,
      floorId: DEMO_GROUND_ID,
      sensorId: null,
      kind: "maintenance",
      severity: "info",
      note: "Window seal checked",
      x: 85,
      y: 215,
      occurredAt: new Date(now.getTime() - 86400000 * 2).toISOString(),
      createdAt: new Date(now.getTime() - 86400000 * 2).toISOString(),
      timePrecision: "exact",
      validFrom: null,
      validTo: null,
      source: "unknown",
      sourceDetail: null,
      confidence: "uncertain",
      revision: 1,
      updatedAt: new Date(now.getTime() - 86400000 * 2).toISOString(),
    }],
    maintenanceTasks: [],
    staticParameters: [{
      id: "parameter-wall",
      houseId: DEMO_HOUSE_ID,
      scopeType: "house",
      scopeId: DEMO_HOUSE_ID,
      key: "wall_insulation",
      value: "200 mm mineral wool",
      unit: null,
      label: "Wall insulation",
    }],
    integration: {
      homeAssistant: { configured: false, connected: false, lastEventAt: null, mappedEntities: 0, error: null },
      tpLink: { configured: false, connected: false, lastPollAt: null, mappedDevices: 0, discoveredDevices: 0, hubModel: null, error: null },
      webhook: { configured: false, lastDeliveryAt: null, error: null },
      telegram: { available: true, configured: false, connected: false, botUsername: null, chatLabel: null, lastDeliveryAt: null, error: null },
      appleNotes: { available: true, configured: false, grantCount: 0, lastSyncAt: null, error: null },
      mock: { enabled: true, intervalMs: 2000, mode: "demo", activatedAt: null },
      weather: { policy: "automatic", availableProviders: ["fmi", "open-meteo"], provider: "fmi", configuredHouses: 0, lastSuccessAt: null, error: null },
    },
    scenarios: [
      { id: "normal", label: "Normal day", description: "Stable indoor conditions" },
      { id: "shower", label: "Shower humidity", description: "Humidity spreads from the bathroom" },
      { id: "leak", label: "Slow leak", description: "Moisture grows around one sensor" },
      { id: "cold-front", label: "Cold front", description: "Cooling progresses from the entry" },
      { id: "heating-failure", label: "Heating failure", description: "A heating zone slowly cools" },
    ],
  };
}

export function nextMockReading(
  sensor: Sensor,
  previous: Reading,
  scenario: MockScenario["id"],
  tick: number,
): Reading {
  let temperatureShift = Math.sin((tick + sensor.x / 120) / 10) * 0.08;
  let humidityShift = Math.cos((tick + sensor.y / 100) / 9) * 0.18;
  let co2Shift = Math.sin((tick + sensor.x / 180 + sensor.y / 210) / 8) * 12;
  if (scenario === "shower") {
    const distance = Math.hypot(sensor.x - 535, sensor.y - 210);
    humidityShift += Math.max(0, 2.2 - distance / 240);
  } else if (scenario === "leak") {
    const distance = Math.hypot(sensor.x - 760, sensor.y - 480);
    humidityShift += Math.max(0, 1.2 - distance / 420);
  } else if (scenario === "cold-front") {
    temperatureShift -= Math.max(0, 0.35 - sensor.x / 3000);
  } else if (scenario === "heating-failure" && sensor.floorId === DEMO_UPPER_ID) {
    temperatureShift -= 0.18;
  }
  if (scenario === "shower" && sensor.room === "Bathroom") co2Shift += 8;
  const temperature = round(clamp(previous.temperature + temperatureShift, 12, 30));
  const humidity = round(clamp(previous.humidity + humidityShift, 20, 90));
  const co2 = Math.round(clamp((measurementValue(previous, "co2") ?? 700) + co2Shift, 380, 2_500));
  return {
    ...previous,
    timestamp: new Date().toISOString(),
    temperature,
    humidity,
    measurements: { ...previous.measurements, temperature, humidity, co2 },
    source: "mock",
    quality: "good",
  };
}

export function readingAt(readings: Reading[], timestamp: number): Reading | undefined {
  return readings.reduce<Reading | undefined>((closest, reading) => {
    if (new Date(reading.timestamp).getTime() > timestamp) return closest;
    if (!closest || new Date(reading.timestamp).getTime() > new Date(closest.timestamp).getTime()) return reading;
    return closest;
  }, undefined);
}

export function displayValue(value: number, metric: Metric, units: UnitSystem): string {
  return formatMeasurement(value, definitionFor(BUILTIN_MEASUREMENTS, metric), units);
}

export function toCanonicalValue(value: number, metric: Metric, units: UnitSystem): number {
  return fromDisplayValue(value, definitionFor(BUILTIN_MEASUREMENTS, metric), units);
}

export function metricValue(reading: Reading, metric: Metric): number {
  return measurementValue(reading, metric) ?? Number.NaN;
}

export function round(value: number): number {
  return Math.round(value * 10) / 10;
}

export function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

export function snapshotToReadings(snapshots: SensorSnapshot[]): Record<string, Reading> {
  return Object.fromEntries(snapshots.filter((item) => item.reading).map((item) => [item.id, item.reading!]));
}
