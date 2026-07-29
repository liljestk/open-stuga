import type {
  HomeInsight,
  HomeMonitoringBlocker,
  HomeMonitoringCollectionResponse,
  HomeMonitoringDetailResponse,
  HomeMonitoringSummary,
  HomePulseCoverage,
  House,
  Sensor,
} from "@climate-twin/contracts";

const generatedAt = "2026-07-14T12:00:00.000Z";

const emptyCoverage: HomePulseCoverage = {
  enabledSensors: 0,
  freshSensors: 0,
  estimatedSensors: 0,
  agingSensors: 0,
  staleSensors: 0,
  sensorsWithoutData: 0,
};

export function monitoringBlocker(
  kind: HomeMonitoringBlocker["kind"],
  count = 1,
  sensorIds: string[] = [],
): HomeMonitoringBlocker {
  return {
    id: `test:${kind}`,
    kind,
    code: `monitoring.blocker.${kind}`,
    parameters: { count },
    fallbackMessage: kind,
    count,
    sensorIds,
    evidenceAt: null,
    acknowledged: false,
  };
}

export function monitoringSummary(input: {
  houseId: string;
  status?: HomeMonitoringSummary["status"];
  pulseStatus?: HomeMonitoringSummary["pulseStatus"];
  coverage?: Partial<HomePulseCoverage>;
  activeAlertCount?: number;
  blockers?: HomeMonitoringBlocker[];
}): HomeMonitoringSummary {
  return {
    houseId: input.houseId,
    generatedAt,
    status: input.status ?? "monitoring-ok",
    pulseStatus: input.pulseStatus ?? "steady",
    coverage: { ...emptyCoverage, ...input.coverage },
    activeAlertCount: input.activeAlertCount ?? 0,
    blockers: input.blockers ?? [],
  };
}

export function monitoringCollection(
  houses: HomeMonitoringSummary[],
): HomeMonitoringCollectionResponse {
  return {
    apiVersion: "1.0",
    dataMode: "demo",
    algorithm: { key: "home-monitoring", version: "home-monitoring-v2.0.0" },
    generatedAt,
    evaluatedAt: generatedAt,
    completeness: "complete",
    warnings: [],
    provenance: {
      algorithmKey: "home-monitoring",
      algorithmVersion: "home-monitoring-v2.0.0",
      evaluatedAt: generatedAt,
      sourceIds: [],
    },
    houses,
  };
}

export function monitoringInsight(input: {
  id: string;
  kind: HomeInsight["kind"];
  severity: HomeInsight["severity"];
  title: string;
  summary?: string;
  action?: string;
  house: House;
  sensor?: Sensor;
  evidence?: HomeInsight["evidence"];
  rank?: number;
}): HomeInsight {
  return {
    id: input.id,
    rank: input.rank ?? 1,
    kind: input.kind,
    severity: input.severity,
    priority: input.severity === "critical" ? 100 : input.severity === "warning" ? 80 : 60,
    titleCode: `monitoring.insight.${input.kind}.title`,
    summaryCode: `monitoring.insight.${input.kind}.summary`,
    actionCode: `monitoring.insight.${input.kind}.action`,
    parameters: {},
    fallbackTitle: input.title,
    fallbackSummary: input.summary ?? input.title,
    fallbackAction: input.action ?? "Inspect the room.",
    target: {
      houseId: input.house.id,
      ...(input.sensor ? {
        sensorId: input.sensor.id,
        sensorName: input.sensor.name,
        floorId: input.sensor.floorId,
        room: input.sensor.room,
      } : {}),
    },
    evidence: input.evidence ?? [],
    freshness: {
      state: "fresh",
      evidenceAt: generatedAt,
      ageMinutes: 0,
    },
    confidence: {
      level: "high",
      score: 0.95,
      reasonCode: "monitoring.confidence.high",
      fallbackReason: "Fresh evidence.",
    },
  };
}

export function monitoringDetail(
  house: HomeMonitoringSummary,
  insights: HomeInsight[],
): HomeMonitoringDetailResponse {
  return {
    ...monitoringCollection([house]),
    house,
    sensorCoverage: [],
    insights,
    advisoryCode: "monitoring.advisory",
    fallbackAdvisory: "Monitoring advisory.",
  };
}
