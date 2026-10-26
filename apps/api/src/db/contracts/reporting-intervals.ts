import "../core.js";

declare module "../core.js" {
  interface DatabaseInternals {
    /**
     * Each series' long-run reporting interval: the median gap between
     * consecutive readings over the last three days, recomputed at most daily.
     * Series without enough readings are absent.
     */
    expectedReportingIntervals(
      series: ReadonlyArray<{ sensorId: string; metric: string }>,
      now?: number,
    ): Map<string, number>;
  }

  interface ClimateDatabaseCore {
    expectedReportingIntervals(
      series: ReadonlyArray<{ sensorId: string; metric: string }>,
      now?: number,
    ): Map<string, number>;
  }
}
