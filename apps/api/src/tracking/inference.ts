import type {
  AssetPositionEstimate,
  GeoCoordinate,
  PropertyArea,
  TrackingConfidenceLevel,
  TrackingFreshnessState,
  TrackingInferenceExplanation,
  TrackingMovementState,
  TrackingObservation,
  TrackingObservationQualityFlag,
  TrackingObserver,
  TrackingPropertySettings,
} from "@climate-twin/contracts";

export const TRACKING_ALGORITHM_VERSION = "location-v1";

export interface TrackingInferenceObservation {
  observation: TrackingObservation;
  observer: TrackingObserver;
}

export interface TrackingInferenceInput {
  equipmentId: string;
  propertyId: string;
  observations: TrackingInferenceObservation[];
  previous: AssetPositionEstimate | null;
  settings: TrackingPropertySettings;
  zones: PropertyArea[];
  now?: Date;
}

export type TrackingInferenceResult = Omit<AssetPositionEstimate, "id" | "version">;

interface CoordinateEvidence extends TrackingInferenceObservation {
  coordinate: GeoCoordinate;
  accuracyMeters: number;
  weight: number;
}

const INVALIDATING_FLAGS = new Set<TrackingObservationQualityFlag>([
  "CLOCK_UNRELIABLE",
  "INVALID_AUTHENTICATOR",
  "PROPERTY_SCOPE_MISMATCH",
  "RSSI_OUTLIER",
  "UNRESOLVED_TAG",
  "OBSERVER_UNTRUSTED",
]);

function clamp(value: number, minimum = 0, maximum = 1): number {
  return Math.max(minimum, Math.min(maximum, value));
}

function radians(value: number): number {
  return value * Math.PI / 180;
}

export function trackingDistanceMeters(left: GeoCoordinate, right: GeoCoordinate): number {
  const earthRadius = 6_371_000;
  const dLatitude = radians(right.latitude - left.latitude);
  const dLongitude = radians(right.longitude - left.longitude);
  const latitude1 = radians(left.latitude);
  const latitude2 = radians(right.latitude);
  const value = Math.sin(dLatitude / 2) ** 2
    + Math.cos(latitude1) * Math.cos(latitude2) * Math.sin(dLongitude / 2) ** 2;
  return earthRadius * 2 * Math.atan2(Math.sqrt(value), Math.sqrt(1 - value));
}

export function trackingPointInPolygon(point: GeoCoordinate, polygon: readonly GeoCoordinate[]): boolean {
  if (polygon.length < 3) return false;
  let inside = false;
  for (let index = 0, previous = polygon.length - 1; index < polygon.length; previous = index++) {
    const currentPoint = polygon[index]!;
    const previousPoint = polygon[previous]!;
    const crosses = (currentPoint.latitude > point.latitude) !== (previousPoint.latitude > point.latitude)
      && point.longitude < (previousPoint.longitude - currentPoint.longitude)
        * (point.latitude - currentPoint.latitude)
        / (previousPoint.latitude - currentPoint.latitude) + currentPoint.longitude;
    if (crosses) inside = !inside;
  }
  return inside;
}

function rssiRangeUncertainty(rssi: number): number {
  if (rssi >= -55) return 4;
  if (rssi >= -67) return 10;
  if (rssi >= -78) return 20;
  if (rssi >= -88) return 35;
  return 60;
}

function rssiWeight(rssi: number): number {
  if (rssi >= -55) return 1;
  if (rssi >= -67) return 0.82;
  if (rssi >= -78) return 0.58;
  if (rssi >= -88) return 0.34;
  return 0.12;
}

function observationAgeSeconds(observation: TrackingObservation, now: Date): number {
  return Math.max(0, (now.getTime() - Date.parse(observation.observedAt)) / 1_000);
}

function observationWeight(entry: TrackingInferenceObservation, accuracyMeters: number, now: Date): number {
  const age = observationAgeSeconds(entry.observation, now);
  const freshness = Math.exp(-age / 90);
  const accuracy = 1 / Math.max(3, accuracyMeters);
  const platform = entry.observer.type === "ios-phone" && entry.observation.appState === "background"
    ? 0.78
    : 1;
  const quality = entry.observation.qualityFlags.includes("LOCATION_LOW_ACCURACY") ? 0.55 : 1;
  return accuracy * rssiWeight(entry.observation.rssi) * freshness
    * clamp(entry.observer.trustLevel, 0.05, 1) * platform * quality;
}

