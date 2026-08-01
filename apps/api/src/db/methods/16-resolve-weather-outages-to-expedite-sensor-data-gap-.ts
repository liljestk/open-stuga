import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import { DEFAULT_ELECTRICITY_PRICE_ENDPOINT, fixedPlanElementOpeningState } from "@climate-twin/contracts";
import type {
  AreaEquipment,
  AreaEquipmentInput,
  AreaEquipmentPatch,
  EquipmentAttachment,
  EquipmentLink,
  EquipmentLinkInput,
  EquipmentLinkPatch,
  ActionPlaybook,
  ActionPlaybookInput,
  ActionRun,
  ActionRunStartInput,
  AlertEvent,
  AlertDeliveryPolicy,
  AlertRule,
  DailyAnalyticsFindingsSnapshot,
  NotificationDeliveryStage,
  NotificationDeliveryStatus,
  NotificationSubjectKind,
  Floor,
  GeoCoordinate,
  House,
  HouseLocation,
  HouseMapPlacement,
  IOSNotificationRegistration,
  IOSNotificationRegistrationInput,
  MaintenanceTask,
  MaintenanceTaskChangedField,
  MaintenanceTaskInput,
  MaintenanceTaskPatch,
  MaintenanceTaskRevision,
  MaintenanceTaskRevisionActor,
  ManualObservation,
  ManualObservationInput,
  ManualObservationPatch,
  MeasurementDefinition,
  MeasurementSample,
  ObservationChangedField,
  ObservationConfidence,
  ObservationRevision,
  ObservationRevisionActor,
  ObservationSource,
  ObservationTimePrecision,
  OpeningStateObservation,
  OpeningStateObservationInput,
  OutdoorConditions,
  OutdoorTemperatureSample,
  Property,
  PropertyElectricityConfig,
  PropertyElectricityConfigInput,
  PropertyElectricityPricePoint,
  PropertyArea,
  PropertyAreaInput,
  PropertyAreaPatch,
  PropertyCreateInput,
  PropertyNote,
  PropertyNoteInput,
  PropertyNotePatch,
  PropertyPatch,
  Reading,
  Sensor,
  SecurityAuditEvent,
  SecurityAuditEventType,
  SecurityAuditOutcome,
  SecurityAuditSubjectType,
  StaticParameter,
  StugubyHouseLink,
  StugubyPropertyLink,
  TenantMemberRole,
  Wall,
  WeatherBackfillState,
  WeatherOutageComponent,
  WeatherProviderName,
} from "@climate-twin/contracts";
import {
  apnsNotificationSnapshot,
  alertNotificationBindings,
  legacyNotificationDestinationRef,
  notificationSnapshot,
  operationalNotificationSnapshot,
  type AlertNotificationBindings,
} from "../../notification-snapshot.js";
import type { APNSDestination } from "../../apns.js";
import {
  DEFAULT_ALERT_DELIVERY_POLICY,
  normalizeAlertDeliveryPolicy,
  notificationScheduleDecision,
  policyFromJson,
  policyJson,
} from "../../notification-policy.js";
import type { EnergyCostAggregateQuery, EnergyCostAggregateRecord, MeasurementCoverageRecord } from "../../timeseries/types.js";
import { CORE_SCHEMA_SQL } from "../migrations/core-schema.js";
import { TP_LINK_LEGACY_CLIMATE_HISTORY_ERROR, TP_LINK_LOCAL_CLIMATE_HISTORY_REARM_KEY, TP_LINK_LOCAL_CLIMATE_HISTORY_RETENTION_MS } from "../support/01-json-value-to-area-equipment-row.js";
import { SensorDataGapSource, SensorDataGapState, WeatherOutageRecord, WeatherOutageRow } from "../support/02-equipment-attachment-row-to-sensor-data-gap-state.js";
import type { HistoricalTelemetryGap } from "../telemetry-gap-types.js";
import { ClimateDataValidationError, SensorDataGapRecord, SensorDataGapRow } from "../support/03-sensor-data-gap-row-to-canonical-json-value.js";
import { normalizedTapoHistoryText, normalizedTapoHistoryTimestamp, sensorDataGapFromRow, weatherOutageFromRow } from "../support/06-canonical-observation-patch-time-to-outdoor-location.js";
import { registerDatabaseMethods } from "../core.js";

