import { pathToFileURL } from "node:url";
import { writeFileSync } from "node:fs";
import type {
  AssetPositionEstimate,
  GeoCoordinate,
  PropertyArea,
  TrackingObservation,
  TrackingObserver,
  TrackingPropertySettings,
} from "@climate-twin/contracts";
import {
  inferTrackedEquipmentPosition,
  trackingDistanceMeters,
} from "./inference.js";

export interface TrackingSimulationOptions {
  seed?: number;
  durationSeconds?: number;
  stepSeconds?: number;
  startAt?: string;
  missedAdvertisementRate?: number;
  rssiNoiseDb?: number;
  clockDriftMs?: number;
  networkOutage?: { startsAtSeconds: number; durationSeconds: number };
}

export interface TrackingSimulation {
  schemaVersion: "stugu.tracking-simulation/v1";
  seed: number;
  generatedAt: string;
  settings: TrackingPropertySettings;
  zones: PropertyArea[];
  observers: TrackingObserver[];
  frames: Array<{
    at: string;
    trueAssetPosition: GeoCoordinate;
    observations: TrackingObservation[];
  }>;
}

export interface TrackingReplayResult {
  sequence: number;
  at: string;
  trueAssetPosition: GeoCoordinate;
  estimate: AssetPositionEstimate;
  errorMeters: number | null;
}

function seededRandom(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state += 0x6d2b79f5;
    let value = state;
    value = Math.imul(value ^ value >>> 15, value | 1);
    value ^= value + Math.imul(value ^ value >>> 7, value | 61);
    return ((value ^ value >>> 14) >>> 0) / 4_294_967_296;
  };
}

function normal(random: () => number): number {
  const left = Math.max(Number.EPSILON, random());
  const right = random();
  return Math.sqrt(-2 * Math.log(left)) * Math.cos(2 * Math.PI * right);
}

function interpolate(left: GeoCoordinate, right: GeoCoordinate, amount: number): GeoCoordinate {
  return {
    latitude: left.latitude + (right.latitude - left.latitude) * amount,
    longitude: left.longitude + (right.longitude - left.longitude) * amount,
  };
}

function routePosition(progress: number): GeoCoordinate {
  const route: Array<[number, GeoCoordinate]> = [
    [0, { latitude: 60.17016, longitude: 24.93017 }],
    [0.25, { latitude: 60.17016, longitude: 24.93017 }],
    [0.55, { latitude: 60.17055, longitude: 24.93070 }],
    [0.8, { latitude: 60.17092, longitude: 24.93120 }],
    [1, { latitude: 60.17115, longitude: 24.93152 }],
  ];
  const rightIndex = route.findIndex(([point]) => point >= progress);
  if (rightIndex <= 0) return route[0]![1];
  const [rightAt, right] = route[rightIndex]!;
  const [leftAt, left] = route[rightIndex - 1]!;
  return interpolate(left, right, (progress - leftAt) / (rightAt - leftAt));
}

function phonePosition(progress: number): GeoCoordinate {
  return interpolate(
    { latitude: 60.17010, longitude: 24.93005 },
    { latitude: 60.17110, longitude: 24.93145 },
    Math.min(1, Math.max(0, progress * 1.08)),
  );
}

function square(center: GeoCoordinate, delta: number): GeoCoordinate[] {
  return [
    { latitude: center.latitude - delta, longitude: center.longitude - delta },
    { latitude: center.latitude - delta, longitude: center.longitude + delta },
    { latitude: center.latitude + delta, longitude: center.longitude + delta },
    { latitude: center.latitude + delta, longitude: center.longitude - delta },
  ];
}

function iso(date: Date): string {
  return date.toISOString();
}

function simulatedRssi(distanceMeters: number, noise: number): number {
  const value = -43 - 19 * Math.log10(Math.max(1, distanceMeters)) + noise;
  return Math.max(-109, Math.min(-20, Math.round(value)));
}

