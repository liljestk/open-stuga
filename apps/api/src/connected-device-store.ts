import type {
  ConnectedDevicePlacement,
  ConnectedDeviceState,
} from "@climate-twin/contracts";
import type { ClimateDatabase } from "./db.js";

interface StateRow {
  state_json: string;
}

interface PlacementRow {
  floor_id: string | null;
  room_id: string | null;
  x: number | null;
  y: number | null;
  z: number | null;
}

interface CommandRow {
  request_hash: string;
  result_state_json: string | null;
  updated_at: string;
}

export type CommandClaim =
  | { status: "claimed" }
  | { status: "pending" }
  | { status: "complete"; state: ConnectedDeviceState }
  | { status: "conflict" };

function parseState(row: StateRow): ConnectedDeviceState {
  return JSON.parse(row.state_json) as ConnectedDeviceState;
}

function semanticState(state: ConnectedDeviceState): string {
  const { observedAt: _observedAt, receivedAt: _receivedAt, ...semantic } = state;
  return JSON.stringify(semantic);
}

const UNPLACED: ConnectedDevicePlacement = {
  floorId: null,
  roomId: null,
  x: null,
  y: null,
  z: null,
};
const STATE_UNCHANGED_HEARTBEAT_MS = 60_000;

/**
 * Durable provider-neutral Tuya projection and idempotency journal.
 * Device identities and local keys remain in the protected secrets file.
 */
export class ConnectedDeviceStore {
  constructor(private readonly database: ClimateDatabase) {}

  record(state: ConnectedDeviceState): boolean {
    return this.database.transaction(() => {
      const row = this.database.db.prepare(
        "SELECT state_json FROM connected_device_state_current WHERE connection_id = ?",
      ).get(state.connectionId) as unknown as StateRow | undefined;
      const previous = row ? parseState(row) : null;
      const changed = !previous || semanticState(previous) !== semanticState(state);
      if (!changed && previous.receivedAt && Number.isFinite(Date.parse(previous.receivedAt))
        && Date.parse(previous.receivedAt) > Date.now() - STATE_UNCHANGED_HEARTBEAT_MS) {
        return false;
      }
      this.database.db.prepare(`
        INSERT INTO connected_device_state_current
          (connection_id, house_id, observed_at, received_at, state_json)
        VALUES (?, ?, ?, ?, ?)
        ON CONFLICT(connection_id) DO UPDATE SET
          house_id = excluded.house_id,
          observed_at = excluded.observed_at,
          received_at = excluded.received_at,
          state_json = excluded.state_json
      `).run(
        state.connectionId,
        state.houseId,
        state.observedAt,
        state.receivedAt,
        JSON.stringify(state),
      );
      return changed;
    });
  }

  current(houseId?: string): ConnectedDeviceState[] {
    const rows = (houseId
      ? this.database.db.prepare(`
          SELECT state_json FROM connected_device_state_current
          WHERE house_id = ? ORDER BY connection_id
        `).all(houseId)
      : this.database.db.prepare(`
          SELECT state_json FROM connected_device_state_current
          ORDER BY house_id, connection_id
        `).all()) as unknown as StateRow[];
    return rows.map(parseState);
  }

  get(connectionId: string): ConnectedDeviceState | null {
    const row = this.database.db.prepare(
      "SELECT state_json FROM connected_device_state_current WHERE connection_id = ?",
    ).get(connectionId) as unknown as StateRow | undefined;
    return row ? parseState(row) : null;
  }

  placement(connectionId: string): ConnectedDevicePlacement {
    const row = this.database.db.prepare(`
      SELECT floor_id, room_id, x, y, z
      FROM connected_device_placements WHERE connection_id = ?
    `).get(connectionId) as unknown as PlacementRow | undefined;
    if (!row) return { ...UNPLACED };
    return {
      floorId: row.floor_id,
      roomId: row.room_id,
      x: row.x,
      y: row.y,
      z: row.z,
    };
  }

  setPlacement(
    connectionId: string,
    houseId: string,
    placement: ConnectedDevicePlacement,
  ): ConnectedDeviceState | null {
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
      const state = this.get(connectionId);
      if (!state) return null;
      const next = { ...state, ...placement, receivedAt: timestamp };
      this.database.db.prepare(`
        UPDATE connected_device_state_current
        SET received_at = ?, state_json = ?
        WHERE connection_id = ?
      `).run(timestamp, JSON.stringify(next), connectionId);
      return next;
    });
  }

  markUnavailable(connectionId: string, timestamp = new Date().toISOString()): ConnectedDeviceState | null {
    const current = this.get(connectionId);
    if (!current || !current.available) return null;
    const unavailable = {
      ...current,
      available: false,
      observedAt: timestamp,
      receivedAt: timestamp,
    };
    this.record(unavailable);
    return unavailable;
  }

  claimCommand(
    connectionId: string,
    houseId: string,
    operationId: string,
    requestHash: string,
  ): CommandClaim {
    return this.database.transaction(() => {
      const timestamp = new Date().toISOString();
      const inserted = this.database.db.prepare(`
        INSERT OR IGNORE INTO connected_device_commands
          (connection_id, house_id, operation_id, request_hash, result_state_json, created_at, updated_at)
        VALUES (?, ?, ?, ?, NULL, ?, ?)
      `).run(connectionId, houseId, operationId, requestHash, timestamp, timestamp);
      if (Number(inserted.changes) > 0) {
        this.pruneCommands();
        return { status: "claimed" };
      }
      const row = this.database.db.prepare(`
        SELECT request_hash, result_state_json, updated_at FROM connected_device_commands
        WHERE connection_id = ? AND operation_id = ?
      `).get(connectionId, operationId) as unknown as CommandRow;
      if (row.request_hash !== requestHash) return { status: "conflict" };
      if (row.result_state_json) {
        return {
          status: "complete",
          state: JSON.parse(row.result_state_json) as ConnectedDeviceState,
        };
      }
      if (Date.parse(row.updated_at) < Date.now() - 30_000) {
        this.database.db.prepare(`
          UPDATE connected_device_commands SET updated_at = ?
          WHERE connection_id = ? AND operation_id = ?
        `).run(timestamp, connectionId, operationId);
        return { status: "claimed" };
      }
      return { status: "pending" };
    });
  }

  releaseCommand(connectionId: string, operationId: string): void {
    this.database.db.prepare(`
      DELETE FROM connected_device_commands
      WHERE connection_id = ? AND operation_id = ? AND result_state_json IS NULL
    `).run(connectionId, operationId);
  }

  completeCommand(
    connectionId: string,
    operationId: string,
    state: ConnectedDeviceState,
  ): void {
    this.database.db.prepare(`
      UPDATE connected_device_commands
      SET result_state_json = ?, updated_at = ?
      WHERE connection_id = ? AND operation_id = ?
    `).run(JSON.stringify(state), new Date().toISOString(), connectionId, operationId);
  }

  deleteConnection(connectionId: string): void {
    this.database.transaction(() => {
      this.database.db.prepare(
        "DELETE FROM connected_device_commands WHERE connection_id = ?",
      ).run(connectionId);
      this.database.db.prepare(
        "DELETE FROM connected_device_placements WHERE connection_id = ?",
      ).run(connectionId);
      this.database.db.prepare(
        "DELETE FROM connected_device_state_current WHERE connection_id = ?",
      ).run(connectionId);
    });
  }

  private pruneCommands(): void {
    const threshold = new Date(Date.now() - 30 * 86_400_000).toISOString();
    this.database.db.prepare(
      "DELETE FROM connected_device_commands WHERE updated_at < ?",
    ).run(threshold);
  }
}
