import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ClimateDatabase } from "../src/db.js";
import {
  mcpBoundedInteger,
  mcpBoundedNumber,
  mcpIsoDate,
  mcpLanguage,
  mcpLocationQuery,
  mcpOptionalFiniteNumber,
  mcpThermalDateRange,
  mcpToolAnnotations,
  requireMcpHouse,
  requireMcpHouseSensor,
  requireMcpConfirmation,
  requireMcpMeasurementTarget,
  requireMcpRealDataPersistenceConfirmation,
  requireMcpSensor,
  summarizeMcpHouse,
  validateMcpToolRegistry,
  validateMcpDateRange,
} from "../src/mcp-validation.js";

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

  it("validates bounded integer and finite-number tool arguments", () => {
    expect(mcpBoundedInteger(undefined, "hours", 12, 1, 168)).toBe(12);
    expect(mcpBoundedInteger(24, "hours", 12, 1, 168)).toBe(24);
    expect(() => mcpBoundedInteger(1.5, "hours", 12, 1, 168))
      .toThrow("hours must be an integer between 1 and 168");
    expect(() => mcpBoundedInteger(169, "hours", 12, 1, 168))
      .toThrow("hours must be an integer between 1 and 168");
    expect(mcpOptionalFiniteNumber(undefined, "scenarioOutdoorTemperatureC")).toBeNull();
    expect(mcpOptionalFiniteNumber(-12.5, "scenarioOutdoorTemperatureC")).toBe(-12.5);
    expect(() => mcpOptionalFiniteNumber("-12.5", "scenarioOutdoorTemperatureC"))
      .toThrow("scenarioOutdoorTemperatureC must be a finite number");
    expect(mcpBoundedNumber(60.17, "latitude", -90, 90)).toBe(60.17);
    expect(() => mcpBoundedNumber(90.1, "latitude", -90, 90))
      .toThrow("latitude must be a number between -90 and 90");
  });

  it("validates external location discovery arguments", () => {
    expect(mcpLocationQuery("  Helsinki  ")).toBe("Helsinki");
    expect(() => mcpLocationQuery("x")).toThrow("query must be a string between 2 and 120 characters");
    expect(mcpLanguage(undefined)).toBe("en");
    expect(mcpLanguage("FI")).toBe("fi");
    expect(() => mcpLanguage("finnish")).toThrow("language must be a two-letter code");
  });

  it("applies the API thermal range defaults and limits", () => {
    expect(mcpThermalDateRange(undefined, undefined, new Date("2026-07-14T12:00:00.000Z"))).toEqual({
      from: "2026-07-07T12:00:00.000Z",
      to: "2026-07-14T12:00:00.000Z",
    });
    expect(mcpThermalDateRange("2026-07-01T00:00:00Z", "2026-07-14T00:00:00Z")).toEqual({
      from: "2026-07-01T00:00:00.000Z",
      to: "2026-07-14T00:00:00.000Z",
    });
    expect(() => mcpThermalDateRange("2026-07-14T00:00:00Z", "2026-07-14T00:00:00Z"))
      .toThrow("from must be before to");
    expect(() => mcpThermalDateRange("2026-06-29T23:59:59Z", "2026-07-14T00:00:00Z"))
      .toThrow("thermal calibration range cannot exceed 14 days");
  });

  it("validates house existence and sensor ownership", () => {
    expect(requireMcpHouse(database, "house-main").id).toBe("house-main");
    expect(requireMcpHouseSensor(database, "house-main", "sensor-01").id).toBe("sensor-01");
    expect(() => requireMcpHouse(database, "missing")).toThrow("Unknown house: missing");
    database.createHouse({
      id: "house-other",
      name: "Other",
      timezone: "Europe/Helsinki",
      floors: [{ id: "floor-main", name: "Main", width: 5, height: 5, elevation: 0, walls: [], rooms: [] }],
    });
    expect(() => requireMcpHouseSensor(database, "house-other", "sensor-01"))
      .toThrow("Sensor sensor-01 does not belong to house house-other");
  });

  it("requires one unique handler for every advertised MCP tool", () => {
    expect(() => validateMcpToolRegistry(["list_houses", "create_house"], ["create_house", "list_houses"]))
      .not.toThrow();
    expect(() => validateMcpToolRegistry(["list_houses", "list_houses"], ["list_houses"]))
      .toThrow("Duplicate MCP tools: list_houses");
    expect(() => validateMcpToolRegistry(["list_houses", "create_house"], ["list_houses", "delete_house"]))
      .toThrow("Missing MCP handlers: create_house; Unlisted MCP handlers: delete_house");
    expect(() => validateMcpToolRegistry(["configure_home_assistant"], ["configure_home_assistant"]))
      .toThrow("Raw credential-writing MCP tools are forbidden: configure_home_assistant");
  });

  it("requires explicit confirmation for destructive tools", () => {
    expect(() => requireMcpConfirmation(true)).not.toThrow();
    expect(() => requireMcpConfirmation(false)).toThrow("confirm must be true for this destructive operation");
    expect(() => requireMcpConfirmation(undefined)).toThrow("confirm must be true for this destructive operation");
  });

  it("requires an explicit opt-in before a weather read may cross the real-data boundary", () => {
    expect(() => requireMcpRealDataPersistenceConfirmation(true)).not.toThrow();
    expect(() => requireMcpRealDataPersistenceConfirmation(false))
      .toThrow("confirmRealDataPersistence must be true");
    expect(mcpToolAnnotations("get_house_weather")).toEqual({
      readOnlyHint: false,
      destructiveHint: true,
      idempotentHint: false,
      openWorldHint: true,
    });
  });

  it("conservatively annotates replacement, import, and replay semantics", () => {
    expect(mcpToolAnnotations("replace_house_layout")).toMatchObject({
      readOnlyHint: false,
      destructiveHint: true,
      idempotentHint: true,
    });
    expect(mcpToolAnnotations("import_measurements")).toMatchObject({
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: true,
    });
    expect(mcpToolAnnotations("start_replay")).toMatchObject({
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: false,
    });
  });

  it("summarizes portfolio houses without precise location, geometry, or embedded images", () => {
    const house = database.createHouse({
      id: "private-house",
      name: "Cabin",
      timezone: "Europe/Helsinki",
      location: { latitude: 60.123456, longitude: 24.654321, label: "Precise private address" },
      mapPlacement: { latitude: 60.123456, longitude: 24.654321, metersPerPlanUnit: 0.25 },
      orientationDegrees: 123.45,
      floors: [{
        id: "private-floor",
        name: "Ground",
        width: 12.345,
        height: 6.789,
        elevation: 0,
        walls: [{ id: "wall-secret", from: { x: 0, y: 0 }, to: { x: 12.345, y: 0 } }],
        rooms: [{ id: "room-private", name: "Bedroom", points: [
          { x: 0, y: 0 }, { x: 4, y: 0 }, { x: 4, y: 3 },
        ] }],
        backgroundImage: "data:image/png;base64,PRIVATE_FLOOR_PLAN",
      }],
    });

    const summary = summarizeMcpHouse(house);
    expect(summary).toMatchObject({
      id: "private-house",
      floorCount: 1,
      roomCount: 1,
      locationConfigured: true,
      mapPlacementConfigured: true,
      floors: [{ id: "private-floor", wallCount: 1, roomCount: 1, visualReferenceConfigured: true }],
    });
    const serialized = JSON.stringify(summary);
    expect(serialized).not.toContain("60.123456");
    expect(serialized).not.toContain("24.654321");
    expect(serialized).not.toContain("Precise private address");
    expect(serialized).not.toContain("PRIVATE_FLOOR_PLAN");
    expect(serialized).not.toContain("wall-secret");
    expect(serialized).not.toContain("room-private");
  });
});