export function generateTrackingSimulation(
  options: TrackingSimulationOptions = {},
): TrackingSimulation {
  const seed = Math.trunc(options.seed ?? 20260725);
  const durationSeconds = Math.max(10, Math.trunc(options.durationSeconds ?? 300));
  const stepSeconds = Math.max(1, Math.trunc(options.stepSeconds ?? 2));
  const missedRate = Math.max(0, Math.min(0.95, options.missedAdvertisementRate ?? 0.12));
  const noiseDb = Math.max(0, Math.min(30, options.rssiNoiseDb ?? 4));
  const clockDriftMs = Math.trunc(options.clockDriftMs ?? 1_500);
  const start = new Date(options.startAt ?? "2026-07-25T19:00:00.000Z");
  if (!Number.isFinite(start.getTime())) throw new Error("startAt must be an ISO 8601 timestamp");
  const random = seededRandom(seed);
  const propertyId = "simulation-property";
  const timestamp = iso(start);
  const zoneCenters = {
    shed: { latitude: 60.17016, longitude: 24.93017 },
    yard: { latitude: 60.17058, longitude: 24.93072 },
    driveway: { latitude: 60.17103, longitude: 24.93134 },
  } as const;
  const zones: PropertyArea[] = Object.entries(zoneCenters).map(([id, center]) => ({
    id: `zone-${id}`,
    propertyId,
    name: id[0]!.toUpperCase() + id.slice(1),
    kind: id === "shed" ? "building" : "yard",
    description: "Deterministic tracking simulation zone",
    location: center,
    polygon: square(center, id === "shed" ? 0.00012 : 0.00025),
    createdAt: timestamp,
    updatedAt: timestamp,
  }));
  const observerDefinitions: Array<{
    id: string;
    type: TrackingObserver["type"];
    position: GeoCoordinate | null;
    zoneId: string | null;
    accuracy: number | null;
  }> = [
    { id: "gateway-shed", type: "linux-gateway", position: zoneCenters.shed, zoneId: "zone-shed", accuracy: 3 },
    { id: "gateway-yard", type: "esp32-gateway", position: zoneCenters.yard, zoneId: "zone-yard", accuracy: 5 },
    { id: "gateway-driveway", type: "esp32-gateway", position: zoneCenters.driveway, zoneId: "zone-driveway", accuracy: 5 },
    { id: "phone-field", type: "android-phone", position: null, zoneId: null, accuracy: null },
  ];
  const observers: TrackingObserver[] = observerDefinitions.map((definition) => ({
    id: definition.id,
    tenantId: "simulation",
    propertyId,
    type: definition.type,
    name: definition.id,
    trustLevel: definition.type === "android-phone" ? 0.85 : 0.95,
    fixedPosition: definition.position,
    fixedPositionAccuracyMeters: definition.accuracy,
    zoneId: definition.zoneId,
    appInstallationId: definition.type === "android-phone" ? "simulation-phone" : null,
    hardwareMetadata: { simulated: true },
    lastHeartbeatAt: timestamp,
    status: "online",
    createdAt: timestamp,
    updatedAt: timestamp,
  }));
  const settings: TrackingPropertySettings = {
    propertyId,
    enabled: true,
    propertyBoundary: square(
      { latitude: 60.17063, longitude: 24.93077 },
      0.00085,
    ),
    liveNearbySeconds: 10,
    recentlySeenSeconds: 120,
    staleSeconds: 1_800,
    unknownSeconds: 604_800,
    movementThresholdMeters: 8,
    movementMaximumIntervalSeconds: 120,
    minimumMovementConfidence: 0.55,
    exitAlertDebounceSeconds: 120,
    updatedAt: timestamp,
  };
  const frames: TrackingSimulation["frames"] = [];
  let eventCounter = 0;
  for (let elapsed = 0; elapsed <= durationSeconds; elapsed += stepSeconds) {
    const progress = elapsed / durationSeconds;
    const trueAssetPosition = routePosition(progress);
    const frameAt = new Date(start.getTime() + elapsed * 1_000);
    const observations: TrackingObservation[] = [];
    for (const observer of observers) {
      const coordinate = observer.type === "android-phone"
        ? phonePosition(progress)
        : observer.fixedPosition;
      if (!coordinate) continue;
      const distance = trackingDistanceMeters(trueAssetPosition, coordinate);
      const detectionProbability = Math.max(0.05, 1 - distance / 115) * (1 - missedRate);
      if (random() > detectionProbability) continue;
      eventCounter += 1;
      const observedAt = new Date(frameAt.getTime() + (
        observer.type === "android-phone" ? clockDriftMs : 0
      ));
      const outage = options.networkOutage;
      const delayed = outage
        && elapsed >= outage.startsAtSeconds
        && elapsed < outage.startsAtSeconds + outage.durationSeconds;
      const receivedAt = delayed
        ? new Date(observedAt.getTime() + outage.durationSeconds * 1_000)
        : new Date(observedAt.getTime() + 800);
      observations.push({
        id: `sim-${elapsed}-${observer.id}`,
        tenantId: "simulation",
        propertyId,
        tagId: "simulation-tag",
        observerId: observer.id,
        observerType: observer.type,
        observedAt: iso(observedAt),
        receivedAt: iso(receivedAt),
        rotatingTagId: "c2ltdWxhdGVk",
        protocolVersion: 1,
        epochCounter: 1,
        eventCounter,
        rssi: simulatedRssi(distance, normal(random) * noiseDb),
        txPower: -8,
        motion: progress > 0.25,
        batteryPercent: 76,
        observerPosition: observer.type === "android-phone"
          ? {
            ...coordinate,
            horizontalAccuracyMeters: 6,
            source: "fused",
            capturedAt: iso(frameAt),
          }
          : null,
        scanMode: observer.type === "android-phone" ? "property" : "gateway",
        appState: observer.type === "android-phone" ? "background" : "background",
        deviceTimeOffsetMs: observer.type === "android-phone" ? clockDriftMs : 0,
        qualityFlags: [],
        accepted: true,
        metadata: { simulated: true, distanceMeters: Math.round(distance * 10) / 10 },
      });
    }
    frames.push({ at: iso(frameAt), trueAssetPosition, observations });
  }
  return {
    schemaVersion: "stugu.tracking-simulation/v1",
    seed,
    generatedAt: new Date(start.getTime() + durationSeconds * 1_000).toISOString(),
    settings,
    zones,
    observers,
    frames,
  };
}

