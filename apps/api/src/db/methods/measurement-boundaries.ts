import type { MeasurementBoundaryQuery } from "../../timeseries/types.js";
import { registerDatabaseMethods } from "../core.js";
import type { MeasurementSampleRow } from "../support/02-equipment-attachment-row-to-sensor-data-gap-state.js";
import { measurementSampleFromRow } from "../support/04-canonical-json-value-to-action-playbook-from-row.js";

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
