/** Public, renderer-neutral contracts for experimental spatial layers. */

export type SpatialLayerMaturity = 'research' | 'experimental' | 'stable';
export type SpatialLayerStatus = 'ready' | 'warming_up' | 'insufficient_data' | 'error';
export type SpatialScopeKind = 'house' | 'property';

export interface SpatialScopeRef {
  kind: SpatialScopeKind;
  id: string;
}

export interface Vector2 {
  x: number;
  y: number;
}

export interface Vector3 extends Vector2 {
  z: number;
}

export type CoordinateFrameKind =
  | 'floor-plan-2d'
  | 'building-local-3d'
  | 'property-local-3d'
  | 'geographic';

export interface CoordinateFrame {
  id: string;
  /** Changes whenever origin, scale, axes, or floor association changes. */
  version: string;
  kind: CoordinateFrameKind;
  unit: 'normalized' | 'm' | 'degrees';
  origin?: Vector3;
  floorId?: string;
  /** Clockwise rotation from true north, when known. */
  rotationDegrees?: number;
}

export type SpatialZoneKind =
  | 'indoor'
  | 'cellar'
  | 'attic'
  | 'crawlspace'
  | 'outdoor'
  | 'building'
  | 'unknown';

export interface SpatialZone {
  id: string;
  name: string;
  kind: SpatialZoneKind;
  frameId: string;
  floorId?: string;
  roomId?: string;
  centroid: Vector3;
  polygon?: Vector2[];
  elevationM?: number;
  heightM?: number;
  volumeM3?: number;
  isEntryZone?: boolean;
  tags?: string[];
}

export type SpatialConnectionKind =
  | 'door'
  | 'open-passage'
  | 'stair'
  | 'vent'
  | 'window'
  | 'envelope-leakage'
  | 'site-link'
  | 'unknown';

export interface SpatialConnection {
  id: string;
  zoneAId: string;
  zoneBId: string;
  kind: SpatialConnectionKind;
  enabled: boolean;
  normallyOpen?: boolean;
  openingAreaM2?: number;
  anchors?: Vector3[];
  tags?: string[];
}

export interface SpatialSensorBinding {
  sensorId: string;
  zoneId: string;
  frameId: string;
  position: Vector3;
  role: 'primary' | 'supporting' | 'outdoor';
  activeFrom: string;
  activeTo?: string;
  placementRisks?: Array<
    | 'near-window'
    | 'near-exterior-wall'
    | 'near-radiator'
    | 'near-heat-pump'
    | 'direct-sunlight'
    | 'unknown'
  >;
}

export interface SpatialTopology {
  scope: SpatialScopeRef;
  frames: CoordinateFrame[];
  zones: SpatialZone[];
  connections: SpatialConnection[];
  sensorBindings: SpatialSensorBinding[];
}

export interface SpatialClimateSample {
  sensorId: string;
  observedAt: string;
  receivedAt?: string;
  temperatureC: number;
  relativeHumidityPct: number;
  pressureHpa?: number;
  pressureSource?: 'observed' | 'configured';
  sourceQuality?: number;
  sourceSequence?: string;
}

export interface SpatialSensorCalibration {
  sensorId: string;
  validFrom: string;
  validTo?: string;
  temperatureOffsetC: number;
  humidityOffsetPct: number;
  responseLagSeconds?: number;
  confidence: number;
  method: 'co-location' | 'manual' | 'factory' | 'estimated';
}

export type SpatialContextEventKind =
  | 'door-open'
  | 'window-open'
  | 'hvac-change'
  | 'heat-pump-change'
  | 'extractor-change'
  | 'dehumidifier-change'
  | 'heater-change'
  | 'cooking'
  | 'shower'
  | 'sauna'
  | 'solar-gain'
  | 'rapid-weather-change'
  | 'persistent-environmental-source'
  | 'known-empty'
  | 'known-occupied';

export interface SpatialContextEvent {
  id: string;
  kind: SpatialContextEventKind;
  startAt: string;
  endAt?: string;
  zoneIds?: string[];
  strength?: number;
}

export interface SpatialLayerMetric {
  value: number | string | boolean | null;
  unit?: string;
  quality: number;
  label?: string;
}

export interface SpatialLayerEvidence {
  /** Evidence strength, not a calibrated probability. */
  score: number;
  kind: 'observation' | 'inference' | 'quality';
  reasonCodes: string[];
  details?: Record<string, number | string | boolean | null>;
}

