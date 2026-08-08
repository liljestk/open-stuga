import type {
  House,
  HvacExclusionSummary,
  MeasurementSample,
  OutdoorTemperatureSample,
  Sensor,
  ThermalCalibrationResult,
  ThermalIsolationConfidence,
  ThermalIsolationEntry,
  ThermalIsolationInsight,
  ThermalIsolationMetrics,
  ThermalIsolationRating,
  ThermalIsolationResult,
} from "@climate-twin/contracts";
import {
  prepareThermalOutdoorBoundary,
  runThermalSimulation,
  runThermalSimulationAsync,
  type PreparedThermalOutdoorBoundary,
} from "./thermal-simulation.js";
import { SYSTEM_VERSION } from "./version.js";
import { HEAT_PUMP_SENSOR_TAG } from "./heat-pump-measurements.js";

const DAY_HOURS = 24;
const CALIBRATION_BUCKET_MS = 5 * 60_000;
const TP_LINK_TEMPERATURE_MODEL_PATTERN = /\bT3(?:10|15)\b/i;

export interface ThermalIsolationInput {
  house: Pick<House, "id" | "name" | "floors">;
  sensors: Sensor[];
  indoorSamplesBySensor: ReadonlyMap<string, MeasurementSample[]>;
  outdoorSamples: OutdoorTemperatureSample[];
  from: string;
  to: string;
  generatedAt?: string;
  hvacExclusion?: HvacExclusionSummary;
}

interface RoomGroup {
  id: string;
  label: string;
  floorId: string;
  floorScopeId: string;
  sensorIds: string[];
}

function round(value: number, precision = 2): number {
  return Number(value.toFixed(precision));
}

function median(values: number[]): number | null {
  if (!values.length) return null;
  const sorted = [...values].sort((left, right) => left - right);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2
    ? sorted[middle] ?? null
    : ((sorted[middle - 1] ?? 0) + (sorted[middle] ?? 0)) / 2;
}

function percentile(values: number[], fraction: number): number | null {
  if (!values.length) return null;
  const sorted = [...values].sort((left, right) => left - right);
  return sorted[Math.min(sorted.length - 1, Math.max(0, Math.ceil(sorted.length * fraction) - 1))] ?? null;
}

function unique<T>(values: T[]): T[] {
  return [...new Set(values)];
}

export function isThermalIsolationTemperatureSensor(
  sensor: Sensor,
  hasRecordedTemperature = false,
): boolean {
  if (sensor.tags.includes(HEAT_PUMP_SENSOR_TAG)) return false;
  return hasRecordedTemperature
    || Boolean(sensor.temperatureEntityId?.trim())
    || Boolean(sensor.measurementEntityIds?.temperature?.trim())
    || Boolean(sensor.tpLinkDeviceId && TP_LINK_TEMPERATURE_MODEL_PATTERN.test(sensor.model));
}

/**
 * Percentage of the modeled indoor state retained after a 24-hour step in the
 * outdoor boundary. This is a dynamic buffering index, not a construction U-value.
 */
export function thermalIsolationScore(timeConstantHours: number): number {
  if (!Number.isFinite(timeConstantHours) || timeConstantHours <= 0) return 0;
  return round(100 * Math.exp(-DAY_HOURS / timeConstantHours), 1);
}

function ratingFor(score: number | null): ThermalIsolationRating | null {
  if (score === null) return null;
  if (score >= 75) return "very-high";
  if (score >= 55) return "high";
  if (score >= 35) return "moderate";
  return "low";
}

function modelSkill(calibration: ThermalCalibrationResult): number | null {
  const mae = calibration.quality.validationMaeC;
  const persistence = calibration.quality.persistenceMaeC;
  if (mae === null || persistence === null || persistence <= 0) return null;
  return round(Math.max(-100, Math.min(100, (1 - mae / persistence) * 100)), 1);
}

