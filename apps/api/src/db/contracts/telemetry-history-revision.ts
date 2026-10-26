import "../core.js";

declare module "../core.js" {
  interface DatabaseInternals {
    /** Bumped whenever a measurement older than two hours is stored. */
    telemetryHistoryRevision(): number;
  }

  interface ClimateDatabaseCore {
    telemetryHistoryRevision(): number;
  }
}
