import type { HeatPumpState, MeasurementSample, Sensor } from "@climate-twin/contracts";
import type { ClimateDatabase } from "./db.js";
import {
  DETACHED_GREE_SENSOR_TAG,
  GREE_SENSOR_TAG,
  HEAT_PUMP_SENSOR_TAG,
  UNPLACED_SENSOR_TAG,
  heatPumpMeasurementSamples,
  heatPumpSensorId,
} from "./heat-pump-measurements.js";
import { heatPumpEvidenceInfluenceRange } from "./analytics/heat-pump-evidence.js";

interface StateRow {
  state_json: string;
  house_id?: string;
}

interface HistoryRow extends StateRow {
  id: number;
}

interface PlacementRow {
  floor_id: string | null;
  room_id: string | null;
  x: number | null;
  y: number | null;
  z: number | null;
}

const UNPLACED = {
  floorId: null,
  roomId: null,
  x: null,
  y: null,
  z: null,
} as const;

function normalizedState(
  state: Partial<HeatPumpState> & Pick<HeatPumpState, "connectionId">,
): HeatPumpState {
  return {
    ...UNPLACED,
    transport: "local",
    currentHumidityPercent: null,
    targetHumidityPercent: null,
    freshAir: null,
    anion: null,
    sleep: null,
    light: null,
    steadyHeat: null,
    powerSave: null,
    cleanFilter: null,
    waterFull: null,
    dehumidifierMode: null,
    compressorFrequencyHz: null,
    diagnostics: {},
    ...state,
  } as HeatPumpState;
}

function stateFromRow(row: StateRow): HeatPumpState {
  return normalizedState(
    JSON.parse(row.state_json) as Partial<HeatPumpState> & Pick<HeatPumpState, "connectionId">,
  );
}

function semanticState(state: HeatPumpState): string {
  const {
    observedAt: _observedAt,
    receivedAt: _receivedAt,
    ...semantic
  } = state;
  return JSON.stringify(semantic);
}

/** Durable typed heat-pump projection and archive journal. No binding keys enter SQLite. */
export class HeatPumpStateStore {
  #measurementSink: ((samples: MeasurementSample[]) => void) | null = null;

  constructor(private readonly database: ClimateDatabase) {
    this.backfillSensorTelemetry();
  }

  setMeasurementSink(sink: (samples: MeasurementSample[]) => void): void {
    this.#measurementSink = sink;
  }

  private sensorName(state: HeatPumpState): string {
    const deviceName = state.name && !/^[0-9a-f]{12}$/iu.test(state.name) ? state.name : null;
    return deviceName ?? ([state.brand, state.model].filter(Boolean).join(" ") || "Gree / Wilfa heat pump");
  }

  private ensureSensor(state: HeatPumpState, reclaimDetached = false): Sensor | null {
    const id = heatPumpSensorId(state.connectionId);
    const existing = this.database.getSensor(id);
    if (existing) {
      const managed = existing.tags.includes(GREE_SENSOR_TAG);
      const detached = existing.tags.includes(DETACHED_GREE_SENSOR_TAG);
      if (existing.houseId !== state.houseId || (!managed && !(reclaimDetached && detached))) return null;
      const name = this.sensorName(state);
      const model = [state.brand, state.model].filter(Boolean).join(" ") || "Gree / Wilfa";
      const tags = reclaimDetached && detached
        ? existing.tags.map((tag) => tag === DETACHED_GREE_SENSOR_TAG ? GREE_SENSOR_TAG : tag)
        : existing.tags;
      const current = existing.name === name && existing.model === model && tags === existing.tags
        ? existing
        : this.database.updateSensor(existing.id, { name, model, tags }) ?? existing;
      return this.syncSensorPlacement(current, state);
    }
    const house = this.database.getHouse(state.houseId);
    const placedFloor = state.floorId
      ? house?.floors.find((candidate) => candidate.id === state.floorId)
      : null;
    const floor = placedFloor ?? house?.floors[0];
    if (!house || !floor) return null;
    const placed = Boolean(placedFloor && state.x !== null && state.y !== null && state.z !== null);
    const room = placed && state.roomId
      ? floor.rooms.find((candidate) => candidate.id === state.roomId) ?? null
      : null;
    return this.database.createSensor({
      id,
      houseId: state.houseId,
      floorId: floor.id,
      name: this.sensorName(state),
      roomId: room?.id ?? null,
      room: room?.name ?? "Unassigned",
      model: [state.brand, state.model].filter(Boolean).join(" ") || "Gree / Wilfa",
      x: placed ? state.x! : floor.width / 2,
      y: placed ? state.y! : floor.height / 2,
      z: placed ? state.z! : floor.elevation + Math.min(1.4, floor.ceilingHeight ?? 2.4),
      energyMeterRole: "standalone",
      tags: [GREE_SENSOR_TAG, HEAT_PUMP_SENSOR_TAG, ...(placed ? [] : [UNPLACED_SENSOR_TAG])],
      enabled: placed,
    });
  }