function confidenceForCalibration(calibration: ThermalCalibrationResult): ThermalIsolationConfidence {
  if (!calibration.model) return "unavailable";
  const weakEvidence = [
    "LOW_THERMAL_DRIVE_VARIATION",
    "WEAK_PARAMETER_IDENTIFICATION",
    "HIGH_VALIDATION_BIAS",
    "MODEL_WORSE_THAN_PERSISTENCE",
    "NEGATIVE_EFFECTIVE_EQUILIBRIUM_LIFT",
  ].some((warning) => calibration.warnings.includes(warning));
  if (weakEvidence) return "low";
  return calibration.status === "ready" ? "high" : "medium";
}

function metricsForCalibration(calibration: ThermalCalibrationResult): ThermalIsolationMetrics {
  const tau = calibration.model?.parameters.timeConstantHours ?? null;
  const score = tau === null ? null : thermalIsolationScore(tau);
  return {
    effectiveTimeConstantHours: tau,
    halfResponseHours: tau === null ? null : round(tau * Math.log(2), 1),
    retainedAfter24HoursPct: score,
    outdoorResponseAfter24HoursPct: score === null ? null : round(100 - score, 1),
    modelSkillPct: modelSkill(calibration),
    typicalTemperatureSpreadC: null,
    p90TemperatureSpreadC: null,
  };
}

function sensitivityScores(calibration: ThermalCalibrationResult): { low: number | null; high: number | null } {
  const sensitivity = calibration.model?.sensitivity;
  if (!sensitivity) return { low: null, high: null };
  return {
    low: thermalIsolationScore(sensitivity.timeConstantLowHours),
    high: thermalIsolationScore(sensitivity.timeConstantHighHours),
  };
}

function sensorEntry(
  input: ThermalIsolationInput,
  sensor: Sensor,
  parentId: string,
  preparedOutdoor: PreparedThermalOutdoorBoundary,
): ThermalIsolationEntry {
  const calibration = runThermalSimulation({
    houseId: input.house.id,
    sensorId: sensor.id,
    roomLabel: sensor.room,
    from: input.from,
    to: input.to,
    indoorSamples: input.indoorSamplesBySensor.get(sensor.id) ?? [],
    outdoorSamples: input.outdoorSamples,
    horizonHours: 0,
    ...(input.generatedAt ? { generatedAt: input.generatedAt } : {}),
    ...(input.hvacExclusion ? { hvacExclusion: input.hvacExclusion } : {}),
  }, preparedOutdoor).calibration;
  return sensorEntryFromCalibration(input, sensor, parentId, calibration);
}

function sensorEntryFromCalibration(
  input: ThermalIsolationInput,
  sensor: Sensor,
  parentId: string,
  calibration: ThermalCalibrationResult,
): ThermalIsolationEntry {
  const metrics = metricsForCalibration(calibration);
  const score = metrics.retainedAfter24HoursPct;
  const sensitivity = sensitivityScores(calibration);
  return {
    scope: {
      type: "sensor",
      id: `sensor:${sensor.id}`,
      label: sensor.name,
      parentId,
      floorId: sensor.floorId,
      sensorIds: [sensor.id],
    },
    calibrationStatus: calibration.status,
    confidence: confidenceForCalibration(calibration),
    rating: ratingFor(score),
    score,
    rank: null,
    comparedWithHousePoints: null,
    childCoveragePct: calibration.model ? 100 : 0,
    sensorCount: 1,
    eligibleSensorCount: calibration.model ? 1 : 0,
    metrics,
    quality: {
      durationHours: calibration.quality.durationHours,
      outdoorRangeC: calibration.quality.outdoorRangeC,
      validationMaeC: calibration.quality.validationMaeC,
      persistenceMaeC: calibration.quality.persistenceMaeC,
      scoreLow: sensitivity.low,
      scoreHigh: sensitivity.high,
    },
    warnings: [...calibration.warnings],
  };
}