function knownRecoverableUntil(
  source: SensorDataGapSource,
  metric: string,
  startedAt: string,
  sensorModel: string,
): string | null {
  if (source !== "tp-link"
    || (metric !== "temperature" && metric !== "humidity")
    || !/\bT3(?:10|15)\b/i.test(sensorModel)) return null;
  const startedMs = Date.parse(startedAt);
  return Number.isFinite(startedMs)
    ? new Date(startedMs + TP_LINK_LOCAL_CLIMATE_HISTORY_RETENTION_MS).toISOString()
    : null;
}

function recoveryCompleteness(
  state: Exclude<SensorDataGapState, "open" | "pending" | "running">,
  recoveredPoints: number,
): "unknown" | "none" | "partial" | "complete" {
  if (recoveredPoints <= 0) return "none";
  return state === "complete" ? "complete" : "partial";
}

registerDatabaseMethods({
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
  latestMeasurementTimestamp(sensorId: string, metric: string, source: SensorDataGapSource): string | null {
      if (!this.getSensor(sensorId)) return null;
      const row = this.db.prepare(`SELECT timestamp FROM measurement_samples
        WHERE sensor_id = ? AND metric = ? AND source = ?
        ORDER BY timestamp DESC, id DESC LIMIT 1`).get(sensorId, metric, source) as { timestamp?: string } | undefined;
      return row?.timestamp ?? null;
    },
  sensorSourceMetrics(sensorId: string, source: SensorDataGapSource): string[] {
      if (!this.getSensor(sensorId)) return [];
      const rows = this.db.prepare(`SELECT metric, MAX(timestamp) AS latest_timestamp FROM measurement_samples
        WHERE sensor_id = ? AND source = ? GROUP BY metric ORDER BY metric`)
        .all(sensorId, source) as unknown as Array<{ metric: string; latest_timestamp: string }>;
      return rows.map((row) => row.metric);
    },
  measurementSampleGaps(
      sensorId: string,
      metric: string,
      source: SensorDataGapSource,
      from: string,
      to: string,
      minimumGapMs: number,
      limit = 100,
    ): HistoricalTelemetryGap[] {
      if (!this.getSensor(sensorId)) return [];
      const safeLimit = Math.max(1, Math.min(1_000, Math.trunc(limit)));
      const thresholdSeconds = Math.max(1, minimumGapMs / 1_000);
      const rows = this.db.prepare(`WITH ordered AS (
          SELECT timestamp, LAG(timestamp) OVER (ORDER BY timestamp) AS previous_timestamp
          FROM measurement_samples
          WHERE sensor_id = ? AND metric = ? AND source = ?
            AND quality = 'good' AND timestamp >= ? AND timestamp <= ?
        )
        SELECT previous_timestamp AS started_at, timestamp AS ended_at,
          (julianday(timestamp) - julianday(previous_timestamp)) * 86400000.0 AS duration_ms
        FROM ordered
        WHERE previous_timestamp IS NOT NULL
          AND (julianday(timestamp) - julianday(previous_timestamp)) * 86400.0 > ?
          AND NOT EXISTS (
            SELECT 1 FROM sensor_data_gaps AS known
            WHERE known.sensor_id = ? AND known.metric = ? AND known.source = ?
              AND known.started_at <= previous_timestamp
              AND COALESCE(known.ended_at, timestamp) >= timestamp
          )
        ORDER BY previous_timestamp LIMIT ?`)
        .all(
          sensorId, metric, source, from, to, thresholdSeconds,
          sensorId, metric, source, safeLimit,
        ) as unknown as Array<{
          started_at: string;
          ended_at: string;
          duration_ms: number;
        }>;
      return rows.map((row) => ({
        startedAt: row.started_at,
        endedAt: row.ended_at,
        durationMs: Math.max(0, Math.round(row.duration_ms)),
      }));
    },
  unrecordedMeasurementSampleGaps(
      sensorId: string,
      metric: string,
      source: SensorDataGapSource,
      candidates: HistoricalTelemetryGap[],
      limit = 100,
    ): HistoricalTelemetryGap[] {
      if (!this.getSensor(sensorId)) return [];
      if (candidates.length === 0) return [];
      if (candidates.length > 1_000) throw new RangeError("At most 1000 candidate gaps may be filtered");
      const safeLimit = Math.max(1, Math.min(1_000, Math.trunc(limit)));
      const normalized = candidates.map((candidate) => {
        const started = Date.parse(candidate.startedAt);
        const ended = Date.parse(candidate.endedAt);
        if (!Number.isFinite(started) || !Number.isFinite(ended) || ended <= started) {
          throw new RangeError("Candidate gap end must be after its start");
        }
        return {
          ...candidate,
          startedAt: new Date(started).toISOString(),
          endedAt: new Date(ended).toISOString(),
        };
      });
      const rows = this.db.prepare(`WITH candidate_gaps AS (
          SELECT CAST(key AS INTEGER) AS candidate_index,
            json_extract(value, '$.startedAt') AS started_at,
            json_extract(value, '$.endedAt') AS ended_at
          FROM json_each(?)
        )
        SELECT candidate_index FROM candidate_gaps AS candidate
        WHERE NOT EXISTS (
          SELECT 1 FROM sensor_data_gaps AS known
          WHERE known.sensor_id = ? AND known.metric = ? AND known.source = ?
            AND known.started_at <= candidate.started_at
            AND COALESCE(known.ended_at, candidate.ended_at) >= candidate.ended_at
        )
        ORDER BY candidate_index LIMIT ?`)
        .all(JSON.stringify(normalized), sensorId, metric, source, safeLimit) as unknown as Array<{
          candidate_index: number;
        }>;
      return rows.map((row) => normalized[Number(row.candidate_index)]!);
    },
  noteHistoricalSensorDataGap(
      sensorId: string,
      metric: string,
      source: SensorDataGapSource,
      startedAt: string,
      endedAt: string,
      detectedAt = new Date().toISOString(),
    ): SensorDataGapRecord {
      if (!this.getSensor(sensorId)) {
        throw new ClimateDataValidationError(404, "SENSOR_NOT_FOUND", `Sensor ${sensorId} does not exist`);
      }
      const existing = this.db.prepare(`SELECT * FROM sensor_data_gaps
        WHERE sensor_id = ? AND metric = ? AND source = ? AND started_at = ? AND ended_at = ?
        ORDER BY id DESC LIMIT 1`)
        .get(sensorId, metric, source, startedAt, endedAt) as unknown as SensorDataGapRow | undefined;
      if (existing) return sensorDataGapFromRow(existing);
      const recoverableUntil = knownRecoverableUntil(
        source,
        metric,
        startedAt,
        this.getSensor(sensorId)?.model ?? "",
      );
      const result = this.db.prepare(`INSERT INTO sensor_data_gaps
        (sensor_id, metric, source, started_at, detected_at, ended_at, recovery_state,
         recoverable_until, recovery_completeness, recovered_points, attempt_count,
         last_attempt_at, next_attempt_at, recovery_error)
        VALUES (?, ?, ?, ?, ?, ?, 'pending', ?, 'unknown', 0, 0, NULL, ?, NULL)`)
        .run(sensorId, metric, source, startedAt, detectedAt, endedAt, recoverableUntil, detectedAt);
      const inserted = this.db.prepare("SELECT * FROM sensor_data_gaps WHERE id = ?")
        .get(Number(result.lastInsertRowid)) as unknown as SensorDataGapRow;
      return sensorDataGapFromRow(inserted);
    },
  /** Explicitly rearms one closed historical gap without disturbing an active recovery lease. */
  rearmSensorDataGapRecovery(
      id: number,
      availableAt = new Date().toISOString(),
      resetAttempts = true,
    ): SensorDataGapRecord | null {
      const at = normalizedTapoHistoryTimestamp(availableAt, "availableAt");
      const result = this.db.prepare(`UPDATE sensor_data_gaps SET recovery_state = 'pending',
          attempt_count = CASE WHEN ? = 1 THEN 0 ELSE attempt_count END,
          recovery_completeness = CASE WHEN recovered_points > 0 THEN 'partial' ELSE 'none' END,
          next_attempt_at = ?, recovery_error = NULL
        WHERE id = ? AND ended_at IS NOT NULL AND recovery_state <> 'running'`)
        .run(resetAttempts ? 1 : 0, at, id);
      return Number(result.changes) > 0 ? this.sensorDataGap(id) : this.sensorDataGap(id);
    },
  /** Rearms persisted TP-Link gaps after a previously unavailable fallback is configured. */
  rearmNotSupportedSensorDataGaps(
      source: SensorDataGapSource,
      capabilityRevision: string,
      availableAt = new Date().toISOString(),
    ): number {
      const at = normalizedTapoHistoryTimestamp(availableAt, "availableAt");
      const revision = normalizedTapoHistoryText(capabilityRevision, "capabilityRevision", 200);
      const key = `sensor-gap-rearm:${source}`;
      return this.immediateTransaction(() => {
        const current = this.db.prepare("SELECT value FROM metadata WHERE key = ?")
          .get(key) as { value: string } | undefined;
        if (current?.value === revision) return 0;
        const result = this.db.prepare(`UPDATE sensor_data_gaps SET recovery_state = 'pending',
            attempt_count = 0,
            recovery_completeness = CASE WHEN recovered_points > 0 THEN 'partial' ELSE 'none' END,
            next_attempt_at = ?, recovery_error = NULL
          WHERE id IN (
            SELECT gap.id FROM sensor_data_gaps AS gap
            JOIN sensors AS sensor ON sensor.id = gap.sensor_id
            JOIN measurement_definitions AS definition ON definition.id = gap.metric
            WHERE gap.source = ? AND gap.ended_at IS NOT NULL
              AND gap.recovery_state = 'not-supported'
              AND sensor.enabled = 1 AND definition.enabled = 1
              AND sensor.tp_link_device_id IS NOT NULL AND trim(sensor.tp_link_device_id) <> ''
          )`).run(at, source);
        this.db.prepare(`INSERT INTO metadata(key, value) VALUES (?, ?)
          ON CONFLICT(key) DO UPDATE SET value = excluded.value`).run(key, revision);
        return Number(result.changes);
      });
    },
  /**
     * Rearms the obsolete T310/T315 capability failure once local retained
     * history becomes available. Gaps outside the hub's retained window remain
     * terminal because retrying them locally can no longer recover the range.
     */
  rearmRetainedTpLinkClimateHistoryGaps(
      capabilityRevision: string,
      availableAt = new Date().toISOString(),
    ): number {
      const at = normalizedTapoHistoryTimestamp(availableAt, "availableAt");
      const revision = normalizedTapoHistoryText(capabilityRevision, "capabilityRevision", 200);
      const retainedAfter = new Date(Date.parse(at) - TP_LINK_LOCAL_CLIMATE_HISTORY_RETENTION_MS).toISOString();
      return this.immediateTransaction(() => {
        const current = this.db.prepare("SELECT value FROM metadata WHERE key = ?")
          .get(TP_LINK_LOCAL_CLIMATE_HISTORY_REARM_KEY) as { value: string } | undefined;
        if (current?.value === revision) return 0;
        const result = this.db.prepare(`UPDATE sensor_data_gaps SET recovery_state = 'pending',
            attempt_count = 0,
            recovery_completeness = CASE WHEN recovered_points > 0 THEN 'partial' ELSE 'none' END,
            next_attempt_at = ?, recovery_error = NULL
          WHERE id IN (
            SELECT gap.id FROM sensor_data_gaps AS gap
            JOIN sensors AS sensor ON sensor.id = gap.sensor_id
            JOIN measurement_definitions AS definition ON definition.id = gap.metric
            WHERE gap.source = 'tp-link' AND gap.ended_at IS NOT NULL
              AND gap.recovery_state = 'not-supported'
              AND gap.metric IN ('temperature', 'humidity')
              AND gap.recovery_error = ?
              AND gap.started_at >= ? AND gap.ended_at <= ?
              AND sensor.enabled = 1 AND definition.enabled = 1
              AND sensor.tp_link_device_id IS NOT NULL AND trim(sensor.tp_link_device_id) <> ''
          )`).run(at, TP_LINK_LEGACY_CLIMATE_HISTORY_ERROR, retainedAfter, at);
        this.db.prepare(`INSERT INTO metadata(key, value) VALUES (?, ?)
          ON CONFLICT(key) DO UPDATE SET value = excluded.value`)
          .run(TP_LINK_LOCAL_CLIMATE_HISTORY_REARM_KEY, revision);
        return Number(result.changes);
      });
    },
  rearmEligibleNotSupportedTapoGaps(sensorId: string | null, metric: string | null): number {
      const at = new Date().toISOString();
      const retainedAfter = new Date(Date.parse(at) - TP_LINK_LOCAL_CLIMATE_HISTORY_RETENTION_MS).toISOString();
      const result = this.db.prepare(`UPDATE sensor_data_gaps SET recovery_state = 'pending',
          attempt_count = 0,
          recovery_completeness = CASE WHEN recovered_points > 0 THEN 'partial' ELSE 'none' END,
          next_attempt_at = ?, recovery_error = NULL
        WHERE source = 'tp-link' AND ended_at IS NOT NULL AND recovery_state = 'not-supported'
          AND (? IS NULL OR sensor_id = ?) AND (? IS NULL OR metric = ?)
          AND (
            EXISTS (SELECT 1 FROM metadata WHERE key = 'sensor-gap-rearm:tp-link')
            OR (
              EXISTS (SELECT 1 FROM metadata WHERE key = ?)
              AND sensor_data_gaps.metric IN ('temperature', 'humidity')
              AND sensor_data_gaps.recovery_error = ?
              AND sensor_data_gaps.started_at >= ? AND sensor_data_gaps.ended_at <= ?
            )
          )
          AND EXISTS (
            SELECT 1 FROM sensors AS sensor
            WHERE sensor.id = sensor_data_gaps.sensor_id AND sensor.enabled = 1
              AND sensor.tp_link_device_id IS NOT NULL AND trim(sensor.tp_link_device_id) <> ''
          )
          AND EXISTS (
            SELECT 1 FROM measurement_definitions AS definition
            WHERE definition.id = sensor_data_gaps.metric AND definition.enabled = 1
          )`).run(
        at, sensorId, sensorId, metric, metric,
        TP_LINK_LOCAL_CLIMATE_HISTORY_REARM_KEY, TP_LINK_LEGACY_CLIMATE_HISTORY_ERROR, retainedAfter, at,
      );
      return Number(result.changes);
    },
  openSensorDataGap(sensorId: string, metric: string, source: SensorDataGapSource): SensorDataGapRecord | null {
      const row = this.db.prepare(`SELECT * FROM sensor_data_gaps
        WHERE sensor_id = ? AND metric = ? AND source = ? AND ended_at IS NULL LIMIT 1`)
        .get(sensorId, metric, source) as unknown as SensorDataGapRow | undefined;
      return row ? sensorDataGapFromRow(row) : null;
    },
  noteSensorDataGap(
      sensorId: string,
      metric: string,
      source: SensorDataGapSource,
      startedAt: string,
      detectedAt = new Date().toISOString(),
    ): SensorDataGapRecord {
      const recoverableUntil = knownRecoverableUntil(
        source,
        metric,
        startedAt,
        this.getSensor(sensorId)?.model ?? "",
      );
      this.db.prepare(`INSERT INTO sensor_data_gaps
        (sensor_id, metric, source, started_at, detected_at, ended_at, recovery_state,
         recoverable_until, recovery_completeness, recovered_points, attempt_count,
         last_attempt_at, next_attempt_at, recovery_error)
        VALUES (?, ?, ?, ?, ?, NULL, 'open', ?, 'unknown', 0, 0, NULL, NULL, NULL)
        ON CONFLICT(sensor_id, metric, source) WHERE ended_at IS NULL DO UPDATE SET
          detected_at = excluded.detected_at`)
        .run(sensorId, metric, source, startedAt, detectedAt, recoverableUntil);
      const gap = this.openSensorDataGap(sensorId, metric, source);
      if (!gap) throw new Error("Could not persist the detected sensor data gap");
      return gap;
    },
  resolveSensorDataGap(
      sensorId: string,
      metric: string,
      source: SensorDataGapSource,
      endedAt = new Date().toISOString(),
    ): SensorDataGapRecord | null {
      const current = this.openSensorDataGap(sensorId, metric, source);
      if (!current) return null;
      const normalizedEnd = Date.parse(endedAt) > Date.parse(current.startedAt) ? endedAt : current.detectedAt;
      this.db.prepare(`UPDATE sensor_data_gaps SET ended_at = ?, recovery_state = 'pending',
        next_attempt_at = ?, recovery_error = NULL WHERE id = ? AND ended_at IS NULL`)
        .run(normalizedEnd, normalizedEnd, current.id);
      return this.sensorDataGap(current.id);
    },
  sensorDataGap(id: number): SensorDataGapRecord | null {
      const row = this.db.prepare(`SELECT gap.* FROM sensor_data_gaps AS gap
        JOIN sensors AS sensor ON sensor.id = gap.sensor_id
        JOIN houses AS house ON house.id = sensor.house_id
        WHERE gap.id = ? AND house.deleted_at IS NULL`).get(id) as unknown as SensorDataGapRow | undefined;
      return row ? sensorDataGapFromRow(row) : null;
    },
  listSensorDataGaps(sensorId?: string, limit = 100): SensorDataGapRecord[] {
      const safeLimit = Math.max(1, Math.min(1_000, Math.trunc(limit)));
      const rows = this.db.prepare(`SELECT gap.* FROM sensor_data_gaps AS gap
        JOIN sensors AS sensor ON sensor.id = gap.sensor_id
        JOIN houses AS house ON house.id = sensor.house_id
        WHERE house.deleted_at IS NULL ${sensorId ? "AND gap.sensor_id = ?" : ""}
        ORDER BY gap.started_at DESC, gap.id DESC LIMIT ?`)
        .all(...(sensorId ? [sensorId, safeLimit] : [safeLimit])) as unknown as SensorDataGapRow[];
      return rows.map(sensorDataGapFromRow);
    },
  listHouseSensorDataGaps(houseId: string, sensorId?: string, limit = 100): SensorDataGapRecord[] {
      const safeLimit = Math.max(1, Math.min(1_000, Math.trunc(limit)));
      const rows = this.db.prepare(`SELECT gap.* FROM sensor_data_gaps AS gap
        JOIN sensors AS sensor ON sensor.id = gap.sensor_id
        JOIN houses AS house ON house.id = sensor.house_id
        WHERE sensor.house_id = ? AND house.deleted_at IS NULL
          ${sensorId ? "AND gap.sensor_id = ?" : ""}
        ORDER BY gap.started_at DESC, gap.id DESC LIMIT ?`)
        .all(...(sensorId ? [houseId, sensorId, safeLimit] : [houseId, safeLimit])) as unknown as SensorDataGapRow[];
      return rows.map(sensorDataGapFromRow);
    },
  recoverableSensorDataGaps(now = new Date().toISOString(), limit = 100): SensorDataGapRecord[] {
      const safeLimit = Math.max(1, Math.min(500, Math.trunc(limit)));
      const rows = this.db.prepare(`SELECT gap.* FROM sensor_data_gaps AS gap
        JOIN sensors AS sensor ON sensor.id = gap.sensor_id
        JOIN houses AS house ON house.id = sensor.house_id
        WHERE house.deleted_at IS NULL AND gap.ended_at IS NOT NULL
          AND gap.recovery_state IN ('pending', 'failed', 'partial', 'running')
          AND (gap.next_attempt_at IS NULL OR gap.next_attempt_at <= ?)
        ORDER BY COALESCE(gap.next_attempt_at, gap.ended_at), gap.id LIMIT ?`)
        .all(now, safeLimit) as unknown as SensorDataGapRow[];
      return rows.map(sensorDataGapFromRow);
    },
  claimSensorDataGapRecovery(id: number, attemptedAt: string, leaseUntil: string): SensorDataGapRecord | null {
      const result = this.db.prepare(`UPDATE sensor_data_gaps SET recovery_state = 'running',
        attempt_count = attempt_count + 1, last_attempt_at = ?, next_attempt_at = ?, recovery_error = NULL
        WHERE id = ? AND ended_at IS NOT NULL
          AND recovery_state IN ('pending', 'failed', 'partial', 'running')
          AND (next_attempt_at IS NULL OR next_attempt_at <= ?)`)
        .run(attemptedAt, leaseUntil, id, attemptedAt);
      return Number(result.changes) > 0 ? this.sensorDataGap(id) : null;
    },
  updateSensorDataGapRecovery(
      id: number,
      state: Exclude<SensorDataGapState, "open" | "pending" | "running">,
      recoveredPoints: number,
      attemptedAt: string,
      error: string | null,
      nextAttemptAt: string | null = null,
    ): void {
      const completeness = recoveryCompleteness(state, recoveredPoints);
      this.db.prepare(`UPDATE sensor_data_gaps SET recovery_state = ?, recovered_points = ?,
        recovery_completeness = ?, last_attempt_at = ?, next_attempt_at = ?, recovery_error = ? WHERE id = ?`)
        .run(
          state,
          Math.max(0, Math.trunc(recoveredPoints)),
          completeness,
          attemptedAt,
          nextAttemptAt,
          error,
          id,
        );
    },
  /** Makes a completed asynchronous export immediately eligible for the gap coordinator's next pass. */
  expediteSensorDataGapRecovery(
      sensorId: string,
      source: SensorDataGapSource,
      from: string,
      to: string,
      now = new Date().toISOString(),
    ): number {
      const rangeStart = normalizedTapoHistoryTimestamp(from, "from");
      const rangeEnd = normalizedTapoHistoryTimestamp(to, "to");
      const attemptedAt = normalizedTapoHistoryTimestamp(now, "now");
      if (Date.parse(rangeStart) > Date.parse(rangeEnd)) {
        throw new ClimateDataValidationError(422, "INVALID_SENSOR_GAP_RANGE", "from must be before or equal to to");
      }
      const result = this.db.prepare(`UPDATE sensor_data_gaps SET next_attempt_at = ?, recovery_error = NULL
        WHERE sensor_id = ? AND source = ? AND ended_at IS NOT NULL
          AND recovery_state IN ('partial', 'failed')
          AND started_at <= ? AND ended_at >= ?`)
        .run(attemptedAt, sensorId, source, rangeEnd, rangeStart);
      return Number(result.changes);
    },
});
