import { registerDatabaseMethods } from "../core.js";

registerDatabaseMethods({
  telemetryHistoryRevision(): number {
    const row = this.db.prepare("SELECT revision FROM telemetry_history_revision WHERE id = 1").get() as
      | { revision: number }
      | undefined;
    return Number(row?.revision ?? 1);
  },
});
