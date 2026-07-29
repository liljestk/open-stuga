import type { HeatPumpState } from "@climate-twin/contracts";
import type { ClimateDatabase } from "./db.js";

interface StateRow {
  state_json: string;
}

interface HistoryRow extends StateRow {
  id: number;
}

function stateFromRow(row: StateRow): HeatPumpState {
  return JSON.parse(row.state_json) as HeatPumpState;
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
  constructor(private readonly database: ClimateDatabase) {}

  record(state: HeatPumpState): boolean {
    return this.database.transaction(() => {
      const row = this.database.db.prepare(
        "SELECT state_json FROM heat_pump_state_current WHERE connection_id = ?",
      ).get(state.connectionId) as unknown as StateRow | undefined;
      const changed = !row || semanticState(stateFromRow(row)) !== semanticState(state);
      const encoded = JSON.stringify(state);
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
      this.database.db.prepare(`
        INSERT OR IGNORE INTO heat_pump_state_history
          (connection_id, house_id, observed_at, received_at, state_json)
        VALUES (?, ?, ?, ?, ?)
      `).run(state.connectionId, state.houseId, state.observedAt, state.receivedAt, encoded);
      return changed;
    });
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
          SELECT state_json FROM heat_pump_state_current
          WHERE house_id = ? ORDER BY observed_at DESC, connection_id
        `).all(houseId)
      : this.database.db.prepare(`
          SELECT state_json FROM heat_pump_state_current
          ORDER BY observed_at DESC, connection_id
        `).all()) as unknown as StateRow[];
    return rows.map(stateFromRow);
  }

  history(
    connectionId: string,
    options: { from?: string; to?: string; limit?: number } = {},
  ): HeatPumpState[] {
    const filters = ["connection_id = ?"];
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
      SELECT state_json FROM heat_pump_state_history
      WHERE ${filters.join(" AND ")}
      ORDER BY observed_at DESC, id DESC LIMIT ?
    `).all(...values) as unknown as StateRow[];
    return rows.map(stateFromRow);
  }

  markUnavailable(connectionId: string, errorAt = new Date().toISOString()): HeatPumpState | null {
    const current = this.current().find((state) => state.connectionId === connectionId);
    if (!current || !current.available) return null;
    const unavailable: HeatPumpState = {
      ...current,
      observedAt: errorAt,
      receivedAt: errorAt,
      available: false,
      activity: current.power === false ? "off" : "unknown",
      activityEvidence: current.power === false ? "protocol" : "unavailable",
    };
    this.record(unavailable);
    return unavailable;
  }
}
