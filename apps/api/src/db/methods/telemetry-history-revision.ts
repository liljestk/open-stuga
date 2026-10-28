import { registerDatabaseMethods } from "../core.js";

declare module "../core.js" {
  interface DatabaseInternals {
    /** Bumped whenever a measurement older than two hours is stored. */
    telemetryHistoryRevision(): number;
  }

  interface ClimateDatabaseCore {
    telemetryHistoryRevision(): number;
  }
}

registerDatabaseMethods({
  telemetryHistoryRevision(): number {
    const row = this.db.prepare("SELECT revision FROM telemetry_history_revision WHERE id = 1").get() as
      | { revision: number }
      | undefined;
    return Number(row?.revision ?? 1);
  },
});
