import { wallLengthPlanUnits } from "./building-structure.js";
import type { Floor, HouseLocation, HouseMapPlacement, Wall } from "./building-structure.js";

import type { House } from "./access-security.js";

import { SYSTEM_VERSION } from "./measurement-analytics.js";

/**
 * Resolves a level's verified horizontal scale. Per-level calibration wins;
 * legacy layouts can continue to use the scale saved with map placement.
 */
export function floorMetersPerPlanUnit(floor: Pick<Floor, "metersPerPlanUnit">, house?: Pick<House, "mapPlacement">): number | null {
  if (Number.isFinite(floor.metersPerPlanUnit) && floor.metersPerPlanUnit! > 0) return floor.metersPerPlanUnit!;
  const legacyScale = house?.mapPlacement?.metersPerPlanUnit;
  return Number.isFinite(legacyScale) && legacyScale! > 0 ? legacyScale! : null;
}

/** Physical wall length when the level has a verified horizontal scale. */
export function wallLengthMeters(
  wall: Pick<Wall, "from" | "to">,
  floor: Pick<Floor, "metersPerPlanUnit">,
  house?: Pick<House, "mapPlacement">,
): number | null {
  const scale = floorMetersPerPlanUnit(floor, house);
  return scale === null ? null : wallLengthPlanUnits(wall) * scale;
}

export type HouseCreateInput = Pick<House, "name" | "timezone" | "floors">
  & Partial<Pick<House, "id" | "propertyId" | "location" | "mapPlacement" | "orientationDegrees">>;

export type HousePatch = Partial<Pick<House, "name" | "timezone" | "floors">> & {
  propertyId?: string;
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

export type WeatherOutageComponent = WeatherComponentName | "service";

export type WeatherBackfillState = "not-needed" | "pending" | "running" | "complete" | "partial" | "failed" | "not-supported";

/** Durable recovery state for the selected Home and its current weather location. */
export interface WeatherRecoveryStatus {
  active: boolean;
  activeSince: string | null;
  affectedComponents: WeatherOutageComponent[];
  lastError: string | null;
  lastRecoveredAt: string | null;
  observationBackfill: {
    state: WeatherBackfillState;
    from: string | null;
    to: string | null;
    recoveredPoints: number;
    lastAttemptAt: string | null;
    error: string | null;
  };
}

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
  /** Optional durable outage and observation-history recovery state. */
  recovery?: WeatherRecoveryStatus;
}

export type OutdoorTemperatureSource =
  | "fmi-observation"
  | "open-meteo-current"
  | "fmi-backfill"
  | "open-meteo-backfill"
  | "mock"
  | "api";

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
  /** Full canonical observation retained for weather-aware historical replay. */
  conditions?: OutdoorConditions;
}

export type SensorDataGapSource = "home-assistant" | "tp-link";

export type SensorDataGapState = "open" | "pending" | "running" | "complete" | "partial" | "failed" | "not-supported";

export type SensorDataGapCompleteness = "unknown" | "none" | "partial" | "complete";

/** Durable record of a sensor interval that was missing and, when possible, recovered upstream. */
export interface SensorDataGap {
  id: number;
  sensorId: string;
  metric: string;
  source: SensorDataGapSource;
  startedAt: string;
  detectedAt: string;
  endedAt: string | null;
  recoveryState: SensorDataGapState;
  /** Earliest known source-retention deadline; null means source-managed or unknown, never unlimited. */
  recoverableUntil: string | null;
  /** Durable result coverage, independent from the coordinator's workflow state. */
  recoveryCompleteness: SensorDataGapCompleteness;
  recoveredPoints: number;
  attemptCount: number;
  lastAttemptAt: string | null;
  nextAttemptAt: string | null;
  recoveryError: string | null;
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
  /** Heat-pump evidence applied before fitting. Absent for legacy callers. */
  hvacExclusion?: HvacExclusionSummary;
}

export interface HvacExclusionSummary {
  /** v2 bridges sub-five-minute unavailability blips bracketed by verified-off evidence; v1 rows predate that and survive in stored artifacts. */
  policy: "verified-heat-pump-off-v1" | "verified-heat-pump-off-v2";
  evidenceState: "not-present" | "complete" | "partial" | "insufficient";
  heatPumpCount: number;
  stateGapMinutes: 5;
  paddingBeforeMinutes: 5;
  paddingAfterMinutes: 30;
  minimumClassifiedPercent: 90;
  minimumUsablePercent: 50;
  windowHours: number;
  classifiedPercent: number;
  verifiedOffHours: number;
  confirmedActiveHours: number;
  possibleActiveHours: number;
  unknownHours: number;
  usableHours: number;
  excludedHours: number;
  retainedSampleCount: number;
  excludedSampleCount: number;
  truncated: boolean;
}

/** Scope levels exposed by the whole-home thermal-isolation comparison. */
export type ThermalIsolationScopeType = "house" | "floor" | "room" | "sensor";

export type ThermalIsolationConfidence = "high" | "medium" | "low" | "unavailable";

export type ThermalIsolationRating = "low" | "moderate" | "high" | "very-high";

