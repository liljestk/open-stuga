import type { AdaptiveEvidenceEpoch } from "@climate-twin/contracts";
import type { DatabaseInternals } from "../../db/core.js";
import { outdoorLocationKey } from "../../db/support/outdoor-location.js";
import { HOUR_MS } from "../forecast/models.js";
import { ADAPTIVE_HOUR_RETENTION_MS } from "./closed-hour.js";
import type { AdaptiveOutdoorHour } from "./climate-prediction.js";

interface WeatherRow {
  temperature_c: number;
  timestamp: string;
  fetched_at: string;
  recorded_at: string;
  source: string;
  station_id: string | null;
}

const MAX_WEATHER_ROWS_PER_HOUR = 64;

/** Called inside the indoor capture transaction. The parent row seals absence as well. */
export function sealAdaptiveWeather(database: Pick<DatabaseInternals, "db" | "getHouse">, epoch: AdaptiveEvidenceEpoch, { hour, capturedAt }: {
  hour: number; capturedAt: number;
}): void {
  if (epoch.dataMode !== "live" || epoch.metric !== "temperature" || epoch.purpose !== "climate") return;
  const location = database.getHouse(epoch.houseId)?.location;
  if (!location) return;
  const prior = database.db.prepare(`SELECT source, station_id FROM adaptive_weather_hours
    WHERE epoch_id = ? ORDER BY hour DESC LIMIT 1`).get(epoch.id) as Pick<WeatherRow, "source" | "station_id"> | undefined;
  const rows = database.db.prepare(`SELECT temperature_c, timestamp, fetched_at, recorded_at, source, station_id
    FROM outdoor_temperature_samples
    WHERE house_id = ? AND location_key = ? AND data_mode = 'live'
      AND timestamp >= ? AND timestamp < ? AND recorded_at IS NOT NULL
      AND source IN ('fmi-observation', 'open-meteo-current')
      ${prior ? "AND source = ? AND station_id IS ?" : ""}
    ORDER BY timestamp DESC, source LIMIT ?`)
    .all(epoch.houseId, outdoorLocationKey(location), new Date(hour).toISOString(), new Date(hour + HOUR_MS).toISOString(),
      ...(prior ? [prior.source, prior.station_id] : []), MAX_WEATHER_ROWS_PER_HOUR + 1) as unknown as WeatherRow[];
  if (rows.length > MAX_WEATHER_ROWS_PER_HOUR) return;
  const weather = rows.find((row) => wasAvailable(row, { hour, capturedAt }));
  if (!weather) return;
  database.db.prepare(`INSERT INTO adaptive_weather_hours
    (epoch_id, hour, temperature_c, observed_at, fetched_at, recorded_at, source, station_id)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)`).run(epoch.id, hour, weather.temperature_c, weather.timestamp,
    weather.fetched_at, weather.recorded_at, weather.source, weather.station_id);
}

function wasAvailable(row: WeatherRow, { hour, capturedAt }: { hour: number; capturedAt: number }): boolean {
  const time = Date.parse(row.timestamp);
  const fetched = Date.parse(row.fetched_at);
  const recorded = Date.parse(row.recorded_at);
  return Number.isFinite(row.temperature_c) && time >= hour && time < hour + HOUR_MS
    && time <= fetched && fetched <= recorded && recorded <= capturedAt
    && (row.source !== "fmi-observation" || Boolean(row.station_id));
}

export function readAdaptiveWeather(database: Pick<DatabaseInternals, "db">, epoch: AdaptiveEvidenceEpoch, { from, to, knownAt }: {
  from: number; to: number; knownAt: number;
}): AdaptiveOutdoorHour[] {
  if (epoch.metric !== "temperature" || epoch.purpose !== "climate" || epoch.dataMode !== "live") return [];
  return database.db.prepare(`SELECT weather.hour AS time, weather.temperature_c AS value, capture.captured_at AS availableAt
    FROM adaptive_weather_hours weather JOIN adaptive_hourly_evidence capture USING (epoch_id, hour)
    WHERE weather.epoch_id = ? AND weather.hour >= ? AND weather.hour < ? AND capture.captured_at <= ?
    ORDER BY weather.hour`)
    .all(epoch.id, Math.max(from, Date.now() - ADAPTIVE_HOUR_RETENTION_MS), to, knownAt) as unknown as AdaptiveOutdoorHour[];
}
