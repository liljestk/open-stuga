import { ADAPTIVE_METRICS, type AdaptiveEvidenceEpoch, type AdaptiveEvidenceScope, type AdaptiveMetric, type DataMode } from "@climate-twin/contracts";
import type { ClimateDatabase } from "../../db.js";
import { HOUR_MS } from "../forecast/models.js";
import { ADAPTIVE_HOUR_RETENTION_MS } from "./closed-hour.js";

const LOCAL_ELIGIBLE = `house.deleted_at IS NULL AND (
  house.stugby_json IS NULL OR json_extract(house.stugby_json, '$.ownership') = 'local'
  OR json_extract(house.stugby_json, '$.syncState') = 'detached')
  AND settings.mode = 'shadow' AND settings.revision = (
    SELECT max(newest.revision) FROM adaptive_settings_revisions newest
    WHERE newest.house_id = house.id AND newest.data_mode = settings.data_mode)`;
const METRIC_PARAMETERS = ADAPTIVE_METRICS.map(() => "?").join(", ");
const SUPPORTED_STREAM = `(
  EXISTS (SELECT 1 FROM sensor_measurement_bindings binding
    WHERE binding.sensor_id = sensor.id AND binding.metric = definition.id)
  OR EXISTS (SELECT 1 FROM sensor_recorded_measurements recorded
    WHERE recorded.sensor_id = sensor.id AND recorded.metric = definition.id)
  OR (? = 'demo' AND EXISTS (SELECT 1 FROM measurement_samples sample
    WHERE sample.sensor_id = sensor.id AND sample.metric = definition.id AND sample.data_mode = 'demo'))
)`;

interface Cursor { house_id: string; sensor_id: string; metric: AdaptiveMetric }
type CollectionHourOutcome = "observation" | "gap" | "unavailable" | "scope-changed";

export class AdaptiveCollectionStore {
  constructor(private readonly database: ClimateDatabase) {}

  dataMode(): DataMode {
    return this.database.isRealDataMode() ? "live" : "demo";
  }

  hasOptIn(dataMode: DataMode): boolean {
    return this.database.db.prepare(`SELECT 1 FROM adaptive_settings_revisions settings
      JOIN houses house ON house.id = settings.house_id WHERE settings.data_mode = ? AND ${LOCAL_ELIGIBLE} LIMIT 1`).get(dataMode) !== undefined;
  }

  hasExpiredEvidence(): boolean {
    return this.database.db.prepare("SELECT 1 FROM adaptive_hourly_evidence WHERE hour < ? LIMIT 1")
      .get(Date.now() - ADAPTIVE_HOUR_RETENTION_MS) !== undefined;
  }

  #page(dataMode: DataMode, options: { cursor?: Cursor; wrap?: boolean; limit: number }): Cursor[] {
    if (options.limit <= 0) return [];
    const after = options.cursor
      ? `AND (sensor.house_id, sensor.id, definition.id) ${options.wrap ? "<=" : ">"} (?, ?, ?)`
      : "";
    const cursor = options.cursor ? [options.cursor.house_id, options.cursor.sensor_id, options.cursor.metric] : [];
    return this.database.db.prepare(`SELECT sensor.house_id, sensor.id AS sensor_id, definition.id AS metric
      FROM adaptive_settings_revisions settings
      JOIN houses house ON house.id = settings.house_id
      JOIN sensors sensor ON sensor.house_id = house.id
      JOIN measurement_definitions definition ON definition.id IN (${METRIC_PARAMETERS}) AND definition.enabled = 1
      WHERE settings.data_mode = ? AND ${LOCAL_ELIGIBLE} AND sensor.enabled = 1 ${after}
        AND ${SUPPORTED_STREAM}
      ORDER BY sensor.house_id, sensor.id, definition.id LIMIT ?`)
      .all(...ADAPTIVE_METRICS, dataMode, ...cursor, dataMode, options.limit) as unknown as Cursor[];
  }

  streams(dataMode: DataMode, limit: number): AdaptiveEvidenceScope[] {
    const cursor = this.database.db.prepare(`SELECT house_id, sensor_id, metric FROM adaptive_collection_cursors WHERE data_mode = ?`)
      .get(dataMode) as Cursor | undefined;
    const page = this.#page(dataMode, { ...(cursor ? { cursor } : {}), limit });
    if (cursor && page.length < limit) page.push(...this.#page(dataMode, { cursor, wrap: true, limit: limit - page.length }));
    return page.map(({ house_id, sensor_id, metric }) => ({
      houseId: house_id, sensorId: sensor_id, metric, dataMode, purpose: "climate",
    }));
  }

  houseStreams({ houseId, dataMode }: { houseId: string; dataMode: DataMode }): AdaptiveEvidenceScope[] {
    const rows = this.database.db.prepare(`SELECT sensor.id AS sensor_id, definition.id AS metric
      FROM sensors sensor JOIN measurement_definitions definition
        ON definition.id IN (${METRIC_PARAMETERS}) AND definition.enabled = 1
      WHERE sensor.house_id = ? AND sensor.enabled = 1 AND ${SUPPORTED_STREAM}
      ORDER BY sensor.id, definition.id`).all(...ADAPTIVE_METRICS, houseId, dataMode) as unknown as Omit<Cursor, "house_id">[];
    return rows.map(({ sensor_id, metric }) => ({ houseId, dataMode, sensorId: sensor_id, metric, purpose: "climate" }));
  }

  checkpointStream(scope: AdaptiveEvidenceScope): void {
    this.database.transaction(() => {
      if (this.dataMode() !== scope.dataMode) return;
      this.database.db.prepare(`INSERT INTO adaptive_collection_cursors (data_mode, house_id, sensor_id, metric) VALUES (?, ?, ?, ?)
        ON CONFLICT(data_mode) DO UPDATE SET house_id = excluded.house_id, sensor_id = excluded.sensor_id, metric = excluded.metric`)
        .run(scope.dataMode, scope.houseId, scope.sensorId, scope.metric);
    });
  }

  nextHour(epochId: string): number | null {
    const row = this.database.db.prepare("SELECT next_hour FROM adaptive_collection_progress WHERE epoch_id = ?")
      .get(epochId) as { next_hour: number } | undefined;
    return row?.next_hour ?? null;
  }

  capture(scope: AdaptiveEvidenceScope, epoch: AdaptiveEvidenceEpoch, hour: number): CollectionHourOutcome {
    return this.database.transaction(() => {
      const result = this.database.captureAdaptiveHour({ scope, epochId: epoch.id, hour });
      if (result.status !== "sealed" && result.status !== "local-history-incomplete") return "scope-changed";
      const unavailable = result.status === "local-history-incomplete";
      this.database.db.prepare(`INSERT INTO adaptive_collection_progress
        (epoch_id, next_hour, unavailable_hours, last_unavailable_hour) VALUES (?, ?, ?, ?)
        ON CONFLICT(epoch_id) DO UPDATE SET next_hour = excluded.next_hour,
          unavailable_hours = adaptive_collection_progress.unavailable_hours + excluded.unavailable_hours,
          last_unavailable_hour = coalesce(excluded.last_unavailable_hour, adaptive_collection_progress.last_unavailable_hour)
        WHERE excluded.next_hour > adaptive_collection_progress.next_hour`)
        .run(epoch.id, hour + HOUR_MS, unavailable ? 1 : 0, unavailable ? hour : null);
      if (result.status === "sealed") return result.capture.outcome.evidence ? "observation" : "gap";
      return "unavailable";
    });
  }
}
