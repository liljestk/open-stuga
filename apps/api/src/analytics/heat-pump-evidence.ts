import type {
  HvacExclusionSummary,
  MeasurementSample,
} from "@climate-twin/contracts";
import type { ClimateDatabase } from "../db.js";

const MINUTE_MS = 60_000;
const MAX_STATE_GAP_MS = 5 * MINUTE_MS;
const PADDING_BEFORE_MS = 5 * MINUTE_MS;
const PADDING_AFTER_MS = 30 * MINUTE_MS;
const MIN_CLASSIFIED_PERCENT = 90;
const MIN_USABLE_PERCENT = 50;
const MAX_HISTORY_ROWS = 50_000;

type EvidenceClass = "off" | "confirmed-active" | "possible-active" | "unknown";

interface EvidenceRow {
  connection_id: string;
  observed_at: string;
  available: number | null;
  power: number | null;
  compressor_frequency_hz: number | null;
}

export interface HeatPumpEvidencePoint {
  connectionId: string;
  time: number;
  classification: EvidenceClass;
}

export interface PassiveInterval {
  fromMs: number;
  toMs: number;
}

export interface HeatPumpExclusionWindow {
  fromMs: number;
  toMs: number;
  passiveIntervals: PassiveInterval[];
  summary: HvacExclusionSummary;
}

export interface ConfiguredHeatPumpConnection {
  id: string;
  houseId: string;
}

export class InsufficientHeatPumpEvidenceError extends Error {
  readonly code = "HVAC_EVIDENCE_INSUFFICIENT";

  constructor() {
    super("Configured heat-pump evidence is insufficient for passive derived analytics");
    this.name = "InsufficientHeatPumpEvidenceError";
  }
}

export function configuredHeatPumpConnectionIds(
  connections: readonly ConfiguredHeatPumpConnection[] | undefined,
  houseId: string,
): string[] {
  return [...new Set((connections ?? [])
    .filter((connection) => connection.houseId === houseId)
    .map((connection) => connection.id))]
    .sort();
}

export function heatPumpEvidenceInfluenceRange(observedAt: string): { from: string; to: string } {
  const observedAtMs = finiteTime(observedAt, "observedAt");
  return {
    from: new Date(observedAtMs - PADDING_BEFORE_MS).toISOString(),
    to: new Date(observedAtMs + MAX_STATE_GAP_MS + PADDING_AFTER_MS).toISOString(),
  };
}

function finiteTime(value: string, label: string): number {
  const parsed = Date.parse(value);
  if (!Number.isFinite(parsed)) throw new RangeError(`${label} must be a valid timestamp`);
  return parsed;
}

function round(value: number, precision = 1): number {
  return Number(value.toFixed(precision));
}

function hours(milliseconds: number): number {
  return round(Math.max(0, milliseconds) / 3_600_000, 2);
}

function classify(row: EvidenceRow): EvidenceClass {
  if (row.available !== 1) return "unknown";
  if (row.compressor_frequency_hz !== null && row.compressor_frequency_hz > 0) {
    return "confirmed-active";
  }
  if (row.power === 0) return "off";
  if (row.power === 1) return "possible-active";
  return "unknown";
}

function mergeIntervals(intervals: readonly PassiveInterval[]): PassiveInterval[] {
  const sorted = intervals
    .filter((interval) => interval.toMs > interval.fromMs)
    .sort((left, right) => left.fromMs - right.fromMs || left.toMs - right.toMs);
  const merged: PassiveInterval[] = [];
  for (const interval of sorted) {
    const previous = merged.at(-1);
    if (!previous || interval.fromMs > previous.toMs) {
      merged.push({ ...interval });
      continue;
    }
    previous.toMs = Math.max(previous.toMs, interval.toMs);
  }
  return merged;
}

function duration(intervals: readonly PassiveInterval[]): number {
  return intervals.reduce((sum, interval) => sum + interval.toMs - interval.fromMs, 0);
}

function complement(
  excluded: readonly PassiveInterval[],
  fromMs: number,
  toMs: number,
): PassiveInterval[] {
  const result: PassiveInterval[] = [];
  let cursor = fromMs;
  for (const interval of mergeIntervals(excluded)) {
    const start = Math.max(fromMs, interval.fromMs);
    const end = Math.min(toMs, interval.toMs);
    if (start > cursor) result.push({ fromMs: cursor, toMs: start });
    cursor = Math.max(cursor, end);
  }
  if (cursor < toMs) result.push({ fromMs: cursor, toMs });
  return result;
}

