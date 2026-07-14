import type { House, Sensor } from "@climate-twin/contracts";
import type { ClimateDatabase } from "./db.js";

const DAY_MS = 24 * 60 * 60_000;

const RAW_CREDENTIAL_WRITING_MCP_TOOLS = new Set([
  "configure_home_assistant",
  "configure_tp_link",
]);

const EXTERNALLY_CONNECTED_MCP_TOOLS = new Set([
  "search_locations", "resolve_coordinate_defaults", "get_house_weather", "discover_integrations",
]);

const STATE_CHANGING_MCP_TOOLS = new Set([
  "create_house", "update_house", "replace_house_layout", "replace_house_floor", "delete_house", "get_house_weather",
  "create_sensor", "update_sensor", "delete_sensor", "create_measurement_definition", "update_measurement_definition",
  "disable_measurement_definition", "ingest_measurements", "import_measurements", "ingest_readings",
  "create_alert_rule", "update_alert_rule", "delete_alert_rule", "acknowledge_alert",
  "create_observation", "delete_observation", "upsert_static_parameter", "delete_static_parameter",
  "upload_asset", "delete_asset", "select_mock_scenario", "generate_mock_tick", "start_replay", "stop_replay",
]);

const DESTRUCTIVE_MCP_TOOLS = new Set([
  // These tools can replace or remove existing geometry even when sensors remain valid.
  "update_house", "replace_house_layout", "replace_house_floor",
  "delete_house", "delete_sensor", "delete_alert_rule", "delete_observation", "delete_static_parameter", "delete_asset",
  // Opt-in persistence can cross the irreversible real-data boundary and purge demo data.
  "get_house_weather",
]);

const NON_IDEMPOTENT_MCP_TOOLS = new Set([
  "create_house", "create_sensor", "create_measurement_definition", "ingest_measurements",
  "ingest_readings", "create_alert_rule", "create_observation", "upload_asset", "generate_mock_tick",
  "get_house_weather", "start_replay",
]);

export interface McpToolAnnotations {
  readOnlyHint: boolean;
  destructiveHint: boolean;
  idempotentHint: boolean;
  openWorldHint: boolean;
}

export function mcpToolAnnotations(toolName: string): McpToolAnnotations {
  return {
    readOnlyHint: !STATE_CHANGING_MCP_TOOLS.has(toolName),
    destructiveHint: DESTRUCTIVE_MCP_TOOLS.has(toolName),
    idempotentHint: !NON_IDEMPOTENT_MCP_TOOLS.has(toolName),
    openWorldHint: EXTERNALLY_CONNECTED_MCP_TOOLS.has(toolName),
  };
}

export interface McpHouseSummary {
  id: string;
  name: string;
  timezone: string;
  locationConfigured: boolean;
  mapPlacementConfigured: boolean;
  orientationConfigured: boolean;
  floorCount: number;
  roomCount: number;
  floors: Array<{
    id: string;
    name: string;
    type?: House["floors"][number]["type"];
    wallCount: number;
    roomCount: number;
    planElementCount: number;
    visualReferenceConfigured: boolean;
  }>;
  updatedAt: string;
}

/** Compact portfolio-safe shape: no coordinates, geometry, or embedded images. */
export function summarizeMcpHouse(house: House): McpHouseSummary {
  return {
    id: house.id,
    name: house.name,
    timezone: house.timezone,
    locationConfigured: house.location !== undefined,
    mapPlacementConfigured: house.mapPlacement !== undefined,
    orientationConfigured: house.orientationDegrees !== undefined,
    floorCount: house.floors.length,
    roomCount: house.floors.reduce((count, floor) => count + floor.rooms.length, 0),
    floors: house.floors.map((floor) => ({
      id: floor.id,
      name: floor.name,
      ...(floor.type === undefined ? {} : { type: floor.type }),
      wallCount: floor.walls.length,
      roomCount: floor.rooms.length,
      planElementCount: floor.planElements?.length ?? 0,
      visualReferenceConfigured: floor.backgroundImage !== undefined,
    })),
    updatedAt: house.updatedAt,
  };
}

export function mcpIsoDate(value: string, field: string): string {
  const rfc3339 = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/;
  if (!rfc3339.test(value) || !Number.isFinite(Date.parse(value))) throw new Error(`${field} must be an ISO date-time`);
  return new Date(value).toISOString();
}

export function validateMcpDateRange(from: string, to: string): void {
  if (Date.parse(from) > Date.parse(to)) throw new Error("from must be before or equal to to");
}