export interface ThermalIsolationMetrics {
  /** Fitted sensor time constant, or the score-equivalent time constant for an aggregate scope. */
  effectiveTimeConstantHours: number | null;
  /** Time for the fitted first-order response to move halfway toward equilibrium. */
  halfResponseHours: number | null;
  /** Modeled percentage of the initial indoor state retained after a 24-hour outdoor step. */
  retainedAfter24HoursPct: number | null;
  /** Complement of retainedAfter24HoursPct. */
  outdoorResponseAfter24HoursPct: number | null;
  /** Improvement over a last-value persistence baseline on chronological validation. */
  modelSkillPct: number | null;
  /** Median synchronous max-minus-min temperature across sensors in this scope. */
  typicalTemperatureSpreadC: number | null;
  /** 90th-percentile synchronous max-minus-min temperature across sensors in this scope. */
  p90TemperatureSpreadC: number | null;
}

export interface ThermalIsolationEntry {
  scope: {
    type: ThermalIsolationScopeType;
    id: string;
    label: string;
    parentId?: string;
    floorId?: string;
    sensorIds: string[];
  };
  calibrationStatus: ThermalCalibrationStatus;
  confidence: ThermalIsolationConfidence;
  rating: ThermalIsolationRating | null;
  /** 0-100 modeled 24-hour retention index; null when calibration is unavailable. */
  score: number | null;
  /** Rank among entries at the same scope level; 1 is the strongest buffering. */
  rank: number | null;
  comparedWithHousePoints: number | null;
  /** Share of immediate child scopes with a usable model. */
  childCoveragePct: number;
  sensorCount: number;
  eligibleSensorCount: number;
  metrics: ThermalIsolationMetrics;
  quality: {
    durationHours: number;
    outdoorRangeC: number;
    validationMaeC: number | null;
    persistenceMaeC: number | null;
    /** Lower and upper score implied by the fitted time-constant sensitivity profile. */
    scoreLow: number | null;
    scoreHigh: number | null;
  };
  /** Stable machine-readable warning/reason identifiers. */
  warnings: string[];
}

export interface ThermalIsolationInsight {
  code: "LOWEST_BUFFERING_ROOM" | "FLOOR_CONTRAST" | "ROOM_SENSOR_SPREAD" | "LIMITED_EVIDENCE";
  scopeIds: string[];
  value: number;
  unit: "score-points" | "celsius" | "percent";
}

export interface ThermalIsolationResult {
  generatedAt: string;
  systemVersion: typeof SYSTEM_VERSION;
  houseId: string;
  from: string;
  to: string;
  entries: ThermalIsolationEntry[];
  insights: ThermalIsolationInsight[];
  methodology: {
    scoreMethod: "modeled-24h-retention-v1";
    aggregationMethod: "median-child-score-v1";
    interpretation: string;
    limitations: string[];
    /** Present when House heat-pump evidence was considered. */
    hvacExclusion?: HvacExclusionSummary;
  };
}

export type MoistureResponseConfidence = "high" | "medium" | "low" | "unavailable";

export interface MoistureResponseMetrics {
  /** Fitted time constant for the indoor vapor-pressure response to the outdoor boundary. */
  responseTimeHours: number | null;
  halfResponseHours: number | null;
  /** Fitted equilibrium change indoors per outdoor vapor-pressure change, expressed as percent. */
  outdoorCouplingPct: number | null;
  medianIndoorVaporPressureHpa: number | null;
  medianOutdoorVaporPressureHpa: number | null;
  /** Median indoor minus outdoor vapor pressure. Positive values indicate an indoor moisture excess. */
  medianMoistureExcessHpa: number | null;
  /** Improvement over a last-value persistence baseline on chronological validation. */
  modelSkillPct: number | null;
}

export interface MoistureResponseEntry {
  scope: {
    type: ThermalIsolationScopeType;
    id: string;
    label: string;
    parentId?: string;
    floorId?: string;
    sensorIds: string[];
  };
  calibrationStatus: ThermalCalibrationStatus;
  confidence: MoistureResponseConfidence;
  /** Rank among modeled peers by response time; 1 reacts fastest. */
  rank: number | null;
  childCoveragePct: number;
  sensorCount: number;
  eligibleSensorCount: number;
  metrics: MoistureResponseMetrics;
  quality: {
    durationHours: number;
    outdoorRangeHpa: number;
    validationMaeHpa: number | null;
    persistenceMaeHpa: number | null;
  };
  warnings: string[];
}

export interface MoistureResponseInsight {
  code:
    | "FASTEST_MOISTURE_RESPONSE_ROOM"
    | "STRONGEST_OUTDOOR_MOISTURE_COUPLING"
    | "HIGHEST_INDOOR_MOISTURE_EXCESS"
    | "LIMITED_MOISTURE_EVIDENCE";
  scopeIds: string[];
  value: number;
  unit: "hours" | "percent" | "hectopascal";
}

export interface MoistureResponseResult {
  generatedAt: string;
  systemVersion: typeof SYSTEM_VERSION;
  houseId: string;
  from: string;
  to: string;
  entries: MoistureResponseEntry[];
  insights: MoistureResponseInsight[];
  methodology: {
    conversionMethod: "buck-vapor-pressure-v1";
    modelMethod: "first-order-moisture-response-v1";
    aggregationMethod: "median-child-metric-v1";
    interpretation: string;
    limitations: string[];
    /** Present when House heat-pump evidence was considered. */
    hvacExclusion?: HvacExclusionSummary;
  };
}
