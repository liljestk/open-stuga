import type {
  DataMode,
  EquipmentLocationEstimate,
  GeoCoordinate,
  TrackingMapCapability,
  TrackingObservation,
  TrackingObserver,
  TrackingPropertySettings,
} from "@climate-twin/contracts";
import type { StoredGatewayRollup } from "./evidence-store.js";
import { compareCodeUnits } from "../text-order.js";

export const TRACKING_INFERENCE_ALGORITHM = "stugu.profile-fusion.2026-07";

export interface TrackingInferenceObservation {
  observation: TrackingObservation;
  observer: TrackingObserver;
}

export interface TrackingInferenceRollup {
  rollup: StoredGatewayRollup;
  observer: TrackingObserver;
}

export interface TrackingInferenceInput {
  dataMode: DataMode;
  equipmentId: string;
  propertyId: string;
  endpointId: string;
  mapCapability: TrackingMapCapability;
  observations: TrackingInferenceObservation[];
  rollups: TrackingInferenceRollup[];
  previous: EquipmentLocationEstimate | null;
  settings: TrackingPropertySettings;
  now?: Date;
}

type EstimateDraft = Omit<EquipmentLocationEstimate, "id" | "version">;

function clamp(value: number, minimum = 0, maximum = 1): number {
  return Math.min(maximum, Math.max(minimum, value));
}

function radians(value: number): number {
  return value * Math.PI / 180;
}

export function trackingDistanceMeters(left: GeoCoordinate, right: GeoCoordinate): number {
  const radius = 6_371_000;
  const latitudeDelta = radians(right.latitude - left.latitude);
  const longitudeDelta = radians(right.longitude - left.longitude);
  const value = Math.sin(latitudeDelta / 2) ** 2
    + Math.cos(radians(left.latitude)) * Math.cos(radians(right.latitude))
    * Math.sin(longitudeDelta / 2) ** 2;
  return 2 * radius * Math.atan2(Math.sqrt(value), Math.sqrt(1 - value));
}

export function trackingPointInPolygon(point: GeoCoordinate, polygon: GeoCoordinate[]): boolean {
  if (polygon.length < 3) return true;
  let inside = false;
  for (let left = 0, right = polygon.length - 1; left < polygon.length; right = left, left += 1) {
    const a = polygon[left]!;
    const b = polygon[right]!;
    const crosses = (a.latitude > point.latitude) !== (b.latitude > point.latitude)
      && point.longitude < (
        (b.longitude - a.longitude) * (point.latitude - a.latitude)
        / (b.latitude - a.latitude)
        + a.longitude
      );
    if (crosses) inside = !inside;
  }
  return inside;
}

function ageSeconds(at: string, now: Date): number {
  return Math.max(0, (now.getTime() - Date.parse(at)) / 1_000);
}

function freshness(age: number, settings: TrackingPropertySettings): EquipmentLocationEstimate["freshness"] {
  if (age <= settings.liveNearbySeconds) return "live";
  if (age <= settings.recentlySeenSeconds) return "recent";
  if (age <= settings.staleSeconds) return "aging";
  if (age <= settings.unknownSeconds) return "stale";
  return "unknown";
}

function observerCoordinate(
  evidence: TrackingInferenceObservation,
): { coordinate: GeoCoordinate; accuracy: number } | null {
  const position = evidence.observation.observerPosition;
  if (position) {
    return {
      coordinate: { latitude: position.latitude, longitude: position.longitude },
      accuracy: position.horizontalAccuracyMeters,
    };
  }
  if (!evidence.observer.fixedPosition) return null;
  return {
    coordinate: evidence.observer.fixedPosition,
    accuracy: evidence.observer.fixedPositionAccuracyMeters ?? 10,
  };
}

function signalWeight(rssi: number, trust: number, age: number): number {
  const normalizedRssi = clamp((rssi + 105) / 65, 0.03, 1);
  return normalizedRssi ** 2 * clamp(trust, 0.05, 1) * Math.exp(-age / 90);
}

function weightedCoordinate(
  values: Array<{ coordinate: GeoCoordinate; weight: number }>,
): GeoCoordinate | null {
  const total = values.reduce((sum, value) => sum + value.weight, 0);
  if (total <= 0) return null;
  return {
    latitude: values.reduce((sum, value) => sum + value.coordinate.latitude * value.weight, 0) / total,
    longitude: values.reduce((sum, value) => sum + value.coordinate.longitude * value.weight, 0) / total,
  };
}

function distinctObservers(
  observations: TrackingInferenceObservation[],
  rollups: TrackingInferenceRollup[],
): string[] {
  return [...new Set([
    ...observations.map((item) => item.observer.id),
    ...rollups.map((item) => item.observer.id),
  ])];
}

function profileVersions(
  observations: TrackingInferenceObservation[],
  rollups: TrackingInferenceRollup[],
): string[] {
  return [...new Set([
    ...observations.map((item) => `${item.observation.profileId}@${item.observation.profileVersion}`),
    ...rollups.map((item) => `${item.rollup.profileId}@${item.rollup.profileVersion}`),
  ])];
}

