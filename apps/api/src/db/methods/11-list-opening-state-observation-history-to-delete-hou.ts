import { isSqliteFailure } from "../sqlite-failure.js";
import { randomUUID } from "node:crypto";
import { automaticWeatherLocation, fixedPlanElementOpeningState, isAutomaticWeatherLocation, openingObservationMatchesElement } from "@climate-twin/contracts";
import type {
  DailyAnalyticsFindingsSnapshot,
  House,
  HouseLocation,
  HouseMapPlacement,
  OpeningStateObservation,
  OpeningStateObservationInput,
} from "@climate-twin/contracts";
import { DEFAULT_PROPERTY_ID, OpeningStateActivityRecord, OpeningStateObservationRow, StoredDailyAnalyticsFindings } from "../support/01-json-value-to-area-equipment-row.js";
import { LocalMaintenanceTaskRevisionActor } from "../support/02-equipment-attachment-row-to-sensor-data-gap-state.js";
import { ClimateDataValidationError } from "../support/03-sensor-data-gap-row-to-canonical-json-value.js";
import { openingStateObservationFromRow } from "../support/04-canonical-json-value-to-action-playbook-from-row.js";
import { outdoorLocationKey } from "../support/06-canonical-observation-patch-time-to-outdoor-location.js";
import { registerDatabaseMethods } from "../core.js";

const MAX_OPENING_PROVIDER_STALE_MS = 30 * 86_400_000;
const OPENING_CANDIDATE_CHECKPOINT_BATCH_ROWS = 256;
function openingCandidateLane(observation: OpeningStateObservation): string {
  return observation.source === "manual" || observation.source === "api"
    ? JSON.stringify([observation.source])
    : JSON.stringify([observation.source, observation.externalId ?? "", observation.connectionId ?? ""]);
}

function openingCandidateCeiling(observation: OpeningStateObservation): string | null {
  const explicit = observation.validUntil === undefined
    ? Number.POSITIVE_INFINITY
    : Date.parse(observation.validUntil);
  if (observation.source !== "home-assistant" && observation.source !== "tapo") {
    return Number.isFinite(explicit) ? new Date(explicit).toISOString() : null;
  }
  return new Date(Math.min(
    explicit,
    Date.parse(observation.observedAt) + MAX_OPENING_PROVIDER_STALE_MS,
  )).toISOString();
}