async function sensorEntryAsync(
  input: ThermalIsolationInput,
  sensor: Sensor,
  parentId: string,
  preparedOutdoor: PreparedThermalOutdoorBoundary,
  signal?: AbortSignal,
): Promise<ThermalIsolationEntry> {
  const calibration = (await runThermalSimulationAsync({
    houseId: input.house.id,
    sensorId: sensor.id,
    roomLabel: sensor.room,
    from: input.from,
    to: input.to,
    indoorSamples: input.indoorSamplesBySensor.get(sensor.id) ?? [],
    outdoorSamples: input.outdoorSamples,
    horizonHours: 0,
    ...(input.generatedAt ? { generatedAt: input.generatedAt } : {}),
    ...(input.hvacExclusion ? { hvacExclusion: input.hvacExclusion } : {}),
  }, preparedOutdoor, signal ? { signal } : {})).calibration;
  return sensorEntryFromCalibration(input, sensor, parentId, calibration);
}

type ThermalSpreadMetrics = Pick<
  ThermalIsolationMetrics,
  "typicalTemperatureSpreadC" | "p90TemperatureSpreadC"
>;

function synchronizedSpread(
  sensorIds: string[],
  indoorSamplesBySensor: ReadonlyMap<string, MeasurementSample[]>,
): ThermalSpreadMetrics {
  if (sensorIds.length < 2) return { typicalTemperatureSpreadC: null, p90TemperatureSpreadC: null };
  const buckets = new Map<number, Map<string, { value: number; weight: number }>>();
  for (const sensorId of sensorIds) {
    for (const sample of indoorSamplesBySensor.get(sensorId) ?? []) {
      const time = Date.parse(sample.timestamp);
      if (sample.metric !== "temperature" || sample.quality === "stale" || sample.source === "replay"
        || !Number.isFinite(time) || !Number.isFinite(sample.value)) continue;
      const bucketTime = Math.floor(time / CALIBRATION_BUCKET_MS) * CALIBRATION_BUCKET_MS;
      const bucket = buckets.get(bucketTime) ?? new Map();
      const candidate = { value: sample.value, weight: sample.quality === "estimated" ? 0.25 : 1 };
      const current = bucket.get(sensorId);
      if (!current || candidate.weight >= current.weight) bucket.set(sensorId, candidate);
      buckets.set(bucketTime, bucket);
    }
  }
  const minimumSensors = Math.max(2, Math.ceil(sensorIds.length * 0.6));
  const spreads = [...buckets.values()].flatMap((bucket) => {
    const values = [...bucket.values()].map((point) => point.value);
    return values.length < minimumSensors ? [] : [Math.max(...values) - Math.min(...values)];
  });
  const typical = median(spreads);
  const p90 = percentile(spreads, 0.9);
  return {
    typicalTemperatureSpreadC: typical === null ? null : round(typical, 2),
    p90TemperatureSpreadC: p90 === null ? null : round(p90, 2),
  };
}

interface PreparedThermalSpread {
  bySensor: Map<string, Map<number, { value: number; weight: number }>>;
}

interface CooperativeAggregationWork {
  signal?: AbortSignal;
  yieldEverySamples: number;
  samplesSinceYield: number;
}

function positiveBatchSize(value: number | undefined, fallback: number): number {
  if (value === undefined || !Number.isFinite(value) || value < 1) return fallback;
  return Math.max(1, Math.floor(value));
}

async function yieldAggregationWork(
  work: CooperativeAggregationWork,
  force = false,
): Promise<void> {
  work.signal?.throwIfAborted();
  if (!force && work.samplesSinceYield < work.yieldEverySamples) return;
  work.samplesSinceYield = 0;
  await new Promise<void>((resolve) => setImmediate(resolve));
  work.signal?.throwIfAborted();
}

