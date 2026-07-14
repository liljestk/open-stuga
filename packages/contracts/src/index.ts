/** Registry identifier for a measurement type (for example `temperature` or `co2`). */
export type Metric = string;
export type MeasurementColorScale = "thermal" | "humidity" | "air-quality" | "sequential";

/** Product release version. Pre-1.0 minor releases may contain breaking changes. */
export const SYSTEM_VERSION = "0.2.0" as const;

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

export type MeasurementDefinitionInput = Pick<MeasurementDefinition, "id" | "labels" | "unit">
  & Partial<Omit<MeasurementDefinition, "id" | "labels" | "unit" | "builtin">>;
export type MeasurementDefinitionPatch = Partial<Omit<MeasurementDefinition, "id" | "builtin">>;

export interface MeasurementSample {
  sensorId: string;
  metric: Metric;
  value: number;
  canonicalUnit: string;
  timestamp: string;
  source: "mock" | "home-assistant" | "tp-link" | "api" | "import" | "replay";
  quality: "good" | "estimated" | "stale";
}

export type MeasurementSampleInput = Pick<MeasurementSample, "sensorId" | "metric" | "value">
  & Partial<Pick<MeasurementSample, "canonicalUnit" | "timestamp" | "source" | "quality">>;

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

/** Architectural symbols placed independently of wall geometry on a floor plan. */
export type PlanElementKind = "door" | "window" | "fireplace" | "vent";

interface PlanElementBase {
  id: string;
  position: Point;
  /** Clockwise rotation in degrees. */
  rotationDegrees: number;
  /** Symbol width in the floor's local coordinate system. */
  width?: number;
}

/** A wall opening whose full width must fit within its referenced wall segment. */
export interface WallOpeningPlanElement extends PlanElementBase {
  kind: "door" | "window";
  /** Used for wall alignment and cascade deletion. */
  wallId: string;
}

/** A free-standing plan symbol that is not tied to wall lifecycle. */
export interface FixturePlanElement extends PlanElementBase {
  kind: "fireplace" | "vent";
  wallId?: never;
}

export type PlanElement = WallOpeningPlanElement | FixturePlanElement;

/** Semantic level type used by the editor to organise mixed building layouts. */
export type FloorType = "basement" | "ground" | "upper" | "attic" | "mezzanine" | "outdoor";

export interface Floor {
  id: string;
  name: string;
  /** Optional semantic type; older layouts without it remain valid. */
  type?: FloorType;
  /** Horizontal floor-plan extent; x coordinates use the same local system. */
  width: number;
  /** Horizontal floor-plan extent; y coordinates use the same local system. */
  height: number;
  /** Absolute floor-plane height in metres in the house vertical coordinate system. */
  elevation: number;
  /** Clear room height in metres, used when stacking and duplicating levels. */
  ceilingHeight?: number;
  walls: Wall[];
  rooms: Room[];
  /** Optional for backward compatibility with layouts saved before plan symbols existed. */
  planElements?: PlanElement[];
  backgroundImage?: string;
}

/** WGS84 position used for house-scoped outdoor context such as weather. */
export interface HouseLocation {
  latitude: number;
  longitude: number;
  /** Optional user-facing description; precise street addresses are not required. */
  label?: string;
  /** ISO 3166-1 alpha-2 hint retained when place discovery supplied it. */
  countryCode?: string;
  /** How this suggestion was obtained; explicit user changes remain distinguishable. */
  source?: "manual" | "place-search" | "browser-geolocation" | "home-assistant" | "map-placement";
  confidence?: "high" | "medium" | "low";
  discoveredAt?: string;
  /** True once a person explicitly enters or adjusts this value. */
  userOverridden?: boolean;
}

export interface DiscoveredLocation {
  id: string;
  name: string;
  label: string;
  latitude: number;
  longitude: number;
  timezone: string;
  countryCode: string | null;
  country: string | null;
  region: string | null;
  source: "open-meteo-geocoding";
  confidence: "high" | "medium";
}

export interface CoordinateDefaults {
  timezone: string;
  source: "open-meteo-coordinate";
}

/**
 * Precise map placement for a floor plan, independent of the location used for
 * weather. Latitude/longitude anchor the plan and metersPerPlanUnit converts
 * its local x/y coordinates to real-world distance.
 */
export interface HouseMapPlacement {
  latitude: number;
  longitude: number;
  metersPerPlanUnit: number;
  /** Floor whose plan extent should be used as the house's map footprint. */
  footprintFloorId?: string;
}

export interface House {
  id: string;
  name: string;
  timezone: string;
  location?: HouseLocation;
  mapPlacement?: HouseMapPlacement;
  /**
   * Clockwise compass bearing of the floor plan's top/up direction.
   * 0 = north, 90 = east, 180 = south, and 270 = west.
   * Omitted until the user confirms the plan's real-world orientation.
   */
  orientationDegrees?: number;
  floors: Floor[];
  createdAt: string;
  updatedAt: string;
}

export type HouseCreateInput = Pick<House, "name" | "timezone" | "floors">
  & Partial<Pick<House, "id" | "location" | "mapPlacement" | "orientationDegrees">>;