  private syncSensorPlacement(sensor: Sensor, state: HeatPumpState): Sensor {
    const house = this.database.getHouse(state.houseId);
    const floor = state.floorId
      ? house?.floors.find((candidate) => candidate.id === state.floorId)
      : null;
    const placed = Boolean(floor && state.x !== null && state.y !== null && state.z !== null);
    if (!placed || !floor) {
      const tags = sensor.tags.includes(UNPLACED_SENSOR_TAG)
        ? sensor.tags
        : [...sensor.tags, UNPLACED_SENSOR_TAG];
      if (!sensor.enabled && tags === sensor.tags) return sensor;
      return this.database.updateSensor(sensor.id, {
        enabled: false,
        tags,
      }) ?? sensor;
    }
    const room = state.roomId
      ? floor.rooms.find((candidate) => candidate.id === state.roomId) ?? null
      : null;
    const tags = sensor.tags.filter((tag) => tag !== UNPLACED_SENSOR_TAG);
    if (sensor.floorId === floor.id && sensor.roomId === (room?.id ?? null)
      && sensor.x === state.x && sensor.y === state.y && sensor.z === state.z
      && sensor.enabled && tags.length === sensor.tags.length) return sensor;
    return this.database.updateSensor(sensor.id, {
      enabled: true,
      floorId: floor.id,
      roomId: room?.id ?? null,
      room: room?.name ?? "Unassigned",
      x: state.x!,
      y: state.y!,
      z: state.z!,
      tags,
    }) ?? sensor;
  }

  private projectionKey(connectionId: string): string {
    return `heat_pump_sensor_projection_v1:${connectionId}`;
  }

  private backfillConnection(state: HeatPumpState, liveObservedAt: string | null = null): void {
    const key = this.projectionKey(state.connectionId);
    if (this.database.db.prepare("SELECT 1 FROM metadata WHERE key = ?").get(key)) return;
    let afterId = 0;
    const page = this.database.db.prepare(`
      SELECT id, state_json FROM heat_pump_state_history
      WHERE connection_id = ? AND id > ? ORDER BY id LIMIT 250
    `);
    while (true) {
      const rows = page.all(state.connectionId, afterId) as unknown as HistoryRow[];
      if (rows.length === 0) break;
      const samples = rows.flatMap((row) => {
        const historical = stateFromRow(row);
        return historical.observedAt === liveObservedAt ? [] : heatPumpMeasurementSamples(historical);
      });
      if (samples.length > 0) this.database.insertMeasurementSamples(samples);
      afterId = rows.at(-1)!.id;
    }
    this.database.db.prepare(`INSERT INTO metadata(key, value) VALUES (?, 'complete')
      ON CONFLICT(key) DO UPDATE SET value = excluded.value`).run(key);
  }

  private backfillSensorTelemetry(): void {
    for (const state of this.current()) {
      try {
        if (this.ensureSensor(state)) this.backfillConnection(state);
      } catch {
        // A projection conflict must not prevent the authoritative heat-pump
        // journal from opening; the next accepted poll retries the projection.
      }
    }
  }