async function prepareThermalSpreadAsync(
  input: ThermalIsolationInput,
  sensorIds: string[],
  work: CooperativeAggregationWork,
): Promise<PreparedThermalSpread> {
  const bySensor = new Map<string, Map<number, { value: number; weight: number }>>();
  for (const sensorId of unique(sensorIds)) {
    const sensorBuckets = new Map<number, { value: number; weight: number }>();
    for (const sample of input.indoorSamplesBySensor.get(sensorId) ?? []) {
      const time = Date.parse(sample.timestamp);
      if (sample.metric === "temperature" && sample.quality !== "stale" && sample.source !== "replay"
        && Number.isFinite(time) && Number.isFinite(sample.value)) {
        const bucketTime = Math.floor(time / CALIBRATION_BUCKET_MS) * CALIBRATION_BUCKET_MS;
        const candidate = { value: sample.value, weight: sample.quality === "estimated" ? 0.25 : 1 };
        const current = sensorBuckets.get(bucketTime);
        if (!current || candidate.weight >= current.weight) sensorBuckets.set(bucketTime, candidate);
      }
      work.samplesSinceYield += 1;
      if (work.samplesSinceYield >= work.yieldEverySamples) await yieldAggregationWork(work);
    }
    bySensor.set(sensorId, sensorBuckets);
  }
  return { bySensor };
}

function spreadCacheKey(sensorIds: string[]): string {
  return JSON.stringify([...sensorIds].sort());
}

async function synchronizedPreparedSpreadAsync(
  sensorIds: string[],
  prepared: PreparedThermalSpread,
  work: CooperativeAggregationWork,
): Promise<ThermalSpreadMetrics> {
  if (sensorIds.length < 2) {
    return { typicalTemperatureSpreadC: null, p90TemperatureSpreadC: null };
  }
  const buckets = new Map<number, number[]>();
  for (const sensorId of unique(sensorIds)) {
    for (const [bucketTime, point] of prepared.bySensor.get(sensorId) ?? []) {
      const values = buckets.get(bucketTime) ?? [];
      values.push(point.value);
      buckets.set(bucketTime, values);
      work.samplesSinceYield += 1;
      if (work.samplesSinceYield >= work.yieldEverySamples) await yieldAggregationWork(work);
    }
  }
  const minimumSensors = Math.max(2, Math.ceil(sensorIds.length * 0.6));
  const spreads: number[] = [];
  for (const values of buckets.values()) {
    if (values.length >= minimumSensors) spreads.push(Math.max(...values) - Math.min(...values));
    work.samplesSinceYield += 1;
    if (work.samplesSinceYield >= work.yieldEverySamples) await yieldAggregationWork(work);
  }
  const typical = median(spreads);
  const p90 = percentile(spreads, 0.9);
  return {
    typicalTemperatureSpreadC: typical === null ? null : round(typical, 2),
    p90TemperatureSpreadC: p90 === null ? null : round(p90, 2),
  };
}

function aggregateConfidence(
  status: ThermalIsolationEntry["calibrationStatus"],
  childCoveragePct: number,
  children: ThermalIsolationEntry[],
): ThermalIsolationConfidence {
  if (status === "insufficient-data") return "unavailable";
  const eligible = children.filter((child) => child.score !== null);
  if (childCoveragePct < 50 || eligible.filter((child) => child.confidence === "low").length > eligible.length / 2) return "low";
  if (status === "ready" && eligible.every((child) => child.confidence === "high")) return "high";
  return "medium";
}