export type HousePatch = Partial<Pick<House, "name" | "timezone" | "floors">> & {
  location?: HouseLocation | null;
  mapPlacement?: HouseMapPlacement | null;
  orientationDegrees?: number | null;
};

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

export type WeatherComponentName = "observation" | "forecast" | "short-range" | "warnings";
export type WeatherProviderName = "fmi" | "open-meteo";
export type WeatherComponentAvailability = "available" | "unavailable" | "not-applicable";
export type WeatherComponentCoverage = "covered" | "outside-coverage" | "unknown";

/**
 * Per-component operational and provenance metadata. This is additive to the
 * legacy `unavailable` array so existing weather clients remain compatible.
 * An empty array is authoritative only when `emptyResultIsAuthoritative` is true.
 */
export interface WeatherComponentStatus {
  provider: WeatherProviderName;
  product: string;
  attribution: string;
  availability: WeatherComponentAvailability;
  coverage: WeatherComponentCoverage;
  emptyResultIsAuthoritative: boolean;
  fetchedAt: string;
  stale: boolean;
}

export type WeatherComponentStatuses = Record<WeatherComponentName, WeatherComponentStatus>;

/** House-scoped observation, forecast, and official warning context. */
export interface HouseWeather {
  houseId: string;
  location: HouseLocation;
  provider: WeatherProviderName;
  attribution: string;
  fetchedAt: string;
  forecastIssuedAt: string | null;
  stale: boolean;
  current: OutdoorConditions | null;
  observationStation: WeatherStation | null;
  forecast: OutdoorConditions[];
  warnings: WeatherWarning[];
  unavailable: Array<"observation" | "forecast" | "short-range" | "warnings">;
  /** Optional for wire compatibility with providers/clients predating component metadata. */
  componentStatus?: WeatherComponentStatuses;
}

export type OutdoorTemperatureSource = "fmi-observation" | "open-meteo-current" | "mock" | "api";

/** Durable outdoor boundary observation. Forecasts are deliberately not stored as observations. */
export interface OutdoorTemperatureSample {
  houseId: string;
  locationKey: string;
  timestamp: string;
  temperatureC: number;
  source: OutdoorTemperatureSource;
  fetchedAt: string;
  stationId: string | null;
  stationName: string | null;
}

export type ThermalCalibrationStatus = "ready" | "provisional" | "insufficient-data";

/** A fitted, effective first-order room model. Parameters are empirical, not construction properties. */
export interface ThermalModelV1 {
  method: "first-order-lumped-v1";
  version: "1.0.0";
  scope: {
    houseId: string;
    sensorIds: string[];
  };
  trainedFrom: string;
  trainedTo: string;
  parameters: {
    timeConstantHours: number;
    effectiveEquilibriumLiftC: number;
  };
  applicability: {
    indoorMinC: number;
    indoorMaxC: number;
    outdoorMinC: number;
    outdoorMaxC: number;
    maxHorizonHours: number;
  };
  sensitivity: {
    timeConstantLowHours: number;
    timeConstantHighHours: number;
    liftLowC: number;
    liftHighC: number;
  };
}

export interface ThermalCalibrationQuality {
  indoorSamples: number;
  outdoorSamples: number;
  alignedSamples: number;
  transitionsUsed: number;
  durationHours: number;
  indoorRangeC: number;
  outdoorRangeC: number;
  validationMaeC: number | null;
  validationRmseC: number | null;
  validationBiasC: number | null;
  persistenceMaeC: number | null;
  residualP90C: number | null;
}

export interface ThermalCalibrationResult {
  status: ThermalCalibrationStatus;
  model: ThermalModelV1 | null;
  quality: ThermalCalibrationQuality;
  /** Stable machine-readable warning/reason identifiers. */
  warnings: string[];
  assumptions: string[];
}

/** Observed and simulated values remain separate; residual is observed minus simulated. */
export interface ThermalSimulationPoint {
  timestamp: string;
  phase: "fit" | "scenario";
  outdoorTemperatureC: number;
  observedTemperatureC: number | null;
  simulatedTemperatureC: number;
  residualC: number | null;
  lowC: number;
  highC: number;
}

export interface ThermalSimulationResult {
  generatedAt: string;
  systemVersion: typeof SYSTEM_VERSION;
  houseId: string;
  sensorId: string;
  roomLabel: string;
  from: string;
  to: string;
  horizonHours: number;
  scenarioOutdoorTemperatureC: number | null;
  /** Latest observation used to initialize a scenario, or null when no model could be fitted. */
  scenarioAnchorTimestamp: string | null;
  calibration: ThermalCalibrationResult;
  points: ThermalSimulationPoint[];
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
  /** Stable child-device identifier when this sensor is read directly from a TP-Link hub. */
  tpLinkDeviceId?: string;
  /** Home Assistant entity bindings keyed by a registered measurement id. */
  measurementEntityIds?: Record<Metric, string>;
  tags: string[];
  enabled: boolean;
}

