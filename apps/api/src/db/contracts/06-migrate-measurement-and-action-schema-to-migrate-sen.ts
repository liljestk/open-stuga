import "../core.js";

declare module "../core.js" {
  interface DatabaseInternals {
    migrateMeasurementAndActionSchema(): void;
    migrateRevisionActors(): void;
    migrateSecurityAuditSubjectTypes(): void;
    migrateOutdoorLocationKeys(): void;
    backfillLegacyMeasurements(): void;
    backfillSeedOutdoorTemperature(): void;
    migrateSensorMeasurementBindings(): void;
  }
}
