import type {
  DataMode,
  DerivedAnalyticsWarning,
  HomeInsight,
  HomeInsightEvidence,
  HomeMonitoringBlocker,
  HomeMonitoringCollectionResponse,
  HomeMonitoringDetailResponse,
  HomeMonitoringEvidenceSource,
  HomeMonitoringSummary,
  House,
  HouseWeather,
  IntegrationStatus,
  MeasurementSample,
  Sensor,
} from "@climate-twin/contracts";
import { HOME_MONITORING_ALGORITHM_VERSION, withSignal } from "@climate-twin/contracts";
import type { ClimateDatabase } from "../../db.js";
import type { HybridTelemetryReader } from "../../timeseries/read-facade.js";
import { deriveHomeMonitoringDraft, type HomeMonitoringDraftBlocker } from "./derive.js";
import { deriveHomePulse } from "./insights.js";
import { coverageFreshnessForSample, HOME_INSIGHT_THRESHOLDS, type DerivedInsight, type LatestMeasurements, type MeasurementHistory, HOME_INSIGHT_ADVISORY } from "./model.js";
import { HEAT_PUMP_SENSOR_TAG } from "../../heat-pump-measurements.js";

const HISTORY_BUCKET_MINUTES = 5;
const HISTORY_LIMIT_PER_METRIC = 100;
const HISTORY_METRICS = ["temperature", "humidity", "co2"] as const;

function ambientSensor(sensor: Sensor): boolean {
  return sensor.enabled && !sensor.tags.includes(HEAT_PUMP_SENSOR_TAG);
}

export interface HomeMonitoringServiceContext {
  database: ClimateDatabase;
  latestMeasurements(houseId: string): readonly MeasurementSample[];
  integrationStatus(houseId: string): IntegrationStatus;
  latestWeather(houseId: string): HouseWeather | null;
  dataMode: DataMode;
  evaluatedAt: string;
  measurementHistory?: MeasurementHistory;
  warnings?: readonly DerivedAnalyticsWarning[];
}

export interface HomeMonitoringScope {
  house: House;
  sensors: readonly Sensor[];
}

interface SharedAlertEvidence {
  rules: ReturnType<ClimateDatabase["listAlertRules"]>;
  alerts: ReturnType<ClimateDatabase["listAlertEvents"]>;
}

function latestMap(samples: readonly MeasurementSample[]): LatestMeasurements {
  const result: LatestMeasurements = {};
  for (const sample of samples) {
    const current = result[sample.sensorId]?.[sample.metric];
    if (current && Date.parse(current.timestamp) > Date.parse(sample.timestamp)) continue;
    result[sample.sensorId] = { ...(result[sample.sensorId] ?? {}), [sample.metric]: sample };
  }
  return result;
}

function historyFromSamples(samples: readonly MeasurementSample[]): MeasurementHistory {
  const history: MeasurementHistory = {};
  for (const sample of samples) {
    const current = history[sample.sensorId]?.[sample.metric] ?? [];
    history[sample.sensorId] = {
      ...(history[sample.sensorId] ?? {}),
      [sample.metric]: [...current, sample],
    };
  }
  for (const metrics of Object.values(history)) {
    for (const [metric, samples] of Object.entries(metrics)) {
      metrics[metric] = samples
        .sort((left, right) => left.timestamp.localeCompare(right.timestamp))
        .slice(-HISTORY_LIMIT_PER_METRIC);
    }
  }
  return history;
}

export async function loadHomeMonitoringHistory(input: {
  database: ClimateDatabase;
  telemetryReader: HybridTelemetryReader;
  scope: HomeMonitoringScope;
  evaluatedAt: string;
  signal?: AbortSignal;
}): Promise<MeasurementHistory> {
  const sensors = input.scope.sensors.filter(ambientSensor);
  if (sensors.length === 0) return {};
  const from = new Date(
    Date.parse(input.evaluatedAt) - HOME_INSIGHT_THRESHOLDS.trendWindowMinutes * 60_000,
  ).toISOString();
  const rollup = await input.telemetryReader.measurementAnalyticsRollup({
    series: sensors.flatMap((sensor) => HISTORY_METRICS.map((metric) => ({
      sensorId: sensor.id,
      metric,
      aggregation: "mean" as const,
    }))),
    from,
    to: input.evaluatedAt,
    resolution: "5m",
    qualities: ["good", "estimated", "stale"],
    ...withSignal(input.signal),
  });
  if (rollup) {
    const history: MeasurementHistory = {};
    for (const series of rollup.result.series) {
      const samples = series.buckets.slice(-HISTORY_LIMIT_PER_METRIC).flatMap((bucket) => (
        bucket.value === null ? [] : [{
          sensorId: series.sensorId,
          metric: series.metric,
          value: bucket.value,
          canonicalUnit: series.canonicalUnit,
          timestamp: bucket.bucketStart,
          source: "api" as const,
          quality: bucket.sampleCount > 1
            ? "estimated" as const
            : bucket.staleSampleCount > 0
              ? "stale" as const
              : bucket.estimatedSampleCount > 0
                ? "estimated" as const
                : "good" as const,
        }]
      ));
      if (samples.length === 0) continue;
      history[series.sensorId] = {
        ...(history[series.sensorId] ?? {}),
        [series.metric]: samples,
      };
    }
    return history;
  }

  return historyFromSamples(input.database.measurementHistoryBucketedMulti(
    sensors.map((sensor) => sensor.id),
    [...HISTORY_METRICS],
    from,
    input.evaluatedAt,
    HISTORY_BUCKET_MINUTES * 60,
    HISTORY_LIMIT_PER_METRIC,
  ));
}

