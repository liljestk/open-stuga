import type {
  AnalyticsQueryRequest,
  AnalyticsQueryResponse,
  HomePerformanceLimitation,
  HomePerformanceResponse,
  House,
  MeasurementDefinition,
  Sensor,
} from "@climate-twin/contracts";
import { HOME_PERFORMANCE_ALGORITHM_VERSION, withSignal } from "@climate-twin/contracts";
import type { ClimateDatabase } from "../../db.js";
import { outdoorLocationKey } from "../../db.js";
import {
  IncompleteTelemetryHistoryError,
  type HybridTelemetryReader,
} from "../../timeseries/read-facade.js";
import { executeAnalyticsQuery } from "../query/execute.js";
import { deriveHomePerformance } from "./derive.js";
import { HEAT_PUMP_SENSOR_TAG } from "../../heat-pump-measurements.js";
import {
  isPassiveHeatPumpTime,
  loadHeatPumpExclusionWindow,
  withHeatPumpPointCounts,
} from "../heat-pump-evidence.js";

const DAY_MS = 86_400_000;
const PERFORMANCE_DAYS = 30;
const RECOVERY_DAYS = 7;
const OUTDOOR_LIMIT = 10_000;
const OPENING_LIMIT = 10_000;
const ACTION_RUN_LIMIT = 500;

export const MAX_HOME_PERFORMANCE_SENSORS = 80;
export const MAX_HOME_PERFORMANCE_EVIDENCE_POINTS = 500_000;
export const MAX_HOME_PERFORMANCE_BATCH_POINTS = 100_000;
export const MAX_HOME_PERFORMANCE_RESPONSE_BYTES = 1_000_000;

export class HomePerformanceScopeError extends Error {
  readonly code = "HOME_PERFORMANCE_SCOPE_TOO_LARGE";

  constructor(message: string) {
    super(message);
    this.name = "HomePerformanceScopeError";
  }
}

export interface HomePerformanceServiceInput {
  house: House;
  sensors: readonly Sensor[];
  definitions: readonly MeasurementDefinition[];
  dataMode: "live" | "demo";
  database: ClimateDatabase;
  telemetryReader: HybridTelemetryReader;
  heatPumpConnectionIds: readonly string[];
  evaluatedAt: string;
  signal?: AbortSignal;
}

function pointCount(
  start: string,
  end: string,
  resolution: "15m" | "1h",
): number {
  const bucketMs = resolution === "15m" ? 15 * 60_000 : 3_600_000;
  return Math.ceil((Date.parse(end) - Date.parse(start)) / bucketMs);
}

function queryRequest(input: {
  house: House;
  sensors: readonly Sensor[];
  metrics: readonly string[];
  dataMode: "live" | "demo";
  start: string;
  end: string;
  resolution: "15m" | "1h";
  requestId: string;
}): AnalyticsQueryRequest {
  return {
    apiVersion: "1.0",
    dataMode: input.dataMode,
    scope: {
      kind: "house",
      id: input.house.id,
      entityIds: input.sensors.map((sensor) => sensor.id),
    },
    measurementIds: [...input.metrics],
    range: {
      start: input.start,
      end: input.end,
      timezone: input.house.timezone,
    },
    resolution: input.resolution,
    aggregation: "default",
    qualityFilter: { include: ["good", "estimated"] },
    include: ["series", "summary", "quality", "provenance"],
    maxPointsPerSeries: 1_000,
    requestId: input.requestId,
  };
}

function combineAnalytics(
  responses: readonly AnalyticsQueryResponse[],
  requestId: string,
): AnalyticsQueryResponse | null {
  const first = responses[0];
  if (!first) return null;
  const series = responses.flatMap((response) => response.series);
  const summaries = responses.flatMap((response) => response.summaries);
  const pointCount = series.reduce((sum, item) => sum + item.points.length, 0);
  const coverage = pointCount === 0
    ? 0
    : series.reduce((sum, item) => (
        sum + item.points.reduce((pointSum, point) => pointSum + point.coverage, 0)
      ), 0) / pointCount;
  return {
    ...first,
    requestId,
    series,
    summaries,
    quality: {
      coverage,
      seriesCount: series.length,
      sampleCount: summaries.reduce((sum, summary) => sum + summary.count, 0),
      excludedSampleCount: responses.reduce(
        (sum, response) => sum + response.quality.excludedSampleCount,
        0,
      ),
      includedQualities: ["good", "estimated"],
      lowCoverageSeries: summaries.filter((summary) => summary.coverage < 0.75).length,
    },
    provenance: [
      ...new Map(
        responses.flatMap((response) => response.provenance)
          .map((item) => [JSON.stringify(item), item]),
      ).values(),
    ],
    warnings: responses.flatMap((response) => response.warnings),
  };
}

