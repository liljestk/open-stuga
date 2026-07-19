import { describe, expect, it, vi } from "vitest";
import type { MeasurementDefinition, Sensor } from "@climate-twin/contracts";
import {
  buildHistoricalImport,
  buildHistoricalImportAsync,
  createInitialMapping,
  MAX_IMPORT_ROWS,
  parseCsv,
  parseImportTimestamp,
  validateImportSheet,
  validateXlsxArchive,
} from "./historicalImport";

function storedZip(entries: Array<{ name: string; text: string; declaredSize?: number }>): ArrayBuffer {
  const encoder = new TextEncoder();
  const localParts: Uint8Array[] = [];
  const centralParts: Uint8Array[] = [];
  let localOffset = 0;
  for (const entry of entries) {
    const name = encoder.encode(entry.name);
    const data = encoder.encode(entry.text);
    const declaredSize = entry.declaredSize ?? data.byteLength;
    const local = new Uint8Array(30 + name.byteLength + data.byteLength);
    const localView = new DataView(local.buffer);
    localView.setUint32(0, 0x04034b50, true);
    localView.setUint16(4, 20, true);
    localView.setUint32(18, data.byteLength, true);
    localView.setUint32(22, declaredSize, true);
    localView.setUint16(26, name.byteLength, true);
    local.set(name, 30);
    local.set(data, 30 + name.byteLength);
    localParts.push(local);

    const central = new Uint8Array(46 + name.byteLength);
    const centralView = new DataView(central.buffer);
    centralView.setUint32(0, 0x02014b50, true);
    centralView.setUint16(4, 20, true);
    centralView.setUint16(6, 20, true);
    centralView.setUint32(20, data.byteLength, true);
    centralView.setUint32(24, declaredSize, true);
    centralView.setUint16(28, name.byteLength, true);
    centralView.setUint32(42, localOffset, true);
    central.set(name, 46);
    centralParts.push(central);
    localOffset += local.byteLength;
  }
  const centralSize = centralParts.reduce((total, part) => total + part.byteLength, 0);
  const result = new Uint8Array(localOffset + centralSize + 22);
  let offset = 0;
  for (const part of localParts) { result.set(part, offset); offset += part.byteLength; }
  for (const part of centralParts) { result.set(part, offset); offset += part.byteLength; }
  const eocd = new DataView(result.buffer, offset, 22);
  eocd.setUint32(0, 0x06054b50, true);
  eocd.setUint16(8, entries.length, true);
  eocd.setUint16(10, entries.length, true);
  eocd.setUint32(12, centralSize, true);
  eocd.setUint32(16, localOffset, true);
  return result.buffer;
}

const definitions: MeasurementDefinition[] = [
  {
    id: "temperature", labels: { en: "Temperature", fi: "Lämpötila" }, unit: "°C", precision: 1,
    validMin: -80, validMax: 100, displayMin: 15, displayMax: 30, interpolationDelta: 2,
    colorScale: "thermal", builtin: true, enabled: true, spatialInterpolation: true, forecastSupported: true,
  },
  {
    id: "humidity", labels: { en: "Humidity", fi: "Ilmankosteus" }, unit: "%", precision: 0,
    validMin: 0, validMax: 100, displayMin: 20, displayMax: 80, interpolationDelta: 8,
    colorScale: "humidity", builtin: true, enabled: true, spatialInterpolation: true, forecastSupported: true,
  },
];

const sensors: Sensor[] = [{
  id: "sensor-living", houseId: "house", floorId: "floor", name: "Living room", room: "Living room",
  model: "T315", x: 1, y: 1, z: 1, tags: [], enabled: true,
}];

