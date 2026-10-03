import type { MeasurementSample } from "@climate-twin/contracts";
import type { MeasurementBoundaryQuery } from "../../timeseries/types.js";
import "../core.js";

declare module "../core.js" {
  interface DatabaseInternals {
    measurementBoundarySamples(query: MeasurementBoundaryQuery): MeasurementSample[];
  }
  interface ClimateDatabaseCore {
    measurementBoundarySamples(query: MeasurementBoundaryQuery): MeasurementSample[];
  }
}