function evidence(
  context: HomeMonitoringServiceContext,
  scope: HomeMonitoringScope,
  includeHistory: boolean,
  sharedAlerts?: SharedAlertEvidence,
) {
  const sensors = scope.sensors.filter(ambientSensor);
  const sensorIds = new Set(sensors.map((sensor) => sensor.id));
  const rules = (sharedAlerts?.rules ?? context.database.listAlertRules())
    .filter((rule) => rule.sensorId === null || sensorIds.has(rule.sensorId));
  const alerts = (sharedAlerts?.alerts ?? context.database.listAlertEvents(2_000, true))
    .filter((alert) => sensorIds.has(alert.sensorId));
  const weather = context.latestWeather(scope.house.id);
  return {
    house: scope.house,
    sensors,
    latestMeasurements: latestMap(
      context.latestMeasurements(scope.house.id)
        .filter((sample) => sensorIds.has(sample.sensorId)),
    ),
    ...(includeHistory ? { measurementHistory: context.measurementHistory ?? {} } : {}),
    alerts,
    alertRules: rules,
    integration: context.integrationStatus(scope.house.id),
    outdoor: weather
      ? {
          current: weather.current,
          stale: weather.stale,
          warnings: weather.warnings,
        }
      : null,
    referenceTime: context.evaluatedAt,
  };
}

function blocker(blocker: HomeMonitoringDraftBlocker): HomeMonitoringBlocker {
  return {
    id: blocker.id,
    kind: blocker.kind,
    code: `monitoring.blocker.${blocker.kind}`,
    parameters: { count: blocker.count },
    fallbackMessage: blocker.summary,
    count: blocker.count,
    sensorIds: blocker.sensorIds,
    evidenceAt: blocker.evidenceAt,
    acknowledged: blocker.acknowledged,
  };
}

function evidenceSample(
  input: ReturnType<typeof evidence>,
  item: DerivedInsight["evidence"][number],
): MeasurementSample | undefined {
  if (!item.sensorId || !item.metric || !item.observedAt) return undefined;
  const latest = input.latestMeasurements[item.sensorId]?.[item.metric];
  if (latest?.timestamp === item.observedAt) return latest;
  return input.measurementHistory?.[item.sensorId]?.[item.metric]
    ?.find((sample) => sample.timestamp === item.observedAt);
}

function insightEvidence(
  input: ReturnType<typeof evidence>,
  item: DerivedInsight["evidence"][number],
  nowMs: number,
): HomeInsightEvidence {
  const sample = evidenceSample(input, item);
  return sample ? {
    ...item,
    source: sample.source,
    quality: sample.quality,
    freshness: coverageFreshnessForSample(sample, nowMs),
  } : item;
}

function insight(item: DerivedInsight, input: ReturnType<typeof evidence>, evaluatedAt: string): HomeInsight {
  return {
    id: item.id,
    rank: item.rank,
    kind: item.kind,
    severity: item.severity,
    priority: item.priority,
    titleCode: `monitoring.insight.${item.kind}.title`,
    summaryCode: `monitoring.insight.${item.kind}.summary`,
    actionCode: `monitoring.insight.${item.kind}.action`,
    parameters: {
      room: item.target.room ?? null,
      sensorName: item.target.sensorName ?? null,
      priority: item.priority,
      ...item.parameters,
    },
    fallbackTitle: item.title,
    fallbackSummary: item.summary,
    fallbackAction: item.action,
    target: item.target,
    evidence: item.evidence.map((entry) => insightEvidence(input, entry, Date.parse(evaluatedAt))),
    freshness: item.freshness,
    confidence: {
      level: item.confidence.level,
      score: item.confidence.score,
      reasonCode: `monitoring.confidence.${item.confidence.level}`,
      fallbackReason: item.confidence.reason,
    },
    ...(item.safetyNote ? { safetyNote: item.safetyNote } : {}),
  };
}

function summaryFrom(
  input: ReturnType<typeof evidence>,
): HomeMonitoringSummary {
  const result = deriveHomeMonitoringDraft(input);
  return {
    houseId: result.houseId,
    generatedAt: result.generatedAt,
    status: result.status,
    pulseStatus: result.pulseStatus,
    coverage: result.coverage,
    activeAlertCount: result.activeAlertCount,
    blockers: result.blockers.map(blocker),
  };
}

function latestEvidenceSamples(input: ReturnType<typeof evidence>): MeasurementSample[] {
  const enabled = new Set(input.sensors.filter(ambientSensor).map((sensor) => sensor.id));
  return Object.values(input.latestMeasurements).flatMap((metrics) => Object.values(metrics))
    .filter((sample): sample is MeasurementSample => Boolean(sample && enabled.has(sample.sensorId)));
}