/**
 * Drop unavailability reports that carry no more suggestion of compressor
 * activity than reporting silence would. The state-gap rule trusts an "off"
 * report for MAX_STATE_GAP_MS of silence, so "unknown" reports sitting between
 * two "off" reports no further apart than that are removed, and the earlier
 * report's reach continues exactly as if the blip had been silence. Silence
 * itself is never bridged: "off" reports further apart than the gap still
 * leave the stretch beyond the first report's reach unclassified. Without
 * this, a two-second availability flap per poll cycle, padded to thirty-five
 * excluded minutes, zeroed out a fully-off window.
 */
function withoutBridgedUnavailabilityBlips(
  points: readonly HeatPumpEvidencePoint[],
): HeatPumpEvidencePoint[] {
  const result: HeatPumpEvidencePoint[] = [];
  for (let index = 0; index < points.length; index += 1) {
    const point = points[index]!;
    if (point.classification !== "unknown") {
      result.push(point);
      continue;
    }
    let end = index;
    while (end < points.length && points[end]!.classification === "unknown") end += 1;
    const previous = points[index - 1];
    const next = points[end];
    const bridged = previous?.classification === "off"
      && next?.classification === "off"
      && next.time - previous.time <= MAX_STATE_GAP_MS;
    if (!bridged) result.push(...points.slice(index, end));
    index = end - 1;
  }
  return result;
}

function pointClassSegments(
  points: readonly HeatPumpEvidencePoint[],
  fromMs: number,
  toMs: number,
): Array<PassiveInterval & { classification: EvidenceClass }> {
  const result: Array<PassiveInterval & { classification: EvidenceClass }> = [];
  for (let index = 0; index < points.length; index += 1) {
    const point = points[index]!;
    const next = points[index + 1];
    const end = Math.min(toMs, point.time + MAX_STATE_GAP_MS, next?.time ?? toMs);
    const start = Math.max(fromMs, point.time);
    if (end > start) result.push({ fromMs: start, toMs: end, classification: point.classification });
  }
  return result;
}

function classAt(
  segments: readonly (PassiveInterval & { classification: EvidenceClass })[],
  index: number,
  time: number,
  absentClassification: EvidenceClass,
): { classification: EvidenceClass; index: number } {
  let current = index;
  while (current < segments.length && segments[current]!.toMs <= time) current += 1;
  const segment = segments[current];
  return {
    classification: segment && segment.fromMs <= time && segment.toMs > time
      ? segment.classification
      : absentClassification,
    index: current,
  };
}

function houseClass(classes: readonly EvidenceClass[]): EvidenceClass {
  if (classes.includes("confirmed-active")) return "confirmed-active";
  if (classes.includes("possible-active")) return "possible-active";
  if (classes.includes("unknown")) return "unknown";
  return "off";
}

