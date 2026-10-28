import type { WeatherOutageComponent, WeatherProviderName, WeatherBackfillState } from "@climate-twin/contracts";
import { WeatherOutageRecord } from "../support/record-types.js";
import { WeatherOutageRow } from "../support/row-types.js";
import { ClimateDataValidationError } from "../support/validation-errors.js";
import { weatherOutageFromRow } from "../support/row-mappers.js";
import { registerDatabaseMethods } from "../core.js";

declare module "../core.js" {
  interface DatabaseInternals {
    noteHistoricalWeatherObservationGap(houseId: string, locationKey: string, provider: WeatherProviderName, startedAt: string, endedAt: string, detectedAt?: string): WeatherOutageRecord;
    noteWeatherOutage(houseId: string, locationKey: string, provider: WeatherProviderName, component: WeatherOutageComponent, error: string, detectedAt?: string): WeatherOutageRecord;
    resolveWeatherOutages(houseId: string, locationKey: string, provider: WeatherProviderName, components: readonly WeatherOutageComponent[], endedAt?: string): WeatherOutageRecord[];
    listWeatherOutages(houseId: string, locationKey: string, limit?: number): WeatherOutageRecord[];
    listActiveWeatherOutages(houseId: string, locationKey: string, limit?: number): WeatherOutageRecord[];
    listWeatherBackfillHistory(houseId: string, locationKey: string, limit?: number): WeatherOutageRecord[];
    listPendingWeatherBackfills(houseId: string, locationKey: string, provider?: WeatherProviderName | null, limit?: number): WeatherOutageRecord[];
    updateWeatherOutageBackfill(id: number, state: WeatherBackfillState, recoveredPoints: number, attemptedAt: string, error: string | null): void;
  }

  interface ClimateDatabaseCore {
    noteHistoricalWeatherObservationGap(houseId: string, locationKey: string, provider: WeatherProviderName, startedAt: string, endedAt: string, detectedAt?: string): WeatherOutageRecord;
    noteWeatherOutage(houseId: string, locationKey: string, provider: WeatherProviderName, component: WeatherOutageComponent, error: string, detectedAt?: string): WeatherOutageRecord;
    resolveWeatherOutages(houseId: string, locationKey: string, provider: WeatherProviderName, components: readonly WeatherOutageComponent[], endedAt?: string): WeatherOutageRecord[];
    listWeatherOutages(houseId: string, locationKey: string, limit?: number): WeatherOutageRecord[];
    listActiveWeatherOutages(houseId: string, locationKey: string, limit?: number): WeatherOutageRecord[];
    listWeatherBackfillHistory(houseId: string, locationKey: string, limit?: number): WeatherOutageRecord[];
    listPendingWeatherBackfills(houseId: string, locationKey: string, provider?: WeatherProviderName | null, limit?: number): WeatherOutageRecord[];
    updateWeatherOutageBackfill(id: number, state: WeatherBackfillState, recoveredPoints: number, attemptedAt: string, error: string | null): void;
  }
}

