import type { MeasurementBoundaryQuery } from "../../timeseries/types.js";
import { registerDatabaseMethods } from "../core.js";
import type { MeasurementSampleRow } from "../support/row-types.js";
import { measurementSampleFromRow } from "../support/row-mappers.js";
import type { MeasurementSample } from "@climate-twin/contracts";

declare module "../core.js" {
  interface DatabaseInternals {
    measurementBoundarySamples(query: MeasurementBoundaryQuery): MeasurementSample[];
  }

  interface ClimateDatabaseCore {
    measurementBoundarySamples(query: MeasurementBoundaryQuery): MeasurementSample[];
  }
}

registerDatabaseMethods({
  measurementBoundarySamples(query: MeasurementBoundaryQuery) {
    const filter = "quality IN (SELECT value FROM json_each(?)) AND (? = 0 OR source NOT IN ('mock', 'replay'))";
    const qualities = JSON.stringify(query.qualities);
    const synthetic = query.excludeSynthetic ? 1 : 0;
    // Indexed predecessor and exact-end seeks. Keep every simultaneous source
    // at the predecessor timestamp so raw conflicts remain explicit.
    const rows = this.db.prepare(`WITH predecessor AS (
        SELECT timestamp FROM measurement_samples
        WHERE sensor_id = ? AND metric = ? AND timestamp < ? AND ${filter}
        ORDER BY timestamp DESC LIMIT 1
      )
      SELECT sensor_id,metric,value,canonical_unit,timestamp,source,quality
      FROM measurement_samples
      WHERE sensor_id = ? AND metric = ? AND timestamp = (SELECT timestamp FROM predecessor) AND ${filter}
      UNION ALL
      SELECT sensor_id,metric,value,canonical_unit,timestamp,source,quality
      FROM measurement_samples
      WHERE sensor_id = ? AND metric = 'energy' AND metric = ? AND timestamp = ? AND ${filter}`)
      .all(query.sensorId, query.metric, query.from, qualities, synthetic,
        query.sensorId, query.metric, qualities, synthetic,
        query.sensorId, query.metric, query.to, qualities, synthetic) as unknown as MeasurementSampleRow[];
    return rows.map(measurementSampleFromRow);
  },
});
