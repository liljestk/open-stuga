import { randomUUID } from "node:crypto";
import type {
  PersistedSpatialLayerSnapshot,
  SpatialConfigurationVersion,
  SpatialCalibrationSession,
  SpatialDataPartition,
  SpatialEngineAssignment,
  SpatialGroundTruth,
  SpatialInferenceRun,
  SpatialLayerSnapshotDraft,
  SpatialRunStatus,
  SpatialScope,
  StoredSpatialContextEvent,
  StoredSpatialSensorBinding,
  StoredSpatialSensorCalibration,
} from "../../types.js";
import { FAR_FUTURE, NonDeterministicSpatialOutputError, SpatialStateValidationError, SqlRow, assertInterval, assertIsoTimestamp, calibrationMethodForStorage, calibrationMethodFromStorage, contentHash, parseJson, partitionParams, runFromRow, scopeParams, snapshotFromRow, stableJson } from "../support/01-far-future-to-spatial-inference-job.js";
import { registerSpatialLayerStateStoreMethods, type SpatialLayerStateStoreInternals } from "../core.js";

registerSpatialLayerStateStoreMethods({
  putConfigurationBundle(this: SpatialLayerStateStoreInternals, input: {
      partition: SpatialDataPartition;
      scope: SpatialScope;
      baseVersion: number;
      config: Record<string, unknown>;
      assignments: Array<Omit<SpatialEngineAssignment, "scope" | "configVersion" | "updatedAt">>;
      createdAt?: string;
      createdBy?: string | null;
    }): { configuration: SpatialConfigurationVersion; assignments: SpatialEngineAssignment[] } {
      return this.transaction(() => {
        const createdAt = input.createdAt ?? new Date().toISOString();
        const configuration = this.putConfiguration({
          partition: input.partition,
          scope: input.scope,
          baseVersion: input.baseVersion,
          config: input.config,
          createdAt,
          createdBy: input.createdBy ?? null,
        });
        const assignments = input.assignments.map((assignment) => this.putAssignment(input.partition, {
          ...assignment,
          scope: input.scope,
          configVersion: configuration.version,
          updatedAt: createdAt,
        }));
        return { configuration, assignments };
      });
    },
  listAssignments(this: SpatialLayerStateStoreInternals, partition: SpatialDataPartition, scope: SpatialScope, includeDisabled = true): SpatialEngineAssignment[] {
      const disabledClause = includeDisabled ? "" : "AND enabled = 1";
      const rows = this.db.prepare(`SELECT * FROM spatial_engine_assignments
        WHERE source_db_id = ? AND data_mode = ? AND scope_kind = ? AND scope_id = ? ${disabledClause}
        ORDER BY engine_id`).all(...partitionParams(partition), ...scopeParams(scope)) as SqlRow[];
      return rows.map((row) => ({
        scope,
        engineId: String(row.engine_id),
        engineVersion: String(row.engine_version),
        enabled: Number(row.enabled) === 1,
        layerIds: parseJson<string[]>(row.layer_ids_json),
        configVersion: Number(row.config_version),
        updatedAt: String(row.updated_at),
      }));
    },
  putAssignment(this: SpatialLayerStateStoreInternals, partition: SpatialDataPartition, assignment: SpatialEngineAssignment): SpatialEngineAssignment {
      this.db.prepare(`INSERT INTO spatial_engine_assignments
        (source_db_id, data_mode, scope_kind, scope_id, engine_id, engine_version, enabled, layer_ids_json, config_version, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(source_db_id, data_mode, scope_kind, scope_id, engine_id) DO UPDATE SET
          engine_version = excluded.engine_version, enabled = excluded.enabled,
          layer_ids_json = excluded.layer_ids_json, config_version = excluded.config_version, updated_at = excluded.updated_at`)
        .run(...partitionParams(partition), ...scopeParams(assignment.scope), assignment.engineId, assignment.engineVersion,
          assignment.enabled ? 1 : 0, stableJson(assignment.layerIds), assignment.configVersion, assignment.updatedAt);
      return structuredClone(assignment);
    },
  putAssignments(this: SpatialLayerStateStoreInternals, partition: SpatialDataPartition, assignments: SpatialEngineAssignment[]): SpatialEngineAssignment[] {
      return this.transaction(() => assignments.map((assignment) => this.putAssignment(partition, assignment)));
    },
  addBinding(this: SpatialLayerStateStoreInternals, partition: SpatialDataPartition, binding: StoredSpatialSensorBinding): StoredSpatialSensorBinding {
      assertInterval(binding.activeFrom, binding.activeTo ?? null, "activeFrom", "activeTo");
      const overlap = this.db.prepare(`SELECT id FROM spatial_sensor_bindings
        WHERE source_db_id = ? AND data_mode = ? AND sensor_id = ?
          AND active_from < COALESCE(?, ?) AND COALESCE(active_to, ?) > ? LIMIT 1`)
        .get(...partitionParams(partition), binding.sensorId, binding.activeTo ?? null, FAR_FUTURE, FAR_FUTURE, binding.activeFrom) as SqlRow | undefined;
      if (overlap) {
        throw new SpatialStateValidationError(409, "BINDING_INTERVAL_OVERLAP", `Sensor ${binding.sensorId} already has a binding in this interval`);
      }
      this.db.prepare(`INSERT INTO spatial_sensor_bindings
        (source_db_id, data_mode, id, house_id, sensor_id, zone_id, role, placement_json, active_from, active_to, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
        .run(...partitionParams(partition), binding.id, binding.houseId, binding.sensorId, binding.zoneId, binding.role,
          stableJson({
            frameId: binding.frameId,
            position: binding.position,
            placementRisks: binding.placementRisks ?? [],
          }), binding.activeFrom, binding.activeTo ?? null, binding.createdAt);
      return structuredClone(binding);
    },
  listBindings(this: SpatialLayerStateStoreInternals, partition: SpatialDataPartition, houseId: string, from?: string, to?: string): StoredSpatialSensorBinding[] {
      const rows = (from && to
        ? this.db.prepare(`SELECT * FROM spatial_sensor_bindings WHERE source_db_id = ? AND data_mode = ? AND house_id = ?
            AND active_from <= ? AND COALESCE(active_to, ?) >= ? ORDER BY sensor_id, active_from`)
          .all(...partitionParams(partition), houseId, to, FAR_FUTURE, from)
        : this.db.prepare(`SELECT * FROM spatial_sensor_bindings WHERE source_db_id = ? AND data_mode = ? AND house_id = ?
            ORDER BY sensor_id, active_from`).all(...partitionParams(partition), houseId)) as SqlRow[];
      return rows.map((row) => {
        const placement = parseJson<{
          frameId: string;
          position: { x: number; y: number; z: number };
          placementRisks: StoredSpatialSensorBinding["placementRisks"];
        }>(row.placement_json);
        return {
          id: String(row.id), houseId: String(row.house_id), sensorId: String(row.sensor_id), zoneId: String(row.zone_id),
          role: row.role as StoredSpatialSensorBinding["role"], frameId: placement.frameId, position: placement.position,
          activeFrom: String(row.active_from), ...(row.active_to === null ? {} : { activeTo: String(row.active_to) }),
          ...(placement.placementRisks && placement.placementRisks.length > 0 ? { placementRisks: placement.placementRisks } : {}),
          createdAt: String(row.created_at),
        };
      });
    },
  addCalibration(this: SpatialLayerStateStoreInternals, partition: SpatialDataPartition, calibration: StoredSpatialSensorCalibration): StoredSpatialSensorCalibration {
      assertInterval(calibration.validFrom, calibration.validTo ?? null, "validFrom", "validTo");
      if (!Number.isFinite(calibration.confidence) || calibration.confidence < 0 || calibration.confidence > 1) {
        throw new SpatialStateValidationError(400, "INVALID_CONFIDENCE", "Calibration confidence must be between 0 and 1");
      }
      const overlap = this.db.prepare(`SELECT id FROM spatial_sensor_calibrations
        WHERE source_db_id = ? AND data_mode = ? AND sensor_id = ?
          AND valid_from < COALESCE(?, ?) AND COALESCE(valid_to, ?) > ? LIMIT 1`)
        .get(...partitionParams(partition), calibration.sensorId, calibration.validTo ?? null, FAR_FUTURE, FAR_FUTURE, calibration.validFrom) as SqlRow | undefined;
      if (overlap) {
        throw new SpatialStateValidationError(409, "CALIBRATION_INTERVAL_OVERLAP", `Sensor ${calibration.sensorId} already has calibration in this interval`);
      }
      this.db.prepare(`INSERT INTO spatial_sensor_calibrations
        (source_db_id, data_mode, id, house_id, sensor_id, valid_from, valid_to, temperature_offset_c,
         humidity_offset_pct, response_lag_seconds, confidence, method, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
        .run(...partitionParams(partition), calibration.id, calibration.houseId, calibration.sensorId,
          calibration.validFrom, calibration.validTo ?? null, calibration.temperatureOffsetC, calibration.humidityOffsetPct,
          calibration.responseLagSeconds ?? null, calibration.confidence, calibrationMethodForStorage(calibration.method), calibration.createdAt);
      return structuredClone(calibration);
    },
  listCalibrations(this: SpatialLayerStateStoreInternals, partition: SpatialDataPartition, houseId: string, from?: string, to?: string): StoredSpatialSensorCalibration[] {
      const rows = (from && to
        ? this.db.prepare(`SELECT * FROM spatial_sensor_calibrations WHERE source_db_id = ? AND data_mode = ? AND house_id = ?
            AND valid_from <= ? AND COALESCE(valid_to, ?) >= ? ORDER BY sensor_id, valid_from`)
          .all(...partitionParams(partition), houseId, to, FAR_FUTURE, from)
        : this.db.prepare(`SELECT * FROM spatial_sensor_calibrations WHERE source_db_id = ? AND data_mode = ? AND house_id = ?
            ORDER BY sensor_id, valid_from`).all(...partitionParams(partition), houseId)) as SqlRow[];
      return rows.map((row) => ({
        id: String(row.id), houseId: String(row.house_id), sensorId: String(row.sensor_id), validFrom: String(row.valid_from),
        ...(row.valid_to === null ? {} : { validTo: String(row.valid_to) }), temperatureOffsetC: Number(row.temperature_offset_c),
        humidityOffsetPct: Number(row.humidity_offset_pct), ...(row.response_lag_seconds === null ? {} : { responseLagSeconds: Number(row.response_lag_seconds) }),
        confidence: Number(row.confidence), method: calibrationMethodFromStorage(row.method), createdAt: String(row.created_at),
      }));
    },
  addCalibrationSession(this: SpatialLayerStateStoreInternals, partition: SpatialDataPartition, session: SpatialCalibrationSession): SpatialCalibrationSession {
      assertInterval(session.startAt, session.endAt, "startAt", "endAt");
      this.db.prepare(`INSERT INTO spatial_calibration_sessions
        (source_db_id, data_mode, id, house_id, kind, status, start_at, end_at, intervention_json, notes, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
        .run(...partitionParams(partition), session.id, session.houseId, session.kind, session.status, session.startAt,
          session.endAt, stableJson(session.intervention), session.notes, session.createdAt, session.updatedAt);
      return structuredClone(session);
    },
  /**
     * Store a calibration session and its child calibrations as one durable unit.
     *
     * Route-level parsing deliberately happens before this method is called, but
     * database constraints (including interval overlap checks) can still fail.
     * Keeping both inserts in the same SQLite transaction prevents a session or
     * an earlier child from surviving a later-child failure.
     */
  addCalibrationSessionBundle(this: SpatialLayerStateStoreInternals,
      partition: SpatialDataPartition,
      session: SpatialCalibrationSession,
      calibrations: StoredSpatialSensorCalibration[],
    ): { session: SpatialCalibrationSession; calibrations: StoredSpatialSensorCalibration[] } {
      return this.transaction(() => ({
        session: this.addCalibrationSession(partition, session),
        calibrations: calibrations.map((calibration) => this.addCalibration(partition, calibration)),
      }));
    },
  listCalibrationSessions(this: SpatialLayerStateStoreInternals, partition: SpatialDataPartition, houseId: string): SpatialCalibrationSession[] {
      const rows = this.db.prepare(`SELECT * FROM spatial_calibration_sessions
        WHERE source_db_id = ? AND data_mode = ? AND house_id = ? ORDER BY start_at DESC`)
        .all(...partitionParams(partition), houseId) as SqlRow[];
      return rows.map((row) => ({
        id: String(row.id), houseId: String(row.house_id), kind: row.kind as SpatialCalibrationSession["kind"],
        status: row.status as SpatialCalibrationSession["status"], startAt: String(row.start_at),
        endAt: row.end_at === null ? null : String(row.end_at), intervention: parseJson<Record<string, unknown>>(row.intervention_json),
        notes: row.notes === null ? null : String(row.notes), createdAt: String(row.created_at), updatedAt: String(row.updated_at),
      }));
    },
  addContextEvent(this: SpatialLayerStateStoreInternals, partition: SpatialDataPartition, event: StoredSpatialContextEvent): StoredSpatialContextEvent {
      assertInterval(event.startAt, event.endAt ?? null, "startAt", "endAt");
      this.db.prepare(`INSERT INTO spatial_context_events
        (source_db_id, data_mode, id, house_id, event_type, start_at, end_at, zone_id, source, payload_json, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
        .run(...partitionParams(partition), event.id, event.houseId, event.kind, event.startAt, event.endAt ?? null,
          event.zoneIds?.[0] ?? null, event.source, stableJson({
            ...event.payload,
            ...(event.zoneIds === undefined ? {} : { zoneIds: event.zoneIds }),
            ...(event.strength === undefined ? {} : { strength: event.strength }),
          }), event.createdAt);
      return structuredClone(event);
    },
  listContextEvents(this: SpatialLayerStateStoreInternals, partition: SpatialDataPartition, houseId: string, from: string, to: string): StoredSpatialContextEvent[] {
      const rows = this.db.prepare(`SELECT * FROM spatial_context_events
        WHERE source_db_id = ? AND data_mode = ? AND house_id = ?
          AND start_at <= ? AND COALESCE(end_at, start_at) >= ? ORDER BY start_at`)
        .all(...partitionParams(partition), houseId, to, from) as SqlRow[];
      return rows.map((row) => {
        const payload = parseJson<Record<string, unknown> & { zoneIds?: string[]; strength?: number }>(row.payload_json);
        const { zoneIds, strength, ...extra } = payload;
        return {
          id: String(row.id), houseId: String(row.house_id), kind: String(row.event_type) as StoredSpatialContextEvent["kind"],
          startAt: String(row.start_at), ...(row.end_at === null ? {} : { endAt: String(row.end_at) }),
          ...(zoneIds === undefined ? {} : { zoneIds }), ...(strength === undefined ? {} : { strength }),
          source: String(row.source), payload: extra, createdAt: String(row.created_at),
        };
      });
    },
  addGroundTruth(this: SpatialLayerStateStoreInternals, partition: SpatialDataPartition, truth: SpatialGroundTruth): SpatialGroundTruth {
      assertInterval(truth.startAt, truth.endAt, "startAt", "endAt");
      this.db.prepare(`INSERT INTO spatial_ground_truth
        (source_db_id, data_mode, id, scope_kind, scope_id, start_at, end_at, label, zone_id, from_zone_id,
         to_zone_id, source, note, created_at, created_by) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
        .run(...partitionParams(partition), truth.id, ...scopeParams(truth.scope), truth.startAt, truth.endAt, truth.label,
          truth.zoneId, truth.fromZoneId, truth.toZoneId, truth.source, truth.note, truth.createdAt, truth.createdBy);
      return structuredClone(truth);
    },
  listGroundTruth(this: SpatialLayerStateStoreInternals, partition: SpatialDataPartition, scope: SpatialScope, from?: string, to?: string): SpatialGroundTruth[] {
      const rows = (from && to
        ? this.db.prepare(`SELECT * FROM spatial_ground_truth WHERE source_db_id = ? AND data_mode = ? AND scope_kind = ? AND scope_id = ?
            AND start_at <= ? AND COALESCE(end_at, start_at) >= ? ORDER BY start_at DESC`)
          .all(...partitionParams(partition), ...scopeParams(scope), to, from)
        : this.db.prepare(`SELECT * FROM spatial_ground_truth WHERE source_db_id = ? AND data_mode = ? AND scope_kind = ? AND scope_id = ?
            ORDER BY start_at DESC`).all(...partitionParams(partition), ...scopeParams(scope))) as SqlRow[];
      return rows.map((row) => ({
        id: String(row.id), scope, startAt: String(row.start_at), endAt: row.end_at === null ? null : String(row.end_at),
        label: String(row.label), zoneId: row.zone_id === null ? null : String(row.zone_id),
        fromZoneId: row.from_zone_id === null ? null : String(row.from_zone_id), toZoneId: row.to_zone_id === null ? null : String(row.to_zone_id),
        source: row.source as SpatialGroundTruth["source"], note: row.note === null ? null : String(row.note),
        createdAt: String(row.created_at), createdBy: row.created_by === null ? null : String(row.created_by),
      }));
    },
  startRun(this: SpatialLayerStateStoreInternals, input: Omit<SpatialInferenceRun, "id" | "status" | "finishedAt" | "inputDigest" | "snapshotIds" | "errorCode" | "errorMessage" | "durationMs"> & { id?: string }): SpatialInferenceRun {
      const run: SpatialInferenceRun = {
        ...input,
        id: input.id ?? randomUUID(),
        status: "running",
        finishedAt: null,
        inputDigest: null,
        snapshotIds: [],
        errorCode: null,
        errorMessage: null,
        durationMs: null,
      };
      this.db.prepare(`INSERT INTO spatial_inference_runs
        (source_db_id, data_mode, id, scope_kind, scope_id, engine_id, engine_version, bucket_at, config_version,
         status, started_at, finished_at, input_digest, snapshot_ids_json, error_code, error_message, duration_ms)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, NULL, '[]', NULL, NULL, NULL)`)
        .run(...partitionParams(run.partition), run.id, ...scopeParams(run.scope), run.engineId, run.engineVersion,
          run.bucketAt, run.configVersion, run.status, run.startedAt);
      return run;
    },
  finishRun(this: SpatialLayerStateStoreInternals, partition: SpatialDataPartition, id: string, result: {
      status: Exclude<SpatialRunStatus, "running">;
      finishedAt: string;
      inputDigest?: string | null;
      snapshotIds?: string[];
      errorCode?: string | null;
      errorMessage?: string | null;
      durationMs: number;
    }): SpatialInferenceRun {
      this.db.prepare(`UPDATE spatial_inference_runs SET status = ?, finished_at = ?, input_digest = ?, snapshot_ids_json = ?,
        error_code = ?, error_message = ?, duration_ms = ? WHERE source_db_id = ? AND data_mode = ? AND id = ?`)
        .run(result.status, result.finishedAt, result.inputDigest ?? null, stableJson(result.snapshotIds ?? []), result.errorCode ?? null,
          result.errorMessage?.slice(0, 2_000) ?? null, result.durationMs, ...partitionParams(partition), id);
      const row = this.db.prepare("SELECT * FROM spatial_inference_runs WHERE source_db_id = ? AND data_mode = ? AND id = ?")
        .get(...partitionParams(partition), id) as SqlRow | undefined;
      if (!row) throw new Error(`Spatial inference run ${id} disappeared`);
      return runFromRow(row);
    },
  latestRun(this: SpatialLayerStateStoreInternals, partition: SpatialDataPartition, scope: SpatialScope, engineId?: string): SpatialInferenceRun | null {
      const engineClause = engineId ? "AND engine_id = ?" : "";
      const row = this.db.prepare(`SELECT * FROM spatial_inference_runs
        WHERE source_db_id = ? AND data_mode = ? AND scope_kind = ? AND scope_id = ? ${engineClause}
        ORDER BY started_at DESC LIMIT 1`)
        .get(...partitionParams(partition), ...scopeParams(scope), ...(engineId ? [engineId] : [])) as SqlRow | undefined;
      return row ? runFromRow(row) : null;
    },
  persistSnapshot(this: SpatialLayerStateStoreInternals, partition: SpatialDataPartition, draft: SpatialLayerSnapshotDraft, createdAt = new Date().toISOString()): PersistedSpatialLayerSnapshot {
      return this.transaction(() => {
        assertInterval(draft.windowStart, draft.windowEnd, "windowStart", "windowEnd");
        assertIsoTimestamp(draft.generatedAt, "generatedAt");
        if (!Number.isFinite(draft.qualityScore) || draft.qualityScore < 0 || draft.qualityScore > 1) {
          throw new SpatialStateValidationError(400, "INVALID_QUALITY_SCORE", "qualityScore must be between 0 and 1");
        }
        const keyMaterial = {
          scope: draft.scope,
          layerId: draft.layerId,
          generatedAt: draft.generatedAt,
          model: draft.model,
          configVersion: draft.configVersion,
        };
        const snapshotKey = contentHash(keyMaterial);
        const hash = contentHash(draft);
        const currentRow = this.db.prepare(`SELECT * FROM spatial_layer_snapshots
          WHERE source_db_id = ? AND data_mode = ? AND snapshot_key = ? AND is_current = 1 LIMIT 1`)
          .get(...partitionParams(partition), snapshotKey) as SqlRow | undefined;
        if (currentRow) {
          if (String(currentRow.input_digest) === draft.inputDigest) {
            if (String(currentRow.content_hash) !== hash) throw new NonDeterministicSpatialOutputError(draft.layerId, draft.generatedAt);
            return snapshotFromRow(currentRow);
          }
          this.db.prepare(`UPDATE spatial_layer_snapshots SET is_current = 0
            WHERE source_db_id = ? AND data_mode = ? AND id = ?`)
            .run(...partitionParams(partition), String(currentRow.id));
        }
        const revision = currentRow ? Number(currentRow.revision) + 1 : 1;
        const id = randomUUID();
        this.db.prepare(`INSERT INTO spatial_layer_snapshots
          (source_db_id, data_mode, id, snapshot_key, scope_kind, scope_id, layer_id, bucket_at, window_start, window_end,
           status, model_json, config_version, input_digest, quality_score, warnings_json, payload_json, content_hash,
           revision, is_current, supersedes_snapshot_id, created_at)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?)`)
          .run(...partitionParams(partition), id, snapshotKey, ...scopeParams(draft.scope), draft.layerId, draft.generatedAt,
            draft.windowStart, draft.windowEnd, draft.status, stableJson(draft.model), draft.configVersion, draft.inputDigest,
            draft.qualityScore, stableJson(draft.warnings), stableJson({
              coordinateFrames: draft.coordinateFrames,
              reasonCodes: draft.reasonCodes,
              zones: draft.zones,
              connections: draft.connections,
              points: draft.points,
              ...(draft.metadata === undefined ? {} : { metadata: draft.metadata }),
            }), hash, revision,
            currentRow ? String(currentRow.id) : null, createdAt);
        const row = this.db.prepare(`SELECT * FROM spatial_layer_snapshots
          WHERE source_db_id = ? AND data_mode = ? AND id = ?`).get(...partitionParams(partition), id) as SqlRow;
        return snapshotFromRow(row);
      });
    },
});
