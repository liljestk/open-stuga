import { maximum, median, minimum } from "@climate-twin/analytics-kernel";
import type { DataMode, House } from "@climate-twin/contracts";
import type { ClimateDatabase } from "../../db.js";
import { outdoorLocationKey } from "../../db.js";
import type { HybridTelemetryReader } from "../../timeseries/read-facade.js";
import { analyticsSeriesKey, buildAnalyticsResponse } from "../query/analytics-query.js";
import type { AdaptiveHour, AdaptiveInputBudget, AdaptiveStoredStream } from "./evidence.js";
import { HOUR } from "./evidence.js";
import { HttpError } from "../../http-error.js";

export interface AdaptiveReadContext {
  database: ClimateDatabase;
  telemetryReader: HybridTelemetryReader;
}
function contextGuard(database: ClimateDatabase, houseId: string, end: number): boolean {
  const from = new Date(end - 3 * HOUR).toISOString();
  const to = new Date(end).toISOString();
  const contacts = database.listOpeningStateObservationHistory(houseId, { from, to, limit: 1000 });
  if (contacts.length >= 1000) return true;
  const last = new Map<string, string>();
  for (const c of contacts) {
    const key = JSON.stringify([c.floorId, c.elementId, c.source]);
    const previous = last.get(key);
    if (previous && previous !== c.state && c.state !== "unknown" && previous !== "unknown"
      && Date.parse(c.observedAt) >= end - 2 * HOUR) return true;
    last.set(key, c.state);
  }
  const pumps = database.db.prepare(`SELECT connection_id,observed_at,json_extract(state_json,'$.power') AS power,
    json_extract(state_json,'$.mode') AS mode,json_extract(state_json,'$.targetTemperatureC') AS target
    FROM heat_pump_state_history WHERE house_id=? AND observed_at>=? AND observed_at<=?
    ORDER BY observed_at LIMIT 5000`).all(houseId, from, to) as Array<{ connection_id: string; observed_at: string; power: unknown; mode: unknown; target: unknown }>;
  if (pumps.length >= 5000) return true;
  const states = new Map<string, string>();
  for (const p of pumps) {
    const value = JSON.stringify([p.power, p.mode, p.target]);
    const previous = states.get(p.connection_id);
    if (previous && previous !== value && Date.parse(p.observed_at) >= end - 2 * HOUR) return true;
    states.set(p.connection_id, value);
  }
  return false;
}
export async function readAdaptiveHour(context: AdaptiveReadContext, input: {
  stored: AdaptiveStoredStream; house: House; mode: DataMode; end: number; now: number; signal: AbortSignal; budget: AdaptiveInputBudget;
}): Promise<AdaptiveHour> {
  const sensor = context.database.getSensor(input.stored.stream.sensorId);
  const definition = context.database.getMeasurementDefinition(input.stored.stream.metric);
  if (!sensor || !definition) throw new HttpError(409, "ADAPTIVE_SCOPE_CHANGED", "Sensor scope changed");
  const from = new Date(input.end - HOUR).toISOString();
  const to = new Date(input.end).toISOString();
  const limit = input.budget.remaining;
  if (limit < 1) throw new HttpError(422, "ADAPTIVE_INPUT_LIMIT", "The hourly evidence exceeded its processing budget");
  const read = await context.telemetryReader.measurementWindow({ sensorIds: [sensor.id], metrics: [definition.id],
    from, to: new Date(input.end - 1).toISOString(), limit, signal: input.signal });
  input.budget.remaining = Math.max(0, limit - read.records.length);
  if (read.records.length >= limit) throw new HttpError(422, "ADAPTIVE_INPUT_LIMIT", "The hourly evidence exceeded its processing budget");
  const samples = read.records.filter(s => input.mode === "demo" ? s.source === "mock" : s.source !== "mock" && s.source !== "replay");
  const intervals = context.database.expectedReportingIntervals([{ sensorId: sensor.id, metric: definition.id }], input.now);
  const result = await buildAnalyticsResponse({ request: { apiVersion: "1.0", requestId: input.stored.stream.id, dataMode: input.mode,
    scope: { kind: "house", id: input.house.id, entityIds: [sensor.id] }, measurementIds: [definition.id],
    range: { start: from, end: to, timezone: input.house.timezone }, resolution: "1h", aggregation: "mean",
    qualityFilter: { include: ["good"] }, maxPointsPerSeries: 1 },
    samples, definitions: [definition], entities: [{ id: sensor.id, label: sensor.name }],
    expectedIntervalSeconds: intervals, archiveState: read.provenance.archiveState, generatedAt: new Date(input.now).toISOString() });
  const point = result.series[0]?.points[0];
  const coverageKnown = intervals.has(analyticsSeriesKey(sensor.id, definition.id));
  const complete = !["failed", "not-ready"].includes(read.provenance.archiveState);
  const usable = complete && coverageKnown && (point?.coverage ?? 0) >= 0.8;
  const weather = input.house.location ? context.database.getWeatherSnapshot(input.house.id, outdoorLocationKey(input.house.location))?.weather : null;
  const outside = weather?.current;
  const outdoor = outside && Date.parse(outside.timestamp) <= input.now && input.now - Date.parse(outside.timestamp) <= 2 * HOUR
    && typeof outside.temperatureC === "number" ? outside.temperatureC : null;
  return { time: input.end, availableAt: input.now, value: usable ? point?.value ?? null : null,
    coverage: point?.coverage ?? 0, sources: [...new Set(samples.filter(s => s.quality === "good").map(s => s.source))],
    outdoor, guarded: contextGuard(context.database, input.house.id, input.end), peer: null,
    predictions: {}, persistence: null, seasonal: null, score: null, excluded: false };
}
export function comparablePeerValue(values: number[], baseline: number[]): number | null {
  if (!values.length) return null;
  const spread = maximum(values)! - minimum(values)!;
  const usual = median(baseline) ?? 0;
  return values.length > 1 && spread > Math.max(1, usual * 2) ? null : median(values);
}
