import type { AlertEvent, AlertRule, House, IntegrationStatus, Sensor } from "@climate-twin/contracts";
import { deriveHomePulse, type HomePulseCoverage, type HomePulseSensorCoverage } from "./homeInsights";
import type { LatestMeasurements, MeasurementHistory } from "./measurements";

export type HouseMonitoringStatus =
  | "action-required"
  | "inspection-recommended"
  | "monitoring-ok"
  | "unknown";

export type HouseMonitoringBlockerKind =
  | "critical-alert"
  | "warning-alert"
  | "information-alert"
  | "no-sensors"
  | "missing-data"
  | "stale-data"
  | "source-disconnected"
  | "estimated-data"
  | "aging-data";

export interface HouseMonitoringBlocker {
  id: string;
  kind: HouseMonitoringBlockerKind;
  summary: string;
  count: number;
  sensorIds: string[];
  evidenceAt: string | null;
  acknowledged: boolean;
}

export interface HouseMonitoringResult {
  houseId: string;
  generatedAt: string;
  status: HouseMonitoringStatus;
  coverage: HomePulseCoverage;
  activeAlertCount: number;
  blockers: HouseMonitoringBlocker[];
}

export interface HouseMonitoringInput {
  house: House;
  sensors: readonly Sensor[];
  latestMeasurements: LatestMeasurements;
  measurementHistory?: MeasurementHistory;
  alerts?: readonly AlertEvent[];
  alertRules?: readonly AlertRule[];
  integration?: IntegrationStatus;
  referenceTime: string | number;
}

const severityOrder = { critical: 3, warning: 2, info: 1 } as const;
const blockerPriority: Record<HouseMonitoringBlockerKind, number> = {
  "critical-alert": 9,
  "warning-alert": 8,
  "no-sensors": 7,
  "missing-data": 6,
  "stale-data": 5,
  "source-disconnected": 4,
  "estimated-data": 4,
  "information-alert": 3,
  "aging-data": 2,
};

function timestampValue(value: string): number {
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : Number.NEGATIVE_INFINITY;
}

function alertBlockers(
  alerts: readonly AlertEvent[],
  rules: readonly AlertRule[],
  sensors: readonly Sensor[],
): HouseMonitoringBlocker[] {
  const sensorsById = new Map(sensors.map((sensor) => [sensor.id, sensor]));
  const rulesById = new Map(rules.map((rule) => [rule.id, rule]));
  const grouped = new Map<string, AlertEvent[]>();
  for (const alert of alerts) {
    if (alert.resolvedAt || !sensorsById.has(alert.sensorId)) continue;
    const rule = rulesById.get(alert.ruleId);
    const key = `${alert.sensorId}:${alert.metric}:${rule?.operator ?? alert.ruleId}`;
    grouped.set(key, [...(grouped.get(key) ?? []), alert]);
  }

  return [...grouped.entries()].map(([key, events]) => {
    const sorted = events.slice().sort((left, right) =>
      severityOrder[right.severity] - severityOrder[left.severity]
      || timestampValue(right.startedAt) - timestampValue(left.startedAt)
      || left.id.localeCompare(right.id));
    const primary = sorted[0]!;
    const sensor = sensorsById.get(primary.sensorId)!;
    const rule = rulesById.get(primary.ruleId);
    const acknowledged = sorted.every((event) => Boolean(event.acknowledgedAt));
    const kind: HouseMonitoringBlockerKind = primary.severity === "critical"
      ? "critical-alert"
      : primary.severity === "warning"
        ? "warning-alert"
        : "information-alert";
    return {
      id: `alert:${key}`,
      kind,
      summary: `${sensor.name} has an ${acknowledged ? "acknowledged but unresolved" : "unresolved"} ${rule?.name || primary.metric} alert.`,
      count: sorted.length,
      sensorIds: [sensor.id],
      evidenceAt: primary.startedAt,
      acknowledged,
    };
  }).sort((left, right) => {
    return blockerPriority[right.kind] - blockerPriority[left.kind]
      || timestampValue(right.evidenceAt ?? "") - timestampValue(left.evidenceAt ?? "")
      || left.id.localeCompare(right.id);
  });
}