function aggregateEntry(
  scope: ThermalIsolationEntry["scope"],
  children: ThermalIsolationEntry[],
  sensorIds: string[],
  indoorSamplesBySensor: ReadonlyMap<string, MeasurementSample[]>,
  preparedSpread?: ThermalSpreadMetrics,
): ThermalIsolationEntry {
  const scoredChildren = children.filter((child) => child.score !== null);
  const score = median(scoredChildren.flatMap((child) => child.score === null ? [] : [child.score]));
  const childCoveragePct = children.length
    ? round(scoredChildren.length / children.length * 100, 1)
    : 0;
  const status: ThermalIsolationEntry["calibrationStatus"] = score === null
    ? "insufficient-data"
    : childCoveragePct === 100 && scoredChildren.every((child) => child.calibrationStatus === "ready")
      ? "ready"
      : "provisional";
  const metricMedian = (selector: (entry: ThermalIsolationEntry) => number | null): number | null => {
    const value = median(scoredChildren.flatMap((entry) => {
      const selected = selector(entry);
      return selected === null ? [] : [selected];
    }));
    return value === null ? null : round(value, 2);
  };
  const aggregateScore = score === null ? null : round(score, 1);
  const medianTimeConstant = metricMedian((entry) => entry.metrics.effectiveTimeConstantHours);
  const effectiveTimeConstantHours = aggregateScore === null
    ? null
    : aggregateScore <= 0 || aggregateScore >= 100
      ? medianTimeConstant
      : round(-DAY_HOURS / Math.log(aggregateScore / 100), 2);
  const eligibleSensorCount = Math.min(
    sensorIds.length,
    scoredChildren.reduce((sum, child) => sum + child.eligibleSensorCount, 0),
  );
  const spread = preparedSpread ?? synchronizedSpread(sensorIds, indoorSamplesBySensor);
  const warnings = unique(children.flatMap((child) => child.warnings));
  if (childCoveragePct < 100) warnings.push(children.length ? "PARTIAL_SCOPE_COVERAGE" : "NO_TEMPERATURE_SENSOR");
  if (!sensorIds.length && !warnings.includes("NO_TEMPERATURE_SENSOR")) warnings.push("NO_TEMPERATURE_SENSOR");
  return {
    scope,
    calibrationStatus: status,
    confidence: aggregateConfidence(status, childCoveragePct, children),
    rating: ratingFor(aggregateScore),
    score: aggregateScore,
    rank: null,
    comparedWithHousePoints: null,
    childCoveragePct,
    sensorCount: sensorIds.length,
    eligibleSensorCount,
    metrics: {
      effectiveTimeConstantHours,
      halfResponseHours: effectiveTimeConstantHours === null ? null : round(effectiveTimeConstantHours * Math.log(2), 1),
      retainedAfter24HoursPct: aggregateScore,
      outdoorResponseAfter24HoursPct: aggregateScore === null ? null : round(100 - aggregateScore, 1),
      modelSkillPct: metricMedian((entry) => entry.metrics.modelSkillPct),
      ...spread,
    },
    quality: {
      durationHours: metricMedian((entry) => entry.quality.durationHours) ?? 0,
      outdoorRangeC: metricMedian((entry) => entry.quality.outdoorRangeC) ?? 0,
      validationMaeC: metricMedian((entry) => entry.quality.validationMaeC),
      persistenceMaeC: metricMedian((entry) => entry.quality.persistenceMaeC),
      scoreLow: metricMedian((entry) => entry.quality.scoreLow),
      scoreHigh: metricMedian((entry) => entry.quality.scoreHigh),
    },
    warnings,
  };
}

function roomGroups(house: ThermalIsolationInput["house"], sensors: Sensor[]): RoomGroup[] {
  const groups = new Map<string, RoomGroup>();
  for (const floor of house.floors) {
    const floorScopeId = `floor:${floor.id}`;
    for (const room of floor.rooms) {
      const id = `room:${floor.id}:${room.id}`;
      groups.set(id, { id, label: room.name, floorId: floor.id, floorScopeId, sensorIds: [] });
    }
  }
  for (const sensor of sensors) {
    const floor = house.floors.find((candidate) => candidate.id === sensor.floorId);
    if (!floor) continue;
    const linkedRoom = sensor.roomId
      ? floor.rooms.find((room) => room.id === sensor.roomId)
      : floor.rooms.find((room) => room.name.trim().toLocaleLowerCase() === sensor.room.trim().toLocaleLowerCase());
    const roomKey = linkedRoom?.id ?? `legacy:${sensor.room.trim().toLocaleLowerCase() || "unassigned"}`;
    const id = `room:${floor.id}:${roomKey}`;
    const group = groups.get(id) ?? {
      id,
      label: linkedRoom?.name ?? (sensor.room.trim() || "Unassigned"),
      floorId: floor.id,
      floorScopeId: `floor:${floor.id}`,
      sensorIds: [],
    };
    group.sensorIds.push(sensor.id);
    groups.set(id, group);
  }
  return [...groups.values()].sort((left, right) => left.floorId.localeCompare(right.floorId) || left.label.localeCompare(right.label));
}

