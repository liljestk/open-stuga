import "../core.js";

declare module "../core.js" {
  interface DatabaseInternals {
    invalidateDerivedAnalyticsHistory(
      houseId: string,
      from: string,
      to: string,
      invalidatedAt?: string,
    ): boolean;
  }

  interface ClimateDatabaseCore {
    invalidateDerivedAnalyticsHistory(
      houseId: string,
      from: string,
      to: string,
      invalidatedAt?: string,
    ): boolean;
  }
}
