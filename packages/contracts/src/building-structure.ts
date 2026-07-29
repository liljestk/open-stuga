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

export interface PlanElementBase {
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

export interface AirflowPlanElementBase extends PlanElementBase {
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

const DEFAULT_OPENING_PROVIDER_STALE_SECONDS = 900;

export function openingObservationMatchesElement(
  element: AirflowPlanElement,
  observation: OpeningStateObservation,
): boolean {
  if (observation.elementId !== element.id) return false;
  if (observation.source !== "home-assistant" && observation.source !== "tapo") return true;
  const binding = element.stateBinding;
  return Boolean(
    binding
    && binding.provider === observation.source
    && observation.externalId === binding.externalId
    && (!binding.connectionId || observation.connectionId === binding.connectionId),
  );
}

export function openingObservationEffectiveUntil(
  observation: OpeningStateObservation,
  binding: OpeningStateBinding | undefined,
  nextObservationAt = Number.POSITIVE_INFINITY,
): number {
  const observedAt = Date.parse(observation.observedAt);
  if (!Number.isFinite(observedAt)) return Number.NaN;
  const declared = observation.validUntil === undefined
    ? Number.POSITIVE_INFINITY
    : Date.parse(observation.validUntil);
  if (observation.validUntil !== undefined && !Number.isFinite(declared)) return observedAt;
  const providerExpiry = observation.source === "home-assistant" || observation.source === "tapo"
    ? observedAt + Math.max(
        1,
        binding?.staleAfterSeconds ?? DEFAULT_OPENING_PROVIDER_STALE_SECONDS,
      ) * 1_000
    : Number.POSITIVE_INFINITY;
  return Math.min(declared, providerExpiry, nextObservationAt);
}

export function openingObservationState(
  observation: OpeningStateObservation,
  binding: OpeningStateBinding | undefined,
): OpeningState {
  if (!binding?.invert || observation.state === "unknown") return observation.state;
  return observation.state === "open" ? "closed" : "open";
}

export function isOpeningObservationEffectiveAt(
  observation: OpeningStateObservation,
  binding: OpeningStateBinding | undefined,
  at: string | number | Date,
): boolean {
  const atMs = at instanceof Date ? at.getTime() : typeof at === "number" ? at : Date.parse(at);
  const observedAt = Date.parse(observation.observedAt);
  const effectiveUntil = openingObservationEffectiveUntil(observation, binding);
  return Number.isFinite(atMs)
    && Number.isFinite(observedAt)
    && observedAt <= atMs
    && atMs < effectiveUntil;
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
    .filter((observation) => openingObservationMatchesElement(element, observation))
    .filter((observation) => isOpeningObservationEffectiveAt(observation, element.stateBinding, atMs))
    .sort((left, right) => Date.parse(right.observedAt) - Date.parse(left.observedAt) || right.id.localeCompare(left.id))[0];
  // Unknown is an explicit loss-of-confidence event. It masks older readings
  // instead of allowing a previous open state to remain effective.
  if (!candidate || candidate.state === "unknown") return fallback;
  const observedState = openingObservationState(candidate, element.stateBinding);
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

export type StugubySyncState = "current" | "pending" | "offline" | "conflict" | "detached";

export type StugubyPropertyEditPolicy = "collaborative" | "read-only";

export type StugubyHouseEditPolicy = "read-only" | "editable";

export type StugubyHouseOwnership = "local" | "shared";

export type StugubyRecoveryState = "not-enabled" | "syncing" | "ready" | "incomplete";

/**
 * Local projection metadata for a coordinator-owned Property. A temporary
 * outage changes syncState only; ownership changes solely through an explicit
 * detach or authority-transfer operation.
 */
export interface StugubyPropertyLink {
  stugubyId: string;
  authorityNodeId: string;
  isAuthority: boolean;
  editPolicy: StugubyPropertyEditPolicy;
  syncState: StugubySyncState;
  authorityEpoch: number;
  lastSyncedRevision: number;
  pendingChangeCount: number;
  conflictCount: number;
  detachedAt?: string;
}

/** Sharing, editing, and recovery are intentionally independent dimensions. */
export interface StugubyHouseLink {
  stugubyId: string;
  authorityNodeId: string;
  publicationId: string;
  ownership: StugubyHouseOwnership;
  editPolicy: StugubyHouseEditPolicy;
  syncState: StugubySyncState;
  authorityEpoch: number;
  pendingChangeCount: number;
  conflictCount: number;
  recoveryState: StugubyRecoveryState;
  designatedSuccessorNodeId?: string;
  recoverySyncedThrough?: string;
  detachedAt?: string;
}