function previousDraft(input: TrackingInferenceInput, now: Date): EstimateDraft {
  const previous = input.previous;
  if (!previous?.lastObservedAt) return {
    dataMode: input.dataMode,
    equipmentId: input.equipmentId,
    propertyId: input.propertyId,
    endpointId: input.endpointId,
    calculatedAt: now.toISOString(),
    effectiveAt: now.toISOString(),
    kind: "unknown",
    coordinate: null,
    uncertaintyRadiusMeters: null,
    zoneId: null,
    confidence: 0,
    truthClass: "inferred",
    source: "none",
    freshness: "unknown",
    movementState: "unknown",
    lastObservedAt: null,
    observerCount: 0,
    provenance: {
      algorithm: TRACKING_INFERENCE_ALGORITHM,
      observationIds: [],
      rollupIds: [],
      observerIds: [],
      profileVersions: [],
      factors: ["No accepted claimed evidence is available."],
    },
  };
  const state = freshness(ageSeconds(previous.lastObservedAt, now), input.settings);
  const keepPosition = state !== "unknown";
  return {
    ...previous,
    calculatedAt: now.toISOString(),
    effectiveAt: previous.effectiveAt,
    kind: keepPosition ? previous.kind : "unknown",
    coordinate: keepPosition ? previous.coordinate : null,
    uncertaintyRadiusMeters: keepPosition && previous.uncertaintyRadiusMeters !== null
      ? previous.uncertaintyRadiusMeters * (state === "stale" ? 2 : 1.25)
      : null,
    zoneId: keepPosition ? previous.zoneId : null,
    confidence: keepPosition ? clamp(previous.confidence * (state === "stale" ? 0.55 : 0.8)) : 0,
    freshness: state,
    movementState: "unknown",
    observerCount: 0,
    provenance: {
      ...previous.provenance,
      algorithm: TRACKING_INFERENCE_ALGORITHM,
      observationIds: [],
      rollupIds: [],
      observerIds: [],
      factors: ["No new evidence; retained the previous estimate with decayed confidence."],
    },
  };
}