function monitoringWarnings(summaries: readonly HomeMonitoringSummary[]): DerivedAnalyticsWarning[] {
  const totals = summaries.reduce((result, summary) => ({
    noSensors: result.noSensors + (summary.coverage.enabledSensors === 0 ? 1 : 0),
    missing: result.missing + summary.coverage.sensorsWithoutData,
    stale: result.stale + summary.coverage.staleSensors,
    aging: result.aging + summary.coverage.agingSensors,
    estimated: result.estimated + summary.coverage.estimatedSensors,
    disconnected: result.disconnected + summary.blockers
      .filter((item) => item.kind === "source-disconnected")
      .reduce((sum, item) => sum + item.count, 0),
  }), { noSensors: 0, missing: 0, stale: 0, aging: 0, estimated: 0, disconnected: 0 });
  const warnings: DerivedAnalyticsWarning[] = [];
  const add = (code: string, message: string, count: number) => {
    if (count > 0) warnings.push({ code, message, details: { count } });
  };
  add(
    "monitoring.no-enabled-sensors",
    "One or more Homes have no enabled sensors and were not evaluated from measurements.",
    totals.noSensors,
  );
  add("monitoring.missing-evidence", "Some enabled sensors have no usable evidence.", totals.missing);
  add("monitoring.stale-evidence", "Some evidence is stale and cannot support a current all-clear.", totals.stale);
  add("monitoring.aging-evidence", "Some evidence is aging and should be confirmed.", totals.aging);
  add("monitoring.estimated-evidence", "Some evidence is estimated rather than directly observed.", totals.estimated);
  add("monitoring.source-disconnected", "Some configured measurement sources are disconnected.", totals.disconnected);
  return warnings;
}

function envelope(
  context: HomeMonitoringServiceContext,
  inputs: readonly ReturnType<typeof evidence>[],
  summaries: readonly HomeMonitoringSummary[],
) {
  const samples = inputs.flatMap(latestEvidenceSamples);
  const evidenceSources = samples
    .map((sample): HomeMonitoringEvidenceSource => ({
      sensorId: sample.sensorId,
      metric: sample.metric,
      observedAt: sample.timestamp,
      source: sample.source,
      quality: sample.quality,
      freshness: coverageFreshnessForSample(sample, Date.parse(context.evaluatedAt)),
    }))
    .sort((left, right) => left.sensorId.localeCompare(right.sensorId)
      || left.metric.localeCompare(right.metric)
      || left.observedAt.localeCompare(right.observedAt));
  const warnings = [...monitoringWarnings(summaries), ...(context.warnings ?? [])];
  const enabledSensorCount = summaries.reduce((sum, summary) => sum + summary.coverage.enabledSensors, 0);
  const completeness = enabledSensorCount === 0 || evidenceSources.length === 0
    ? "unavailable" as const
    : warnings.length > 0
      ? "partial" as const
      : "complete" as const;
  return {
    apiVersion: "1.0" as const,
    dataMode: context.dataMode,
    algorithm: {
      key: "home-monitoring" as const,
      version: HOME_MONITORING_ALGORITHM_VERSION as typeof HOME_MONITORING_ALGORITHM_VERSION,
    },
    generatedAt: context.evaluatedAt,
    evaluatedAt: context.evaluatedAt,
    completeness,
    warnings,
    provenance: {
      algorithmKey: "home-monitoring",
      algorithmVersion: HOME_MONITORING_ALGORITHM_VERSION,
      evaluatedAt: context.evaluatedAt,
      sourceIds: [...new Set(evidenceSources.map((item) => item.sensorId))],
    },
    evidenceSources,
  };
}

export function getHomeMonitoringCollection(
  context: HomeMonitoringServiceContext,
  scopes: readonly HomeMonitoringScope[],
): HomeMonitoringCollectionResponse {
  const ordered = [...scopes].sort((left, right) => left.house.id.localeCompare(right.house.id));
  const sharedAlerts: SharedAlertEvidence = {
    rules: context.database.listAlertRules(),
    alerts: context.database.listAlertEvents(2_000, true),
  };
  const inputs = ordered.map((scope) => evidence(context, scope, false, sharedAlerts));
  const summaries = inputs.map(summaryFrom);
  return {
    ...envelope(context, inputs, summaries),
    houses: summaries,
  };
}

export function getHomeMonitoringDetail(
  context: HomeMonitoringServiceContext,
  scope: HomeMonitoringScope,
): HomeMonitoringDetailResponse {
  const collected = evidence(context, scope, true);
  const pulse = deriveHomePulse(collected);
  const summary = summaryFrom(collected);
  return {
    ...envelope(context, [collected], [summary]),
    house: summary,
    sensorCoverage: pulse.sensorCoverage,
    insights: pulse.insights.map((item) => insight(item, collected, context.evaluatedAt)),
    advisoryCode: "monitoring.advisory",
    fallbackAdvisory: HOME_INSIGHT_ADVISORY,
  };
}