function ranked(entries: ThermalIsolationEntry[]): ThermalIsolationEntry[] {
  const order = [...entries]
    .filter((entry) => entry.score !== null)
    .sort((left, right) => (right.score ?? 0) - (left.score ?? 0) || left.scope.label.localeCompare(right.scope.label));
  const ranks = new Map<string, number>();
  let previousScore: number | null = null;
  let currentRank = 0;
  order.forEach((entry, index) => {
    if (previousScore === null || entry.score !== previousScore) currentRank = index + 1;
    ranks.set(entry.scope.id, currentRank);
    previousScore = entry.score;
  });
  return entries.map((entry) => ({ ...entry, rank: ranks.get(entry.scope.id) ?? null }));
}

function buildInsights(entries: ThermalIsolationEntry[]): ThermalIsolationInsight[] {
  const insights: ThermalIsolationInsight[] = [];
  const rooms = entries.filter((entry) => entry.scope.type === "room" && entry.score !== null);
  const floors = entries.filter((entry) => entry.scope.type === "floor" && entry.score !== null);
  const orderedRooms = [...rooms].sort((left, right) => (left.score ?? 0) - (right.score ?? 0));
  const weakestRoom = orderedRooms[0];
  const nextWeakestRoom = orderedRooms[1];
  if (
    weakestRoom?.score !== null
    && weakestRoom?.score !== undefined
    && nextWeakestRoom?.score !== null
    && nextWeakestRoom?.score !== undefined
    && nextWeakestRoom.score > weakestRoom.score
  ) {
    insights.push({ code: "LOWEST_BUFFERING_ROOM", scopeIds: [weakestRoom.scope.id], value: weakestRoom.score, unit: "score-points" });
  }
  if (floors.length > 1) {
    const ordered = [...floors].sort((left, right) => (left.score ?? 0) - (right.score ?? 0));
    const low = ordered[0];
    const high = ordered.at(-1);
    const uniqueLow = ordered.filter((entry) => entry.score === low?.score).length === 1;
    const uniqueHigh = ordered.filter((entry) => entry.score === high?.score).length === 1;
    if (
      low?.score !== null
      && low?.score !== undefined
      && high?.score !== null
      && high?.score !== undefined
      && high.score > low.score
      && uniqueLow
      && uniqueHigh
    ) {
      insights.push({
        code: "FLOOR_CONTRAST",
        scopeIds: [high.scope.id, low.scope.id],
        value: round(high.score - low.score, 1),
        unit: "score-points",
      });
    }
  }
  const largestRoomSpread = [...rooms]
    .filter((entry) => entry.metrics.p90TemperatureSpreadC !== null)
    .sort((left, right) => (right.metrics.p90TemperatureSpreadC ?? 0) - (left.metrics.p90TemperatureSpreadC ?? 0))[0];
  if ((largestRoomSpread?.metrics.p90TemperatureSpreadC ?? 0) >= 0.8) {
    insights.push({
      code: "ROOM_SENSOR_SPREAD",
      scopeIds: [largestRoomSpread!.scope.id],
      value: largestRoomSpread!.metrics.p90TemperatureSpreadC!,
      unit: "celsius",
    });
  }
  const house = entries.find((entry) => entry.scope.type === "house");
  if (house && (house.confidence === "low" || house.confidence === "unavailable" || house.childCoveragePct < 100)) {
    insights.push({
      code: "LIMITED_EVIDENCE",
      scopeIds: [house.scope.id],
      value: house.childCoveragePct,
      unit: "percent",
    });
  }
  return insights;
}

interface PreparedThermalIsolationRun {
  enabledSensors: Sensor[];
  groups: RoomGroup[];
  parentBySensor: Map<string, string>;
  outdoor: PreparedThermalOutdoorBoundary;
}