async function analyticsEvidence(input: {
  service: HomePerformanceServiceInput;
  sensors: readonly Sensor[];
  definitions: readonly MeasurementDefinition[];
  start: string;
  end: string;
  resolution: "15m" | "1h";
  key: string;
}): Promise<AnalyticsQueryResponse | null> {
  input.service.signal?.throwIfAborted();
  if (input.sensors.length === 0 || input.definitions.length === 0) return null;
  const buckets = pointCount(input.start, input.end, input.resolution);
  const pointsPerSensor = buckets * input.definitions.length;
  const batchSize = Math.max(
    1,
    Math.floor(MAX_HOME_PERFORMANCE_BATCH_POINTS / Math.max(1, pointsPerSensor)),
  );
  const batches: Sensor[][] = [];
  for (let index = 0; index < input.sensors.length; index += batchSize) {
    batches.push(input.sensors.slice(index, index + batchSize));
  }
  const responses: AnalyticsQueryResponse[] = [];
  for (const [index, sensors] of batches.entries()) {
    input.service.signal?.throwIfAborted();
    responses.push(await executeAnalyticsQuery({
      request: queryRequest({
        house: input.service.house,
        sensors,
        metrics: input.definitions.map((definition) => definition.id),
        dataMode: input.service.dataMode,
        start: input.start,
        end: input.end,
        resolution: input.resolution,
        requestId: `${input.key}-${index + 1}`,
      }),
      sensors,
      definitions: input.definitions,
      telemetryReader: input.service.telemetryReader,
      generatedAt: input.service.evaluatedAt,
      ...withSignal(input.service.signal),
    }));
  }
  input.service.signal?.throwIfAborted();
  return combineAnalytics(responses, input.key);
}

async function settled<T>(
  task: () => Promise<T>,
  signal?: AbortSignal,
): Promise<PromiseSettledResult<T>> {
  try {
    return { status: "fulfilled", value: await task() };
  } catch (reason) {
    // Evidence outages are intentionally downgraded to warnings, but a
    // cancellation is control flow: swallowing it would let a stopped job
    // derive and publish a partial "successful" artifact.
    signal?.throwIfAborted();
    if (reason instanceof Error && reason.name === "AbortError") throw reason;
    return { status: "rejected", reason };
  }
}

function warningFor(error: unknown, source: string) {
  if (error instanceof IncompleteTelemetryHistoryError) {
    return {
      code: "TELEMETRY_ARCHIVE_REQUIRED",
      message: `${source} history is temporarily incomplete.`,
      details: { source, archiveState: error.archiveState },
    };
  }
  return {
    code: "HOME_PERFORMANCE_EVIDENCE_UNAVAILABLE",
    message: `${source} evidence could not be processed.`,
    details: { source },
  };
}

function archiveState(responses: readonly (AnalyticsQueryResponse | null)[]) {
  const states = responses.flatMap((response) => (
    response?.provenance.map((item) => item.archiveState) ?? []
  ));
  if (states.includes("failed")) return "failed" as const;
  if (states.includes("not-ready")) return "not-ready" as const;
  if (states.includes("merged")) return "merged" as const;
  return "not-configured" as const;
}