function coordinateEvidence(entry: TrackingInferenceObservation, now: Date): CoordinateEvidence | null {
  if (entry.observation.qualityFlags.includes("LOCATION_STALE")) return null;
  const mobile = entry.observation.observerPosition;
  const coordinate = mobile ?? entry.observer.fixedPosition;
  if (!coordinate) return null;
  const accuracyMeters = mobile?.horizontalAccuracyMeters
    ?? entry.observer.fixedPositionAccuracyMeters
    ?? 25;
  return {
    ...entry,
    coordinate: { latitude: coordinate.latitude, longitude: coordinate.longitude },
    accuracyMeters,
    weight: observationWeight(entry, accuracyMeters, now),
  };
}

function coordinateZone(
  coordinate: GeoCoordinate,
  zones: readonly PropertyArea[],
): string | null {
  const containing = zones.filter((zone) => (
    zone.polygon.length >= 3 && trackingPointInPolygon(coordinate, zone.polygon)
  ));
  containing.sort((left, right) => {
    const leftBuilding = left.kind === "building" ? 1 : 0;
    const rightBuilding = right.kind === "building" ? 1 : 0;
    return rightBuilding - leftBuilding
      || left.name.localeCompare(right.name)
      || left.id.localeCompare(right.id);
  });
  return containing[0]?.id ?? null;
}

function weightedGeometricMedian(entries: readonly CoordinateEvidence[]): GeoCoordinate {
  const origin = entries[0]!.coordinate;
  const latitudeScale = 111_320;
  const longitudeScale = Math.max(1, latitudeScale * Math.cos(radians(origin.latitude)));
  const points = entries.map((entry) => ({
    x: (entry.coordinate.longitude - origin.longitude) * longitudeScale,
    y: (entry.coordinate.latitude - origin.latitude) * latitudeScale,
    weight: Math.max(entry.weight, 0.000_001),
  }));
  const weightTotal = points.reduce((total, point) => total + point.weight, 0);
  let x = points.reduce((total, point) => total + point.x * point.weight, 0) / weightTotal;
  let y = points.reduce((total, point) => total + point.y * point.weight, 0) / weightTotal;
  for (let iteration = 0; iteration < 40; iteration += 1) {
    let xNumerator = 0;
    let yNumerator = 0;
    let denominator = 0;
    for (const point of points) {
      const distance = Math.max(0.05, Math.hypot(x - point.x, y - point.y));
      const weight = point.weight / distance;
      xNumerator += point.x * weight;
      yNumerator += point.y * weight;
      denominator += weight;
    }
    const nextX = xNumerator / denominator;
    const nextY = yNumerator / denominator;
    if (Math.hypot(nextX - x, nextY - y) < 0.05) {
      x = nextX;
      y = nextY;
      break;
    }
    x = nextX;
    y = nextY;
  }
  return {
    latitude: origin.latitude + y / latitudeScale,
    longitude: origin.longitude + x / longitudeScale,
  };
}

function confidenceLevel(confidence: number): TrackingConfidenceLevel {
  if (confidence >= 0.8) return "high";
  if (confidence >= 0.55) return "medium";
  return "low";
}

function freshnessState(ageSeconds: number, settings: TrackingPropertySettings): TrackingFreshnessState {
  if (ageSeconds <= settings.liveNearbySeconds) return "live";
  if (ageSeconds <= settings.recentlySeenSeconds) return "recent";
  if (ageSeconds <= settings.staleSeconds) return "last-known";
  if (ageSeconds <= settings.unknownSeconds) return "stale";
  return "unknown";
}

function movementState(
  latest: readonly TrackingInferenceObservation[],
  coordinate: GeoCoordinate | null,
  zoneId: string | null,
  confidence: number,
  previous: AssetPositionEstimate | null,
  settings: TrackingPropertySettings,
): TrackingMovementState {
  if (latest.some(({ observation }) => observation.motion)) return "moving";
  if (!previous || confidence < settings.minimumMovementConfidence) return "unknown";
  const elapsed = (Date.parse(latest[0]?.observation.observedAt ?? "") - Date.parse(previous.effectiveAt)) / 1_000;
  if (elapsed < 0 || elapsed > settings.movementMaximumIntervalSeconds) return "unknown";
  if (zoneId && previous.zoneId && zoneId !== previous.zoneId) return "moving";
  if (coordinate && previous.coordinate
    && trackingDistanceMeters(coordinate, previous.coordinate) >= settings.movementThresholdMeters) return "moving";
  return "stationary";
}

