import { hasLocalHouseAuthority, type HouseWeather } from "@climate-twin/contracts";
import { outdoorLocationKey } from "../db.js";
import { requireMcpHouse, mcpBoundedInteger, validateMcpDateRange } from "../mcp-validation.js";
import { WeatherRequestSupersededError } from "../weather.js";
import type { McpRuntime } from "./runtime.js";
import { mcpDateTime, requiredToolString } from "./arguments.js";

export async function getHouseWeather(runtime: McpRuntime, houseId: string, hours: number): Promise<HouseWeather> {
  const { database, weather } = runtime;
  const house = requireMcpHouse(database, houseId);
  if (!hasLocalHouseAuthority(house)) {
    throw new Error(`House ${houseId} is a remote Stuguby projection`);
  }
  if (!house.location) throw new Error(`House ${houseId} does not have a weather location`);
  const result = await weather.get(house, hours);
  const current = database.getHouse(house.id);
  if (!current || current.updatedAt !== house.updatedAt
    || outdoorLocationKey(current.location) !== outdoorLocationKey(result.location)) {
    throw new WeatherRequestSupersededError();
  }
  return result;
}

export async function outdoorTemperatureHistory(runtime: McpRuntime, args: Record<string, unknown>): Promise<object> {
  const { database, telemetryReader } = runtime;
  const house = requireMcpHouse(database, requiredToolString(args, "houseId"));
  const to = mcpDateTime(args, "to", new Date());
  const from = mcpDateTime(args, "from", new Date(Date.parse(to) - 24 * 3_600_000));
  validateMcpDateRange(from, to);
  const limit = mcpBoundedInteger(args.limit, "limit", 20_000, 1, 50_000);
  if (!house.location) return { samples: [], from, to, truncated: false };
  const samples = (await telemetryReader.outdoorTemperatureHistory({
    houseId: house.id,
    locationKey: outdoorLocationKey(house.location),
    from,
    to,
    limit: limit + 1,
  })).records;
  const truncated = samples.length > limit;
  return { samples: truncated ? samples.slice(-limit) : samples, from, to, truncated };
}
