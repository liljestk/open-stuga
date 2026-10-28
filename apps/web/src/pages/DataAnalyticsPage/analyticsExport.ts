import type { AnalyticsQueryResponse } from "@climate-twin/contracts";
import { csvDocument } from "../../csv";

export function analyticsCsv(result: AnalyticsQueryResponse): string {
  const rows: Array<Array<string | number>> = [[
    "api_version", "data_mode", "request_id", "timezone", "range_start", "range_end", "generated_at",
    "series", "entity_id", "measurement", "timestamp", "value", "unit", "truth_class", "aggregation",
    "resolution", "quality_filter", "excluded_source_samples", "coverage", "sample_count", "quality_flags", "algorithm", "algorithm_version",
  ]];
  for (const series of result.series) {
    for (const point of series.points) {
      rows.push([
        result.apiVersion, result.dataMode, result.requestId, result.resolvedRange.timezone, result.resolvedRange.start,
        result.resolvedRange.end, result.generatedAt, series.entityLabel, series.entityId, series.measurementId, point.timestamp,
        point.value ?? "", series.canonicalUnit, series.truthClass, series.aggregation, series.resolution,
        result.quality.includedQualities.join("|"), result.quality.excludedSampleCount,
        point.coverage, point.sampleCount, point.qualityFlags.join("|"),
        series.provenance.algorithmKey, series.provenance.algorithmVersion,
      ]);
    }
  }
  return csvDocument(rows);
}

export function downloadText(filename: string, content: string, type: string): void {
  const url = URL.createObjectURL(new Blob([content], { type }));
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = filename;
  anchor.click();
  setTimeout(() => URL.revokeObjectURL(url), 0);
}