function prepareThermalIsolationRun(input: ThermalIsolationInput): PreparedThermalIsolationRun {
  const sensorsWithTemperatureSamples = new Set(
    [...input.indoorSamplesBySensor.entries()].flatMap(([sensorId, samples]) =>
      samples.some((sample) => sample.metric === "temperature") ? [sensorId] : []),
  );
  const enabledSensors = input.sensors.filter((sensor) =>
    sensor.enabled
    && sensor.houseId === input.house.id
    && isThermalIsolationTemperatureSensor(sensor, sensorsWithTemperatureSamples.has(sensor.id)));
  const groups = roomGroups(input.house, enabledSensors);
  const parentBySensor = new Map(groups.flatMap((group) => group.sensorIds.map((sensorId) => [sensorId, group.id] as const)));
  return {
    enabledSensors,
    groups,
    parentBySensor,
    outdoor: prepareThermalOutdoorBoundary(input.outdoorSamples),
  };
}

async function prepareAsyncSpreadResolver(
  input: ThermalIsolationInput,
  prepared: PreparedThermalIsolationRun,
  options: ThermalIsolationAsyncOptions,
): Promise<(sensorIds: string[]) => ThermalSpreadMetrics> {
  const work: CooperativeAggregationWork = {
    ...(options.signal ? { signal: options.signal } : {}),
    yieldEverySamples: positiveBatchSize(options.yieldEveryAggregationSamples, 1_024),
    samplesSinceYield: 0,
  };
  await yieldAggregationWork(work, true);
  const spreadInput = await prepareThermalSpreadAsync(
    input,
    prepared.enabledSensors.map((sensor) => sensor.id),
    work,
  );
  const floorSensorIds = input.house.floors.map((floor) => unique(
    prepared.groups
      .filter((group) => group.floorId === floor.id)
      .flatMap((group) => group.sensorIds),
  ));
  const scopeSensorIds = [
    ...prepared.groups.map((group) => group.sensorIds),
    ...floorSensorIds,
    unique(floorSensorIds.flat()),
  ];
  const spreadCache = new Map<string, ThermalSpreadMetrics>();
  for (const sensorIds of scopeSensorIds) {
    const key = spreadCacheKey(sensorIds);
    if (spreadCache.has(key)) continue;
    spreadCache.set(key, await synchronizedPreparedSpreadAsync(sensorIds, spreadInput, work));
  }
  await yieldAggregationWork(work, true);
  return (sensorIds) => {
    const spread = spreadCache.get(spreadCacheKey(sensorIds));
    if (!spread) throw new Error("Prepared thermal spread is missing for an isolation scope");
    return spread;
  };
}

