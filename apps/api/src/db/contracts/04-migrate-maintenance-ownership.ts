import "../core.js";

declare module "../core.js" {
  interface DatabaseInternals {
    migrateMaintenanceOwnership(): void;
  }
}
