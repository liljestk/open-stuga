import type {
  MeasurementAnalyticsRollupQuery,
  MeasurementAnalyticsRollupResult,
} from "../../types.js";
import "../core.js";

declare module "../core.js" {
  interface TimeseriesStoreInternals {
    measurementAnalyticsRollup(query: MeasurementAnalyticsRollupQuery): Promise<MeasurementAnalyticsRollupResult>;
  }

  interface TimeseriesStoreCore {
    measurementAnalyticsRollup(query: MeasurementAnalyticsRollupQuery): Promise<MeasurementAnalyticsRollupResult>;
  }
}
