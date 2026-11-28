import { SOURCE_LINEAGE, normalizedTimestampExpression } from "./configuration.mjs";

export function verifiedDataMode(table, row) {
  if (row.data_mode == null) return null;
  const { demoSources } = SOURCE_LINEAGE[table];
  const expectedMode = demoSources.includes(row.source) ? "demo" : "live";
  if (row.data_mode !== expectedMode) throw new Error(`Source ${table} row contains an invalid data mode for its source`);
  return row.data_mode;
}

export function lineageInventoryExpressions(table, columns) {
  const lineage = SOURCE_LINEAGE[table];
  if (!lineage) return "";
  const modePresent = columns.includes("data_mode");
  const recordedPresent = lineage.columns.includes("recorded_at") && columns.includes("recorded_at");
  const demoSources = lineage.demoSources.map((source) => `'${source}'`).join(", ");
  return `,
    ${modePresent ? `COUNT(*) FILTER (WHERE data_mode = 'demo' AND source IN (${demoSources}))` : "0"} AS demo_rows,
    ${modePresent ? `COUNT(*) FILTER (WHERE data_mode = 'live' AND source NOT IN (${demoSources}))` : "0"} AS live_rows,
    ${modePresent ? "COUNT(*) FILTER (WHERE data_mode IS NULL)" : "COUNT(*)"} AS unclassified_rows,
    ${modePresent ? `COUNT(*) FILTER (WHERE data_mode IS NOT NULL AND data_mode IS NOT (
      CASE WHEN source IN (${demoSources}) THEN 'demo' ELSE 'live' END))` : "0"} AS invalid_modes,
    ${recordedPresent ? "COUNT(recorded_at)" : "0"} AS recorded_rows,
    ${recordedPresent ? `COUNT(*) FILTER (
      WHERE recorded_at IS NOT NULL AND ${normalizedTimestampExpression("recorded_at")} IS NULL)` : "0"} AS invalid_recording_times`;
}

export function lineageInventory(summary) {
  if (summary.demo_rows === undefined) return {};
  const demoRows = Number(summary.demo_rows);
  const liveRows = Number(summary.live_rows);
  const invalidModes = Number(summary.invalid_modes);
  return {
    lineage: {
      demoRows, liveRows,
      unclassifiedRows: Number(summary.unclassified_rows),
      invalidModes,
      recordedRows: Number(summary.recorded_rows),
      invalidRecordingTimes: Number(summary.invalid_recording_times),
    },
  };
}
