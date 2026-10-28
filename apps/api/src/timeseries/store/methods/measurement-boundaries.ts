import { qualifiedName } from "../../schema.js";
import type { MeasurementBoundaryQuery, MeasurementSampleRecord } from "../../types.js";
import { registerTimeseriesStoreMethods, type TimeseriesStoreInternals } from "../core.js";
import { measurementFromRow } from "../support/row-mappers.js";
import type { MeasurementRow } from "../support/row-types.js";

declare module "../core.js" {
  interface TimeseriesStoreInternals {
    measurementBoundarySamples(query: MeasurementBoundaryQuery): Promise<MeasurementSampleRecord[]>;
  }

  interface TimeseriesStoreCore {
    measurementBoundarySamples(query: MeasurementBoundaryQuery): Promise<MeasurementSampleRecord[]>;
  }
}

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