export function buildHeatPumpExclusionWindow(input: {
  from: string;
  to: string;
  connectionIds: readonly string[];
  configuredConnectionIds?: readonly string[];
  points: readonly HeatPumpEvidencePoint[];
  truncated?: boolean;
}): HeatPumpExclusionWindow {
  const fromMs = finiteTime(input.from, "from");
  const toMs = finiteTime(input.to, "to");
  if (fromMs >= toMs) throw new RangeError("Heat-pump evidence range must be positive");
  const windowMs = toMs - fromMs;
  const connectionIds = [...new Set(input.connectionIds)].sort();
  const configuredConnectionIds = new Set(
    input.configuredConnectionIds ?? connectionIds,
  );
  if (connectionIds.length === 0) {
    return {
      fromMs,
      toMs,
      passiveIntervals: [{ fromMs, toMs }],
      summary: {
        policy: "verified-heat-pump-off-v2",
        evidenceState: "not-present",
        heatPumpCount: 0,
        stateGapMinutes: 5,
        paddingBeforeMinutes: 5,
        paddingAfterMinutes: 30,
        minimumClassifiedPercent: MIN_CLASSIFIED_PERCENT,
        minimumUsablePercent: MIN_USABLE_PERCENT,
        windowHours: hours(windowMs),
        classifiedPercent: 100,
        verifiedOffHours: hours(windowMs),
        confirmedActiveHours: 0,
        possibleActiveHours: 0,
        unknownHours: 0,
        usableHours: hours(windowMs),
        excludedHours: 0,
        retainedSampleCount: 0,
        excludedSampleCount: 0,
        truncated: false,
      },
    };
  }

  const expandedFrom = fromMs - PADDING_AFTER_MS;
  const expandedTo = toMs + PADDING_BEFORE_MS;
  const byConnection = new Map(connectionIds.map((id) => [id, [] as HeatPumpEvidencePoint[]]));
  for (const point of input.points) {
    if (!Number.isFinite(point.time) || point.time < expandedFrom - MAX_STATE_GAP_MS || point.time > expandedTo) continue;
    const series = byConnection.get(point.connectionId);
    if (series) series.push(point);
  }
  const segments = new Map([...byConnection].map(([id, points]) => [
    id,
    pointClassSegments(
      withoutBridgedUnavailabilityBlips(points.sort((left, right) => left.time - right.time)),
      expandedFrom,
      expandedTo,
    ),
  ]));
  const boundaries = new Set<number>([expandedFrom, expandedTo, fromMs, toMs]);
  for (const series of segments.values()) {
    for (const segment of series) {
      boundaries.add(segment.fromMs);
      boundaries.add(segment.toMs);
    }
  }
  const ordered = [...boundaries].sort((left, right) => left - right);
  const indices = new Map(connectionIds.map((id) => [id, 0]));
  const classified: Array<PassiveInterval & { classification: EvidenceClass }> = [];
  for (let index = 0; index < ordered.length - 1; index += 1) {
    const start = ordered[index]!;
    const end = ordered[index + 1]!;
    if (end <= start) continue;
    const classes = connectionIds.map((id) => {
      const found = classAt(
        segments.get(id) ?? [],
        indices.get(id) ?? 0,
        start,
        configuredConnectionIds.has(id) ? "unknown" : "off",
      );
      indices.set(id, found.index);
      return found.classification;
    });
    const classification = houseClass(classes);
    const previous = classified.at(-1);
    if (previous?.classification === classification && previous.toMs === start) previous.toMs = end;
    else classified.push({ fromMs: start, toMs: end, classification });
  }

  const rawInWindow = (classification: EvidenceClass) => mergeIntervals(classified
    .filter((segment) => segment.classification === classification)
    .map((segment) => ({
      fromMs: Math.max(fromMs, segment.fromMs),
      toMs: Math.min(toMs, segment.toMs),
    })));
  const confirmedActive = rawInWindow("confirmed-active");
  const possibleActive = rawInWindow("possible-active");
  const unknown = rawInWindow("unknown");
  const verifiedOff = rawInWindow("off");
  const classifiedMs = duration(confirmedActive) + duration(possibleActive) + duration(verifiedOff);
  const classifiedPercent = windowMs === 0 ? 0 : classifiedMs / windowMs * 100;

  const paddedExclusions = mergeIntervals(classified
    .filter((segment) => segment.classification !== "off")
    .map((segment) => ({
      fromMs: Math.max(fromMs, segment.fromMs - PADDING_BEFORE_MS),
      toMs: Math.min(toMs, segment.toMs + PADDING_AFTER_MS),
    })));
  const candidatePassive = complement(paddedExclusions, fromMs, toMs);
  const candidateUsableMs = duration(candidatePassive);
  const candidateUsablePercent = candidateUsableMs / windowMs * 100;
  const meetsCoverage = !input.truncated
    && classifiedPercent >= MIN_CLASSIFIED_PERCENT
    && candidateUsablePercent >= MIN_USABLE_PERCENT;
  const passiveIntervals = meetsCoverage ? candidatePassive : [];
  const usableMs = meetsCoverage ? candidateUsableMs : 0;
  const excludedMs = windowMs - usableMs;
  return {
    fromMs,
    toMs,
    passiveIntervals,
    summary: {
      policy: "verified-heat-pump-off-v2",
      evidenceState: !meetsCoverage
        ? "insufficient"
        : excludedMs <= 1_000
          ? "complete"
          : "partial",
      heatPumpCount: connectionIds.length,
      stateGapMinutes: 5,
      paddingBeforeMinutes: 5,
      paddingAfterMinutes: 30,
      minimumClassifiedPercent: MIN_CLASSIFIED_PERCENT,
      minimumUsablePercent: MIN_USABLE_PERCENT,
      windowHours: hours(windowMs),
      classifiedPercent: round(classifiedPercent, 1),
      verifiedOffHours: hours(duration(verifiedOff)),
      confirmedActiveHours: hours(duration(confirmedActive)),
      possibleActiveHours: hours(duration(possibleActive)),
      unknownHours: hours(duration(unknown)),
      usableHours: hours(usableMs),
      excludedHours: hours(excludedMs),
      retainedSampleCount: 0,
      excludedSampleCount: 0,
      truncated: Boolean(input.truncated),
    },
  };
}