describe("historical spreadsheet import", () => {
  it("detects semicolon CSV, Finnish headers, decimal commas, and local house time", () => {
    const sheet = parseCsv([
      "Päivämäärä;Anturi;Lämpötila (°C);Ilmankosteus (%)",
      "15.01.2026 08:30;Living room;21,4;45,5",
    ].join("\n"), "history.csv");
    const mapping = createInitialMapping(sheet, definitions, sensors, "fi");
    const preview = buildHistoricalImport(sheet, mapping, sensors, definitions, "Europe/Helsinki");

    expect(mapping).toMatchObject({ timestampColumn: 0, sensorColumn: 1, mode: "wide", dateOrder: "dmy" });
    expect(preview.issues).toEqual([]);
    expect(preview.samples).toEqual([
      expect.objectContaining({ metric: "temperature", value: 21.4, timestamp: "2026-01-15T06:30:00.000Z", source: "import" }),
      expect.objectContaining({ metric: "humidity", value: 45.5, timestamp: "2026-01-15T06:30:00.000Z", source: "import" }),
    ]);
  });

  it("converts Fahrenheit, reports invalid rows, and removes duplicates inside the file", () => {
    const sheet = parseCsv([
      "Date and time,Sensor,Temperature (°F),Humidity (%)",
      "2026-01-15 08:00,Living room,68,45",
      "2026-01-15 08:00,Living room,68,45",
      "2026-01-15 09:00,Unknown room,70,44",
      "not a date,Living room,72,44",
      "2026-01-15 10:00,Living room,72,145",
    ].join("\n"));
    const mapping = createInitialMapping(sheet, definitions, sensors, "en");
    const preview = buildHistoricalImport(sheet, mapping, sensors, definitions, "UTC");

    expect(mapping.wideColumns.find((item) => item.metric === "temperature")?.inputUnit).toBe("fahrenheit");
    expect(preview.samples).toEqual([
      expect.objectContaining({ metric: "temperature", value: 20 }),
      expect.objectContaining({ metric: "humidity", value: 45 }),
      expect.objectContaining({ metric: "temperature", value: 22.2222 }),
    ]);
    expect(preview.duplicatesInFile).toBe(2);
    expect(preview.issues).toEqual([
      { row: 4, message: "The sensor does not match a sensor in this house." },
      { row: 5, message: "The date or time could not be read." },
      { row: 6, message: "Humidity is outside the allowed range." },
    ]);
  });

  it("supports files where metric and value are listed down rows", () => {
    const sheet = parseCsv([
      "Timestamp,Sensor,Measurement,Value,Unit",
      "2026-01-15T08:00:00Z,sensor-living,Temperature,68,°F",
      "2026-01-15T08:00:00Z,sensor-living,Humidity,48,%",
    ].join("\n"));
    const mapping = createInitialMapping(sheet, definitions, sensors, "en");
    const preview = buildHistoricalImport(sheet, mapping, sensors, definitions, "Europe/Helsinki");

    expect(mapping.mode).toBe("long");
    expect(preview.samples).toEqual([
      expect.objectContaining({ metric: "temperature", value: 20, timestamp: "2026-01-15T08:00:00.000Z" }),
      expect.objectContaining({ metric: "humidity", value: 48, timestamp: "2026-01-15T08:00:00.000Z" }),
    ]);
  });

  it("tracks the date range without depending on input order", () => {
    const sheet = parseCsv([
      "Timestamp,Sensor,Temperature",
      "2026-03-01T08:00:00Z,Living room,21",
      "2026-01-01T08:00:00Z,Living room,19",
      "2026-02-01T08:00:00Z,Living room,20",
    ].join("\n"));
    const mapping = createInitialMapping(sheet, definitions, sensors, "en");
    const preview = buildHistoricalImport(sheet, mapping, sensors, definitions, "UTC");

    expect(preview.firstTimestamp).toBe("2026-01-01T08:00:00.000Z");
    expect(preview.lastTimestamp).toBe("2026-03-01T08:00:00.000Z");
  });

  it("retains only the displayed issue details while preserving exact totals", () => {
    const rows = Array.from({ length: 30 }, (_, index) => `2026-01-${String(index % 28 + 1).padStart(2, "0")}T08:00:00Z,Living room,invalid,invalid`);
    const sheet = parseCsv([
      "Timestamp,Sensor,Temperature,Humidity",
      ...rows,
    ].join("\n"));
    const mapping = createInitialMapping(sheet, definitions, sensors, "en");
    const preview = buildHistoricalImport(sheet, mapping, sensors, definitions, "UTC");

    expect(preview.samples).toEqual([]);
    expect(preview.issues).toHaveLength(25);
    expect(preview.issueCount).toBe(60);
    expect(preview.issueRowCount).toBe(30);
    expect(preview.issues[0]?.row).toBe(2);
    expect(preview.issues.at(-1)?.row).toBe(14);
  });

  it("parses Excel serial dates in the selected house timezone", () => {
    expect(parseImportTimestamp(46037.5, "Europe/Helsinki", "auto")).toBe("2026-01-15T10:00:00.000Z");
  });

  it("returns a row-level invalid timestamp for numeric dates outside the JavaScript date range", () => {
    expect(parseImportTimestamp(1e20, "UTC", "auto")).toBeNull();
    expect(parseImportTimestamp(Number.MAX_VALUE, "UTC", "auto")).toBeNull();
  });

  it("parses large delimited files without spreading every row width into a function call", () => {
    const rowCount = 150_000;
    const sheet = parseCsv(Array.from({ length: rowCount }, (_, index) => `${index},${index + 1}`).join("\n"));
    expect(sheet.rows).toHaveLength(rowCount);
    expect(sheet.rows.at(-1)).toEqual(["149999", "150000"]);
  });

  it("rejects decoded sheets beyond the row bound before iterating their contents", () => {
    const oversized = { name: "Too many rows", rows: new Array<string[]>(MAX_IMPORT_ROWS + 1) };
    expect(() => validateImportSheet(oversized)).toThrow(/too much data/i);
  });

  it("rejects unsafe worksheet dimensions before the Excel parser allocates them", async () => {
    const archive = storedZip([{
      name: "xl/worksheets/sheet1.xml",
      text: '<worksheet><dimension ref="A1:XFD1048576"/><sheetData/></worksheet>',
    }]);

    await expect(validateXlsxArchive(archive)).rejects.toThrow(/too much data/i);
  });

  it("applies the decoded row bound across every worksheet before parsing", async () => {
    const archive = storedZip([
      { name: "xl/worksheets/sheet1.xml", text: '<worksheet><dimension ref="A1:A150000"/><sheetData/></worksheet>' },
      { name: "xl/worksheets/sheet2.xml", text: '<worksheet><dimension ref="A1:A150000"/><sheetData/></worksheet>' },
    ]);

    await expect(validateXlsxArchive(archive)).rejects.toThrow(/too much data/i);
  });

  it("measures actual expanded worksheet bytes instead of trusting ZIP metadata", async () => {
    const archive = storedZip([{
      name: "xl/worksheets/sheet1.xml",
      text: '<worksheet><dimension ref="A1"/><sheetData><row><c r="A1"><v>1</v></c></row></sheetData></worksheet>',
      declaredSize: 1,
    }]);

    await expect(validateXlsxArchive(archive)).rejects.toThrow(/too much data/i);
  });

  it("yields between preview chunks and aborts before processing the remaining rows", async () => {
    const base = Date.parse("2026-01-01T00:00:00.000Z");
    const sheet = parseCsv([
      "Timestamp,Sensor,Temperature",
      ...Array.from({ length: 1_500 }, (_, index) => (
        `${new Date(base + index * 60_000).toISOString()},Living room,21`
      )),
    ].join("\n"));
    const mapping = createInitialMapping(sheet, definitions, sensors, "en");
    const controller = new AbortController();
    const onProgress = vi.fn();
    let settled = false;
    const preview = buildHistoricalImportAsync(sheet, mapping, sensors, definitions, "UTC", {
      signal: controller.signal,
      onProgress,
    });
    void preview.then(() => { settled = true; }, () => { settled = true; });

    expect(settled).toBe(false);
    expect(onProgress).toHaveBeenNthCalledWith(1, 0, 1_500);
    expect(onProgress).toHaveBeenNthCalledWith(2, 1_000, 1_500);
    controller.abort();

    await expect(preview).rejects.toMatchObject({ name: "AbortError" });
    expect(onProgress).toHaveBeenCalledTimes(2);
  });
});
