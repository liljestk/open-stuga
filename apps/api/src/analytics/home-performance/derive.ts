import { maximum, minimum } from "@climate-twin/analytics-kernel";
import type {
  AnalyticsQueryResponse,
  AnalyticsSeries,
} from "@climate-twin/contracts";
import { HOME_PERFORMANCE_ALGORITHM_VERSION, HomePerformanceInput, HomePerformanceLimitation, HomePerformanceResult, HomePerformanceSensorHealth, HomePerformanceSensorIssue, compareStable, exposureResult, median, recoveryEvidenceBySensor, round } from "./model.js";
import { definitionFor, energyResult, maintenanceResult, moistureRecoveryResult, openingEffectivenessResult, sampleMedian } from "./derive-support.js";

export function sensorHealthResult(input: HomePerformanceInput): HomePerformanceSensorHealth {
  const midpoint = (Date.parse(input.from) + Date.parse(input.to)) / 2;
  const enabledSensorIds = new Set(input.sensors.filter((sensor) => sensor.enabled).map((sensor) => sensor.id));
  const responses = [input.climate, input.energy].filter((value): value is AnalyticsQueryResponse => value !== null);
  const series = responses.flatMap((response) => response.series)
    .filter((item) => item.summary.count > 0 && enabledSensorIds.has(item.entityId));
  const supportedBySensor = new Map<string, AnalyticsSeries[]>();
  for (const item of series) {
    const existing = supportedBySensor.get(item.entityId) ?? [];
    existing.push(item);
    supportedBySensor.set(item.entityId, existing);
  }
  const issues: HomePerformanceSensorIssue[] = [];
  for (const sensor of input.sensors.filter((candidate) => candidate.enabled)) {
    const supported = supportedBySensor.get(sensor.id) ?? [];
    if (supported.length === 0) continue;
    const lowestCoverage = [...supported]
      .sort((left, right) => left.summary.coverage - right.summary.coverage
        || compareStable(left.measurementId, right.measurementId))[0];
    if (lowestCoverage && lowestCoverage.summary.coverage < 0.75) {
      issues.push({
        code: "low-coverage",
        sensorId: sensor.id,
        sensorName: sensor.name,
        metric: lowestCoverage.measurementId,
        value: round(lowestCoverage.summary.coverage * 100, 0),
        unit: "%",
      });
    }
    for (const item of supported.filter((candidate) => ["temperature", "humidity", "co2", "power"].includes(candidate.measurementId))) {
      const pointValues = item.points.flatMap((point) => (
        point.value === null || !Number.isFinite(point.value) ? [] : [point.value]
      ));
      const definition = definitionFor(input.definitions, item.measurementId);
      const flatlineThreshold = Math.max(0.01, (definition?.interpolationDelta ?? 1) * 0.2);
      if (item.summary.coverage >= 0.75 && pointValues.length >= 24
        && (maximum(pointValues) ?? Number.NEGATIVE_INFINITY) - (minimum(pointValues) ?? Number.POSITIVE_INFINITY) <= flatlineThreshold) {
        issues.push({
          code: "flatline",
          sensorId: sensor.id,
          sensorName: sensor.name,
          metric: item.measurementId,
          value: round((maximum(pointValues) ?? Number.NEGATIVE_INFINITY) - (minimum(pointValues) ?? Number.POSITIVE_INFINITY), definition?.precision ?? 1),
          unit: definition?.unit ?? "",
        });
      }
      if (item.summary.coverage < 0.75 || !["temperature", "humidity", "co2"].includes(item.measurementId)) continue;
      const peers = series.filter((candidate) => (
        candidate.measurementId === item.measurementId
        && candidate.entityId !== sensor.id
        && candidate.summary.coverage >= 0.75
      ));
      if (peers.length === 0) continue;
      const ownFirst = sampleMedian(item.points, (time) => time < midpoint);
      const ownSecond = sampleMedian(item.points, (time) => time >= midpoint);
      const peerFirst = median(peers.flatMap((peer) => peer.points.flatMap((point) => {
        const time = Date.parse(point.timestamp);
        return point.value === null || !Number.isFinite(point.value) || !Number.isFinite(time) || time >= midpoint
          ? []
          : [point.value];
      })));
      const peerSecond = median(peers.flatMap((peer) => peer.points.flatMap((point) => {
        const time = Date.parse(point.timestamp);
        return point.value === null || !Number.isFinite(point.value) || !Number.isFinite(time) || time < midpoint
          ? []
          : [point.value];
      })));
      if (ownFirst === null || ownSecond === null || peerFirst === null || peerSecond === null) continue;
      const changedOffset = (ownSecond - peerSecond) - (ownFirst - peerFirst);
      const threshold = item.measurementId === "temperature" ? 1 : item.measurementId === "humidity" ? 5 : 150;
      if (Math.abs(changedOffset) >= threshold) {
        issues.push({
          code: "changed-baseline",
          sensorId: sensor.id,
          sensorName: sensor.name,
          metric: item.measurementId,
          value: round(changedOffset, definition?.precision ?? 1),
          unit: definition?.unit ?? "",
        });
      }
    }
  }
  const monitoredSensors = supportedBySensor.size;
  const sensorsWithIssues = new Set(issues.map((issue) => issue.sensorId));
  const coverage = series.length === 0
    ? null
    : series.reduce((sum, item) => sum + item.summary.coverage, 0) / series.length;
  return {
    state: monitoredSensors === 0
      ? "unavailable"
      : (coverage ?? 0) >= 0.75 && issues.length === 0
        ? "ready"
        : "limited",
    monitoredSensors,
    healthySensors: Math.max(0, monitoredSensors - sensorsWithIssues.size),
    coveragePercent: coverage === null ? null : round(coverage * 100, 0),
    issues: issues.sort((left, right) => (
      compareStable(left.sensorName, right.sensorName) || compareStable(left.metric, right.metric)
    )),
  };
}