  private project(state: HeatPumpState, reclaimDetached = false): void {
    if (!this.ensureSensor(state, reclaimDetached)) return;
    this.backfillConnection(state, this.#measurementSink ? state.observedAt : null);
    const samples = heatPumpMeasurementSamples(state);
    if (samples.length === 0) return;
    if (this.#measurementSink) {
      try {
        this.#measurementSink(samples);
        return;
      } catch {
        // The heat-pump journal remains authoritative; retain the generic
        // projection even if the live publisher is temporarily unavailable.
      }
    }
    this.database.insertMeasurementSamples(samples);
  }

  record(state: HeatPumpState, options: { reclaimDetached?: boolean } = {}): boolean {
    if (!this.database.getHouse(state.houseId)) return false;
    const storedState = { ...normalizedState(state), ...this.placement(state.connectionId) };
    let accepted = true;
    const changed = this.database.transaction(() => {
      const row = this.database.db.prepare(
        "SELECT state_json, house_id FROM heat_pump_state_current WHERE connection_id = ?",
      ).get(state.connectionId) as unknown as StateRow | undefined;
      if (row?.house_id && row.house_id !== state.houseId) {
        accepted = false;
        return false;
      }
      const changed = !row || semanticState(stateFromRow(row)) !== semanticState(storedState);
      const encoded = JSON.stringify(storedState);
      this.database.db.prepare(`
        INSERT INTO heat_pump_state_current
          (connection_id, house_id, observed_at, received_at, state_json)
        VALUES (?, ?, ?, ?, ?)
        ON CONFLICT(connection_id) DO UPDATE SET
          house_id = excluded.house_id,
          observed_at = excluded.observed_at,
          received_at = excluded.received_at,
          state_json = excluded.state_json
      `).run(state.connectionId, state.houseId, state.observedAt, state.receivedAt, encoded);
      const historyInsert = this.database.db.prepare(`
        INSERT OR IGNORE INTO heat_pump_state_history
          (connection_id, house_id, observed_at, received_at, state_json)
        VALUES (?, ?, ?, ?, ?)
      `).run(state.connectionId, state.houseId, state.observedAt, state.receivedAt, encoded);
      if (Number(historyInsert.changes) > 0) {
        const influence = heatPumpEvidenceInfluenceRange(state.observedAt);
        this.database.invalidateDerivedAnalyticsHistory(
          state.houseId,
          influence.from,
          influence.to,
        );
      }
      return changed;
    });
    if (accepted) {
      try {
        this.project(storedState, options.reclaimDetached ?? false);
      } catch {
        // The typed heat-pump state is already durable. Retry the derived
        // sensor projection on the next poll instead of losing the connection.
      }
    }
    return changed;
  }

  archivePage(afterRowId: number, limit: number): Array<{ rowId: number; record: HeatPumpState }> {
    if (!Number.isInteger(limit) || limit < 1 || limit > 10_000) {
      throw new RangeError("Heat-pump archive page size must be an integer from 1 to 10000");
    }
    const pageSize = limit;
    if (!Number.isSafeInteger(afterRowId) || afterRowId < 0) {
      throw new RangeError("Heat-pump archive cursor is invalid");
    }
    const rows = this.database.db.prepare(`
      SELECT id, state_json FROM heat_pump_state_history
      WHERE id > ? ORDER BY id LIMIT ?
    `).all(afterRowId, pageSize) as unknown as HistoryRow[];
    return rows.map((row) => ({ rowId: row.id, record: stateFromRow(row) }));
  }

  current(houseId?: string): HeatPumpState[] {
    const rows = (houseId
      ? this.database.db.prepare(`
          SELECT state.state_json FROM heat_pump_state_current AS state
          JOIN houses AS house ON house.id = state.house_id
          WHERE state.house_id = ? AND house.deleted_at IS NULL
          ORDER BY state.observed_at DESC, state.connection_id
        `).all(houseId)
      : this.database.db.prepare(`
          SELECT state.state_json FROM heat_pump_state_current AS state
          JOIN houses AS house ON house.id = state.house_id
          WHERE house.deleted_at IS NULL ORDER BY state.observed_at DESC, state.connection_id
        `).all()) as unknown as StateRow[];
    return rows.map(stateFromRow);
  }

  placement(connectionId: string): Pick<HeatPumpState, "floorId" | "roomId" | "x" | "y" | "z"> {
    const row = this.database.db.prepare(`
      SELECT placement.floor_id, placement.room_id, placement.x, placement.y, placement.z
      FROM connected_device_placements AS placement
      JOIN houses AS house ON house.id = placement.house_id
      WHERE placement.connection_id = ? AND house.deleted_at IS NULL
    `).get(connectionId) as unknown as PlacementRow | undefined;
    return row ? {
      floorId: row.floor_id,
      roomId: row.room_id,
      x: row.x,
      y: row.y,
      z: row.z,
    } : { ...UNPLACED };
  }

  setPlacement(
    connectionId: string,
    houseId: string,
    placement: Pick<HeatPumpState, "floorId" | "roomId" | "x" | "y" | "z">,
  ): HeatPumpState | null {
    if (!this.database.getHouse(houseId)) return null;
    return this.database.transaction(() => {
      const timestamp = new Date().toISOString();
      this.database.db.prepare(`
        INSERT INTO connected_device_placements
          (connection_id, house_id, floor_id, room_id, x, y, z, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(connection_id) DO UPDATE SET
          house_id = excluded.house_id,
          floor_id = excluded.floor_id,
          room_id = excluded.room_id,
          x = excluded.x,
          y = excluded.y,
          z = excluded.z,
          updated_at = excluded.updated_at
      `).run(
        connectionId,
        houseId,
        placement.floorId,
        placement.roomId,
        placement.x,
        placement.y,
        placement.z,
        timestamp,
      );
      const row = this.database.db.prepare(`
        SELECT state_json FROM heat_pump_state_current
        WHERE connection_id = ? AND house_id = ?
      `).get(connectionId, houseId) as unknown as StateRow | undefined;
      if (!row) return null;
      const next = { ...stateFromRow(row), ...placement, receivedAt: timestamp };
      this.database.db.prepare(`
        UPDATE heat_pump_state_current SET received_at = ?, state_json = ?
        WHERE connection_id = ? AND house_id = ?
      `).run(timestamp, JSON.stringify(next), connectionId, houseId);
      try {
        this.ensureSensor(next);
      } catch {
        // Placement remains durable even if its sensor projection needs retrying.
      }
      return next;
    });
  }

  history(
    connectionId: string,
    options: { from?: string; to?: string; limit?: number } = {},
  ): HeatPumpState[] {
    const filters = ["state.connection_id = ?", "house.deleted_at IS NULL"];
    const values: Array<string | number> = [connectionId];
    if (options.from) {
      filters.push("observed_at >= ?");
      values.push(options.from);
    }
    if (options.to) {
      filters.push("observed_at <= ?");
      values.push(options.to);
    }
    const limit = Math.max(1, Math.min(1_000, options.limit ?? 250));
    values.push(limit);
    const rows = this.database.db.prepare(`
      SELECT state.state_json FROM heat_pump_state_history AS state
      JOIN houses AS house ON house.id = state.house_id
      WHERE ${filters.join(" AND ")}
      ORDER BY state.observed_at DESC, state.id DESC LIMIT ?
    `).all(...values) as unknown as StateRow[];
    return rows.map(stateFromRow);
  }

  detachSensor(connectionId: string, houseId: string): Sensor | null {
    const sensor = this.database.getSensor(heatPumpSensorId(connectionId));
    if (!sensor || sensor.houseId !== houseId || !sensor.tags.includes(GREE_SENSOR_TAG)) return null;
    return this.database.updateSensor(sensor.id, {
      enabled: false,
      tags: sensor.tags.map((tag) => tag === GREE_SENSOR_TAG ? DETACHED_GREE_SENSOR_TAG : tag),
    });
  }

  /**
   * Journal the connection as unavailable from `errorAt`, which may predate
   * the call when a debounce backdates the outage start. `receivedAt` keeps
   * meaning the moment this row was written, as it does for every snapshot.
   */
  markUnavailable(
    connectionId: string,
    errorAt = new Date().toISOString(),
    receivedAt = new Date().toISOString(),
  ): HeatPumpState | null {
    const current = this.current().find((state) => state.connectionId === connectionId);
    if (!current || !current.available) return null;
    const unavailable: HeatPumpState = {
      ...current,
      observedAt: errorAt,
      receivedAt,
      available: false,
      activity: current.power === false ? "off" : "unknown",
      activityEvidence: current.power === false ? "protocol" : "unavailable",
    };
    this.record(unavailable);
    return unavailable;
  }
}
