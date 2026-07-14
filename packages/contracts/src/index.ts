/** Registry identifier for a measurement type (for example `temperature` or `co2`). */
export type Metric = string;
export type MeasurementColorScale = "thermal" | "humidity" | "air-quality" | "sequential";

export interface MeasurementDefinition {
  id: Metric;
  labels: Record<string, string>;
  unit: string;
  precision: number;
  validMin: number | null;
  validMax: number | null;
  displayMin: number | null;
  displayMax: number | null;
  interpolationDelta: number;
  colorScale: MeasurementColorScale;
  builtin: boolean;
  enabled: boolean;
  spatialInterpolation: boolean;
  forecastSupported: boolean;
}

export interface MeasurementSample {
  sensorId: string;
  metric: Metric;
  value: number;
  canonicalUnit: string;
  timestamp: string;
  source: "mock" | "home-assistant" | "api" | "replay";
  quality: "good" | "estimated" | "stale";
}

export interface MeasurementForecastPoint {
  sensorId: string;
  metric: Metric;
  timestamp: string;
  value: number;
  low: number;
  high: number;
}

export interface MeasurementSnapshotEntry {
  sensorId: string;
  measurements: Record<Metric, MeasurementSample>;
}
export type UnitSystem = "metric" | "imperial";
export type ConnectionState = "live" | "reconnecting" | "offline";

export interface Point {
  x: number;
  y: number;
}

export interface Wall {
  id: string;
  from: Point;
  to: Point;
}

export interface Room {
  id: string;
  name: string;
  points: Point[];
  kind?: string;
}

export interface Floor {
  id: string;
  name: string;
  /** Horizontal floor-plan extent; x coordinates use the same local system. */
  width: number;
  /** Horizontal floor-plan extent; y coordinates use the same local system. */
  height: number;
  /** Absolute floor-plane height in metres in the house vertical coordinate system. */
  elevation: number;
  walls: Wall[];
  rooms: Room[];
  backgroundImage?: string;
}

/** WGS84 position used for house-scoped outdoor context such as weather. */
export interface HouseLocation {
  latitude: number;
  longitude: number;
  /** Optional user-facing description; precise street addresses are not required. */
  label?: string;
}

export interface House {
  id: string;
  name: string;
  timezone: string;
  location?: HouseLocation;
  floors: Floor[];
  createdAt: string;
  updatedAt: string;
}

/** Canonical outdoor values. Missing upstream values are omitted, never invented. */
export interface OutdoorConditions {
  timestamp: string;
  temperatureC?: number;
  dewPointC?: number;
  relativeHumidityPercent?: number;
  pressureHpa?: number;
  windDirectionDegrees?: number;
  windSpeedMps?: number;
  windGustMps?: number;
  precipitation1hMm?: number;
  precipitationIntensityMmPerHour?: number;
  precipitationProbabilityPercent?: number;
  precipitationFormCode?: number;
  potentialPrecipitationFormCode?: number;
  snowDepthCm?: number;
  cloudCoverPercent?: number;
  lowCloudCoverPercent?: number;
  mediumCloudCoverPercent?: number;
  highCloudCoverPercent?: number;
  visibilityMeters?: number;
  fogIntensity?: number;
  globalRadiationWm2?: number;
  weatherSymbolCode?: number;
  presentWeatherCode?: number;
  thunderstormProbabilityPercent?: number;
  frostProbabilityPercent?: number;
  severeFrostProbabilityPercent?: number;
  maximumWindSpeedMps?: number;
  maximumWindGustMps?: number;
}

export interface WeatherStation {
  id: string | null;
  name: string;
  latitude: number;
  longitude: number;
  distanceKm: number;
}

export type WeatherWarningSeverity = "minor" | "moderate" | "severe" | "extreme" | "unknown";

export interface WeatherWarning {
  id: string;
  event: string;
  headline: string;
  description: string;
  severity: WeatherWarningSeverity;
  urgency: string;
  certainty: string;
  effectiveAt: string | null;
  onsetAt: string | null;
  expiresAt: string | null;
  areas: string[];
  web: string | null;
}