export function replayTrackingSimulation(
  simulation: TrackingSimulation,
): TrackingReplayResult[] {
  const observers = new Map(simulation.observers.map((observer) => [observer.id, observer]));
  const accumulated: TrackingObservation[] = [];
  const results: TrackingReplayResult[] = [];
  let previous: AssetPositionEstimate | null = null;
  for (const frame of simulation.frames) {
    accumulated.push(...frame.observations);
    if (frame.observations.length === 0 && !previous) continue;
    const inferred = inferTrackedEquipmentPosition({
      equipmentId: "simulation-equipment",
      propertyId: simulation.settings.propertyId,
      observations: accumulated.flatMap((observation) => {
        const observer = observers.get(observation.observerId);
        return observer ? [{ observation, observer }] : [];
      }),
      previous,
      settings: simulation.settings,
      zones: simulation.zones,
      now: new Date(frame.at),
    });
    const estimate: AssetPositionEstimate = {
      ...inferred,
      id: `simulation-estimate-${results.length + 1}`,
      version: results.length + 1,
    };
    previous = estimate;
    results.push({
      sequence: results.length + 1,
      at: frame.at,
      trueAssetPosition: frame.trueAssetPosition,
      estimate,
      errorMeters: estimate.coordinate
        ? trackingDistanceMeters(estimate.coordinate, frame.trueAssetPosition)
        : null,
    });
  }
  return results;
}

function cliArguments(argv: string[]): {
  options: TrackingSimulationOptions;
  output: string | null;
} {
  const options: TrackingSimulationOptions = {};
  let output: string | null = null;
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    const value = argv[index + 1];
    if (argument === "--seed" && value) { options.seed = Number(value); index += 1; }
    else if (argument === "--duration-seconds" && value) { options.durationSeconds = Number(value); index += 1; }
    else if (argument === "--step-seconds" && value) { options.stepSeconds = Number(value); index += 1; }
    else if (argument === "--output" && value) { output = value; index += 1; }
    else throw new Error(`Unknown or incomplete argument: ${argument}`);
  }
  return { options, output };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const { options, output } = cliArguments(process.argv.slice(2));
  const simulation = generateTrackingSimulation(options);
  const replay = replayTrackingSimulation(simulation);
  const errors = replay.map((item) => item.errorMeters).filter((value): value is number => value !== null);
  const payload = {
    simulation,
    replay,
    summary: {
      estimates: replay.length,
      coordinateEstimates: errors.length,
      medianErrorMeters: errors.length === 0
        ? null
        : [...errors].sort((left, right) => left - right)[Math.floor(errors.length / 2)],
    },
  };
  const json = `${JSON.stringify(payload, null, 2)}\n`;
  if (output) writeFileSync(output, json, { encoding: "utf8", flag: "wx" });
  else process.stdout.write(json);
}