export interface SpatialLayerStyleHint {
  emphasis?: number;
  opacity?: number;
  lineStyle?: 'solid' | 'dashed' | 'dotted';
  direction?: 'a-to-b' | 'b-to-a' | 'both' | 'none';
  palette?: 'temperature' | 'humidity' | 'quality' | 'air' | 'activity' | 'neutral';
}

export interface ZoneLayerValue {
  zoneId: string;
  frameId: string;
  /** Snapshot-local geometry identity retained for historical 2D/3D replay. */
  name?: string;
  floorId?: string;
  roomId?: string;
  polygon?: Vector2[];
  tags?: string[];
  anchor?: Vector3;
  metrics: Record<string, SpatialLayerMetric>;
  evidence: SpatialLayerEvidence[];
  reasonCodes: string[];
  style?: SpatialLayerStyleHint;
}

export interface ConnectionLayerValue {
  connectionId: string;
  frameId?: string;
  anchors?: Vector3[];
  /** Per-anchor frames for stairs/cross-floor or other multi-frame edges. */
  anchorRefs?: Array<{ frameId: string; position: Vector3 }>;
  fromZoneId: string | null;
  toZoneId: string | null;
  state:
    | 'directed'
    | 'bidirectional-evidence'
    | 'no-detectable-propagation'
    | 'uncertain'
    | 'insufficient-data';
  metrics: Record<string, SpatialLayerMetric>;
  evidence: SpatialLayerEvidence[];
  reasonCodes: string[];
  style?: SpatialLayerStyleHint;
}

export interface PointLayerValue {
  pointId: string;
  zoneId?: string;
  frameId: string;
  position: Vector3;
  metrics: Record<string, SpatialLayerMetric>;
  evidence: SpatialLayerEvidence[];
  reasonCodes: string[];
  style?: SpatialLayerStyleHint;
}

export interface SpatialLayerSnapshot {
  scope: SpatialScopeRef;
  /** Exact coordinate definitions used by this revision for historical replay. */
  coordinateFrames: CoordinateFrame[];
  layerId: string;
  model: {
    id: string;
    version: string;
    maturity: SpatialLayerMaturity;
  };
  generatedAt: string;
  windowStart: string;
  windowEnd: string;
  status: SpatialLayerStatus;
  configVersion: string;
  inputDigest: string;
  qualityScore: number;
  warnings: string[];
  reasonCodes: string[];
  zones: ZoneLayerValue[];
  connections: ConnectionLayerValue[];
  points: PointLayerValue[];
  metadata?: Record<string, number | string | boolean | null>;
}

/**
 * Dependency outputs are immutable inputs to a downstream engine. Their model
 * version and input digest form part of the downstream snapshot provenance.
 */
export type SpatialDeepReadonly<T> =
  T extends (...args: never[]) => unknown
    ? T
    : T extends readonly (infer Item)[]
      ? readonly SpatialDeepReadonly<Item>[]
      : T extends object
        ? { readonly [Key in keyof T]: SpatialDeepReadonly<T[Key]> }
        : T;

export type SpatialLayerDependencySnapshot = SpatialDeepReadonly<SpatialLayerSnapshot>;

export interface SpatialLayerEngineManifest {
  id: string;
  version: string;
  maturity: SpatialLayerMaturity;
  title: string;
  description: string;
  supportedScopes: SpatialScopeKind[];
  requiredMetrics: Array<'temperatureC' | 'relativeHumidityPct'>;
  producedLayerIds: string[];
  dependencies?: string[];
}

export interface SpatialLayerEngineInput {
  scope: SpatialScopeRef;
  topology: SpatialTopology;
  samples: SpatialClimateSample[];
  calibrations?: SpatialSensorCalibration[];
  contextEvents?: SpatialContextEvent[];
  generatedAt: string;
  windowStart: string;
  windowEnd: string;
  configVersion: string;
  targetBucketSeconds?: 30 | 60;
  config?: Readonly<Record<string, unknown>>;
  /** Direct, declared prerequisite outputs supplied by the engine host. */
  dependencySnapshots?: readonly SpatialLayerDependencySnapshot[];
}

export interface SpatialLayerEngine {
  readonly manifest: SpatialLayerEngineManifest;
  infer(input: SpatialLayerEngineInput): SpatialLayerSnapshot[] | Promise<SpatialLayerSnapshot[]>;
}

export interface SpatialLayerEngineHealth {
  engineId: string;
  modelVersion: string;
  maturity: SpatialLayerMaturity;
  state: 'available' | 'disabled' | 'error';
  message?: string;
}