export function unique<T>(values: readonly T[]): T[] {
  return [...new Set(values)];
}

export function deriveHomePerformance(input: HomePerformanceInput): HomePerformanceResult {
  const recoveryEvidence = recoveryEvidenceBySensor(input);
  const exposure = exposureResult(input);
  const recovery = moistureRecoveryResult(input, recoveryEvidence);
  const openingEffectiveness = openingEffectivenessResult(input, recoveryEvidence);
  const energy = energyResult(input);
  const maintenance = maintenanceResult(input);
  const sensorHealth = sensorHealthResult(input);
  const sections = [exposure, recovery, openingEffectiveness, energy, maintenance, sensorHealth];
  const available = sections.filter((section) => section.state !== "unavailable").length;
  const ready = sections.filter((section) => section.state === "ready").length;
  const archiveStates = unique([
    input.climate?.quality.seriesCount ? input.climate.provenance.map((item) => item.archiveState) : [],
    input.recoveryClimate?.quality.seriesCount ? input.recoveryClimate.provenance.map((item) => item.archiveState) : [],
    input.energy?.quality.seriesCount ? input.energy.provenance.map((item) => item.archiveState) : [],
  ].flat()).sort(compareStable);
  const limitations = unique<HomePerformanceLimitation>([
    ...(archiveStates.some((state) => state === "failed" || state === "not-ready") ? ["archive-incomplete" as const] : []),
    ...(input.sensorScopeTruncated ? ["sensor-scope-limited" as const] : []),
    ...(input.evidenceScopeTruncated ? ["evidence-scope-limited" as const] : []),
    ...(openingEffectiveness.state === "unavailable" ? ["opening-history-missing" as const] : []),
    ...(energy.source === "unclassified-electricity" ? ["unclassified-energy" as const] : []),
    ...(maintenance.state !== "ready" ? ["maintenance-evidence-missing" as const] : []),
    ...(sensorHealth.issues.some((issue) => issue.code === "low-coverage")
      || (sensorHealth.coveragePercent !== null && sensorHealth.coveragePercent < 75)
      ? ["coverage-limited" as const]
      : []),
  ]);
  const enabledSensorIds = new Set(input.sensors.filter((sensor) => sensor.enabled).map((sensor) => sensor.id));
  const sourceIds = unique([
    ...(input.climate?.series ?? []),
    ...(input.recoveryClimate?.series ?? []),
    ...(input.energy?.series ?? []),
  ].filter((series) => series.summary.count > 0 && enabledSensorIds.has(series.entityId))
    .map((series) => series.entityId)).sort(compareStable);
  return {
    status: available === 0
      ? "unavailable"
      : ready === sections.length && limitations.length === 0
        ? "ready"
        : "limited",
    generatedAt: input.generatedAt ?? new Date().toISOString(),
    from: input.from,
    to: input.to,
    exposure,
    recovery,
    openingEffectiveness,
    energy,
    maintenance,
    sensorHealth,
    limitations,
    provenance: {
      truthClass: "derived",
      algorithmVersion: HOME_PERFORMANCE_ALGORITHM_VERSION,
      sourceIds,
      archiveStates,
    },
  };
}
