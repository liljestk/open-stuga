import type {
  DataMode,
  HomeInsight,
  HomeMonitoringBlocker,
  HomeMonitoringCollectionResponse,
  HomeMonitoringDetailResponse,
  HomeMonitoringSummary,
  House,
  HouseWeather,
  IntegrationStatus,
  MeasurementSample,
  Sensor,
} from "@climate-twin/contracts";
import { HOME_MONITORING_ALGORITHM_VERSION } from "@climate-twin/contracts";
import type { ClimateDatabase } from "../../db.js";
import {
  deriveHouseMonitoring,
  type HouseMonitoringBlocker as DerivedBlocker,
} from "./derive.js";
import {
  deriveHomePulse,
  HOME_INSIGHT_ADVISORY,
  HOME_INSIGHT_THRESHOLDS,
  type HomeInsight as DerivedInsight,
  type LatestMeasurements,
  type MeasurementHistory,
} from "./insights.js";

const HISTORY_BUCKET_MINUTES = 5;
const HISTORY_LIMIT_PER_METRIC = 100;
const HISTORY_METRICS = ["temperature", "humidity", "co2"] as const;

export interface HomeMonitoringServiceContext {
  database: ClimateDatabase;
  latestMeasurements(houseId: string): readonly MeasurementSample[];
  integrationStatus(houseId: string): IntegrationStatus;
  latestWeather(houseId: string): HouseWeather | null;
  dataMode: DataMode;
  evaluatedAt: string;
}

export interface HomeMonitoringScope {
  house: House;
  sensors: readonly Sensor[];
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

function recentHistory(
  context: HomeMonitoringServiceContext,
  scope: HomeMonitoringScope,
): MeasurementHistory {
  const to = Date.parse(context.evaluatedAt);
  const from = new Date(
    to - HOME_INSIGHT_THRESHOLDS.trendWindowMinutes * 60_000,
  ).toISOString();
  const history: MeasurementHistory = {};
  for (const sensor of scope.sensors) {
    if (!sensor.enabled) continue;
    for (const metric of HISTORY_METRICS) {
      const samples = context.database.measurementHistoryBucketed(
        sensor.id,
        metric,
        from,
        context.evaluatedAt,
        HISTORY_BUCKET_MINUTES * 60,
        HISTORY_LIMIT_PER_METRIC,
      );
      if (samples.length === 0) continue;
      history[sensor.id] = { ...(history[sensor.id] ?? {}), [metric]: samples };
    }
  }
  return history;
}

function evidence(
  context: HomeMonitoringServiceContext,
  scope: HomeMonitoringScope,
  includeHistory: boolean,
) {
  const sensorIds = new Set(scope.sensors.map((sensor) => sensor.id));
  const rules = context.database.listAlertRules()
    .filter((rule) => rule.sensorId === null || sensorIds.has(rule.sensorId));
  const alerts = context.database.listAlertEvents(2_000, true)
    .filter((alert) => sensorIds.has(alert.sensorId));
  const weather = context.latestWeather(scope.house.id);
  return {
    house: scope.house,
    sensors: [...scope.sensors],
    latestMeasurements: latestMap(
      context.latestMeasurements(scope.house.id)
        .filter((sample) => sensorIds.has(sample.sensorId)),
    ),
    ...(includeHistory ? { measurementHistory: recentHistory(context, scope) } : {}),
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

function blocker(blocker: DerivedBlocker): HomeMonitoringBlocker {
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

function insight(item: DerivedInsight): HomeInsight {
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
    evidence: item.evidence,
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
  const result = deriveHouseMonitoring(input);
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

function envelope(context: HomeMonitoringServiceContext, sourceIds: string[]) {
  return {
    apiVersion: "1.0" as const,
    dataMode: context.dataMode,
    algorithm: {
      key: "home-monitoring" as const,
      version: HOME_MONITORING_ALGORITHM_VERSION as typeof HOME_MONITORING_ALGORITHM_VERSION,
    },
    generatedAt: context.evaluatedAt,
    evaluatedAt: context.evaluatedAt,
    completeness: "complete" as const,
    warnings: [],
    provenance: {
      algorithmKey: "home-monitoring",
      algorithmVersion: HOME_MONITORING_ALGORITHM_VERSION,
      evaluatedAt: context.evaluatedAt,
      sourceIds,
    },
  };
}

export function getHomeMonitoringCollection(
  context: HomeMonitoringServiceContext,
  scopes: readonly HomeMonitoringScope[],
): HomeMonitoringCollectionResponse {
  const ordered = [...scopes].sort((left, right) => left.house.id.localeCompare(right.house.id));
  return {
    ...envelope(context, ordered.flatMap((scope) => scope.sensors.map((sensor) => sensor.id))),
    houses: ordered.map((scope) => summaryFrom(evidence(context, scope, false))),
  };
}

export function getHomeMonitoringDetail(
  context: HomeMonitoringServiceContext,
  scope: HomeMonitoringScope,
): HomeMonitoringDetailResponse {
  const collected = evidence(context, scope, true);
  const pulse = deriveHomePulse(collected);
  return {
    ...envelope(context, scope.sensors.map((sensor) => sensor.id)),
    house: summaryFrom(collected),
    sensorCoverage: pulse.sensorCoverage,
    insights: pulse.insights.map(insight),
    advisoryCode: "monitoring.advisory",
    fallbackAdvisory: HOME_INSIGHT_ADVISORY,
  };
}
