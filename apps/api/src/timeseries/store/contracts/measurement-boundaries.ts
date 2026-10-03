import type { MeasurementBoundaryQuery, MeasurementSampleRecord } from "../../types.js";
import "../core.js";

declare module "../core.js" {
  interface TimeseriesStoreInternals {
    measurementBoundarySamples(query: MeasurementBoundaryQuery): Promise<MeasurementSampleRecord[]>;
  }
  interface TimeseriesStoreCore {
    measurementBoundarySamples(query: MeasurementBoundaryQuery): Promise<MeasurementSampleRecord[]>;
  }
}