export type SensorCreateInput = Omit<Sensor, "id"> & { id?: string };
export type SensorPatch = Partial<Omit<Sensor, "id" | "tpLinkDeviceId">> & { tpLinkDeviceId?: string | null };

/** Sanitized TP-Link child-device details exposed for local onboarding. */
export interface TpLinkDiscoveredDevice {
  deviceId: string;
  model: string;
  alias: string | null;
  status: string | null;
  temperature: number | null;
  humidity: number | null;
  battery: number | null;
  lastSeenAt: string;
  mappedSensorId: string | null;
}

export interface Reading {
  sensorId: string;
  timestamp: string;
  temperature: number;
  humidity: number;
  battery: number | null;
  source: "mock" | "home-assistant" | "tp-link" | "api" | "import" | "replay";
  quality: "good" | "estimated" | "stale";
  /** Optional generic projection. Legacy fields remain required for v1 compatibility. */
  measurements?: Record<Metric, number>;
}

export type ReadingInput = Pick<Reading, "sensorId" | "temperature" | "humidity">
  & Partial<Pick<Reading, "timestamp" | "battery" | "quality" | "measurements">>;

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

export type AlertRuleInput = Omit<AlertRule, "id" | "sensorId" | "enabled" | "webhookEnabled"> & {
  id?: string;
  sensorId?: string | null;
  enabled?: boolean;
  webhookEnabled?: boolean;
};
export type AlertRulePatch = Partial<Omit<AlertRule, "id">>;

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

export type ManualObservationInput = Omit<ManualObservation, "id" | "sensorId" | "x" | "y" | "occurredAt" | "createdAt"> & {
  id?: string;
  sensorId?: string | null;
  x?: number | null;
  y?: number | null;
  occurredAt?: string;
};

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

export type StaticParameterInput = Omit<StaticParameter, "id" | "unit"> & { id?: string; unit?: string | null };

export interface AssetRecord {
  id: string;
  houseId: string;
  name: string;
  mimeType: string;
  kind: "floor-plan" | "model-3d" | "other";
  size: number;
  createdAt: string;
}

export interface AssetUploadInput {
  houseId: string;
  name: string;
  mimeType: "image/png" | "image/jpeg" | "image/webp" | "model/gltf+json" | "model/gltf-binary";
  kind: AssetRecord["kind"];
  /** Base64 bytes, optionally prefixed by a data URL. */
  data: string;
}

export interface IntegrationStatus {
  homeAssistant: {
    configured: boolean;
    connected: boolean;
    lastEventAt: string | null;
    mappedEntities: number;
    error: string | null;
  };
  tpLink: {
    configured: boolean;
    connected: boolean;
    lastPollAt: string | null;
    mappedDevices: number;
    discoveredDevices: number;
    hubModel: "H100" | "H200" | null;
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
    /** `real` is a persistent one-way latch: demo telemetry can no longer be stored or generated. */
    mode: "demo" | "real";
    activatedAt: string | null;
  };
  weather: {
    /** Selection policy; omitted by older servers that always used `provider`. */
    policy?: "automatic" | WeatherProviderName;
    /** Providers installed behind the automatic router. */
    availableProviders?: WeatherProviderName[];
    provider: WeatherProviderName;
    configuredHouses: number;
    lastSuccessAt: string | null;
    error: string | null;
  };
}

export interface HomeAssistantDiscoveredInstance {
  name: string;
  url: string;
  host: string;
  port: number;
  version: string | null;
}

export interface TpLinkDiscoveredHub {
  host: string;
  model: "H100" | "H200";
  alias: string | null;
}

export interface IntegrationDiscoveryResult {
  homeAssistant: HomeAssistantDiscoveredInstance[];
  tpLink: TpLinkDiscoveredHub[];
  warnings: string[];
}

export interface HomeAssistantConfigInput {
  url: string;
  token: string;
}

export interface TpLinkConfigInput {
  host: string;
  username: string;
  password: string;
}

export interface IntegrationConfigurationResult {
  ok: true;
  configured: true;
  integration: IntegrationStatus;
}

export interface IntegrationTestResult {
  ok: boolean;
  message: string;
}

export interface TelemetryEvent {
  type: "reading" | "measurement" | "alert" | "integration" | "heartbeat";
  data: Reading | MeasurementSample | AlertEvent | IntegrationStatus | { timestamp: string };
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

export interface ReplayState {
  active: boolean;
  count: number;
  emitted: number;
  speed: number;
  from: string | null;
  to: string | null;
}

export interface ReplayInput {
  sensorIds?: string[];
  from?: string;
  to?: string;
  speed?: number;
}

export interface ApiError {
  error: {
    code: string;
    message: string;
    details?: unknown;
  };
}

export const API_V1_VERSION = "v1" as const;
export const API_V2_VERSION = "v2" as const;
/** Legacy alias retained for v1 clients. */
export const API_VERSION = API_V1_VERSION;
export const API_V1_PREFIX = `/api/${API_V1_VERSION}` as const;
export const API_V2_PREFIX = `/api/${API_V2_VERSION}` as const;
/** Legacy alias retained for v1 clients. */
export const DEFAULT_API_PREFIX = API_V1_PREFIX;
