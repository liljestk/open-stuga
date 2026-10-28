import { type OpeningStateObservation, fixedPlanElementOpeningState, type OpeningStateObservationInput } from "@climate-twin/contracts";
import { OpeningStateObservationRow } from "../support/row-types.js";
import { OpeningStateActivityRecord } from "../support/record-types.js";
import { ClimateDataValidationError } from "../support/validation-errors.js";
import { openingStateObservationFromRow } from "../support/row-mappers.js";
import { registerDatabaseMethods } from "../core.js";
import { isSqliteFailure } from "../sqlite-failure.js";
import { randomUUID } from "node:crypto";

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

declare module "../core.js" {
  interface DatabaseInternals {
    listOpeningStateObservations(houseId: string, options?: { limit?: number; at?: string | number | Date }): OpeningStateObservation[];
    listCurrentOpeningStateCandidates(houseId: string, at?: string | number | Date, limit?: number): OpeningStateObservation[];
    listOpeningStateObservationHistory(houseId: string, window: { from: string | number | Date; to: string | number | Date; limit?: number }): OpeningStateObservation[];
    openingStateActivity(houseId: string, from: string | number | Date, to: string | number | Date): OpeningStateActivityRecord[];
    recordOpeningStateObservation(houseId: string, input: OpeningStateObservationInput): OpeningStateObservation;
  }

  interface ClimateDatabaseCore {
    listOpeningStateObservations(houseId: string, options?: { limit?: number; at?: string | number | Date }): OpeningStateObservation[];
    listCurrentOpeningStateCandidates(houseId: string, at?: string | number | Date, limit?: number): OpeningStateObservation[];
    listOpeningStateObservationHistory(houseId: string, window: { from: string | number | Date; to: string | number | Date; limit?: number }): OpeningStateObservation[];
    openingStateActivity(houseId: string, from: string | number | Date, to: string | number | Date): OpeningStateActivityRecord[];
    recordOpeningStateObservation(houseId: string, input: OpeningStateObservationInput): OpeningStateObservation;
  }
}

registerDatabaseMethods({
  listOpeningStateObservations(houseId: string, { limit = 5_000, at }: { limit?: number; at?: string | number | Date } = {}): OpeningStateObservation[] {
      if (!this.getHouse(houseId)) return [];
      const boundedLimit = Math.min(10_000, Math.max(1, Math.trunc(limit)));
      if (at === undefined) {
        const rows = this.db.prepare(`SELECT id, house_id, floor_id, element_id, state, open_fraction, source, observed_at, valid_until, external_id, connection_id
          FROM opening_state_observations WHERE house_id = ? ORDER BY observed_at DESC, id DESC LIMIT ?`)
          .all(houseId, boundedLimit) as unknown as OpeningStateObservationRow[];
        return rows.map(openingStateObservationFromRow);
      }
      const atMs = at instanceof Date ? at.getTime() : typeof at === "number" ? at : Date.parse(at);
      if (!Number.isFinite(atMs)) return [];
      const atIso = new Date(atMs).toISOString();
      const house = this.getHouse(houseId)!;
      const columns = "id, house_id, floor_id, element_id, state, open_fraction, source, observed_at, valid_until, external_id, connection_id";
      const latestBySource = this.db.prepare(`SELECT ${columns} FROM opening_state_observations
        WHERE house_id = ? AND floor_id = ? AND element_id = ? AND source = ?
          AND observed_at <= ? AND (valid_until IS NULL OR valid_until > ?)
        ORDER BY observed_at DESC, id DESC LIMIT 1`);
      const latestProvider = this.db.prepare(`SELECT ${columns} FROM opening_state_observations
        WHERE house_id = ? AND floor_id = ? AND element_id = ? AND source = ? AND external_id = ?
          AND observed_at <= ? AND (valid_until IS NULL OR valid_until > ?)
        ORDER BY observed_at DESC, id DESC LIMIT 1`);
      const latestProviderConnection = this.db.prepare(`SELECT ${columns} FROM opening_state_observations
        WHERE house_id = ? AND floor_id = ? AND element_id = ? AND source = ? AND external_id = ? AND connection_id = ?
          AND observed_at <= ? AND (valid_until IS NULL OR valid_until > ?)
        ORDER BY observed_at DESC, id DESC LIMIT 1`);
      const rows: OpeningStateObservationRow[] = [];
      // Each lookup is bounded and uses the house/element/provider indexes. This
      // remains fast after years of adapter heartbeats while retaining an old,
      // still-valid manual state for replay and fallback resolution.
      for (const floor of house.floors) {
        for (const element of floor.planElements ?? []) {
          if (element.kind !== "door" && element.kind !== "window" && element.kind !== "vent") continue;
          for (const source of ["manual", "api"] as const) {
            const row = latestBySource.get(houseId, floor.id, element.id, source, atIso, atIso) as unknown as OpeningStateObservationRow | undefined;
            if (row) rows.push(row);
          }
          const binding = element.stateBinding;
          if (!binding) continue;
          const row = binding.connectionId
            ? latestProviderConnection.get(houseId, floor.id, element.id, binding.provider, binding.externalId,
                binding.connectionId, atIso, atIso) as unknown as OpeningStateObservationRow | undefined
            : latestProvider.get(houseId, floor.id, element.id, binding.provider, binding.externalId,
                atIso, atIso) as unknown as OpeningStateObservationRow | undefined;
          if (row) rows.push(row);
        }
      }
      return rows.sort((left, right) => right.observed_at.localeCompare(left.observed_at) || right.id.localeCompare(left.id))
        .slice(0, boundedLimit).map(openingStateObservationFromRow);
    },
  listCurrentOpeningStateCandidates(
      houseId: string,
      at: string | number | Date = new Date(),
      limit = 10_000,
    ): OpeningStateObservation[] {
      if (!this.getHouse(houseId)) return [];
      const atMs = at instanceof Date ? at.getTime() : typeof at === "number" ? at : Date.parse(at);
      if (!Number.isFinite(atMs)) return [];
      const atIso = new Date(atMs).toISOString();
      const boundedLimit = Math.min(10_000, Math.max(1, Math.trunc(limit)));
      const rows = this.db.prepare(`SELECT observation.id, observation.house_id, observation.floor_id,
          observation.element_id, observation.state, observation.open_fraction, observation.source,
          observation.observed_at, observation.valid_until, observation.external_id, observation.connection_id
        FROM opening_state_current_candidates AS candidate
        JOIN opening_state_observations AS observation ON observation.id = candidate.observation_id
        WHERE candidate.house_id = ?
          AND candidate.observed_at <= ?
          AND (candidate.effective_until_ceiling IS NULL OR candidate.effective_until_ceiling > ?)
        ORDER BY candidate.observed_at DESC, candidate.observation_id DESC
        LIMIT ?`)
        .all(houseId, atIso, atIso, boundedLimit) as unknown as OpeningStateObservationRow[];
      return rows.map(openingStateObservationFromRow);
    },
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
});
