import { ClimateDatabase } from "../db.js";
import { publicElectricityConfiguration } from "../electricity/prices.js";
import { requireMcpHouse, requireMcpHouseSensor, validateMcpDateRange } from "./validation.js";
import type { McpRuntime } from "./runtime.js";
import { mcpDateTime, requiredToolString } from "./arguments.js";

export async function propertyElectricity(runtime: McpRuntime, args: Record<string, unknown>): Promise<object> {
  const { database, telemetryReader } = runtime;
  const propertyId = requiredToolString(args, "propertyId");
  if (!database.getProperty(propertyId)) throw new Error(`Unknown property: ${propertyId}`);
  const electricity = database.getPropertyElectricityConfig(propertyId);
  if (!electricity) throw new Error(`Property ${propertyId} does not have electricity configuration`);
  const to = mcpDateTime(args, "to", new Date(Date.now() + 48 * 3_600_000));
  const from = mcpDateTime(args, "from", new Date(Date.now() - 24 * 3_600_000));
  validateMcpDateRange(from, to);
  const prices = (await telemetryReader.electricityPriceHistory({
    propertyId,
    from,
    to,
    limit: 10_000,
  })).records;
  return {
    config: publicElectricityConfiguration(electricity, true),
    current: database.getCurrentPropertyElectricityPrice(propertyId),
    prices,
  };
}

export async function houseElectricityPrice(runtime: McpRuntime, args: Record<string, unknown>): Promise<object> {
  const { database, telemetryReader } = runtime;
  const house = requireMcpHouse(database, requiredToolString(args, "houseId"));
  const toHomePrice = (price: NonNullable<ReturnType<ClimateDatabase["getCurrentPropertyElectricityPrice"]>>) => ({
    startAt: price.startAt,
    endAt: price.endAt,
    effectivePriceCentsPerKwh: price.effectivePriceCentsPerKwh,
    effectivePriceEurPerKwh: price.effectivePriceEurPerKwh,
    fetchedAt: price.fetchedAt,
  });
  const propertyPrice = database.getCurrentPropertyElectricityPrice(house.propertyId);
  const current = propertyPrice ? toHomePrice(propertyPrice) : null;
  if (args.from === undefined && args.to === undefined) return { current };
  const to = mcpDateTime(args, "to", new Date(Date.now() + 48 * 3_600_000));
  const from = mcpDateTime(args, "from", new Date(Date.now() - 24 * 3_600_000));
  validateMcpDateRange(from, to);
  return {
    current,
    prices: (await telemetryReader.electricityPriceHistory({
      propertyId: house.propertyId,
      from,
      to,
      limit: 10_000,
    })).records.map(toHomePrice),
  };
}

export async function houseEnergyCost(runtime: McpRuntime, args: Record<string, unknown>): Promise<unknown> {
  const { database, energyCost } = runtime;
  const house = requireMcpHouse(database, requiredToolString(args, "houseId"));
  const sensor = requireMcpHouseSensor(database, house.id, requiredToolString(args, "sensorId"));
  const to = mcpDateTime(args, "to", new Date());
  const from = mcpDateTime(args, "from", new Date(Date.parse(to) - 30 * 86_400_000));
  const durationMs = Date.parse(to) - Date.parse(from);
  if (durationMs <= 0 || durationMs > 366 * 86_400_000) {
    throw new Error("Energy cost range must be greater than zero and at most 366 days");
  }
  return energyCost.calculate({
    houseId: house.id,
    propertyId: house.propertyId,
    sensorId: sensor.id,
    from,
    to,
  });
}

export async function houseEnergySummary(runtime: McpRuntime, args: Record<string, unknown>): Promise<unknown> {
  const { database, energyCost } = runtime;
  const house = requireMcpHouse(database, requiredToolString(args, "houseId"));
  const to = mcpDateTime(args, "to", new Date());
  const from = mcpDateTime(args, "from", new Date(Date.parse(to) - 30 * 86_400_000));
  const durationMs = Date.parse(to) - Date.parse(from);
  if (durationMs <= 0 || durationMs > 366 * 86_400_000) {
    throw new Error("Energy summary range must be greater than zero and at most 366 days");
  }
  return energyCost.summarize({
    houseId: house.id,
    propertyId: house.propertyId,
    sensorIds: database.listSensors(house.id).filter((sensor) => sensor.enabled).map((sensor) => sensor.id),
    from,
    to,
  });
}