registerDatabaseMethods({
  listOpeningStateObservationHistory(
      houseId: string,
      { from, to, limit = 10_000 }: { from: string | number | Date; to: string | number | Date; limit?: number },
    ): OpeningStateObservation[] {
      if (!this.getHouse(houseId)) return [];
      const fromMs = from instanceof Date ? from.getTime() : typeof from === "number" ? from : Date.parse(from);
      const toMs = to instanceof Date ? to.getTime() : typeof to === "number" ? to : Date.parse(to);
      if (!Number.isFinite(fromMs) || !Number.isFinite(toMs) || toMs < fromMs) return [];
      const boundedLimit = Math.min(10_000, Math.max(1, Math.trunc(limit)));
      const rows = this.db.prepare(`SELECT id, house_id, floor_id, element_id, state, open_fraction, source, observed_at, valid_until, external_id, connection_id
        FROM opening_state_observations
        WHERE house_id = ? AND observed_at >= ? AND observed_at <= ?
        ORDER BY observed_at DESC, id DESC LIMIT ?`)
        .all(houseId, new Date(fromMs).toISOString(), new Date(toMs).toISOString(), boundedLimit) as unknown as OpeningStateObservationRow[];
      return rows.map(openingStateObservationFromRow).sort((left, right) => (
        left.observedAt.localeCompare(right.observedAt) || left.id.localeCompare(right.id)
      ));
    },
  /**
     * Counts confirmed contact-state transitions without treating repeated
     * provider heartbeats, startup snapshots, or unknown states as openings.
     */
  openingStateActivity(
      houseId: string,
      from: string | number | Date,
      to: string | number | Date,
    ): OpeningStateActivityRecord[] {
      if (!this.getHouse(houseId)) return [];
      const fromMs = from instanceof Date ? from.getTime() : typeof from === "number" ? from : Date.parse(from);
      const toMs = to instanceof Date ? to.getTime() : typeof to === "number" ? to : Date.parse(to);
      if (!Number.isFinite(fromMs) || !Number.isFinite(toMs) || toMs <= fromMs) return [];
      const rows = this.db.prepare(`WITH ordered AS (
          SELECT floor_id, element_id, source, external_id, connection_id, state, observed_at,
            LAG(state) OVER (
              PARTITION BY floor_id, element_id, source, COALESCE(external_id, ''), COALESCE(connection_id, '')
              ORDER BY observed_at, id
            ) AS previous_state
          FROM opening_state_observations
          WHERE house_id = ? AND observed_at < ?
        )
        SELECT floor_id, element_id, source, external_id, connection_id,
          COUNT(*) AS observation_count,
          SUM(CASE WHEN state = 'open' AND previous_state = 'closed' THEN 1 ELSE 0 END) AS opened_count,
          SUM(CASE WHEN state = 'closed' AND previous_state = 'open' THEN 1 ELSE 0 END) AS closed_count
        FROM ordered
        WHERE observed_at >= ?
        GROUP BY floor_id, element_id, source, external_id, connection_id
        ORDER BY floor_id, element_id, source, external_id, connection_id`)
        .all(houseId, new Date(toMs).toISOString(), new Date(fromMs).toISOString()) as unknown as Array<{
          floor_id: string;
          element_id: string;
          source: OpeningStateObservation["source"];
          external_id: string | null;
          connection_id: string | null;
          observation_count: number;
          opened_count: number;
          closed_count: number;
        }>;
      return rows.map((row) => ({
        floorId: row.floor_id,
        elementId: row.element_id,
        source: row.source,
        externalId: row.external_id,
        connectionId: row.connection_id,
        observationCount: Number(row.observation_count),
        openedCount: Number(row.opened_count),
        closedCount: Number(row.closed_count),
      }));
    },
  dailyAnalyticsFindings(houseId: string, dataMode: "live" | "demo"): StoredDailyAnalyticsFindings | null {
      if (!this.getHouse(houseId)) return null;
      const row = this.db.prepare(`SELECT snapshot_json, last_attempt_at, last_error
        FROM analytics_daily_findings WHERE house_id = ? AND data_mode = ?`)
        .get(houseId, dataMode) as { snapshot_json: string | null; last_attempt_at: string; last_error: string | null } | undefined;
      if (!row) return null;
      let snapshot: DailyAnalyticsFindingsSnapshot | null = null;
      if (row.snapshot_json) {
        try {
          snapshot = JSON.parse(row.snapshot_json) as DailyAnalyticsFindingsSnapshot;
        } catch {
          return { snapshot: null, lastAttemptAt: row.last_attempt_at, lastError: "Stored daily findings are unreadable" };
        }
      }
      return { snapshot, lastAttemptAt: row.last_attempt_at, lastError: row.last_error };
    },
  saveDailyAnalyticsFindings(snapshot: DailyAnalyticsFindingsSnapshot): void {
      if (!this.getHouse(snapshot.houseId)) throw new Error(`House ${snapshot.houseId} does not exist`);
      const snapshotJson = JSON.stringify(snapshot);
      if (Buffer.byteLength(snapshotJson, "utf8") > 1_000_000) throw new Error("Daily analytics snapshot exceeds 1 MB");
      this.db.prepare(`INSERT INTO analytics_daily_findings
          (house_id, data_mode, evaluated_through, generated_at, algorithm_version, snapshot_json, last_attempt_at, last_error)
        VALUES (?, ?, ?, ?, ?, ?, ?, NULL)
        ON CONFLICT(house_id) DO UPDATE SET
          data_mode = excluded.data_mode,
          evaluated_through = excluded.evaluated_through,
          generated_at = excluded.generated_at,
          algorithm_version = excluded.algorithm_version,
          snapshot_json = excluded.snapshot_json,
          last_attempt_at = excluded.last_attempt_at,
          last_error = NULL`)
        .run(snapshot.houseId, snapshot.dataMode, snapshot.evaluatedThrough, snapshot.generatedAt,
          snapshot.algorithmVersion, snapshotJson, snapshot.generatedAt);
    },
  recordDailyAnalyticsFindingsFailure(
      houseId: string,
      dataMode: "live" | "demo",
      attemptedAt: string,
      error: string,
    ): void {
      if (!this.getHouse(houseId)) return;
      const detail = error.trim().slice(0, 1_000) || "Daily analytics run failed";
      this.db.prepare(`INSERT INTO analytics_daily_findings
          (house_id, data_mode, evaluated_through, generated_at, algorithm_version, snapshot_json, last_attempt_at, last_error)
        VALUES (?, ?, NULL, NULL, NULL, NULL, ?, ?)
        ON CONFLICT(house_id) DO UPDATE SET
          data_mode = excluded.data_mode,
          evaluated_through = CASE WHEN analytics_daily_findings.data_mode = excluded.data_mode
            THEN analytics_daily_findings.evaluated_through ELSE NULL END,
          generated_at = CASE WHEN analytics_daily_findings.data_mode = excluded.data_mode
            THEN analytics_daily_findings.generated_at ELSE NULL END,
          algorithm_version = CASE WHEN analytics_daily_findings.data_mode = excluded.data_mode
            THEN analytics_daily_findings.algorithm_version ELSE NULL END,
          snapshot_json = CASE WHEN analytics_daily_findings.data_mode = excluded.data_mode
            THEN analytics_daily_findings.snapshot_json ELSE NULL END,
          last_attempt_at = excluded.last_attempt_at,
          last_error = excluded.last_error`)
        .run(houseId, dataMode, attemptedAt, detail);
    },
  recordOpeningStateObservation(houseId: string, input: OpeningStateObservationInput): OpeningStateObservation {
      const house = this.getHouse(houseId);
      if (!house) throw new ClimateDataValidationError(404, "HOUSE_NOT_FOUND", `House ${houseId} does not exist`);
      const floor = house.floors.find((candidate) => candidate.id === input.floorId);
      if (!floor) throw new ClimateDataValidationError(404, "OPENING_FLOOR_NOT_FOUND", `Floor ${input.floorId} does not exist in house ${houseId}`);
      const element = (floor.planElements ?? []).find((candidate) => candidate.id === input.elementId);
      if (!element || (element.kind !== "door" && element.kind !== "window" && element.kind !== "vent")) {
        throw new ClimateDataValidationError(404, "OPENING_NOT_FOUND", `Opening ${input.elementId} does not exist on floor ${input.floorId}`);
      }
      if (!["open", "closed", "unknown"].includes(input.state)) {
        throw new ClimateDataValidationError(400, "INVALID_OPENING_STATE", "Opening state must be open, closed, or unknown");
      }
      if (!["manual", "home-assistant", "tapo", "api"].includes(input.source)) {
        throw new ClimateDataValidationError(400, "INVALID_OPENING_STATE_SOURCE", "Opening state source is not supported");
      }
      const fixedState = fixedPlanElementOpeningState(element);
      if (fixedState !== null && input.state !== fixedState) {
        throw new ClimateDataValidationError(400, "INVALID_OPENING_STATE", `${element.variant} openings must remain ${fixedState}`);
      }
      if (input.openFraction !== undefined && (!Number.isFinite(input.openFraction) || input.openFraction < 0 || input.openFraction > 1
        || (input.state !== "open" && input.openFraction !== 0))) {
        throw new ClimateDataValidationError(400, "INVALID_OPENING_FRACTION", "Opening fraction must be from 0 to 1 and non-zero only for an open state");
      }
      const observedAtMs = Date.parse(input.observedAt);
      if (!Number.isFinite(observedAtMs)) throw new ClimateDataValidationError(400, "INVALID_OPENING_OBSERVED_AT", "observedAt must be an ISO 8601 timestamp");
      const observedAt = new Date(observedAtMs).toISOString();
      let validUntil: string | undefined;
      if (input.validUntil !== undefined) {
        const validUntilMs = Date.parse(input.validUntil);
        if (!Number.isFinite(validUntilMs) || validUntilMs <= observedAtMs) {
          throw new ClimateDataValidationError(400, "INVALID_OPENING_VALID_UNTIL", "validUntil must be later than observedAt");
        }
        validUntil = new Date(validUntilMs).toISOString();
      }
      const externalId = input.externalId?.trim();
      if (externalId !== undefined && (!externalId || externalId.length > 255)) {
        throw new ClimateDataValidationError(400, "INVALID_OPENING_EXTERNAL_ID", "externalId must contain 1 to 255 characters");
      }
      const connectionId = input.connectionId?.trim();
      if (connectionId !== undefined && (!connectionId || connectionId.length > 255)) {
        throw new ClimateDataValidationError(400, "INVALID_OPENING_CONNECTION_ID", "connectionId must contain 1 to 255 characters");
      }
      if (input.source === "home-assistant" || input.source === "tapo") {
        if (!element.stateBinding || element.stateBinding.provider !== input.source
          || !externalId || externalId !== element.stateBinding.externalId
          || (element.stateBinding.connectionId !== undefined && connectionId !== element.stateBinding.connectionId)) {
          throw new ClimateDataValidationError(409, "OPENING_BINDING_MISMATCH", "The provider observation does not match this opening's configured sensor binding");
        }
      }
      const id = input.id?.trim() || randomUUID();
      const observation: OpeningStateObservation = {
        id, houseId, floorId: floor.id, elementId: element.id, state: input.state,
        ...(input.openFraction !== undefined ? { openFraction: input.openFraction } : {}),
        source: input.source, observedAt,
        ...(validUntil ? { validUntil } : {}),
        ...(externalId ? { externalId } : {}),
        ...(connectionId ? { connectionId } : {}),
      };
      try {
        this.immediateTransaction(() => {
          const recordedAt = new Date().toISOString();
          const inserted = this.db.prepare(`INSERT INTO opening_state_observations
            (id, house_id, floor_id, element_id, state, open_fraction, source, observed_at, valid_until, external_id, connection_id, created_at)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
            .run(observation.id, houseId, floor.id, element.id, observation.state, observation.openFraction ?? null,
              observation.source, observation.observedAt, observation.validUntil ?? null, observation.externalId ?? null,
              observation.connectionId ?? null, recordedAt);
          this.db.prepare(`INSERT INTO metadata(key, value)
              VALUES ('opening_state_current_candidates_rowid_v2', ?)
              ON CONFLICT(key) DO UPDATE SET value = excluded.value
              WHERE CAST(metadata.value AS INTEGER) + ? <= CAST(excluded.value AS INTEGER)`)
            .run(String(inserted.lastInsertRowid), OPENING_CANDIDATE_CHECKPOINT_BATCH_ROWS);
          this.invalidateDerivedAnalyticsHistory(
            houseId,
            observation.observedAt,
            observation.validUntil ?? observation.observedAt,
            recordedAt,
          );

          // Keep only candidates that can still become the latest effective
          // row. A shorter temporary observation deliberately retains the
          // older baseline beneath it so expiry cannot erase known state.
          this.db.prepare(`DELETE FROM opening_state_current_candidates
            WHERE effective_until_ceiling IS NOT NULL AND effective_until_ceiling <= ?`).run(recordedAt);
          const lane = openingCandidateLane(observation);
          const ceiling = openingCandidateCeiling(observation);
          if (ceiling === null || ceiling > recordedAt) {
            const dominated = this.db.prepare(`SELECT 1 FROM opening_state_current_candidates
              WHERE house_id = ? AND floor_id = ? AND element_id = ? AND lane_key = ?
                AND observed_at <= ?
                AND (observed_at > ? OR (observed_at = ? AND observation_id > ?))
                AND (effective_until_ceiling IS NULL OR (? IS NOT NULL AND effective_until_ceiling >= ?))
              LIMIT 1`).get(
                houseId, floor.id, element.id, lane,
                recordedAt,
                observation.observedAt, observation.observedAt, observation.id,
                ceiling, ceiling,
              );
            if (!dominated) {
              this.db.prepare(`INSERT OR IGNORE INTO opening_state_current_candidates
                (observation_id, house_id, floor_id, element_id, lane_key, observed_at, effective_until_ceiling)
                VALUES (?, ?, ?, ?, ?, ?, ?)`)
                .run(observation.id, houseId, floor.id, element.id, lane, observation.observedAt, ceiling);
              if (observation.observedAt <= recordedAt) {
                this.db.prepare(`DELETE FROM opening_state_current_candidates
                  WHERE house_id = ? AND floor_id = ? AND element_id = ? AND lane_key = ?
                    AND (observed_at < ? OR (observed_at = ? AND observation_id < ?))
                    AND (? IS NULL OR (effective_until_ceiling IS NOT NULL AND effective_until_ceiling <= ?))`)
                  .run(
                    houseId, floor.id, element.id, lane,
                    observation.observedAt, observation.observedAt, observation.id,
                    ceiling, ceiling,
                  );
              }
            }
          }
        });
      } catch (error) {
        if (isSqliteFailure(error, "unique", "opening_state_observations.id")) {
          throw new ClimateDataValidationError(409, "OPENING_OBSERVATION_ID_CONFLICT", `Opening observation ${id} already exists`);
        }
        throw error;
      }
      return observation;
    },
  createHouse(input: Pick<House, "name" | "timezone" | "floors"> & {
      id?: string;
      propertyId?: string;
      location?: HouseLocation;
      mapPlacement?: HouseMapPlacement;
      orientationDegrees?: number;
    }): House {
      return this.immediateTransaction(() => {
        this.parseFloorDefinitions(input.floors);
        this.validateHouseTimezone(input.timezone);
        if (input.location) this.validateHouseLocation(input.location);
        if (input.mapPlacement) this.validateHouseMapPlacement(input.mapPlacement, input.floors);
        if (input.orientationDegrees !== undefined) this.validateHouseOrientation(input.orientationDegrees);
        const timestamp = new Date().toISOString();
        let propertyId: string;
        if (input.propertyId !== undefined) {
          propertyId = input.propertyId.trim();
          if (!propertyId) {
            throw new ClimateDataValidationError(
              422,
              "HOUSE_PROPERTY_REQUIRED",
              "A non-empty propertyId is required when it is supplied",
            );
          }
        } else {
          const candidates = this.db.prepare("SELECT id FROM properties ORDER BY created_at, id LIMIT 2")
            .all() as Array<{ id: string }>;
          if (candidates.length === 0) propertyId = this.ensureDefaultProperty().id;
          else if (candidates.length === 1) propertyId = candidates[0]!.id;
          else {
            throw new ClimateDataValidationError(
              422,
              "HOUSE_PROPERTY_REQUIRED",
              "propertyId is required when more than one property exists",
            );
          }
        }
        const property = this.getProperty(propertyId);
        if (!property) {
          throw new ClimateDataValidationError(404, "HOUSE_PROPERTY_NOT_FOUND", `Property ${propertyId} does not exist`);
        }
        const location = input.location ?? automaticWeatherLocation(property.location, input.mapPlacement);
        const house: House = {
          id: input.id ?? randomUUID(), propertyId, name: input.name, timezone: input.timezone,
          ...(location ? { location } : {}),
          ...(input.mapPlacement ? { mapPlacement: input.mapPlacement } : {}),
          ...(input.orientationDegrees !== undefined ? { orientationDegrees: input.orientationDegrees } : {}),
          floors: input.floors,
          createdAt: timestamp, updatedAt: timestamp,
        };
        this.assertTelemetryResourceIdAvailable("house", house.id);
        try {
          this.db.prepare(`INSERT INTO houses
            (id, property_id, name, timezone, location_json, map_placement_json, orientation_degrees, floors_json, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
            .run(house.id, propertyId, house.name, house.timezone, house.location ? JSON.stringify(house.location) : null,
              house.mapPlacement ? JSON.stringify(house.mapPlacement) : null,
              house.orientationDegrees ?? null,
              JSON.stringify(house.floors), house.createdAt, house.updatedAt);
        } catch (error) {
          if (isSqliteFailure(error, "unique", "houses.id")) {
            throw new ClimateDataValidationError(409, "HOUSE_ID_CONFLICT", `House ${house.id} already exists`);
          }
          throw error;
        }
        return house;
      });
    },
  updateHouse(
      id: string,
      patch: Partial<Pick<House, "name" | "timezone" | "floors">> & {
        propertyId?: string;
        location?: HouseLocation | null;
        mapPlacement?: HouseMapPlacement | null;
        orientationDegrees?: number | null;
      },
      actor: LocalMaintenanceTaskRevisionActor = "local-rest",
    ): House | null {
      return this.immediateTransaction(() => {
        const current = this.getHouse(id);
        if (!current) return null;
        const affectedTasks = patch.propertyId !== undefined && patch.propertyId !== current.propertyId
          ? this.maintenanceTasksBeforeScopeMove("house_id = ?", [id])
          : [];
        // Apply nullable optional fields explicitly so `null` never leaks into
        // the public House contract (absence is represented by omission).
        const next: House = { ...current, id, updatedAt: this.nextUpdatedAt(current.updatedAt) };
        if (patch.propertyId !== undefined) {
          const propertyId = patch.propertyId.trim();
          if (!propertyId || !this.getProperty(propertyId)) {
            throw new ClimateDataValidationError(
              404,
              "HOUSE_PROPERTY_NOT_FOUND",
              `Property ${patch.propertyId} does not exist`,
            );
          }
          if (propertyId !== current.propertyId) this.requireImmutableTelemetryLineage("house", id);
          next.propertyId = propertyId;
        }
        if (patch.name !== undefined) next.name = patch.name;
        if (patch.timezone !== undefined) {
          // A legacy database may contain a timezone accepted by an older build.
          // Preserve that value when an unrelated full-form update echoes it, but
          // validate every newly introduced timezone.
          if (patch.timezone !== current.timezone) this.validateHouseTimezone(patch.timezone);
          next.timezone = patch.timezone;
        }
        if (patch.floors !== undefined) next.floors = patch.floors;
        if (patch.orientationDegrees === null) delete next.orientationDegrees;
        else if (patch.orientationDegrees !== undefined) next.orientationDegrees = patch.orientationDegrees;
        if (patch.location === null) delete next.location;
        else if (patch.location !== undefined) next.location = patch.location;
        if (patch.mapPlacement === null) delete next.mapPlacement;
        else if (patch.mapPlacement !== undefined) next.mapPlacement = patch.mapPlacement;
        if (patch.location === null
          || (patch.location === undefined && (!next.location || isAutomaticWeatherLocation(current.location)))) {
          const inferred = automaticWeatherLocation(this.getProperty(next.propertyId)?.location, next.mapPlacement);
          if (inferred) next.location = inferred;
          else delete next.location;
        }
        this.parseFloorDefinitions(next.floors);
        if (next.mapPlacement) this.validateHouseMapPlacement(next.mapPlacement, next.floors);
        if (next.location) this.validateHouseLocation(next.location);
        if (next.orientationDegrees !== undefined) this.validateHouseOrientation(next.orientationDegrees);
        this.validateHouseLayoutForSensors(id, next.floors);
        if (patch.floors !== undefined) {
          this.validateHouseLayoutForObservations(id, next.floors);
          this.validateHouseLayoutForConnectedDevices(id, next.floors);
          this.validateHouseLayoutForMaintenanceTasks(id, next.floors);
        }
        this.db.prepare("UPDATE houses SET property_id = ?, name = ?, timezone = ?, location_json = ?, map_placement_json = ?, orientation_degrees = ?, floors_json = ?, updated_at = ? WHERE id = ?")
          .run(next.propertyId ?? DEFAULT_PROPERTY_ID, next.name, next.timezone, next.location ? JSON.stringify(next.location) : null,
            next.mapPlacement ? JSON.stringify(next.mapPlacement) : null,
            next.orientationDegrees ?? null,
            JSON.stringify(next.floors), next.updatedAt, id);
        if (patch.floors !== undefined) {
          const openings = new Map(next.floors.flatMap((floor) => (floor.planElements ?? []).flatMap((element) => (
            element.kind === "door" || element.kind === "window" || element.kind === "vent"
              ? [[`${floor.id}\u0000${element.id}`, element] as const]
              : []
          ))));
          const candidates = this.db.prepare(`SELECT observation.id, observation.house_id, observation.floor_id,
              observation.element_id, observation.state, observation.open_fraction, observation.source,
              observation.observed_at, observation.valid_until, observation.external_id, observation.connection_id
            FROM opening_state_current_candidates candidate
            JOIN opening_state_observations observation ON observation.id = candidate.observation_id
            WHERE candidate.house_id = ?`).all(id) as unknown as OpeningStateObservationRow[];
          const removeCandidate = this.db.prepare(
            "DELETE FROM opening_state_current_candidates WHERE observation_id = ?",
          );
          for (const row of candidates) {
            const observation = openingStateObservationFromRow(row);
            const opening = openings.get(`${observation.floorId}\u0000${observation.elementId}`);
            if (!opening || fixedPlanElementOpeningState(opening) !== null
              || !openingObservationMatchesElement(opening, observation)) removeCandidate.run(observation.id);
          }
        }
        this.recordScopeMoveMaintenanceRevisions(affectedTasks, actor);
        const weatherLocationChanged = outdoorLocationKey(current.location) !== outdoorLocationKey(next.location);
        if (patch.floors !== undefined || weatherLocationChanged || patch.timezone !== undefined) {
          this.db.prepare("DELETE FROM analytics_daily_findings WHERE house_id = ?").run(id);
        }
        return next;
      });
    },
  /**
   * Revoked federation replicas must be erasable even if a local-only producer
   * was accidentally attached before the authority boundary was enforced.
   */
  purgeSharedHouseProjection(id: string): boolean {
      return this.immediateTransaction(() => {
        const house = this.getHouse(id);
        if (!house) return false;
        if (house.stuguby?.ownership !== "shared" || house.stuguby.syncState === "detached") {
          throw new ClimateDataValidationError(
            409,
            "HOUSE_NOT_SHARED_PROJECTION",
            `House ${id} is not an active shared federation projection`,
          );
        }
        while (true) {
          const items = this.listAreaEquipment({ houseId: id, limit: 10_000 });
          if (items.length === 0) break;
          for (const item of items) {
            if (!this.updateAreaEquipment(item.id, { houseId: null }, "system-service")) {
              throw new Error(`Could not detach equipment ${item.id} from shared Home ${id}`);
            }
          }
        }
        while (true) {
          const notes = this.listPropertyNotes({ houseId: id, limit: 10_000 });
          if (notes.length === 0) break;
          for (const note of notes) {
            if (!this.deletePropertyNote(note.id)) {
              throw new Error(`Could not delete note ${note.id} from shared Home ${id}`);
            }
          }
        }
        while (true) {
          const tasks = this.listMaintenanceTasks({ houseId: id, limit: 10_000 });
          if (tasks.length === 0) break;
          for (const task of tasks) {
            if (!this.updateMaintenanceTask(task.id, {
              baseRevision: task.revision,
              houseId: null,
              floorId: null,
              observationIds: task.observationIds.filter((observationId) => (
                this.getObservation(observationId)?.houseId !== id
              )),
            }, "system-service")) {
              throw new Error(`Could not detach maintenance task ${task.id} from shared Home ${id}`);
            }
          }
        }
        return Number(this.db.prepare("DELETE FROM houses WHERE id = ?").run(id).changes) > 0;
      });
    },
  deleteHouse(id: string): boolean {
      const deletedAt = new Date().toISOString();
      return this.immediateTransaction(() => {
        const hidden = Number(this.db.prepare(`UPDATE houses
          SET deleted_at = ?, updated_at = ?
          WHERE id = ? AND deleted_at IS NULL`).run(deletedAt, deletedAt, id).changes) > 0;
        if (!hidden) return false;
        this.db.prepare(`UPDATE external_source_gateways
          SET enabled = 0, revision = revision + 1, updated_at = ?
          WHERE house_id = ? AND enabled = 1`).run(deletedAt, id);
        return true;
      });
    },
});