export function loadHeatPumpExclusionWindow(
  database: ClimateDatabase,
  houseId: string,
  from: string,
  to: string,
  configuredConnectionIds: readonly string[],
): HeatPumpExclusionWindow {
  const fromMs = finiteTime(from, "from");
  const toMs = finiteTime(to, "to");
  const queryFrom = new Date(fromMs - PADDING_AFTER_MS - MAX_STATE_GAP_MS).toISOString();
  const queryTo = new Date(toMs + PADDING_BEFORE_MS).toISOString();
  const rows = database.db.prepare(`
    SELECT connection_id, observed_at,
      CAST(json_extract(state_json, '$.available') AS INTEGER) AS available,
      CAST(json_extract(state_json, '$.power') AS INTEGER) AS power,
      CAST(json_extract(state_json, '$.compressorFrequencyHz') AS REAL) AS compressor_frequency_hz
    FROM heat_pump_state_history
    WHERE house_id = ? AND observed_at >= ? AND observed_at <= ?
    LIMIT ?
  `).all(houseId, queryFrom, queryTo, MAX_HISTORY_ROWS + 1) as unknown as EvidenceRow[];
  const truncated = rows.length > MAX_HISTORY_ROWS;
  const bounded = truncated ? rows.slice(0, MAX_HISTORY_ROWS) : rows;
  const connectionIds = [
    ...configuredConnectionIds,
    ...bounded.map((row) => row.connection_id),
  ];
  return buildHeatPumpExclusionWindow({
    from,
    to,
    connectionIds,
    configuredConnectionIds,
    points: bounded.map((row) => ({
      connectionId: row.connection_id,
      time: Date.parse(row.observed_at),
      classification: classify(row),
    })),
    truncated,
  });
}

export function isPassiveHeatPumpTime(window: HeatPumpExclusionWindow, timestamp: string | number): boolean {
  const time = typeof timestamp === "number" ? timestamp : Date.parse(timestamp);
  if (!Number.isFinite(time)) return false;
  if (window.summary.evidenceState === "not-present") return true;
  return isTimeWithinPassiveIntervals(window.passiveIntervals, time);
}

export function isTimeWithinPassiveIntervals(
  intervals: readonly PassiveInterval[] | undefined,
  time: number,
): boolean {
  return intervals === undefined
    || intervals.some((interval) => time >= interval.fromMs && time < interval.toMs);
}

export function filterHeatPumpAffectedSamples(
  samples: readonly MeasurementSample[],
  window: HeatPumpExclusionWindow,
): { samples: MeasurementSample[]; summary: HvacExclusionSummary } {
  const retained = samples.filter((sample) => isPassiveHeatPumpTime(window, sample.timestamp));
  return {
    samples: retained,
    summary: {
      ...window.summary,
      retainedSampleCount: retained.length,
      excludedSampleCount: samples.length - retained.length,
    },
  };
}

export function filterHeatPumpAffectedSampleMap(
  samplesBySensor: ReadonlyMap<string, MeasurementSample[]>,
  window: HeatPumpExclusionWindow,
): { samplesBySensor: Map<string, MeasurementSample[]>; summary: HvacExclusionSummary } {
  const result = new Map<string, MeasurementSample[]>();
  let retained = 0;
  let total = 0;
  for (const [sensorId, samples] of samplesBySensor) {
    const filtered = samples.filter((sample) => isPassiveHeatPumpTime(window, sample.timestamp));
    result.set(sensorId, filtered);
    retained += filtered.length;
    total += samples.length;
  }
  return {
    samplesBySensor: result,
    summary: {
      ...window.summary,
      retainedSampleCount: retained,
      excludedSampleCount: total - retained,
    },
  };
}

export function withHeatPumpPointCounts(
  window: HeatPumpExclusionWindow,
  total: number,
  retained: number,
): HvacExclusionSummary {
  return {
    ...window.summary,
    retainedSampleCount: retained,
    excludedSampleCount: Math.max(0, total - retained),
  };
}
