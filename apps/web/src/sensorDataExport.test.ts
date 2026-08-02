import { describe, expect, it } from "vitest";
import { strFromU8, unzipSync } from "fflate";
import readXlsxFile from "read-excel-file/node";
import type { AnalyticsQueryResponse } from "@climate-twin/contracts";
import { createDemoState } from "./domain";
import {
  buildSensorExportTable,
  mergeAnalyticsResponses,
  sensorExportCsv,
  sensorExportXlsx,
} from "./sensorDataExport";

function response(): AnalyticsQueryResponse {
  const timestamp = "2026-07-01T12:00:00.000Z";
  const provenance = {
    algorithmKey: "analytics-bucket-rollup",
    algorithmVersion: "1.0.0",
    generatedAt: timestamp,
    inputStart: timestamp,
    inputEnd: "2026-07-01T12:15:00.000Z",
    sourceIds: ["sensor-1"],
    archiveState: "not-configured" as const,
  };
  const summary = (measurementId: string, unit: string, value: number) => ({
    entityId: "sensor-1",
    measurementId,
    canonicalUnit: unit,
    count: 1,
    coverage: 1,
    minimum: value,
    maximum: value,
    mean: value,
    median: value,
    standardDeviation: 0,
    medianAbsoluteDeviation: 0,
    p05: value,
    p95: value,
  });
  const series = (measurementId: string, unit: string, value: number) => ({
    entityId: "sensor-1",
    entityLabel: "=SUM(1,2)",
    measurementId,
    canonicalUnit: unit,
    truthClass: "derived" as const,
    aggregation: "mean" as const,
    resolution: "15m" as const,
    points: [{ timestamp, value, minimum: value, maximum: value, sampleCount: 1, coverage: 1, qualityFlags: [] }],
    summary: summary(measurementId, unit, value),
    provenance,
  });
  return {
    apiVersion: "1.0",
    requestId: "export-1",
    dataMode: "demo",
    resolvedRange: { start: timestamp, end: "2026-07-01T12:15:00.000Z", timezone: "Europe/Helsinki" },
    resolution: "15m",
    series: [series("temperature", "°C", 20.25), series("humidity", "%", 52)],
    summaries: [summary("temperature", "°C", 20.25), summary("humidity", "%", 52)],
    quality: { coverage: 1, seriesCount: 2, sampleCount: 2, excludedSampleCount: 0, includedQualities: ["good"], lowCoverageSeries: 0 },
    provenance: [provenance, provenance],
    warnings: [],
    generatedAt: timestamp,
    cache: { hit: false, keyVersion: "analytics-query-v1" },
  };
}

function table() {
  const state = createDemoState();
  const sensor = { ...state.sensors[0]!, id: "sensor-1", name: "=SUM(1,2)" };
  const definitions = state.measurementDefinitions.filter((definition) => ["temperature", "humidity"].includes(definition.id));
  return buildSensorExportTable({
    result: response(),
    sensors: [sensor],
    definitions,
    locale: "en",
    units: "metric",
    labels: { localTime: "Home time", utcTime: "UTC timestamp", sensorName: "Sensor name", sensorId: "Sensor ID" },
  });
}

describe("sensor data export", () => {
  it("aligns multiple measurements into one row per sensor and time bucket", () => {
    const exportTable = table();
    expect(exportTable.rows).toHaveLength(1);
    expect(exportTable.rows[0]).toMatchObject({
      localTimestamp: "2026-07-01 15:00:00 GMT+03:00",
      sensorName: "=SUM(1,2)",
      values: { temperature: 20.3, humidity: 52 },
    });
    expect(exportTable.columns.map((column) => column.label)).toEqual(["Temperature", "Humidity"]);
  });

  it("writes formula-safe CSV and a single styled Excel worksheet", async () => {
    const exportTable = table();
    const csv = sensorExportCsv(exportTable);
    expect(csv).toContain("Home time,UTC timestamp,Sensor name,Sensor ID,Temperature (°C),Humidity (%)");
    expect(csv).toContain("\"'=SUM(1,2)\"");

    const workbook = unzipSync(sensorExportXlsx(exportTable, "Sensor data"));
    expect(Object.keys(workbook)).toContain("xl/worksheets/sheet1.xml");
    const sheet = strFromU8(workbook["xl/worksheets/sheet1.xml"]!);
    const workbookXml = strFromU8(workbook["xl/workbook.xml"]!);
    expect(workbookXml).toContain('sheet name="Sensor data"');
    expect(sheet).toContain("<autoFilter");
    expect(sheet).toContain("=SUM(1,2)");
    expect(sheet).not.toContain("<f>");
    expect(sheet).toContain("<v>20.3</v>");
    await expect(readXlsxFile(Buffer.from(sensorExportXlsx(exportTable, "Sensor data")))).resolves.toEqual([{
      sheet: "Sensor data",
      data: [
        ["Home time", "UTC timestamp", "Sensor name", "Sensor ID", "Temperature (°C)", "Humidity (%)"],
        ["2026-07-01 15:00:00 GMT+03:00", "2026-07-01T12:00:00.000Z", "=SUM(1,2)", "sensor-1", 20.3, 52],
      ],
    }]);
  });

  it("merges safe query batches without losing series or warnings", () => {
    const first = response();
    const second = {
      ...response(),
      requestId: "export-2",
      series: response().series.map((series) => ({ ...series, entityId: "sensor-2", entityLabel: "Bedroom" })),
      summaries: response().summaries.map((summary) => ({ ...summary, entityId: "sensor-2" })),
      warnings: [{ code: "LOW_COVERAGE", message: "Some buckets have low coverage." }],
    };
    const merged = mergeAnalyticsResponses([first, second], "merged");
    expect(merged.requestId).toBe("merged");
    expect(merged.series).toHaveLength(4);
    expect(merged.quality.seriesCount).toBe(4);
    expect(merged.warnings).toEqual(second.warnings);
  });
});
