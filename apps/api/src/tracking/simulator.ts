import { writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  TRACKING_SCHEMA_VERSION,
  type EquipmentLocationEstimate,
  type GeoCoordinate,
  type TrackingObservation,
  type TrackingObserver,
  type TrackingPropertySettings,
} from "@climate-twin/contracts";
import {
  inferTrackedEquipmentPosition,
  trackingDistanceMeters,
} from "./inference.js";

export interface TrackingSimulationOptions {
  seed?: number;
  durationSeconds?: number;
  stepSeconds?: number;
  missedAdvertisementRate?: number;
  networkOutage?: {
    startsAtSeconds: number;
    durationSeconds: number;
  };
}

export interface TrackingSimulationFrame {
  receivedAt: string;
  observations: TrackingObservation[];
}

export interface TrackingSimulation {
  schemaVersion: typeof TRACKING_SCHEMA_VERSION;
  dataMode: "demo";
  startedAt: string;
  durationSeconds: number;
  profile: {
    id: string;
    version: string;
    mapCapability: "COORDINATE";
  };
  propertyId: string;
  equipmentId: string;
  endpointId: string;
  observers: TrackingObserver[];
  frames: TrackingSimulationFrame[];
}

export interface TrackingSimulationReplayEntry {
  receivedAt: string;
  estimate: EquipmentLocationEstimate;
}

const simulationStart = new Date("2026-07-27T12:00:00.000Z");
const profile = {
  id: "org.stugu.simulated-verified-tracker",
  version: "2026.07",
  mapCapability: "COORDINATE",
} as const;

function seededRandom(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state += 0x6D2B79F5;
    let value = state;
    value = Math.imul(value ^ value >>> 15, value | 1);
    value ^= value + Math.imul(value ^ value >>> 7, value | 61);
    return ((value ^ value >>> 14) >>> 0) / 4_294_967_296;
  };
}

function clamp(value: number, minimum: number, maximum: number): number {
  return Math.min(maximum, Math.max(minimum, value));
}

function observer(
  id: string,
  coordinate: GeoCoordinate,
  now: string,
): TrackingObserver {
  return {
    id,
    tenantId: "local",
    propertyId: "property-simulation",
    type: "linux-gateway",
    name: id,
    trustLevel: 0.95,
    fixedPosition: coordinate,
    fixedPositionAccuracyMeters: 4,
    zoneId: null,
    appInstallationId: null,
    hardwareMetadata: { simulated: true },
    lastHeartbeatAt: now,
    status: "online",
    createdAt: now,
    updatedAt: now,
  };
}

function equipmentCoordinate(elapsed: number, duration: number): GeoCoordinate {
  const progress = duration <= 0 ? 0 : elapsed / duration;
  return {
    latitude: 60.16945 + progress * 0.00055,
    longitude: 24.93835 + progress * 0.00115,
  };
}

function receivedAt(
  observedAt: Date,
  elapsed: number,
  random: () => number,
  outage: TrackingSimulationOptions["networkOutage"],
): Date {
  const normalDelay = 100 + Math.floor(random() * 900);
  if (!outage
    || elapsed < outage.startsAtSeconds
    || elapsed >= outage.startsAtSeconds + outage.durationSeconds) {
    return new Date(observedAt.getTime() + normalDelay);
  }
  const outageEnd = simulationStart.getTime()
    + (outage.startsAtSeconds + outage.durationSeconds) * 1_000;
  return new Date(outageEnd + Math.floor(random() * 2_000));
}

