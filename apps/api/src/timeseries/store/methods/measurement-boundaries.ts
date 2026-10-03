import { qualifiedName } from "../../schema.js";
import type { MeasurementBoundaryQuery } from "../../types.js";
import { registerTimeseriesStoreMethods, type TimeseriesStoreInternals } from "../core.js";
import { measurementFromRow, type MeasurementRow } from "../support/01-default-schema-to-measurement-bucket-from-row.js";

registerTimeseriesStoreMethods({
  async measurementBoundarySamples(this: TimeseriesStoreInternals, query: MeasurementBoundaryQuery) {
    const samples = qualifiedName(this.schema, "measurement_samples");
    const result = await this.__query<MeasurementRow>(`WITH predecessor AS (
        SELECT observed_at FROM ${samples}
        WHERE sensor_id = $1 AND metric = $2 AND observed_at < $3::TIMESTAMPTZ
          AND quality = ANY($5::TEXT[]) AND (NOT $6::BOOLEAN OR source NOT IN ('mock','replay'))
        ORDER BY observed_at DESC LIMIT 1
      )
      SELECT sensor_id,metric,value,canonical_unit,observed_at,source,quality,metadata
      FROM ${samples}
      WHERE sensor_id = $1 AND metric = $2 AND observed_at = (SELECT observed_at FROM predecessor)
        AND quality = ANY($5::TEXT[]) AND (NOT $6::BOOLEAN OR source NOT IN ('mock','replay'))
      UNION ALL
      SELECT sensor_id,metric,value,canonical_unit,observed_at,source,quality,metadata
      FROM ${samples}
      WHERE sensor_id = $1 AND metric = $2 AND metric = 'energy' AND observed_at = $4::TIMESTAMPTZ
        AND quality = ANY($5::TEXT[]) AND (NOT $6::BOOLEAN OR source NOT IN ('mock','replay'))`,
    [query.sensorId, query.metric, query.from, query.to, query.qualities, query.excludeSynthetic ?? false], query);
    return result.rows.map(measurementFromRow);
  },
});