function coverageBlockers(
  coverage: HomePulseCoverage,
  sensorCoverage: readonly HomePulseSensorCoverage[],
): HouseMonitoringBlocker[] {
  if (coverage.enabledSensors === 0) {
    return [{
      id: "coverage:no-sensors",
      kind: "no-sensors",
      summary: "No enabled sensors are available to confirm the home's condition.",
      count: 0,
      sensorIds: [],
      evidenceAt: null,
      acknowledged: false,
    }];
  }

  const matching = (state: HomePulseSensorCoverage["freshness"]["state"]) =>
    sensorCoverage.filter((sensor) => sensor.freshness.state === state);
  const earliestEvidence = (items: readonly HomePulseSensorCoverage[]): string | null =>
    items.map((item) => item.freshness.evidenceAt)
      .filter((value): value is string => typeof value === "string" && Number.isFinite(Date.parse(value)))
      .sort((left, right) => timestampValue(left) - timestampValue(right))[0] ?? null;
  const blockers: HouseMonitoringBlocker[] = [];
  if (coverage.sensorsWithoutData > 0) {
    const affected = matching("unknown");
    blockers.push({
      id: "coverage:missing",
      kind: "missing-data",
      summary: `${affected.length} enabled ${affected.length === 1 ? "sensor is" : "sensors are"} missing required monitoring data.`,
      count: affected.length,
      sensorIds: affected.map((sensor) => sensor.sensorId),
      evidenceAt: null,
      acknowledged: false,
    });
  }
  if (coverage.staleSensors > 0) {
    const affected = matching("stale");
    blockers.push({
      id: "coverage:stale",
      kind: "stale-data",
      summary: `${affected.length} enabled ${affected.length === 1 ? "sensor has" : "sensors have"} stale required monitoring data.`,
      count: affected.length,
      sensorIds: affected.map((sensor) => sensor.sensorId),
      evidenceAt: earliestEvidence(affected),
      acknowledged: false,
    });
  }
  if (coverage.estimatedSensors > 0) {
    const affected = matching("estimated");
    blockers.push({
      id: "coverage:estimated",
      kind: "estimated-data",
      summary: `${affected.length} enabled ${affected.length === 1 ? "sensor has" : "sensors have"} only estimated current data.`,
      count: affected.length,
      sensorIds: affected.map((sensor) => sensor.sensorId),
      evidenceAt: earliestEvidence(affected),
      acknowledged: false,
    });
  }
  if (coverage.agingSensors > 0) {
    const affected = matching("aging");
    blockers.push({
      id: "coverage:aging",
      kind: "aging-data",
      summary: `${affected.length} enabled ${affected.length === 1 ? "sensor needs" : "sensors need"} fresh required monitoring data soon.`,
      count: affected.length,
      sensorIds: affected.map((sensor) => sensor.sensorId),
      evidenceAt: earliestEvidence(affected),
      acknowledged: false,
    });
  }
  return blockers;
}