function baseResult(
  input: TrackingInferenceInput,
  now: Date,
  effectiveAt: string,
  explanation: TrackingInferenceExplanation,
): Pick<TrackingInferenceResult,
  "equipmentId" | "propertyId" | "calculatedAt" | "effectiveAt" | "algorithmVersion" | "explanation"> {
  return {
    equipmentId: input.equipmentId,
    propertyId: input.propertyId,
    calculatedAt: now.toISOString(),
    effectiveAt,
    algorithmVersion: TRACKING_ALGORITHM_VERSION,
    explanation,
  };
}

function lastKnown(input: TrackingInferenceInput, now: Date): TrackingInferenceResult {
  const previous = input.previous;
  if (!previous || !previous.lastObservedAt) {
    const explanation: TrackingInferenceExplanation = {
      method: "NO_RELIABLE_EVIDENCE",
      inputObservationCount: input.observations.length,
      acceptedObservationCount: 0,
      rejectedObservationCount: input.observations.length,
      primaryFactors: ["NO_VALID_POSITION"],
    };
    return {
      ...baseResult(input, now, now.toISOString(), explanation),
      positionType: "unknown",
      coordinate: null,
      accuracyRadiusMeters: null,
      zoneId: null,
      confidence: 0,
      confidenceLevel: "low",
      movementState: "unknown",
      freshnessState: "unknown",
      lastObservedAt: null,
      observerCount: 0,
      evidenceObservationIds: [],
    };
  }
  const age = Math.max(0, (now.getTime() - Date.parse(previous.lastObservedAt)) / 1_000);
  const freshness = freshnessState(age, input.settings);
  if (freshness === "unknown") {
    return {
      ...previous,
      ...baseResult(input, now, previous.effectiveAt, {
        method: "NO_RELIABLE_EVIDENCE",
        inputObservationCount: input.observations.length,
        acceptedObservationCount: 0,
        rejectedObservationCount: input.observations.length,
        primaryFactors: ["LAST_OBSERVATION_EXPIRED"],
      }),
      positionType: "unknown",
      coordinate: null,
      accuracyRadiusMeters: null,
      zoneId: null,
      confidence: 0,
      confidenceLevel: "low",
      movementState: "unknown",
      freshnessState: "unknown",
      observerCount: 0,
      evidenceObservationIds: [],
    };
  }
  const confidence = clamp(previous.confidence * Math.exp(-age / Math.max(60, input.settings.staleSeconds)));
  return {
    ...previous,
    ...baseResult(input, now, previous.effectiveAt, {
      method: "LAST_KNOWN",
      inputObservationCount: input.observations.length,
      acceptedObservationCount: 0,
      rejectedObservationCount: input.observations.length,
      primaryFactors: ["NO_RECENT_OBSERVATIONS", `AGE_SECONDS_${Math.round(age)}`],
    }),
    positionType: "last-known",
    confidence,
    confidenceLevel: confidenceLevel(confidence),
    movementState: "unknown",
    freshnessState: freshness,
    observerCount: 0,
    evidenceObservationIds: [],
  };
}

