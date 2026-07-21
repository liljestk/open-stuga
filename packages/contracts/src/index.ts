/** Registry identifier for a measurement type (for example `temperature` or `co2`). */
export type Metric = string;
export type MeasurementColorScale = "thermal" | "humidity" | "air-quality" | "sequential";

/** Analytics partitions use `live`; the legacy integration status calls the same mode `real`. */
export type DataMode = "live" | "demo";

export type TruthClass =
  | "observed"
  | "derived"
  | "estimated"
  | "inferred"
  | "forecast"
  | "simulated";

export type ConfidenceLevel = "none" | "very_low" | "low" | "medium" | "high";

export type QualityFlag =
  | "missing"
  | "stale"
  | "duplicate"
  | "out_of_order"
  | "clock_skew"
  | "out_of_physical_range"
  | "implausible_rate"
  | "spike"
  | "flatline"
  | "sensor_reset"
  | "counter_reset"
  | "source_estimated"
  | "interpolated"
  | "calibrated"
  | "placement_unknown"
  | "weather_remote"
  | "estimated_pressure"
  | "topology_incomplete"
  | "low_coverage";

export type MeasurementKind =
  | "gauge"
  | "rate"
  | "increment"
  | "cumulative_counter"
  | "binary_state"
  | "categorical_state";

export type AggregationSemantic =
  | "mean"
  | "sum"
  | "delta"
  | "last"
  | "time_weighted_mean"
  | "duration"
  | "custom";

/** Product release version. Pre-1.0 minor releases may contain breaking changes. */
export const SYSTEM_VERSION = "0.3.0" as const;