function completeThermalIsolation(
  input: ThermalIsolationInput,
  groups: RoomGroup[],
  entriesForSensors: ThermalIsolationEntry[],
  spreadForSensorIds?: (sensorIds: string[]) => ThermalSpreadMetrics,
): ThermalIsolationResult {
  const sensorEntries = ranked(entriesForSensors);
  const sensorEntryById = new Map(sensorEntries.map((entry) => [entry.scope.sensorIds[0]!, entry]));

  let roomEntries = groups.map((group) => aggregateEntry(
    {
      type: "room",
      id: group.id,
      label: group.label,
      parentId: group.floorScopeId,
      floorId: group.floorId,
      sensorIds: [...group.sensorIds],
    },
    group.sensorIds.flatMap((sensorId) => {
      const entry = sensorEntryById.get(sensorId);
      return entry ? [entry] : [];
    }),
    group.sensorIds,
    input.indoorSamplesBySensor,
    spreadForSensorIds?.(group.sensorIds),
  ));
  roomEntries = ranked(roomEntries);

  let floorEntries = input.house.floors.map((floor) => {
    const children = roomEntries.filter((entry) => entry.scope.floorId === floor.id);
    const sensorIds = unique(children.flatMap((entry) => entry.scope.sensorIds));
    return aggregateEntry(
      {
        type: "floor",
        id: `floor:${floor.id}`,
        label: floor.name,
        parentId: `house:${input.house.id}`,
        floorId: floor.id,
        sensorIds,
      },
      children,
      sensorIds,
      input.indoorSamplesBySensor,
      spreadForSensorIds?.(sensorIds),
    );
  });
  floorEntries = ranked(floorEntries);

  const houseSensorIds = unique(floorEntries.flatMap((entry) => entry.scope.sensorIds));
  const houseEntry = aggregateEntry(
    {
      type: "house",
      id: `house:${input.house.id}`,
      label: input.house.name,
      sensorIds: houseSensorIds,
    },
    floorEntries,
    houseSensorIds,
    input.indoorSamplesBySensor,
    spreadForSensorIds?.(houseSensorIds),
  );
  houseEntry.rank = houseEntry.score === null ? null : 1;

  const houseScore = houseEntry.score;
  const entries = [houseEntry, ...floorEntries, ...roomEntries, ...sensorEntries].map((entry) => ({
    ...entry,
    comparedWithHousePoints: houseScore === null || entry.score === null ? null : round(entry.score - houseScore, 1),
  }));

  return {
    generatedAt: input.generatedAt ?? new Date().toISOString(),
    systemVersion: SYSTEM_VERSION,
    houseId: input.house.id,
    from: input.from,
    to: input.to,
    entries,
    insights: buildInsights(entries),
    methodology: {
      scoreMethod: "modeled-24h-retention-v1",
      aggregationMethod: "median-child-score-v1",
      interpretation: "Higher scores mean the fitted indoor temperature changes more slowly after an outdoor temperature step.",
      limitations: [
        "Periods without verified heat-pump-off evidence are excluded when a tracked heat pump exists; other heating, ventilation, solar gains, occupants, appliances, and sensor placement remain mixed into the fit.",
        "It is a comparative empirical indicator, not a wall U-value, airtightness result, energy rating, or building-code assessment.",
        "Floor and house values are medians of child scopes so one heavily instrumented room does not dominate the result.",
      ],
      ...(input.hvacExclusion ? { hvacExclusion: input.hvacExclusion } : {}),
    },
  };
}

export function runThermalIsolation(input: ThermalIsolationInput): ThermalIsolationResult {
  const prepared = prepareThermalIsolationRun(input);
  const sensorEntries = prepared.enabledSensors.map((sensor) => sensorEntry(
    input,
    sensor,
    prepared.parentBySensor.get(sensor.id) ?? `floor:${sensor.floorId}`,
    prepared.outdoor,
  ));
  return completeThermalIsolation(input, prepared.groups, sensorEntries);
}

export interface ThermalIsolationAsyncOptions {
  signal?: AbortSignal;
  yieldEvery?: number;
  yieldEveryAggregationSamples?: number;
}

export async function runThermalIsolationAsync(
  input: ThermalIsolationInput,
  options: ThermalIsolationAsyncOptions = {},
): Promise<ThermalIsolationResult> {
  options.signal?.throwIfAborted();
  await new Promise<void>((resolve) => setImmediate(resolve));
  options.signal?.throwIfAborted();
  const prepared = prepareThermalIsolationRun(input);
  const sensorEntries: ThermalIsolationEntry[] = [];
  const yieldEvery = positiveBatchSize(options.yieldEvery, 1);
  for (let index = 0; index < prepared.enabledSensors.length; index += 1) {
    if (index % yieldEvery === 0) {
      await new Promise<void>((resolve) => setImmediate(resolve));
    }
    options.signal?.throwIfAborted();
    const sensor = prepared.enabledSensors[index];
    if (!sensor) continue;
    sensorEntries.push(await sensorEntryAsync(
      input,
      sensor,
      prepared.parentBySensor.get(sensor.id) ?? `floor:${sensor.floorId}`,
      prepared.outdoor,
      options.signal,
    ));
  }
  options.signal?.throwIfAborted();
  const spreadForSensorIds = await prepareAsyncSpreadResolver(input, prepared, options);
  options.signal?.throwIfAborted();
  return completeThermalIsolation(input, prepared.groups, sensorEntries, spreadForSensorIds);
}