export function generateTrackingSimulation(
  options: TrackingSimulationOptions = {},
): TrackingSimulation {
  const seed = options.seed ?? 42;
  const durationSeconds = options.durationSeconds ?? 300;
  const stepSeconds = options.stepSeconds ?? 2;
  const missedRate = clamp(options.missedAdvertisementRate ?? 0.12, 0, 1);
  if (!Number.isFinite(durationSeconds) || durationSeconds <= 0
    || !Number.isFinite(stepSeconds) || stepSeconds <= 0) {
    throw new Error("Simulation duration and step must be positive");
  }
  const random = seededRandom(seed);
  const startedAt = simulationStart.toISOString();
  const observers = [
    observer("gateway-north", { latitude: 60.17035, longitude: 24.93865 }, startedAt),
    observer("gateway-east", { latitude: 60.16975, longitude: 24.94050 }, startedAt),
    observer("gateway-west", { latitude: 60.16920, longitude: 24.93755 }, startedAt),
  ];
  const frames: TrackingSimulationFrame[] = [];
  let observationIndex = 0;
  for (let elapsed = 0; elapsed <= durationSeconds; elapsed += stepSeconds) {
    const observedAt = new Date(simulationStart.getTime() + elapsed * 1_000);
    const location = equipmentCoordinate(elapsed, durationSeconds);
    const observations: TrackingObservation[] = [];
    for (const gateway of observers) {
      if (random() < missedRate) continue;
      observationIndex += 1;
      const distance = trackingDistanceMeters(location, gateway.fixedPosition!);
      const noise = (random() - 0.5) * 8;
      const rssi = Math.round(clamp(-42 - 18 * Math.log10(Math.max(1, distance)) + noise, -110, -30));
      const acceptedAt = receivedAt(observedAt, elapsed, random, options.networkOutage);
      const id = `simulation-observation-${String(observationIndex).padStart(6, "0")}`;
      observations.push({
        id,
        observationId: id,
        idempotencyKey: `simulation:${seed}:${gateway.id}:${elapsed}`,
        dataMode: "demo",
        tenantId: "local",
        propertyId: "property-simulation",
        endpointId: "endpoint-simulation",
        equipmentId: "equipment-simulation",
        observerId: gateway.id,
        observerType: gateway.type,
        observedAt: observedAt.toISOString(),
        receivedAt: acceptedAt.toISOString(),
        profileId: profile.id,
        profileVersion: profile.version,
        rssi,
        txPower: -59,
        batteryPercent: 82,
        motion: elapsed > 0,
        counter: observationIndex,
        observerPosition: null,
        scanContext: "fixed-gateway",
        qualityFlags: acceptedAt.getTime() - observedAt.getTime() > 10_000
          ? ["OUT_OF_ORDER"]
          : [],
        trust: gateway.trustLevel,
        telemetry: { simulationSeed: seed },
      });
    }
    if (observations.length === 0) continue;
    const latestReceipt = observations
      .map((item) => item.receivedAt)
      .sort()
      .at(-1)!;
    const normalized = observations.map((item) => ({ ...item, receivedAt: latestReceipt }));
    frames.push({ receivedAt: latestReceipt, observations: normalized });
  }
  frames.sort((left, right) => Date.parse(left.receivedAt) - Date.parse(right.receivedAt));
  return {
    schemaVersion: TRACKING_SCHEMA_VERSION,
    dataMode: "demo",
    startedAt,
    durationSeconds,
    profile,
    propertyId: "property-simulation",
    equipmentId: "equipment-simulation",
    endpointId: "endpoint-simulation",
    observers,
    frames,
  };
}

function simulationSettings(startedAt: string): TrackingPropertySettings {
  return {
    propertyId: "property-simulation",
    enabled: true,
    propertyBoundary: [],
    liveNearbySeconds: 10,
    recentlySeenSeconds: 120,
    staleSeconds: 1_800,
    unknownSeconds: 604_800,
    movementThresholdMeters: 8,
    movementMaximumIntervalSeconds: 120,
    minimumMovementConfidence: 0.55,
    exitAlertDebounceSeconds: 120,
    observationRetentionDays: 14,
    rollupRetentionDays: 180,
    estimateRetentionDays: 730,
    updatedAt: startedAt,
  };
}

export function replayTrackingSimulation(
  simulation: TrackingSimulation,
): TrackingSimulationReplayEntry[] {
  const observers = new Map(simulation.observers.map((item) => [item.id, item]));
  const accepted: TrackingObservation[] = [];
  const replay: TrackingSimulationReplayEntry[] = [];
  let previous: EquipmentLocationEstimate | null = null;
  for (const [index, frame] of simulation.frames.entries()) {
    accepted.push(...frame.observations);
    const evidence = accepted.flatMap((observation) => {
      const resolvedObserver = observers.get(observation.observerId);
      return resolvedObserver ? [{ observation, observer: resolvedObserver }] : [];
    });
    const inferred = inferTrackedEquipmentPosition({
      dataMode: simulation.dataMode,
      equipmentId: simulation.equipmentId,
      propertyId: simulation.propertyId,
      endpointId: simulation.endpointId,
      mapCapability: simulation.profile.mapCapability,
      observations: evidence,
      rollups: [],
      previous,
      settings: simulationSettings(simulation.startedAt),
      now: new Date(frame.receivedAt),
    });
    previous = {
      ...inferred,
      id: `simulation-estimate-${String(index + 1).padStart(6, "0")}`,
      truthClass: "simulated",
      provenance: {
        ...inferred.provenance,
        factors: [...inferred.provenance.factors, "Generated by the deterministic tracking simulator."],
      },
      version: index + 1,
    };
    replay.push({ receivedAt: frame.receivedAt, estimate: previous });
  }
  return replay;
}

function argument(name: string): string | undefined {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

async function main(): Promise<void> {
  const simulation = generateTrackingSimulation({
    seed: Number(argument("--seed") ?? 42),
    durationSeconds: Number(argument("--duration-seconds") ?? 300),
    stepSeconds: Number(argument("--step-seconds") ?? 2),
    missedAdvertisementRate: Number(argument("--missed-rate") ?? 0.12),
  });
  const output = JSON.stringify({
    simulation,
    replay: replayTrackingSimulation(simulation),
  }, null, 2);
  const outputPath = argument("--output");
  if (outputPath) {
    await writeFile(resolve(outputPath), `${output}\n`, "utf8");
    return;
  }
  process.stdout.write(`${output}\n`);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await main();
}