export interface MeasurementDefinition {
  id: Metric;
  labels: Record<string, string>;
  unit: string;
  /** Optional during the pre-1.0 registry migration; persisted definitions always populate these fields. */
  dimension?: string;
  allowedUnits?: string[];
  kind?: MeasurementKind;
  defaultAggregation?: AggregationSemantic;
  genericHistoryEnabled?: boolean;
  genericStatsEnabled?: boolean;
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

export type AnalyticsResolution = "auto" | "raw" | "1m" | "5m" | "15m" | "1h" | "1d";
export type AnalyticsAggregation = "default" | Exclude<AggregationSemantic, "duration" | "custom"> | "min" | "max";
export type AnalyticsSampleQuality = MeasurementSample["quality"];

export interface AnalyticsQualityFilter {
  /** Only samples with one of these source quality states participate in values and summaries. */
  include: AnalyticsSampleQuality[];
}

export interface AnalyticsEntityScope {
  kind: "house";
  id: string;
  /** Omit to include every enabled sensor in the house. */
  entityIds?: string[];
}

export interface AnalyticsQueryRequest {
  apiVersion: "1.0";
  dataMode: DataMode;
  scope: AnalyticsEntityScope;
  measurementIds: string[];
  range: {
    start: string;
    end: string;
    timezone: string;
  };
  resolution: AnalyticsResolution;
  aggregation: AnalyticsAggregation;
  qualityFilter?: AnalyticsQualityFilter;
  include?: Array<"series" | "summary" | "provenance" | "quality">;
  maxPointsPerSeries?: number;
  requestId: string;
}

export interface AnalyticsProvenance {
  algorithmKey: string;
  algorithmVersion: string;
  generatedAt: string;
  inputStart: string;
  inputEnd: string;
  sourceIds: string[];
  archiveState: "not-configured" | "not-ready" | "merged" | "failed";
}

export interface AnalyticsPoint {
  timestamp: string;
  value: number | null;
  minimum: number | null;
  maximum: number | null;
  sampleCount: number;
  coverage: number;
  qualityFlags: QualityFlag[];
}

export interface AnalyticsSummary {
  entityId: string;
  measurementId: string;
  canonicalUnit: string;
  count: number;
  coverage: number;
  minimum: number | null;
  maximum: number | null;
  mean: number | null;
  median: number | null;
  standardDeviation: number | null;
  medianAbsoluteDeviation: number | null;
  p05: number | null;
  p95: number | null;
}

export interface AnalyticsSeries {
  entityId: string;
  entityLabel: string;
  measurementId: string;
  canonicalUnit: string;
  truthClass: TruthClass;
  /** Raw means no aggregation was applied; all other values describe the bucket rollup. */
  aggregation: "raw" | Exclude<AnalyticsAggregation, "default">;
  resolution: Exclude<AnalyticsResolution, "auto">;
  points: AnalyticsPoint[];
  summary: AnalyticsSummary;
  provenance: AnalyticsProvenance;
}

export interface AnalyticsQueryQualitySummary {
  coverage: number;
  seriesCount: number;
  sampleCount: number;
  excludedSampleCount: number;
  includedQualities: AnalyticsSampleQuality[];
  lowCoverageSeries: number;
}

export interface AnalyticsWarning {
  code: string;
  message: string;
}

export interface AnalyticsQueryResponse {
  apiVersion: "1.0";
  requestId: string;
  dataMode: DataMode;
  resolvedRange: AnalyticsQueryRequest["range"];
  resolution: Exclude<AnalyticsResolution, "auto">;
  series: AnalyticsSeries[];
  summaries: AnalyticsSummary[];
  quality: AnalyticsQueryQualitySummary;
  provenance: AnalyticsProvenance[];
  warnings: AnalyticsWarning[];
  generatedAt: string;
  cache: { hit: false; keyVersion: "analytics-query-v1" };
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

/** Geometric wall length in the floor plan's local coordinate system. */
export function wallLengthPlanUnits(wall: Pick<Wall, "from" | "to">): number {
  return Math.hypot(wall.to.x - wall.from.x, wall.to.y - wall.from.y);
}

export interface Room {
  id: string;
  name: string;
  points: Point[];
  kind?: string;
}

/** Architectural symbols placed independently of wall geometry on a floor plan. */
export type PlanElementKind = "door" | "window" | "fireplace" | "vent" | "fireEscape";

export type OpeningState = "open" | "closed" | "unknown";
export type ConfiguredOpeningState = Exclude<OpeningState, "unknown">;
export type OpeningStateSource = "manual" | "home-assistant" | "tapo" | "api";
export type DoorVariant = "interior" | "exterior" | "sliding" | "double" | "open-passage";
export type WindowVariant = "fixed" | "casement" | "tilt-turn" | "sliding";
export type VentVariant = "passive" | "supply" | "extract" | "balanced" | "transfer";
export type FireEscapeVariant = "ladder" | "stairs";

/**
 * Provider-neutral link from an architectural opening to an external state
 * source. The configured state remains the fallback whenever this source is
 * missing, stale, or reports an unknown value.
 */
export interface OpeningStateBinding {
  provider: Extract<OpeningStateSource, "home-assistant" | "tapo">;
  /** Home Assistant entity id or Tapo child-device id. */
  externalId: string;
  /** Optional integration connection when multiple accounts/hubs are present. */
  connectionId?: string;
  /** Reverses open/closed for sensors installed with opposite polarity. */
  invert?: boolean;
  /** Observation age after which the configured state is used again. */
  staleAfterSeconds?: number;
}

interface PlanElementBase {
  id: string;
  position: Point;
  /** Clockwise rotation in degrees. */
  rotationDegrees: number;
  /** Symbol width in the floor's local coordinate system. */
  width?: number;
  /** Physical symbol height in metres, used by the 3D representation. */
  height?: number;
  /** Optional human-readable instance name used in opening inventories. */
  label?: string;
}

interface AirflowPlanElementBase extends PlanElementBase {
  /** Manual state and fallback when a linked contact sensor is unavailable. */
  state?: ConfiguredOpeningState;
  /** Effective aperture while open, from fully shut (0) to fully open (1). */
  openFraction?: number;
  /** Bottom of the element above the floor, in metres. */
  bottomOffsetM?: number;
  stateBinding?: OpeningStateBinding;
}

/** A door whose full width must fit within its referenced wall segment. */
export interface DoorPlanElement extends AirflowPlanElementBase {
  kind: "door";
  /** Used for wall alignment and cascade deletion. */
  wallId: string;
  variant?: DoorVariant;
}

/** A window whose full width must fit within its referenced wall segment. */
export interface WindowPlanElement extends AirflowPlanElementBase {
  kind: "window";
  /** Used for wall alignment and cascade deletion. */
  wallId: string;
  variant?: WindowVariant;
}

/** A free-standing vent, including passive, transfer, and mechanical variants. */
export interface VentPlanElement extends AirflowPlanElementBase {
  kind: "vent";
  wallId?: never;
  variant?: VentVariant;
  /** Optional design flow used by the qualitative model, in cubic metres/hour. */
  nominalFlowM3h?: number;
}

/** A free-standing fireplace that is not tied to wall lifecycle. */
export interface FireplacePlanElement extends PlanElementBase {
  kind: "fireplace";
  wallId?: never;
  /** Fireplaces can continue vertically as a chimney through every higher level and the roof. */
  verticalExtent?: "level" | "roof";
  /** Chimney projection above the roof surface in metres. Only meaningful for roof-reaching fireplaces. */
  chimneyHeightAboveRoof?: number;
  /** Independent chimney-shaft width in floor-plan units. Falls back to 55% of the fireplace width. */
  chimneyWidth?: number;
  /** Chimney-shaft depth in floor-plan units. Falls back to a proportion of its width. */
  chimneyDepth?: number;
}

/** A wall-attached escape ladder or stair mounted on the house exterior. */
export interface FireEscapePlanElement extends PlanElementBase {
  kind: "fireEscape";
  /** Exterior wall used for alignment, movement, and cascade deletion. */
  wallId: string;
  variant?: FireEscapeVariant;
  /** Bottom of the fire escape above the floor plane, in metres. */
  bottomOffsetM?: number;
  /** Horizontal projection out from the exterior wall, in floor-plan units. */
  projection?: number;
}

export type WallOpeningPlanElement = DoorPlanElement | WindowPlanElement;
export type FixturePlanElement = FireplacePlanElement | VentPlanElement;
export type AirflowPlanElement = WallOpeningPlanElement | VentPlanElement;
export type PlanElement = AirflowPlanElement | FireplacePlanElement | FireEscapePlanElement;

export function isAirflowPlanElement(element: PlanElement): element is AirflowPlanElement {
  return element.kind === "door" || element.kind === "window" || element.kind === "vent";
}

/** Effective-dated state accepted from manual, API, Home Assistant, or Tapo sources. */
export interface OpeningStateObservation {
  id: string;
  houseId: string;
  floorId: string;
  elementId: string;
  state: OpeningState;
  /** Optional aperture reported by a richer upstream source. */
  openFraction?: number;
  source: OpeningStateSource;
  observedAt: string;
  validUntil?: string;
  externalId?: string;
  /** Integration connection that produced the provider observation. */
  connectionId?: string;
}

export interface OpeningStateObservationInput extends Omit<OpeningStateObservation, "id" | "houseId"> {
  id?: string;
}

export interface EffectiveOpeningState {
  state: ConfiguredOpeningState;
  openFraction: number;
  source: OpeningStateSource | "default";
  observedAt?: string;
  assumed: boolean;
}

export interface OpeningStateSnapshotEntry extends EffectiveOpeningState {
  floorId: string;
  elementId: string;
  kind: AirflowPlanElement["kind"];
  label?: string;
}

export interface OpeningStateSnapshot {
  houseId: string;
  at: string;
  states: OpeningStateSnapshotEntry[];
}

export function defaultPlanElementOpeningState(element: AirflowPlanElement): ConfiguredOpeningState {
  if (element.kind === "vent") return "open";
  if (element.kind === "door" && element.variant === "open-passage") return "open";
  return "closed";
}

/** Physical variants whose state cannot be changed by a manual or sensor reading. */
export function fixedPlanElementOpeningState(element: AirflowPlanElement): ConfiguredOpeningState | null {
  if (element.kind === "window" && element.variant === "fixed") return "closed";
  if (element.kind === "door" && element.variant === "open-passage") return "open";
  return null;
}

/** Resolves an opening without observations, using conservative architectural defaults. */
export function configuredPlanElementOpeningState(element: AirflowPlanElement): EffectiveOpeningState {
  const fixedState = fixedPlanElementOpeningState(element);
  const state = fixedState ?? element.state ?? defaultPlanElementOpeningState(element);
  const explicitlyConfigured = element.state === state;
  return {
    state,
    openFraction: state === "open" ? Math.min(1, Math.max(0, element.openFraction ?? 1)) : 0,
    source: explicitlyConfigured ? "manual" : "default",
    assumed: !explicitlyConfigured,
  };
}

/** Resolves the latest valid observation, then falls back to the configured/manual state. */
export function resolvePlanElementOpeningState(
  element: AirflowPlanElement,
  observations: readonly OpeningStateObservation[],
  at: string | number | Date = Date.now(),
): EffectiveOpeningState {
  const atMs = at instanceof Date ? at.getTime() : typeof at === "number" ? at : Date.parse(at);
  const fallback = configuredPlanElementOpeningState(element);
  if (!Number.isFinite(atMs) || fixedPlanElementOpeningState(element) !== null) return fallback;
  const candidate = observations
    .filter((observation) => observation.elementId === element.id)
    .filter((observation) => {
      const observedAt = Date.parse(observation.observedAt);
      if (!Number.isFinite(observedAt) || observedAt > atMs) return false;
      if (observation.validUntil) {
        const validUntil = Date.parse(observation.validUntil);
        if (!Number.isFinite(validUntil) || validUntil <= atMs) return false;
      }
      if (observation.source === "home-assistant" || observation.source === "tapo") {
        if (!element.stateBinding || element.stateBinding.provider !== observation.source) return false;
        if (!observation.externalId || observation.externalId !== element.stateBinding.externalId) return false;
        if (element.stateBinding.connectionId && observation.connectionId !== element.stateBinding.connectionId) return false;
        if (atMs - observedAt > (element.stateBinding.staleAfterSeconds ?? 900) * 1_000) return false;
      }
      return true;
    })
    .sort((left, right) => Date.parse(right.observedAt) - Date.parse(left.observedAt) || right.id.localeCompare(left.id))[0];
  // Unknown is an explicit loss-of-confidence event. It masks older readings
  // instead of allowing a previous open state to remain effective.
  if (!candidate || candidate.state === "unknown") return fallback;
  const invert = (candidate.source === "home-assistant" || candidate.source === "tapo") && element.stateBinding?.invert;
  const observedState = invert ? (candidate.state === "open" ? "closed" : "open") : candidate.state;
  const state = observedState as ConfiguredOpeningState;
  return {
    state,
    openFraction: state === "open" ? Math.min(1, Math.max(0, candidate.openFraction ?? element.openFraction ?? 1)) : 0,
    source: candidate.source,
    observedAt: candidate.observedAt,
    assumed: false,
  };
}

/** Semantic level type used by the editor to organise mixed building layouts. */
export type FloorType = "basement" | "ground" | "upper" | "attic" | "mezzanine" | "outdoor";

export type RoofStyle = "gable" | "hip" | "shed" | "flat";

/** Roof envelope attached to the level directly beneath it (normally an attic). */
export interface RoofDesign {
  style: RoofStyle;
  /** Roof slope from horizontal. Flat roofs use zero degrees. */
  pitchDegrees: number;
  /** Direction followed by the ridge; shed roofs fall perpendicular to this axis. */
  ridgeAxis: "x" | "y";
  /** Horizontal extension beyond the level footprint, in floor-plan units. */
  overhang: number;
  /** Vertical wall between the attic floor and the eaves, in metres. */
  eavesHeight: number;
}

export interface Floor {
  id: string;
  name: string;
  /** Optional semantic type; older layouts without it remain valid. */
  type?: FloorType;
  /** Horizontal floor-plan extent; x coordinates use the same local system. */
  width: number;
  /** Horizontal floor-plan extent; y coordinates use the same local system. */
  height: number;
  /** Verified horizontal conversion for this level. One local x/y unit equals this many metres. */
  metersPerPlanUnit?: number;
  /** Absolute floor-plane height in metres in the house vertical coordinate system. */
  elevation: number;
  /** Clear room height in metres, used when stacking and duplicating levels. */
  ceilingHeight?: number;
  /** Exterior wall height above this floor plane in metres. Falls back to ceilingHeight for older layouts. */
  wallHeight?: number;
  /** Optional roof envelope for this level. Older layouts remain flat/open when omitted. */
  roof?: RoofDesign;
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

/** A managed parcel or estate that groups buildings and outdoor areas. */
export interface Property {
  id: string;
  name: string;
  description: string | null;
  /** Optional map centre used before any house or area geometry is available. */
  location: HouseLocation | null;
  createdAt: string;
  updatedAt: string;
}

export type ElectricityPriceProvider = "porssisahko" | "custom";
export type ElectricityContractType = "spot" | "fixed" | "other";

/** Property-owned price source and the small set of contract adjustments used for cost estimates. */
export interface PropertyElectricityConfig {
  propertyId: string;
  provider: ElectricityPriceProvider;
  /** A JSON feed compatible with the Pörssisähkö `prices` response shape. */
  endpointUrl: string;
  enabled: boolean;
  marginCentsPerKwh: number;
  contractType: ElectricityContractType;
  contractName: string | null;
  retailer: string | null;
  monthlyFeeEur: number | null;
  lastFetchedAt: string | null;
  lastError: string | null;
  updatedAt: string;
}

export type PropertyElectricityConfigInput = Pick<PropertyElectricityConfig,
  "provider" | "endpointUrl" | "enabled" | "marginCentsPerKwh" | "contractType"
> & Partial<Pick<PropertyElectricityConfig, "contractName" | "retailer" | "monthlyFeeEur">>;

/** Raw source values are retained in cents/kWh; effective values are derived and never overwrite them. */
export interface PropertyElectricityPricePoint {
  propertyId: string;
  startAt: string;
  endAt: string;
  rawPriceCentsPerKwh: number;
  effectivePriceCentsPerKwh: number;
  effectivePriceEurPerKwh: number;
  fetchedAt: string;
}

export interface EnergyOptimizationWindow {
  startAt: string;
  endAt: string;
  averagePriceCentsPerKwh: number;
  relativeToAveragePercent: number;
  rank: "best" | "good" | "expensive";
}

export interface EnergyOptimizationInsight {
  id: string;
  severity: "info" | "opportunity" | "warning";
  title: string;
  explanation: string;
  estimatedSavingsEur: number | null;
}

/** Read-only, reproducible optimization report. It never controls equipment. */
export interface EnergyOptimizationReport {
  propertyId: string;
  generatedAt: string;
  priceCoverageFrom: string | null;
  priceCoverageUntil: string | null;
  averagePriceCentsPerKwh: number | null;
  currentPriceCentsPerKwh: number | null;
  currentPricePercentile: number | null;
  suggestedWindows: EnergyOptimizationWindow[];
  recentDailyConsumptionKwh: number | null;
  estimatedDailyCostEur: number | null;
  baselinePowerWatts: number | null;
  peakPowerWatts: number | null;
  insights: EnergyOptimizationInsight[];
  limitations: string[];
}

/**
 * House-authorized projection used for Home consumption and running-cost UI.
 * Contract/source identity and the unadjusted upstream price are deliberately
 * excluded because those remain Property-administration data.
 */
export type HomeElectricityPricePoint = Pick<PropertyElectricityPricePoint,
  "startAt" | "endAt" | "effectivePriceCentsPerKwh" | "effectivePriceEurPerKwh" | "fetchedAt"
>;

/** Time-aligned, cumulative energy cost for one Home energy meter. */
export interface HomeEnergyCost {
  houseId: string;
  sensorId: string;
  from: string;
  to: string;
  consumptionKwh: number | null;
  pricedConsumptionKwh: number | null;
  costEur: number | null;
  priceCoveragePercent: number;
  measurementCoverageFrom: string | null;
  measurementCoverageUntil: string | null;
  complete: boolean;
  calculatedAt: string;
}

export const DEFAULT_ELECTRICITY_PRICE_ENDPOINT = "https://api.porssisahko.net/v2/latest-prices.json" as const;

export type PropertyCreateInput = Pick<Property, "name"> & Partial<Pick<Property, "id" | "description" | "location">>;
export type PropertyPatch = Partial<Pick<Property, "name" | "description" | "location">>;

/** One WGS84 property-map coordinate. */
export interface GeoCoordinate {
  latitude: number;
  longitude: number;
}

export type PropertyAreaKind =
  | "well"
  | "beach"
  | "garage"
  | "plantation"
  | "garden"
  | "field"
  | "forest"
  | "shoreline"
  | "dock"
  | "road"
  | "yard"
  | "building"
  | "other";

/** A named outdoor area or fixed-position asset within a property. */
export interface PropertyArea {
  id: string;
  propertyId: string;
  name: string;
  kind: PropertyAreaKind;
  description: string | null;
  /** Optional fixed position for point assets such as wells, sheds, and tanks. */
  location?: GeoCoordinate;
  /** Empty for point assets; boundaries are closed implicitly and must not repeat their first vertex. */
  polygon: GeoCoordinate[];
  createdAt: string;
  updatedAt: string;
}

export type PropertyAreaInput = Pick<PropertyArea, "propertyId" | "name" | "kind" | "polygon">
  & Partial<Pick<PropertyArea, "id" | "description" | "location">>;
/** Updating propertyId moves the complete area aggregate, including its equipment and scoped context. */
export type PropertyAreaPatch = Partial<Pick<PropertyArea, "propertyId" | "name" | "kind" | "description" | "polygon">> & {
  location?: GeoCoordinate | null;
};

export type AreaEquipmentStatus = "active" | "out-of-service" | "retired";

/** Maintainable equipment installed in one mapped property area. */
export interface AreaEquipment {
  id: string;
  propertyId: string;
  areaId: string;
  name: string;
  kind: string;
  manufacturer: string | null;
  model: string | null;
  serialNumber: string | null;
  status: AreaEquipmentStatus;
  notes: string | null;
  createdAt: string;
  updatedAt: string;
}

export type AreaEquipmentInput = Pick<AreaEquipment, "areaId" | "name" | "kind">
  & Partial<Pick<AreaEquipment, "id" | "propertyId" | "manufacturer" | "model" | "serialNumber" | "status" | "notes">>;
export type AreaEquipmentPatch = Partial<Pick<AreaEquipment,
  "areaId" | "name" | "kind" | "manufacturer" | "model" | "serialNumber" | "status" | "notes"
>>;

export type PropertyNoteKind = "note" | "inspection" | "maintenance";

/** Free-form context attached to a property or one of its resources. */
export interface PropertyNote {
  id: string;
  propertyId: string;
  houseId: string | null;
  areaId: string | null;
  equipmentId: string | null;
  kind: PropertyNoteKind;
  text: string;
  createdAt: string;
  updatedAt: string;
}

export type PropertyNoteInput = Pick<PropertyNote, "propertyId" | "kind" | "text">
  & Partial<Pick<PropertyNote, "id" | "houseId" | "areaId" | "equipmentId">>;
export type PropertyNotePatch = Partial<Pick<PropertyNote, "houseId" | "areaId" | "equipmentId" | "kind" | "text">>;

export type TenantMemberRole = "owner" | "admin" | "member" | "guest" | "service";
export type GuestAccessScope = "property" | "house" | "area";

export interface GuestAccessGrant {
  scopeType: GuestAccessScope;
  scopeId: string;
}

export interface TenantMemberSummary {
  email: string;
  role: Exclude<TenantMemberRole, "service">;
  joinedAt?: string;
  invitedAt?: string;
  expiresAt?: string;
  grants: GuestAccessGrant[];
}

/** One tenant the authenticated principal may explicitly select. */
export interface TenantAccessSummary {
  id: string;
  name: string;
  role: TenantMemberRole;
}

export interface AppSession {
  authenticated: boolean;
  principal: { type: string; email: string | null };
  tenant: { id: string; name: string; role: TenantMemberRole };
  /** All memberships available to this principal, without other members' identities. */
  availableTenants: TenantAccessSummary[];
  /** Guests are always read-only; this explicit flag keeps clients fail-closed. */
  readOnly: boolean;
  grants: GuestAccessGrant[];
  /** Present for cookie-authenticated local sessions and submitted as X-CSRF-Token on mutations. */
  csrfToken?: string;
  /** True only while the pristine local database still permits first-owner setup. */
  setupRequired?: boolean;
}

export interface LocalAuthCredentials {
  email: string;
  password: string;
}

export type LocalOwnerSetupInput = LocalAuthCredentials;
export interface LocalInvitationRegistrationInput {
  token: string;
  password: string;
  /** Optional confirmation only. The one-time token identifies the invitation. */
  email?: string;
}
export type LocalLoginInput = LocalAuthCredentials;

export interface TenantMemberCreateInput {
  email: string;
  role: Exclude<TenantMemberRole, "owner" | "service">;
  grants?: GuestAccessGrant[];
}

export interface TenantMemberAccessUpdateInput {
  grants: GuestAccessGrant[];
}

export interface TenantMembersResponse {
  members: TenantMemberSummary[];
  invitations: TenantMemberSummary[];
}

export interface CloudflareAccessSyncSummary {
  status: "disabled" | "pending" | "synced";
  lastSyncedAt: string | null;
}

export interface TenantInvitationCreated {
  invitation: TenantMemberSummary;
  /** Shown once; only its SHA-256 digest is persisted. */
  registrationToken: string;
  activationPath: string;
  expiresAt: string;
  cloudflareAccess?: CloudflareAccessSyncSummary;
}

export type SecurityAuditOutcome = "succeeded" | "denied";

export type SecurityAuditEventType =
  | "auth.owner.created"
  | "auth.invitation.accepted"
  | "auth.login"
  | "auth.logout"
  | "membership.invitation.created"
  | "membership.grants.replaced"
  | "membership.revoked"
  | "integration.credentials.configured"
  | "integration.credentials.rotated"
  | "integration.credentials.revoked"
  | "integration.grant.issued"
  | "integration.grant.revoked";

export type SecurityAuditSubjectType = "account" | "workspace-member" | "integration" | "integration-grant";
export type SecurityAuditDetailValue = string | number | boolean | null;

/** Append-only, secret-free evidence for authentication and privileged credential changes. */
export interface SecurityAuditEvent {
  id: string;
  eventType: SecurityAuditEventType;
  outcome: SecurityAuditOutcome;
  actorUserId: string | null;
  actorRole: TenantMemberRole | null;
  subjectType: SecurityAuditSubjectType;
  subjectId: string;
  details: Record<string, SecurityAuditDetailValue>;
  createdAt: string;
}

export interface House {
  id: string;
  /** Every current house belongs to exactly one property. Legacy records are backfilled at deserialization/migration time. */
  propertyId: string;
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
}

export interface Sensor {
  id: string;
  houseId: string;
  floorId: string;
  name: string;
  /**
   * Stable relationship to a room on `floorId`. `null` (or omission from a
   * legacy client) means the display label has not been linked to floor-plan
   * geometry.
   */
  roomId?: string | null;
  /** Backwards-compatible room label; synchronized from the linked Room name. */
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
  /** House-scoped TP-Link connection which owns `tpLinkDeviceId`. */
  tpLinkConnectionId?: string;
  /** Home Assistant entity bindings keyed by a registered measurement id. */
  measurementEntityIds?: Record<Metric, string>;
  tags: string[];
  enabled: boolean;
}

export type SensorCreateInput = Omit<Sensor, "id"> & { id?: string };
export type SensorPatch = Partial<Omit<Sensor, "id" | "tpLinkDeviceId" | "tpLinkConnectionId">> & {
  tpLinkDeviceId?: string | null;
  tpLinkConnectionId?: string | null;
};

/** Sanitized TP-Link child-device details exposed for local onboarding. */
export interface TpLinkDiscoveredDevice {
  /** House owning the TP-Link connection which discovered this endpoint. */
  houseId?: string;
  /** Stable identifier for the house-scoped TP-Link host/connection. */
  connectionId?: string;
  deviceId: string;
  model: string;
  alias: string | null;
  status: string | null;
  temperature: number | null;
  humidity: number | null;
  battery: number | null;
  /** Contact state reported by devices such as Tapo T110; null when unavailable. */
  contactOpen?: boolean | null;
  /** Instantaneous active power reported by a python-kasa Energy module, in W. */
  power?: number | null;
  /** Device-provided cumulative energy counter, in kWh. Currently total since reboot. */
  energy?: number | null;
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

export type AlertQuietHoursMode = "defer" | "silent";

/**
 * Durable, rule-local delivery policy. Alert detection is never disabled by a
 * delivery schedule: outside a delivery window the event is still recorded
 * and the notification is deferred or made silent according to this policy.
 */
export interface AlertDeliveryPolicy {
  /** IANA timezone used for local delivery windows. */
  timeZone: string;
  /** ISO weekday numbers (Monday=1 ... Sunday=7) on which normal delivery is active. */
  activeDays: number[];
  /** Optional local HH:mm window. A window crossing midnight is supported. */
  activeFrom: string | null;
  activeUntil: string | null;
  quietHoursFrom: string | null;
  quietHoursUntil: string | null;
  quietHoursMode: AlertQuietHoursMode;
  /** Critical alerts may bypass deferred quiet hours, but remain marked as such. */
  criticalBypassQuietHours: boolean;
  /** Send one escalation when an event remains open and unacknowledged. */
  escalationAfterSeconds: number | null;
  /** Repeat reminders while an event remains open and unacknowledged. */
  reminderIntervalSeconds: number | null;
  /** Delivery attempts before a row is moved to the durable dead-letter state. */
  maxAttempts: number;
}

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
  /** Send newly opened, non-demo events through the configured Telegram bot. */
  telegramEnabled: boolean;
  /** Optional for older clients; the API always returns the normalized policy. */
  deliveryPolicy?: AlertDeliveryPolicy;
}

export type AlertRuleInput = Omit<AlertRule, "id" | "sensorId" | "enabled" | "webhookEnabled" | "telegramEnabled"> & {
  id?: string;
  sensorId?: string | null;
  enabled?: boolean;
  webhookEnabled?: boolean;
  telegramEnabled?: boolean;
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

export type NotificationSubjectKind = "alert" | "maintenance" | "action-run";
export type NotificationDeliveryStage = "initial" | "escalation" | "reminder" | "due" | "verification";
export type NotificationChannel = "webhook" | "telegram";

/** Redacted operational view of the immutable notification delivery ledger. */
export interface NotificationDeliveryStatus {
  id: string;
  subjectKind: NotificationSubjectKind;
  subjectId: string;
  stage: NotificationDeliveryStage;
  sequence: number;
  channel: NotificationChannel;
  destinationId: string;
  attempts: number;
  maxAttempts: number;
  availableAt: string;
  createdAt: string;
  deliveredAt: string | null;
  deadLetteredAt: string | null;
  abandonedAt: string | null;
  lastError: string | null;
}

export type ActionPlaybookGoal = "decrease" | "increase" | "below" | "above";

/** A reusable, evidence-based response to an alert or observed condition. */
export interface ActionPlaybook {
  id: string;
  name: string;
  description: string;
  instructions: string[];
  metric: Metric;
  goal: ActionPlaybookGoal;
  /** Required absolute improvement for increase/decrease goals. */
  minimumImprovement: number;
  /** Target used by below/above goals. */
  targetValue: number | null;
  waitSeconds: number;
  verificationWindowSeconds: number;
  enabled: boolean;
  builtIn: boolean;
  createdAt: string;
  updatedAt: string;
}

export type ActionPlaybookInput = Pick<ActionPlaybook,
  "name" | "description" | "instructions" | "metric" | "goal" | "minimumImprovement" |
  "targetValue" | "waitSeconds" | "verificationWindowSeconds"
> & Partial<Pick<ActionPlaybook, "id" | "enabled">>;

export type ActionRunStatus = "active" | "waiting" | "verified" | "not-improved" | "cancelled";

/** Durable execution and automatic before/after verification evidence. */
export interface ActionRun {
  id: string;
  playbookId: string;
  alertEventId: string | null;
  maintenanceTaskId: string | null;
  sensorId: string;
  metric: Metric;
  status: ActionRunStatus;
  startedAt: string;
  actionCompletedAt: string | null;
  verifyAfter: string | null;
  verificationDeadline: string | null;
  baselineValue: number;
  baselineTimestamp: string;
  resultValue: number | null;
  resultTimestamp: string | null;
  improvement: number | null;
  sampleCount: number;
  operatorNote: string | null;
  verificationNote: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface ActionRunStartInput {
  playbookId: string;
  sensorId: string;
  alertEventId?: string | null;
  maintenanceTaskId?: string | null;
  operatorNote?: string | null;
}

export type ObservationKind =
  | "leak"
  | "condensation"
  | "mould"
  | "ventilation"
  | "maintenance"
  | "note";

export type ObservationTimePrecision = "exact" | "approximate" | "date-only" | "date-range" | "unknown";
export type ObservationSource =
  | "owner"
  | "caretaker"
  | "contractor"
  | "sensor"
  | "imported-document"
  | "automated-analysis"
  | "unknown";
export type ObservationConfidence = "confirmed" | "probable" | "uncertain" | "awaiting-inspection";
export type ObservationStatus = "open" | "resolved";
/** Maximum canonical resolution outcome length accepted by API and MCP writes. */
export const MAX_OBSERVATION_RESOLUTION_NOTE_LENGTH = 5_000 as const;
export type ObservationRevisionActor = "local-rest" | "local-mcp" | "local-migration" | "workspace-user" | "system-service";
export type ObservationChangedField =
  | "floorId"
  | "sensorId"
  | "kind"
  | "severity"
  | "note"
  | "x"
  | "y"
  | "occurredAt"
  | "timePrecision"
  | "validFrom"
  | "validTo"
  | "source"
  | "sourceDetail"
  | "confidence"
  | "status"
  | "resolutionNote"
  | "resolvedAt";

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
  /** Observed time. Exact/approximate values are canonical UTC instants; date-only values stay YYYY-MM-DD. */
  occurredAt: string;
  /** Immutable server-recorded time. */
  createdAt: string;
  /** Additive v1 fields are optional so older stored/demo objects remain wire-compatible. Current servers always return them. */
  timePrecision?: ObservationTimePrecision;
  validFrom?: string | null;
  validTo?: string | null;
  source?: ObservationSource;
  sourceDetail?: string | null;
  confidence?: ObservationConfidence;
  /** Lifecycle state. Older observations without this additive field are open. */
  status?: ObservationStatus;
  /** Required, human-readable outcome while resolved, for example "Fixed leak". */
  resolutionNote?: string | null;
  /** Server-recorded resolution instant. Cleared when the observation is reopened. */
  resolvedAt?: string | null;
  revision?: number;
  updatedAt?: string;
}

export type ManualObservationInput = Pick<ManualObservation, "houseId" | "floorId" | "kind" | "severity" | "note"> & {
  id?: string;
  sensorId?: string | null;
  x?: number | null;
  y?: number | null;
  occurredAt?: string;
  timePrecision?: ObservationTimePrecision;
  validFrom?: string | null;
  validTo?: string | null;
  source?: ObservationSource;
  sourceDetail?: string | null;
  confidence?: ObservationConfidence;
};

export type ManualObservationPatch = {
  /** Optimistic concurrency guard. The patch is rejected when the stored revision has moved on. */
  baseRevision: number;
} & Partial<Pick<ManualObservation,
  | "floorId"
  | "sensorId"
  | "kind"
  | "severity"
  | "note"
  | "x"
  | "y"
  | "occurredAt"
  | "timePrecision"
  | "validFrom"
  | "validTo"
  | "source"
  | "sourceDetail"
  | "confidence"
  | "status"
  | "resolutionNote"
>>;

export interface ObservationRevision {
  observationId: string;
  revision: number;
  changedAt: string;
  actor: ObservationRevisionActor;
  actorId?: string | null;
  actorLabel?: string | null;
  changedFields: ObservationChangedField[];
  snapshot: ManualObservation;
}

/** Why a maintenance task exists. This classification must remain visible to users. */
export type MaintenanceTaskBasis =
  | "required"
  | "scheduled"
  | "condition-based"
  | "predictive"
  | "optional-improvement";

export type MaintenanceTaskPriority = "low" | "normal" | "high" | "urgent";
export type MaintenanceTaskStatus = "planned" | "in-progress" | "completed" | "verified" | "cancelled";
export type MaintenanceTaskRevisionActor = ObservationRevisionActor;
export type MaintenanceTaskChangedField =
  | "propertyId"
  | "houseId"
  | "floorId"
  | "areaId"
  | "equipmentId"
  | "title"
  | "description"
  | "basis"
  | "basisDetail"
  | "priority"
  | "plannedFor"
  | "dueBy"
  | "observationIds"
  | "status"
  | "completionNote"
  | "completedAt"
  | "verificationNote"
  | "verifiedAt";

export interface MaintenanceTask {
  id: string;
  /** Stable owner used for outdoor/estate work even when no house exists. */
  propertyId: string;
  /** Optional building context for indoor work, scheduling defaults, and evidence links. */
  houseId: string | null;
  floorId: string | null;
  /** Optional mapped outdoor/estate context. Both resources must belong to the house's property. */
  areaId?: string | null;
  equipmentId?: string | null;
  title: string;
  description: string | null;
  basis: MaintenanceTaskBasis;
  basisDetail: string | null;
  priority: MaintenanceTaskPriority;
  /** Property-local calendar date in YYYY-MM-DD form. */
  plannedFor: string | null;
  /** Property-local calendar date in YYYY-MM-DD form. Predictive tasks cannot claim a formal due date. */
  dueBy: string | null;
  /** Canonically sorted, duplicate-free evidence links. */
  observationIds: string[];
  status: MaintenanceTaskStatus;
  completionNote: string | null;
  /** Server-recorded instant when work was marked completed. */
  completedAt: string | null;
  verificationNote: string | null;
  /** Server-recorded instant when completed work was verified. */
  verifiedAt: string | null;
  revision: number;
  createdAt: string;
  updatedAt: string;
}

type MaintenanceTaskInputCommon = Pick<MaintenanceTask, "title" | "basis"> & {
  id?: string;
  floorId?: string | null;
  areaId?: string | null;
  equipmentId?: string | null;
  description?: string | null;
  basisDetail?: string | null;
  priority?: MaintenanceTaskPriority;
  plannedFor?: string | null;
  dueBy?: string | null;
  observationIds?: string[];
};

/** Existing house-first clients may omit propertyId; land-only work supplies propertyId and a nullable houseId. */
export type MaintenanceTaskInput = MaintenanceTaskInputCommon & (
  | { propertyId: string; houseId?: string | null }
  | { houseId: string; propertyId?: string }
);

export type MaintenanceTaskPatch = {
  /** Optimistic concurrency guard. */
  baseRevision: number;
} & Partial<Pick<MaintenanceTask,
  | "houseId"
  | "floorId"
  | "areaId"
  | "equipmentId"
  | "title"
  | "description"
  | "basis"
  | "basisDetail"
  | "priority"
  | "plannedFor"
  | "dueBy"
  | "observationIds"
  | "status"
  | "completionNote"
  | "verificationNote"
>>;

export interface MaintenanceTaskRevision {
  maintenanceTaskId: string;
  revision: number;
  changedAt: string;
  actor: MaintenanceTaskRevisionActor;
  actorId?: string | null;
  actorLabel?: string | null;
  changedFields: MaintenanceTaskChangedField[];
  snapshot: MaintenanceTask;
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

export type DataExportPrivacyLevel = "structure" | "operations" | "full";

export interface DataExportPreview {
  schemaVersion: "stuga.export/v1";
  generatedAt: string;
  privacyLevel: DataExportPrivacyLevel;
  includesTelemetry: boolean;
  counts: Record<string, number>;
  sensitiveCategories: string[];
  estimatedTelemetryRows: number;
}

export interface BackupOperationStatus {
  available: boolean;
  schedulerHealthy: boolean;
  requestId: string | null;
  state: "idle" | "requested" | "running" | "complete" | "failed";
  requestedAt: string | null;
  completedAt: string | null;
  backupPath: string | null;
  lastError: string | null;
  latestVerifiedBackupAt: string | null;
  latestRestoreDrillAt: string | null;
}

export type SetupDoctorCheckStatus = "pass" | "warning" | "fail" | "not-applicable";

export interface SetupDoctorCheck {
  id: string;
  category: "storage" | "telemetry" | "integration" | "sensors" | "notifications" | "recovery" | "security";
  status: SetupDoctorCheckStatus;
  title: string;
  detail: string;
  action: string | null;
}

export interface SetupDoctorReport {
  generatedAt: string;
  overall: "ready" | "attention" | "blocked";
  checks: SetupDoctorCheck[];
}

export interface SensorLabelDescriptor {
  sensorId: string;
  sensorName: string;
  houseName: string;
  roomName: string | null;
  setupUri: string;
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
    /** Additive per-house status; aggregate fields above remain for older clients. */
    connections?: Array<{
      houseId: string;
      configured: boolean;
      connected: boolean;
      lastEventAt: string | null;
      mappedEntities: number;
      error: string | null;
    }>;
  };
  tpLink: {
    configured: boolean;
    connected: boolean;
    lastPollAt: string | null;
    mappedDevices: number;
    discoveredDevices: number;
    hubModel: "H100" | "H200" | null;
    error: string | null;
    /** Additive per-house status; aggregate fields above remain for older clients. */
    connections?: Array<{
      id: string;
      houseId: string;
      configured: boolean;
      connected: boolean;
      lastPollAt: string | null;
      mappedDevices: number;
      discoveredDevices: number;
      hubModel: "H100" | "H200" | null;
      error: string | null;
    }>;
  };
  webhook: {
    configured: boolean;
    lastDeliveryAt: string | null;
    error: string | null;
    /** Additive per-destination health. URLs and credentials are never exposed. */
    destinations?: Array<{
      id: string;
      lastDeliveryAt: string | null;
      error: string | null;
    }>;
  };
  /** Optional for wire compatibility with Stuga servers without native automation status. */
  telegram?: {
    /** False when the running server does not provide local secret storage and alert evaluation. */
    available: boolean;
    configured: boolean;
    connected: boolean;
    botUsername: string | null;
    chatLabel: string | null;
    lastDeliveryAt: string | null;
    error: string | null;
  };
  /**
   * Apple Notes is bridged by user-run iOS Shortcuts. Stuga never receives an
   * Apple Account credential and does not claim live document synchronization.
   */
  appleNotes?: {
    available: boolean;
    configured: boolean;
    grantCount: number;
    lastSyncAt: string | null;
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
    /** Additive per-Home status; aggregate fields above remain for older clients. */
    connections?: Array<{
      houseId: string;
      configured: boolean;
      provider: WeatherProviderName;
      lastSuccessAt: string | null;
      error: string | null;
    }>;
  };
}

export interface HomeAssistantDiscoveredInstance {
  name: string;
  url: string;
  host: string;
  port: number;
  version: string | null;
}

export interface TpLinkDiscoveredSource {
  host: string;
  model: string;
  alias: string | null;
  sourceType?: "hub" | "energy-device";
}

export interface IntegrationDiscoveryResult {
  homeAssistant: HomeAssistantDiscoveredInstance[];
  tpLink: TpLinkDiscoveredSource[];
  warnings: string[];
}

export interface HomeAssistantConfigInput {
  houseId: string;
  url: string;
  token: string;
}

export interface TpLinkConfigInput {
  houseId: string;
  /** Omit to create a stable connection id for this host. */
  connectionId?: string;
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

export interface TelegramChatCandidate {
  /** Telegram's immutable numeric chat identifier, serialized to avoid JS integer truncation. */
  id: string;
  label: string;
  username: string | null;
  type: "private";
}

export interface TelegramDiscoveryResult {
  botUsername: string;
  chats: TelegramChatCandidate[];
  message: string;
}

export interface TelegramConfigInput {
  botToken: string;
  chatId: string;
}

export interface AppleNotesGrantSummary {
  id: string;
  deviceLabel: string;
  houseId: string;
  createdAt: string;
}

export interface AppleNotesGrantCreated extends AppleNotesGrantSummary {
  /** Returned once. Stuga never returns this bearer token again. */
  token: string;
  integration: IntegrationStatus;
}

export interface AppleNotesSnapshot {
  schema: "stuga.apple-notes-snapshot/v1";
  generatedAt: string;
  houseId: string;
  title: string;
  text: string;
  maintenanceTasks: MaintenanceTask[];
}

export type AppleNotesMaintenanceCaptureInput = MaintenanceTaskInputCommon & {
  schema: "stuga.apple-notes-command/v1";
  houseId: string;
  propertyId?: string;
  /** UUID generated once by the Shortcut and reused if its HTTP request is retried. */
  operationId: string;
};

export interface AppleNotesMaintenanceCaptureResult {
  ok: true;
  deduplicated: boolean;
  task: MaintenanceTask;
  receipt: string;
}

export type WeatherUpdateTrigger = "scheduled-refresh" | "on-demand";

/**
 * Provider-neutral snapshot accepted by the weather event layer. The stable ID
 * lets at-least-once consumers discard a repeated delivery.
 */
export interface WeatherUpdateEvent {
  id: string;
  type: "weather.snapshot";
  houseId: string;
  publishedAt: string;
  trigger: WeatherUpdateTrigger;
  weather: HouseWeather;
}

export type TelemetryEvent =
  | { type: "reading"; data: Reading }
  | { type: "measurement"; data: MeasurementSample }
  | { type: "alert"; data: AlertEvent }
  | { type: "integration"; data: IntegrationStatus }
  | { type: "weather"; data: WeatherUpdateEvent }
  | { type: "mutation"; data: { method: string; resource: string; occurredAt: string } }
  | { type: "heartbeat"; data: { timestamp: string } };

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