function integrationBlockers(
  integration: IntegrationStatus | undefined,
  sensors: readonly Sensor[],
  latest: LatestMeasurements,
): HouseMonitoringBlocker[] {
  if (!integration) return [];
  const homeAssistantDown = integration.homeAssistant.connections
    ? integration.homeAssistant.connections.some((connection) => connection.configured && !connection.connected)
    : !integration.homeAssistant.connected;
  const tpLinkDownFor = (sensor: Sensor): boolean => {
    const connections = integration.tpLink.connections;
    if (!connections) return !integration.tpLink.connected;
    if (sensor.tpLinkConnectionId) {
      const connection = connections.find((candidate) => candidate.id === sensor.tpLinkConnectionId);
      return Boolean(connection?.configured && !connection.connected);
    }
    // A legacy/unbound source cannot be assigned to a healthy connection, so
    // remain conservative if any Home-scoped TP-Link connection is down.
    return connections.some((connection) => connection.configured && !connection.connected);
  };
  const sourceDownFor = (sensor: Sensor, source: string): boolean => source === "home-assistant"
    ? homeAssistantDown
    : source === "tp-link" && tpLinkDownFor(sensor);
  const affected = sensors.filter((sensor) => sensor.enabled && Object.values(latest[sensor.id] ?? {})
    .some((sample) => sourceDownFor(sensor, sample.source)));
  if (affected.length === 0) return [];
  const disconnectedSources = new Set(affected.flatMap((sensor) => Object.values(latest[sensor.id] ?? {})
    .filter((sample) => sourceDownFor(sensor, sample.source)).map((sample) => sample.source)));
  const evidenceAt = affected.flatMap((sensor) => Object.values(latest[sensor.id] ?? {})
    .filter((sample) => sourceDownFor(sensor, sample.source)))
    .filter((sample) => Number.isFinite(Date.parse(sample.timestamp)))
    .map((sample) => sample.timestamp)
    .sort((left, right) => timestampValue(right) - timestampValue(left))[0] ?? null;
  return [{
    id: `integration:${[...disconnectedSources].sort().join("+")}`,
    kind: "source-disconnected",
    summary: `${affected.length} enabled ${affected.length === 1 ? "sensor depends" : "sensors depend"} on a disconnected data source.`,
    count: affected.length,
    sensorIds: affected.map((sensor) => sensor.id),
    evidenceAt,
    acknowledged: false,
  }];
}

/**
 * Produce one explanation-first monitoring result for every surface that needs
 * to decide whether a house is genuinely known to be okay. Freshness and
 * quality classification come from the same Home Pulse engine used on Home.
 */
export function deriveHouseMonitoring(input: HouseMonitoringInput): HouseMonitoringResult {
  const houseSensors = input.sensors.filter((sensor) => sensor.houseId === input.house.id);
  const pulse = deriveHomePulse({
    house: input.house,
    sensors: houseSensors,
    latestMeasurements: input.latestMeasurements,
    measurementHistory: input.measurementHistory ?? {},
    alerts: input.alerts ?? [],
    alertRules: input.alertRules ?? [],
    referenceTime: input.referenceTime,
    maxInsights: 8,
  });
  const alerts = alertBlockers(input.alerts ?? [], input.alertRules ?? [], houseSensors);
  const coverage = coverageBlockers(pulse.coverage, pulse.sensorCoverage);
  const integrations = integrationBlockers(input.integration, houseSensors, input.latestMeasurements);
  const blockers = [...alerts, ...coverage, ...integrations].sort((left, right) =>
    blockerPriority[right.kind] - blockerPriority[left.kind]
    || timestampValue(right.evidenceAt ?? "") - timestampValue(left.evidenceAt ?? "")
    || left.id.localeCompare(right.id));
  const hasActionAlert = alerts.some((blocker) => blocker.kind === "critical-alert" || blocker.kind === "warning-alert");
  const hasUnknownCoverage = pulse.coverage.enabledSensors === 0
    || pulse.coverage.sensorsWithoutData > 0
    || pulse.coverage.staleSensors > 0
    || pulse.coverage.freshSensors + pulse.coverage.estimatedSensors === 0;
  const hasInspectionReason = alerts.some((blocker) => blocker.kind === "information-alert")
    || pulse.coverage.agingSensors > 0
    || pulse.coverage.estimatedSensors > 0
    || integrations.length > 0;
  const status: HouseMonitoringStatus = hasActionAlert
    ? "action-required"
    : hasUnknownCoverage
      ? "unknown"
      : hasInspectionReason
        ? "inspection-recommended"
        : "monitoring-ok";

  const reference = typeof input.referenceTime === "number" ? input.referenceTime : Date.parse(input.referenceTime);
  if (!Number.isFinite(reference)) throw new RangeError("referenceTime must be a valid timestamp");
  return {
    houseId: input.house.id,
    generatedAt: new Date(reference).toISOString(),
    status,
    coverage: pulse.coverage,
    activeAlertCount: alerts.reduce((count, blocker) => count + blocker.count, 0),
    blockers,
  };
}

export function monitoringPrimaryBlocker(result: HouseMonitoringResult): HouseMonitoringBlocker | null {
  return result.blockers[0] ?? null;
}
