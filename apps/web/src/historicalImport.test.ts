import { describe, expect, it } from "vitest";
import type { MeasurementDefinition, Sensor } from "@climate-twin/contracts";
import {
  buildHistoricalImport,
  createInitialMapping,
  parseCsv,
  parseImportTimestamp,
} from "./historicalImport";

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

  it("parses Excel serial dates in the selected house timezone", () => {
    expect(parseImportTimestamp(46037.5, "Europe/Helsinki", "auto")).toBe("2026-01-15T10:00:00.000Z");
  });
});