registerDatabaseMethods({
  noteHistoricalWeatherObservationGap(
      houseId: string,
      locationKey: string,
      provider: WeatherProviderName,
      startedAt: string,
      endedAt: string,
      detectedAt = new Date().toISOString(),
    ): WeatherOutageRecord {
      if (!this.getHouse(houseId)) {
        throw new ClimateDataValidationError(404, "HOUSE_NOT_FOUND", `House ${houseId} does not exist`);
      }
      const existing = this.db.prepare(`SELECT * FROM weather_outages
        WHERE house_id = ? AND location_key = ? AND provider = ?
          AND component = 'observation' AND backfill_from = ? AND backfill_to = ?
        ORDER BY id DESC LIMIT 1`)
        .get(houseId, locationKey, provider, startedAt, endedAt) as unknown as WeatherOutageRow | undefined;
      if (existing) return weatherOutageFromRow(existing);
      const result = this.db.prepare(`INSERT INTO weather_outages
        (house_id, location_key, provider, component, started_at, last_seen_at, ended_at, last_error,
         backfill_state, backfill_from, backfill_to, recovered_points, last_attempt_at, backfill_error)
        VALUES (?, ?, ?, 'observation', ?, ?, ?, ?, 'pending', ?, ?, 0, NULL, NULL)`)
        .run(
          houseId,
          locationKey,
          provider,
          startedAt,
          detectedAt,
          endedAt,
          "A historical observation gap was found in stored weather telemetry",
          startedAt,
          endedAt,
        );
      const inserted = this.db.prepare("SELECT * FROM weather_outages WHERE id = ?")
        .get(Number(result.lastInsertRowid)) as unknown as WeatherOutageRow;
      return weatherOutageFromRow(inserted);
    },
  noteWeatherOutage(
      houseId: string,
      locationKey: string,
      provider: WeatherProviderName,
      component: WeatherOutageComponent,
      error: string,
      detectedAt = new Date().toISOString(),
    ): WeatherOutageRecord {
      if (!this.getHouse(houseId)) {
        throw new ClimateDataValidationError(404, "HOUSE_NOT_FOUND", `House ${houseId} does not exist`);
      }
      this.db.prepare(`INSERT INTO weather_outages
        (house_id, location_key, provider, component, started_at, last_seen_at, ended_at, last_error,
         backfill_state, backfill_from, backfill_to, recovered_points, last_attempt_at, backfill_error)
        VALUES (?, ?, ?, ?, ?, ?, NULL, ?, 'not-needed', NULL, NULL, 0, NULL, NULL)
        ON CONFLICT(house_id, location_key, provider, component) WHERE ended_at IS NULL DO UPDATE SET
          last_seen_at = excluded.last_seen_at,
          last_error = excluded.last_error`)
        .run(houseId, locationKey, provider, component, detectedAt, detectedAt, error);
      const row = this.db.prepare(`SELECT * FROM weather_outages
        WHERE house_id = ? AND location_key = ? AND provider = ? AND component = ? AND ended_at IS NULL`)
        .get(houseId, locationKey, provider, component) as unknown as WeatherOutageRow;
      return weatherOutageFromRow(row);
    },
  resolveWeatherOutages(
      houseId: string,
      locationKey: string,
      provider: WeatherProviderName,
      components: readonly WeatherOutageComponent[],
      endedAt = new Date().toISOString(),
    ): WeatherOutageRecord[] {
      if (components.length === 0) return [];
      const placeholders = components.map(() => "?").join(",");
      this.db.prepare(`UPDATE weather_outages SET
          ended_at = ?,
          backfill_state = CASE WHEN component IN ('service', 'observation') THEN 'pending' ELSE 'not-supported' END,
          backfill_from = CASE WHEN component IN ('service', 'observation') THEN started_at ELSE NULL END,
          backfill_to = CASE WHEN component IN ('service', 'observation') THEN ? ELSE NULL END,
          backfill_error = NULL
        WHERE house_id = ? AND location_key = ? AND provider = ? AND ended_at IS NULL
          AND component IN (${placeholders})`)
        .run(endedAt, endedAt, houseId, locationKey, provider, ...components);
      return this.listWeatherOutages(houseId, locationKey)
        .filter((outage) => outage.endedAt === endedAt && components.includes(outage.component));
    },
  listWeatherOutages(houseId: string, locationKey: string, limit = 50): WeatherOutageRecord[] {
      if (!this.getHouse(houseId)) return [];
      const safeLimit = Math.max(1, Math.min(500, Math.trunc(limit)));
      const rows = this.db.prepare(`SELECT * FROM weather_outages
        WHERE house_id = ? AND location_key = ?
        ORDER BY started_at DESC, id DESC LIMIT ?`)
        .all(houseId, locationKey, safeLimit) as unknown as WeatherOutageRow[];
      return rows.map(weatherOutageFromRow);
    },
  listActiveWeatherOutages(houseId: string, locationKey: string, limit = 20): WeatherOutageRecord[] {
      if (!this.getHouse(houseId)) return [];
      const safeLimit = Math.max(1, Math.min(100, Math.trunc(limit)));
      const rows = this.db.prepare(`SELECT * FROM weather_outages
        WHERE house_id = ? AND location_key = ? AND ended_at IS NULL
        ORDER BY started_at DESC, id DESC LIMIT ?`)
        .all(houseId, locationKey, safeLimit) as unknown as WeatherOutageRow[];
      return rows.map(weatherOutageFromRow);
    },
  listWeatherBackfillHistory(houseId: string, locationKey: string, limit = 50): WeatherOutageRecord[] {
      if (!this.getHouse(houseId)) return [];
      const safeLimit = Math.max(1, Math.min(500, Math.trunc(limit)));
      const rows = this.db.prepare(`SELECT * FROM weather_outages
        WHERE house_id = ? AND location_key = ? AND component IN ('service', 'observation')
        ORDER BY started_at DESC, id DESC LIMIT ?`)
        .all(houseId, locationKey, safeLimit) as unknown as WeatherOutageRow[];
      return rows.map(weatherOutageFromRow);
    },
  listPendingWeatherBackfills(
      houseId: string,
      locationKey: string,
      provider: WeatherProviderName | null = null,
      limit = 500,
    ): WeatherOutageRecord[] {
      if (!this.getHouse(houseId)) return [];
      const safeLimit = Math.max(1, Math.min(500, Math.trunc(limit)));
      const providerPredicate = provider === null ? "" : "AND provider = ?";
      const rows = this.db.prepare(`SELECT * FROM weather_outages
        WHERE house_id = ? AND location_key = ? ${providerPredicate}
          AND ended_at IS NOT NULL
          AND component IN ('service', 'observation')
          AND backfill_state IN ('pending', 'running', 'failed', 'partial')
        ORDER BY CASE WHEN backfill_state = 'failed' THEN 1 ELSE 0 END ASC,
          CASE WHEN backfill_state = 'failed' THEN COALESCE(last_attempt_at, '') ELSE started_at END ASC,
          started_at ASC, id ASC LIMIT ?`);
      const rowsForProvider = provider === null
        ? rows.all(houseId, locationKey, safeLimit)
        : rows.all(houseId, locationKey, provider, safeLimit);
      return (rowsForProvider as unknown as WeatherOutageRow[]).map(weatherOutageFromRow);
    },
  updateWeatherOutageBackfill(
      id: number,
      state: WeatherBackfillState,
      recoveredPoints: number,
      attemptedAt: string,
      error: string | null,
    ): void {
      this.db.prepare(`UPDATE weather_outages SET backfill_state = ?, recovered_points = ?,
        last_attempt_at = ?, backfill_error = ? WHERE id = ?`)
        .run(state, Math.max(0, Math.trunc(recoveredPoints)), attemptedAt, error, id);
    },
});