/** House-scoped FMI observation, forecast, and official warning context. */
export interface HouseWeather {
  houseId: string;
  location: HouseLocation;
  provider: "fmi";
  attribution: string;
  fetchedAt: string;
  forecastIssuedAt: string | null;
  stale: boolean;
  current: OutdoorConditions | null;
  observationStation: WeatherStation | null;
  forecast: OutdoorConditions[];
  warnings: WeatherWarning[];
  unavailable: Array<"observation" | "forecast" | "short-range" | "warnings">;
}

export interface Sensor {
  id: string;
  houseId: string;
  floorId: string;
  name: string;
  room: string;
  model: string;
  /** Local position within the selected floor's width coordinate system. */
  x: number;
  /** Local position within the selected floor's height coordinate system. */
  y: number;
  /** Absolute height in metres using the same vertical coordinate system as Floor.elevation. */
  z: number;
  temperatureEntityId?: string;
  humidityEntityId?: string;
  batteryEntityId?: string;
  /** Home Assistant entity bindings keyed by a registered measurement id. */
  measurementEntityIds?: Record<Metric, string>;
  tags: string[];
  enabled: boolean;
}

export interface Reading {
  sensorId: string;
  timestamp: string;
  temperature: number;
  humidity: number;
  battery: number | null;
  source: "mock" | "home-assistant" | "api" | "replay";
  quality: "good" | "estimated" | "stale";
  /** Optional generic projection. Legacy fields remain required for v1 compatibility. */
  measurements?: Record<Metric, number>;
}

export interface SensorSnapshot extends Sensor {
  reading: Reading | null;
}

export interface ForecastPoint {
  sensorId: string;
  timestamp: string;
  temperature: number;
  humidity: number;
  temperatureLow: number;
  temperatureHigh: number;
  humidityLow: number;
  humidityHigh: number;
  measurements?: Record<Metric, { value: number; low: number; high: number }>;
}

export type AlertOperator = "gt" | "gte" | "lt" | "lte";
export type AlertSeverity = "info" | "warning" | "critical";

export interface AlertRule {
  id: string;
  name: string;
  sensorId: string | null;
  metric: Metric;
  operator: AlertOperator;
  threshold: number;
  durationSeconds: number;
  severity: AlertSeverity;
  enabled: boolean;
  webhookEnabled: boolean;
}

export interface AlertEvent {
  id: string;
  ruleId: string;
  sensorId: string;
  metric: Metric;
  value: number;
  threshold: number;
  severity: AlertSeverity;
  startedAt: string;
  acknowledgedAt: string | null;
  resolvedAt: string | null;
}

export type ObservationKind =
  | "leak"
  | "condensation"
  | "mould"
  | "ventilation"
  | "maintenance"
  | "note";

export interface ManualObservation {
  id: string;
  houseId: string;
  floorId: string;
  sensorId: string | null;
  kind: ObservationKind;
  severity: AlertSeverity;
  note: string;
  x: number | null;
  y: number | null;
  occurredAt: string;
  createdAt: string;
}

export interface StaticParameter {
  id: string;
  houseId: string;
  scopeType: "house" | "floor" | "room" | "sensor";
  scopeId: string;
  key: string;
  value: string | number | boolean;
  unit: string | null;
  label: string;
}

export interface IntegrationStatus {
  homeAssistant: {
    configured: boolean;
    connected: boolean;
    lastEventAt: string | null;
    mappedEntities: number;
    error: string | null;
  };
  webhook: {
    configured: boolean;
    lastDeliveryAt: string | null;
    error: string | null;
  };
  mock: {
    enabled: boolean;
    intervalMs: number;
  };
  weather: {
    provider: "fmi";
    configuredHouses: number;
    lastSuccessAt: string | null;
    error: string | null;
  };
}

export interface TelemetryEvent {
  type: "reading" | "alert" | "integration" | "heartbeat";
  data: Reading | AlertEvent | IntegrationStatus | { timestamp: string };
}

export interface HistorySeries {
  sensorId: string;
  readings: Reading[];
  forecast: ForecastPoint[];
}

export interface MockScenario {
  id: "normal" | "shower" | "leak" | "cold-front" | "heating-failure";
  label: string;
  description: string;
}

export interface ApiError {
  error: {
    code: string;
    message: string;
    details?: unknown;
  };
}

export const API_VERSION = "v1" as const;
export const DEFAULT_API_PREFIX = `/api/${API_VERSION}` as const;
