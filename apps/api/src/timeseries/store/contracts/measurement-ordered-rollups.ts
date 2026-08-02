import type {
  MeasurementAnalyticsSeriesQuery,
  MeasurementOrderedRollupWorkResult,
  QueryControl,
} from "../../types.js";
import "../core.js";

declare module "../core.js" {
  interface TimeseriesStoreInternals {
    enqueueMeasurementOrderedRollups(
      series: readonly MeasurementAnalyticsSeriesQuery[],
      from: string,
      to: string,
      qualityMask: number,
      sourceScope: "all" | "real",
      bucketSeconds: 60 | 900 | 3600 | 86400,
      control?: QueryControl,
      dayStarts?: readonly string[],
    ): Promise<number>;
    rebuildNextMeasurementOrderedRollup(control?: QueryControl): Promise<MeasurementOrderedRollupWorkResult>;
  }

  interface TimeseriesStoreCore {
    rebuildNextMeasurementOrderedRollup(control?: QueryControl): Promise<MeasurementOrderedRollupWorkResult>;
  }
}