export function inferTrackedEquipmentPosition(input: TrackingInferenceInput): TrackingInferenceResult {
  const now = input.now ?? new Date();
  const valid = input.observations
    .filter(({ observation, observer }) => observation.accepted
      && observer.status !== "disabled"
      && observation.propertyId === input.propertyId
      && !observation.qualityFlags.some((flag) => INVALIDATING_FLAGS.has(flag))
      && Number.isFinite(Date.parse(observation.observedAt)))
    .sort((left, right) => Date.parse(right.observation.observedAt) - Date.parse(left.observation.observedAt));
  const recent = valid.filter(({ observation }) => (
    observationAgeSeconds(observation, now) <= input.settings.recentlySeenSeconds
  ));
  if (recent.length === 0) return lastKnown(input, now);

  const latestAt = recent[0]!.observation.observedAt;
  const fusionWindow = recent.filter(({ observation }) => (
    Date.parse(latestAt) - Date.parse(observation.observedAt) <= 15_000
  ));
  const latestByObserver = new Map<string, TrackingInferenceObservation>();
  for (const entry of fusionWindow) {
    if (!latestByObserver.has(entry.observer.id)) latestByObserver.set(entry.observer.id, entry);
  }
  const fusionEvidence = [...latestByObserver.values()];
  const findEvidence = fusionEvidence.filter(({ observation, observer }) => (
    observation.scanMode === "find-nearby"
      && (observer.type === "ios-phone" || observer.type === "android-phone")
      && observationAgeSeconds(observation, now) <= input.settings.liveNearbySeconds
  ));
  const coordinateEntries = fusionEvidence.map((entry) => coordinateEvidence(entry, now))
    .filter((entry): entry is CoordinateEvidence => entry !== null);
  const selectedEntries = findEvidence.length > 0
    ? findEvidence.map((entry) => coordinateEvidence(entry, now)).filter((entry): entry is CoordinateEvidence => entry !== null)
    : coordinateEntries;
  const distinctObservers = new Set(selectedEntries.map(({ observer }) => observer.id));

  if (findEvidence.length > 0 && selectedEntries.length === 0) {
    const latestFind = findEvidence[0]!;
    const age = observationAgeSeconds(latestFind.observation, now);
    const confidence = clamp(
      0.42
      + rssiWeight(latestFind.observation.rssi) * 0.22
      + (1 - clamp(age / input.settings.liveNearbySeconds)) * 0.16,
    );
    return {
      ...baseResult(input, now, latestFind.observation.observedAt, {
        method: "FIND_NEARBY",
        inputObservationCount: input.observations.length,
        acceptedObservationCount: findEvidence.length,
        rejectedObservationCount: input.observations.length - findEvidence.length,
        primaryFactors: [
          "FOREGROUND_FIND_MODE",
          "LIVE_PROXIMITY_WITHOUT_OBSERVER_COORDINATE",
        ],
      }),
      positionType: "nearby-live",
      coordinate: null,
      accuracyRadiusMeters: null,
      zoneId: null,
      confidence,
      confidenceLevel: confidenceLevel(confidence),
      movementState: movementState(recent, null, null, confidence, input.previous, input.settings),
      freshnessState: freshnessState(age, input.settings),
      lastObservedAt: latestFind.observation.observedAt,
      observerCount: new Set(findEvidence.map(({ observer }) => observer.id)).size,
      evidenceObservationIds: findEvidence.map(({ observation }) => observation.id),
    };
  }

  if (selectedEntries.length > 0 && (findEvidence.length > 0 || distinctObservers.size >= 2)) {
    const coordinate = weightedGeometricMedian(selectedEntries);
    const spread = Math.max(...selectedEntries.map((entry) => trackingDistanceMeters(coordinate, entry.coordinate)));
    const bestAccuracy = Math.min(...selectedEntries.map((entry) => entry.accuracyMeters));
    const hasMobile = selectedEntries.some(({ observer }) => observer.type === "ios-phone" || observer.type === "android-phone");
    const floor = findEvidence.length > 0 ? 3 : hasMobile ? 5 : 10;
    const accuracyRadiusMeters = Math.max(
      floor,
      bestAccuracy,
      spread,
      Math.min(...selectedEntries.map(({ observation }) => rssiRangeUncertainty(observation.rssi))),
    );
    const agreement = 1 - clamp(spread / 80);
    const freshness = 1 - clamp(observationAgeSeconds(recent[0]!.observation, now) / input.settings.recentlySeenSeconds);
    const confidence = clamp(0.38 + Math.min(0.28, distinctObservers.size * 0.1) + agreement * 0.2 + freshness * 0.12);
    const method = findEvidence.length > 0
      ? "FIND_NEARBY"
      : hasMobile ? "MULTI_OBSERVER_WEIGHTED_MEDIAN" : "MULTIPLE_FIXED_GATEWAYS";
    const zoneId = coordinateZone(coordinate, input.zones);
    const movement = movementState(recent, coordinate, zoneId, confidence, input.previous, input.settings);
    return {
      ...baseResult(input, now, latestAt, {
        method,
        inputObservationCount: input.observations.length,
        acceptedObservationCount: selectedEntries.length,
        rejectedObservationCount: input.observations.length - selectedEntries.length,
        primaryFactors: [
          `${distinctObservers.size}_DISTINCT_OBSERVERS`,
          `AGREEMENT_WITHIN_${Math.round(spread)}_METERS`,
          ...(findEvidence.length > 0 ? ["FOREGROUND_FIND_MODE"] : []),
        ],
      }),
      positionType: findEvidence.length > 0 ? "nearby-live" : "estimated-coordinate",
      coordinate,
      accuracyRadiusMeters,
      zoneId,
      confidence,
      confidenceLevel: confidenceLevel(confidence),
      movementState: movement,
      freshnessState: freshnessState(observationAgeSeconds(recent[0]!.observation, now), input.settings),
      lastObservedAt: latestAt,
      observerCount: distinctObservers.size,
      evidenceObservationIds: selectedEntries.map(({ observation }) => observation.id),
    };
  }

  const mobile = selectedEntries.find(({ observer }) => (
    observer.type === "ios-phone" || observer.type === "android-phone"
  ));
  if (mobile) {
    const radius = Math.max(12, mobile.accuracyMeters, rssiRangeUncertainty(mobile.observation.rssi));
    const confidence = clamp(
      0.3
      + rssiWeight(mobile.observation.rssi) * 0.18
      + clamp(1 - mobile.accuracyMeters / 100) * 0.16
      + clamp(mobile.observer.trustLevel) * 0.12,
    );
    const zoneId = coordinateZone(mobile.coordinate, input.zones);
    return {
      ...baseResult(input, now, mobile.observation.observedAt, {
        method: "SINGLE_MOBILE_OBSERVER",
        inputObservationCount: input.observations.length,
        acceptedObservationCount: 1,
        rejectedObservationCount: input.observations.length - 1,
        primaryFactors: ["ONE_PHONE_OBSERVATION", `RSSI_BAND_${Math.round(mobile.observation.rssi)}`],
      }),
      positionType: "estimated-coordinate",
      coordinate: mobile.coordinate,
      accuracyRadiusMeters: radius,
      zoneId,
      confidence,
      confidenceLevel: confidenceLevel(confidence),
      movementState: movementState(recent, mobile.coordinate, zoneId, confidence, input.previous, input.settings),
      freshnessState: freshnessState(observationAgeSeconds(mobile.observation, now), input.settings),
      lastObservedAt: mobile.observation.observedAt,
      observerCount: 1,
      evidenceObservationIds: [mobile.observation.id],
    };
  }

  const zoneScores = new Map<string, { score: number; entries: TrackingInferenceObservation[] }>();
  for (const entry of recent) {
    if (entry.observer.type === "ios-phone" || entry.observer.type === "android-phone") continue;
    if (!entry.observer.zoneId) continue;
    const current = zoneScores.get(entry.observer.zoneId) ?? { score: 0, entries: [] };
    const age = observationAgeSeconds(entry.observation, now);
    current.score += rssiWeight(entry.observation.rssi)
      * Math.exp(-age / 90)
      * clamp(entry.observer.trustLevel, 0.05, 1);
    current.entries.push(entry);
    zoneScores.set(entry.observer.zoneId, current);
  }
  const rankedZones = [...zoneScores].sort((left, right) => right[1].score - left[1].score);
  const winner = rankedZones[0];
  const runnerUp = rankedZones[1];
  if (winner && winner[1].score >= 0.2 && (!runnerUp || winner[1].score >= runnerUp[1].score * 1.2)) {
    const [zoneId, evidence] = winner;
    const changingFreshZone = input.previous?.zoneId
      && input.previous.zoneId !== zoneId
      && (input.previous.freshnessState === "live" || input.previous.freshnessState === "recent")
      && evidence.entries.length < 2;
    if (changingFreshZone) {
      const { id: _id, version: _version, ...held } = input.previous!;
      return held;
    }
    const confidence = clamp(0.38 + Math.min(0.3, evidence.score * 0.25)
      + Math.min(0.18, evidence.entries.length * 0.05));
    const observedAt = evidence.entries
      .map(({ observation }) => observation.observedAt)
      .sort((left, right) => Date.parse(right) - Date.parse(left))[0] ?? latestAt;
    return {
      ...baseResult(input, now, observedAt, {
        method: "FIXED_GATEWAY_ZONE",
        inputObservationCount: input.observations.length,
        acceptedObservationCount: evidence.entries.length,
        rejectedObservationCount: input.observations.length - evidence.entries.length,
        primaryFactors: [
          "STRONGEST_FIXED_GATEWAY_ZONE",
          `${evidence.entries.length}_SUPPORTING_OBSERVATIONS`,
        ],
      }),
      positionType: "confirmed-zone",
      coordinate: null,
      accuracyRadiusMeters: null,
      zoneId,
      confidence,
      confidenceLevel: confidenceLevel(confidence),
      movementState: movementState(recent, null, zoneId, confidence, input.previous, input.settings),
      freshnessState: freshnessState(observationAgeSeconds(evidence.entries[0]!.observation, now), input.settings),
      lastObservedAt: observedAt,
      observerCount: new Set(evidence.entries.map(({ observer }) => observer.id)).size,
      evidenceObservationIds: evidence.entries.map(({ observation }) => observation.id),
    };
  }

  return lastKnown(input, now);
}
