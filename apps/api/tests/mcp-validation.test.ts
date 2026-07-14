import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ClimateDatabase } from "../src/db.js";
import { mcpIsoDate, requireMcpMeasurementTarget, requireMcpSensor, validateMcpDateRange } from "../src/mcp-validation.js";

describe("MCP measurement argument validation", () => {
  let database: ClimateDatabase;

  beforeEach(() => { database = new ClimateDatabase(":memory:"); });
  afterEach(() => database.close());

  it("normalizes ISO dates and rejects invalid or reversed ranges", () => {
    expect(mcpIsoDate("2026-07-14T12:00:00+03:00", "from")).toBe("2026-07-14T09:00:00.000Z");
    expect(() => mcpIsoDate("not-a-date", "from")).toThrow("from must be an ISO date-time");
    expect(() => mcpIsoDate("July 14, 2026", "from")).toThrow("from must be an ISO date-time");
    expect(() => validateMcpDateRange("2026-07-15T00:00:00.000Z", "2026-07-14T00:00:00.000Z"))
      .toThrow("from must be before or equal to to");
  });

  it("requires existing sensors and registered metrics", () => {
    expect(() => requireMcpSensor(database, "missing")).toThrow("Unknown sensor: missing");
    expect(() => requireMcpMeasurementTarget(database, "sensor-01", "missing_metric"))
      .toThrow("Unknown measurement metric: missing_metric");
    expect(() => requireMcpMeasurementTarget(database, "missing", "co2"))
      .toThrow("Unknown sensor: missing");
    expect(() => requireMcpMeasurementTarget(database, "sensor-01", "co2")).not.toThrow();
  });
});
