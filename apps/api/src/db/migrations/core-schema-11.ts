/** Daily latency histograms of the analytics a Home actually used, kept on the appliance as evidence. */
export const CORE_SCHEMA_11 = `
      CREATE TABLE IF NOT EXISTS analytics_latency_histogram (
        day TEXT NOT NULL,
        house_id TEXT NOT NULL,
        operation TEXT NOT NULL,
        bucket_ms INTEGER NOT NULL CHECK (bucket_ms > 0),
        count INTEGER NOT NULL CHECK (count >= 0),
        PRIMARY KEY (day, house_id, operation, bucket_ms)
      );
      `;
