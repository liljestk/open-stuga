import "../core.js";

declare module "../core.js" {
  interface DatabaseInternals {
    migratePropertyAndObservationIntegrity(): void;
  }
}