export async function getHomePerformance(
  input: HomePerformanceServiceInput,
): Promise<HomePerformanceResponse> {
  input.signal?.throwIfAborted();
  const sensors = [...input.sensors]
    .filter((sensor) => sensor.enabled && !sensor.tags.includes(HEAT_PUMP_SENSOR_TAG))
    .sort((left, right) => left.id.localeCompare(right.id));
  if (sensors.length > MAX_HOME_PERFORMANCE_SENSORS) {
    throw new HomePerformanceScopeError(
      `Home Performance supports at most ${MAX_HOME_PERFORMANCE_SENSORS} visible enabled sensors`,
    );
  }
  const definitions = input.definitions.filter((definition) => definition.enabled);
  const byId = new Map(definitions.map((definition) => [definition.id, definition]));
  const climateDefinitions = ["temperature", "humidity", "co2"]
    .flatMap((id) => byId.has(id) ? [byId.get(id)!] : []);
  const energyDefinitions = ["energy", "power"]
    .flatMap((id) => byId.has(id) ? [byId.get(id)!] : []);
  const to = input.evaluatedAt;
  const from = new Date(Date.parse(to) - PERFORMANCE_DAYS * DAY_MS).toISOString();
  const recoveryFrom = new Date(Date.parse(to) - RECOVERY_DAYS * DAY_MS).toISOString();
  const heatPumpWindow = loadHeatPumpExclusionWindow(
    input.database,
    input.house.id,
    recoveryFrom,
    to,
    input.heatPumpConnectionIds,
  );
  const projectedPoints = sensors.length * (
    pointCount(from, to, "1h") * (climateDefinitions.length + energyDefinitions.length)
    + pointCount(recoveryFrom, to, "15m") * climateDefinitions.length
  );
  if (projectedPoints > MAX_HOME_PERFORMANCE_EVIDENCE_POINTS) {
    throw new HomePerformanceScopeError(
      `Home Performance would exceed ${MAX_HOME_PERFORMANCE_EVIDENCE_POINTS} evidence points`,
    );
  }

  const [climateEvidence, recoveryEvidence] = await Promise.all([
    settled(() => analyticsEvidence({
      service: input,
      sensors,
      definitions: climateDefinitions,
      start: from,
      end: to,
      resolution: "1h",
      key: `home-performance-climate-${input.house.id}`,
    }), input.signal),
    settled(() => analyticsEvidence({
      service: input,
      sensors,
      definitions: climateDefinitions,
      start: recoveryFrom,
      end: to,
      resolution: "15m",
      key: `home-performance-recovery-${input.house.id}`,
    }), input.signal),
  ]);
  input.signal?.throwIfAborted();
  const [energyEvidence, outdoorEvidence] = await Promise.all([
    settled(() => analyticsEvidence({
      service: input,
      sensors,
      definitions: energyDefinitions,
      start: from,
      end: to,
      resolution: "1h",
      key: `home-performance-energy-${input.house.id}`,
    }), input.signal),
    settled(() => input.house.location
      ? input.telemetryReader.outdoorTemperatureHistory({
          houseId: input.house.id,
          locationKey: outdoorLocationKey(input.house.location),
          from,
          to,
          limit: OUTDOOR_LIMIT,
          ...withSignal(input.signal),
        })
      : Promise.resolve(null), input.signal),
  ]);
  input.signal?.throwIfAborted();
  const openingsEvidence = await settled(() => Promise.all([
      input.telemetryReader.openingStateSnapshot({
        houseId: input.house.id,
        at: recoveryFrom,
        limit: OPENING_LIMIT,
        ...withSignal(input.signal),
      }),
      input.telemetryReader.openingStateHistory({
        houseId: input.house.id,
        from: recoveryFrom,
        to,
        limit: OPENING_LIMIT,
        ...withSignal(input.signal),
      }),
    ]), input.signal);
  input.signal?.throwIfAborted();
  // Named, so each failed read's warning names the source it came from.
  const evidence = {
    climate: climateEvidence,
    recovery: recoveryEvidence,
    energy: energyEvidence,
    outdoor: outdoorEvidence,
    openings: openingsEvidence,
  };
  const warnings: HomePerformanceResponse["warnings"] = Object.entries(evidence).flatMap(([source, result]) => (
    result.status === "rejected" ? [warningFor(result.reason, source)] : []
  ));
  const fulfilled = <T>(result: PromiseSettledResult<T>): T | null => (
    result.status === "fulfilled" ? result.value : null
  );
  const climate = fulfilled(evidence.climate);
  const recovery = fulfilled(evidence.recovery);
  const energy = fulfilled(evidence.energy);
  const outdoorRead = fulfilled(evidence.outdoor);
  const openingReads = fulfilled(evidence.openings);
  const truncated = (source: string, label: string, limit: number) => warnings.push({
    code: "HOME_PERFORMANCE_EVIDENCE_TRUNCATED",
    message: `${label} evidence reached its server limit.`,
    details: { source, limit },
  });
  const recoveryPoints = recovery?.series.flatMap((series) => series.points
    .filter((point) => point.value !== null && Number.isFinite(point.value))) ?? [];
  const retainedRecoveryPoints = recoveryPoints.filter((point) => (
    isPassiveHeatPumpTime(heatPumpWindow, point.timestamp)
  ));
  const hvacExclusion = withHeatPumpPointCounts(
    heatPumpWindow,
    recoveryPoints.length,
    retainedRecoveryPoints.length,
  );
  const outdoorTruncated = (outdoorRead?.records.length ?? 0) >= OUTDOOR_LIMIT;
  const openingTruncated = Boolean(
    openingReads
    && (openingReads[0].records.length >= OPENING_LIMIT
      || openingReads[1].records.length >= OPENING_LIMIT),
  );
  if (outdoorTruncated) truncated("outdoor", "Outdoor", OUTDOOR_LIMIT);
  if (openingTruncated) truncated("openings", "Opening", OPENING_LIMIT);
  const openings = openingReads && !openingTruncated
    ? [...new Map(
        [...openingReads[0].records, ...openingReads[1].records]
          .map((observation) => [observation.id, observation]),
      ).values()]
    : [];
  const actionRuns = input.database.listActionRuns({
    houseId: input.house.id,
    limit: ACTION_RUN_LIMIT,
  });
  if (actionRuns.length >= ACTION_RUN_LIMIT) truncated("actions", "Action", ACTION_RUN_LIMIT);
  const result = deriveHomePerformance({
    house: input.house,
    sensors,
    definitions,
    climate,
    recoveryClimate: recovery,
    energy,
    outdoor: outdoorTruncated ? [] : outdoorRead?.records ?? [],
    openings,
    actionRuns: actionRuns.length >= ACTION_RUN_LIMIT ? [] : actionRuns,
    maintenanceTasks: input.database.listMaintenanceTasks({
      houseId: input.house.id,
      limit: 500,
    }),
    observations: input.database.listObservations(input.house.id),
    from,
    to,
    generatedAt: input.evaluatedAt,
    hvacPassiveIntervals: heatPumpWindow.passiveIntervals,
    parameters: input.database.listParameters(input.house.id),
  });
  input.signal?.throwIfAborted();
  const limitations = result.limitations.filter((item): item is HomePerformanceLimitation => (
    item !== "sensor-scope-limited" && item !== "evidence-scope-limited"
  ));
  const state = archiveState([climate, recovery, energy]);
  const response: HomePerformanceResponse = {
    apiVersion: "1.0",
    houseId: input.house.id,
    dataMode: input.dataMode,
    status: result.status,
    generatedAt: result.generatedAt,
    evaluatedAt: input.evaluatedAt,
    from,
    to,
    recoveryFrom,
    complete: warnings.length === 0,
    exposure: result.exposure,
    recovery: result.recovery,
    openingEffectiveness: result.openingEffectiveness,
    energy: result.energy,
    maintenance: result.maintenance,
    sensorHealth: result.sensorHealth,
    limitations,
    warnings,
    hvacExclusion,
    provenance: {
      truthClass: "derived",
      algorithmKey: "home-performance",
      algorithmVersion: HOME_PERFORMANCE_ALGORITHM_VERSION,
      evaluatedAt: input.evaluatedAt,
      sourceIds: result.provenance.sourceIds,
      archiveState: state,
      archiveStates: result.provenance.archiveStates,
    },
    cache: {
      hit: false,
      coalesced: false,
      keyVersion: "home-performance-v1",
      ttlSeconds: 60,
    },
  };
  if (Buffer.byteLength(JSON.stringify(response), "utf8") > MAX_HOME_PERFORMANCE_RESPONSE_BYTES) {
    throw new HomePerformanceScopeError("Home Performance response exceeds the server byte limit");
  }
  return response;
}