export function mcpBoundedInteger(
  value: unknown,
  field: string,
  fallback: number,
  minimum: number,
  maximum: number,
): number {
  if (value === undefined) return fallback;
  if (typeof value !== "number" || !Number.isInteger(value) || value < minimum || value > maximum) {
    throw new Error(`${field} must be an integer between ${minimum} and ${maximum}`);
  }
  return value;
}

export function mcpOptionalFiniteNumber(value: unknown, field: string): number | null {
  if (value === undefined) return null;
  if (typeof value !== "number" || !Number.isFinite(value)) throw new Error(`${field} must be a finite number`);
  return value;
}

export function mcpBoundedNumber(value: unknown, field: string, minimum: number, maximum: number): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value < minimum || value > maximum) {
    throw new Error(`${field} must be a number between ${minimum} and ${maximum}`);
  }
  return value;
}

export function mcpLocationQuery(value: unknown): string {
  if (typeof value !== "string") throw new Error("query must be a string between 2 and 120 characters");
  const query = value.trim();
  if (query.length < 2 || query.length > 120) throw new Error("query must be a string between 2 and 120 characters");
  return query;
}

export function mcpLanguage(value: unknown): string {
  if (value === undefined) return "en";
  if (typeof value !== "string" || !/^[a-z]{2}$/i.test(value)) throw new Error("language must be a two-letter code");
  return value.toLowerCase();
}

export function requireMcpConfirmation(value: unknown): void {
  if (value !== true) throw new Error("confirm must be true for this destructive operation");
}

export function requireMcpRealDataPersistenceConfirmation(value: unknown): void {
  if (value !== true) {
    throw new Error(
      "confirmRealDataPersistence must be true because persisting provider data can permanently activate real-data mode and purge demo telemetry",
    );
  }
}

export function mcpThermalDateRange(
  fromValue: string | undefined,
  toValue: string | undefined,
  now = new Date(),
): { from: string; to: string } {
  const to = toValue === undefined ? now.toISOString() : mcpIsoDate(toValue, "to");
  const from = fromValue === undefined
    ? new Date(Date.parse(to) - 7 * DAY_MS).toISOString()
    : mcpIsoDate(fromValue, "from");
  if (Date.parse(from) >= Date.parse(to)) throw new Error("from must be before to");
  if (Date.parse(to) - Date.parse(from) > 14 * DAY_MS) {
    throw new Error("thermal calibration range cannot exceed 14 days");
  }
  return { from, to };
}

export function requireMcpHouse(database: ClimateDatabase, houseId: string): House {
  const house = database.getHouse(houseId);
  if (!house) throw new Error(`Unknown house: ${houseId}`);
  return house;
}

export function requireMcpSensor(database: ClimateDatabase, sensorId: string): void {
  if (!database.getSensor(sensorId)) throw new Error(`Unknown sensor: ${sensorId}`);
}

export function requireMcpHouseSensor(database: ClimateDatabase, houseId: string, sensorId: string): Sensor {
  requireMcpHouse(database, houseId);
  const sensor = database.getSensor(sensorId);
  if (!sensor) throw new Error(`Unknown sensor: ${sensorId}`);
  if (sensor.houseId !== houseId) throw new Error(`Sensor ${sensorId} does not belong to house ${houseId}`);
  return sensor;
}

export function requireMcpMeasurementTarget(database: ClimateDatabase, sensorId: string, metric: string): void {
  requireMcpSensor(database, sensorId);
  if (!database.getMeasurementDefinition(metric)) throw new Error(`Unknown measurement metric: ${metric}`);
}

export function validateMcpToolRegistry(toolNames: string[], handlerNames: string[]): void {
  const duplicateTools = toolNames.filter((name, index) => toolNames.indexOf(name) !== index);
  if (duplicateTools.length) throw new Error(`Duplicate MCP tools: ${[...new Set(duplicateTools)].join(", ")}`);
  const credentialTools = toolNames.filter((name) => RAW_CREDENTIAL_WRITING_MCP_TOOLS.has(name));
  if (credentialTools.length) {
    throw new Error(`Raw credential-writing MCP tools are forbidden: ${credentialTools.join(", ")}`);
  }
  const tools = new Set(toolNames);
  const handlers = new Set(handlerNames);
  const missingHandlers = toolNames.filter((name) => !handlers.has(name));
  const unlistedHandlers = handlerNames.filter((name) => !tools.has(name));
  if (missingHandlers.length || unlistedHandlers.length) {
    throw new Error([
      missingHandlers.length ? `Missing MCP handlers: ${missingHandlers.join(", ")}` : "",
      unlistedHandlers.length ? `Unlisted MCP handlers: ${unlistedHandlers.join(", ")}` : "",
    ].filter(Boolean).join("; "));
  }
}