export function inferTrackedEquipmentPosition(input: TrackingInferenceInput): EstimateDraft {
  const now = input.now ?? new Date();
  const maximumAge = Math.max(input.settings.staleSeconds, 300);
  const observations = input.observations
    .filter(({ observation }) => ageSeconds(observation.observedAt, now) <= maximumAge)
    .sort((left, right) => Date.parse(right.observation.observedAt) - Date.parse(left.observation.observedAt));
  const rollups = input.rollups
    .filter(({ rollup }) => ageSeconds(rollup.windowEndedAt, now) <= maximumAge)
    .sort((left, right) => Date.parse(right.rollup.windowEndedAt) - Date.parse(left.rollup.windowEndedAt));
  if (observations.length === 0 && rollups.length === 0) return previousDraft(input, now);

  const lastObservedAt = [
    ...observations.map((item) => item.observation.observedAt),
    ...rollups.map((item) => item.rollup.windowEndedAt),
  ].sort(compareCodeUnits).at(-1)!;
  const state = freshness(ageSeconds(lastObservedAt, now), input.settings);
  const observerIds = distinctObservers(observations, rollups);
  const observationIds = observations.map((item) => item.observation.id);
  const rollupIds = rollups.map((item) => item.rollup.id);
  const factors: string[] = [];

  const activeFind = observations.find(({ observation }) => (
    observation.scanContext === "foreground-find"
    && observation.observerPosition
    && ageSeconds(observation.observedAt, now) <= input.settings.liveNearbySeconds
  ));
  let kind: EquipmentLocationEstimate["kind"] = "unknown";
  let coordinate: GeoCoordinate | null = null;
  let uncertaintyRadiusMeters: number | null = null;
  let zoneId: string | null = null;
  let source: EquipmentLocationEstimate["source"] = "none";
  let confidence = 0;

  if (activeFind) {
    const located = observerCoordinate(activeFind)!;
    kind = "nearby";
    coordinate = located.coordinate;
    uncertaintyRadiusMeters = Math.max(3, located.accuracy + Math.max(0, -activeFind.observation.rssi - 45) * 0.6);
    source = "mobile-observer";
    confidence = clamp(activeFind.observation.trust * 0.9);
    factors.push("An authorized foreground Find session supplied current nearby evidence.");
  } else {
    const fixed = [
      ...rollups.map((item) => ({
        observer: item.observer,
        rssi: item.rollup.rssiMean,
        trust: item.observer.trustLevel,
        at: item.rollup.windowEndedAt,
        coordinate: item.observer.fixedPosition,
        accuracy: item.observer.fixedPositionAccuracyMeters ?? 10,
      })),
      ...observations.filter((item) => !item.observation.observerPosition).map((item) => ({
        observer: item.observer,
        rssi: item.observation.rssi,
        trust: item.observation.trust,
        at: item.observation.observedAt,
        coordinate: item.observer.fixedPosition,
        accuracy: item.observer.fixedPositionAccuracyMeters ?? 10,
      })),
    ].filter((item) => item.observer.fixedPosition || item.observer.zoneId);
    const zoneScores = new Map<string, number>();
    for (const item of fixed) {
      if (!item.observer.zoneId) continue;
      const weight = signalWeight(item.rssi, item.trust, ageSeconds(item.at, now));
      zoneScores.set(item.observer.zoneId, (zoneScores.get(item.observer.zoneId) ?? 0) + weight);
    }
    const rankedZones = [...zoneScores].sort((left, right) => right[1] - left[1]);
    if (rankedZones[0] && (input.mapCapability === "ZONE" || input.mapCapability === "AREA")) {
      kind = input.mapCapability === "ZONE" ? "zone" : "area";
      zoneId = rankedZones[0][0];
      source = fixed.length > 1 ? "multi-observer" : "fixed-gateway";
      const total = rankedZones.reduce((sum, item) => sum + item[1], 0);
      confidence = clamp(0.45 + 0.45 * (rankedZones[0][1] / Math.max(total, 0.001)));
      factors.push(`${fixed.length} fixed-gateway evidence stream(s) support the selected area.`);
    } else if (input.mapCapability === "COORDINATE") {
      const coordinateEvidence = fixed.flatMap((item) => item.coordinate ? [{
        coordinate: item.coordinate,
        weight: signalWeight(item.rssi, item.trust, ageSeconds(item.at, now)),
        accuracy: item.accuracy,
      }] : []);
      if (coordinateEvidence.length >= 2) {
        coordinate = weightedCoordinate(coordinateEvidence);
        kind = coordinate ? "coordinate" : "unknown";
        source = "multi-observer";
        uncertaintyRadiusMeters = coordinate
          ? Math.max(
            10,
            ...coordinateEvidence.map((item) => trackingDistanceMeters(coordinate!, item.coordinate) + item.accuracy),
          )
          : null;
        confidence = clamp(0.35 + coordinateEvidence.length * 0.08, 0, 0.75);
        factors.push("A coordinate-capable profile combined multiple fixed observer placements.");
      }
    }
    if (kind === "unknown") {
      const mobile = observations
        .map((item) => ({ item, located: observerCoordinate(item) }))
        .filter((value): value is { item: TrackingInferenceObservation; located: NonNullable<typeof value.located> } => (
          value.located !== null && value.item.observation.observerPosition !== null
        ));
      if (mobile.length > 0) {
        const weighted = mobile.map(({ item, located }) => ({
          coordinate: located.coordinate,
          weight: signalWeight(
            item.observation.rssi,
            item.observation.trust,
            ageSeconds(item.observation.observedAt, now),
          ) / Math.max(1, located.accuracy),
          accuracy: located.accuracy,
        }));
        coordinate = weightedCoordinate(weighted);
        kind = input.mapCapability === "NEARBY" ? "nearby" : "area";
        source = mobile.length > 1 ? "multi-observer" : "mobile-observer";
        uncertaintyRadiusMeters = coordinate
          ? Math.max(25, ...weighted.map((item) => (
            trackingDistanceMeters(coordinate!, item.coordinate) + item.accuracy
          )))
          : null;
        confidence = clamp(0.3 + mobile.length * 0.08, 0, 0.65);
        factors.push("Opportunistic mobile evidence produced an uncertainty-bounded area estimate.");
      }
    }
  }

  const motionEvidence = observations.some((item) => item.observation.motion === true)
    || rollups.some((item) => item.rollup.motionObserved === true);
  let movementState: EquipmentLocationEstimate["movementState"] = motionEvidence ? "moving" : "unknown";
  if (!motionEvidence && input.previous?.coordinate && coordinate
    && input.previous.confidence >= input.settings.minimumMovementConfidence
    && confidence >= input.settings.minimumMovementConfidence
    && trackingDistanceMeters(input.previous.coordinate, coordinate) >= input.settings.movementThresholdMeters
    && Math.abs(Date.parse(lastObservedAt) - Date.parse(input.previous.effectiveAt))
      <= input.settings.movementMaximumIntervalSeconds * 1_000) {
    movementState = "moving";
    factors.push("Two sufficiently confident estimates crossed the configured movement threshold.");
  }
  if (movementState === "unknown" && state === "live" && (observations.length + rollups.length) >= 2) {
    movementState = "stationary";
  }
  if (kind === "unknown") factors.push("Evidence was accepted but cannot support this profile's map capability.");
  return {
    dataMode: input.dataMode,
    equipmentId: input.equipmentId,
    propertyId: input.propertyId,
    endpointId: input.endpointId,
    calculatedAt: now.toISOString(),
    effectiveAt: lastObservedAt,
    kind,
    coordinate,
    uncertaintyRadiusMeters,
    zoneId,
    confidence,
    truthClass: "inferred",
    source,
    freshness: state,
    movementState,
    lastObservedAt,
    observerCount: observerIds.length,
    provenance: {
      algorithm: TRACKING_INFERENCE_ALGORITHM,
      observationIds,
      rollupIds,
      observerIds,
      profileVersions: profileVersions(observations, rollups),
      factors,
    },
  };
}
