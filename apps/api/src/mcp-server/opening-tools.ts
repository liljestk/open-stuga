import { resolvePlanElementOpeningState } from "@climate-twin/contracts";
import { mcpBoundedInteger, mcpIsoDate, requireMcpHouse } from "./validation.js";
import { getOpeningActivity } from "../analytics/opening-activity/service.js";
import type { McpRuntime } from "./runtime.js";
import { mcpDateTime, requiredToolString } from "./arguments.js";

export async function houseOpeningStates(runtime: McpRuntime, args: Record<string, unknown>): Promise<object> {
  const { database, telemetryReader } = runtime;
  const house = requireMcpHouse(database, requiredToolString(args, "houseId"));
  const at = mcpDateTime(args, "at", new Date());
  const observations = (await telemetryReader.openingStateSnapshot({
    houseId: house.id,
    at,
    limit: 10_000,
  })).records;
  const states = house.floors.flatMap((floor) => (floor.planElements ?? []).flatMap((element) => {
    if (element.kind !== "door" && element.kind !== "window" && element.kind !== "vent") return [];
    return [{
      floorId: floor.id,
      elementId: element.id,
      kind: element.kind,
      ...(element.label ? { label: element.label } : {}),
      ...resolvePlanElementOpeningState(
        element,
        observations.filter((observation) => observation.floorId === floor.id),
        at,
      ),
    }];
  }));
  if (args.from === undefined) return { snapshot: { houseId: house.id, at, states }, observations };
  const from = mcpIsoDate(requiredToolString(args, "from"), "from");
  const to = mcpDateTime(args, "to", new Date(at));
  const durationMs = Date.parse(to) - Date.parse(from);
  if (durationMs <= 0 || durationMs > 366 * 86_400_000) {
    throw new Error("Opening-state history must cover more than zero and at most 366 days");
  }
  const limit = mcpBoundedInteger(args.limit, "limit", 10_000, 1, 10_000);
  const [initialRead, historyRead] = await Promise.all([
    telemetryReader.openingStateSnapshot({ houseId: house.id, at: from, limit }),
    telemetryReader.openingStateHistory({ houseId: house.id, from, to, limit }),
  ]);
  const initial = initialRead.records;
  const history = historyRead.records;
  const merged = [...new Map([...initial, ...history].map((observation) => [observation.id, observation])).values()]
    .sort((left, right) => Date.parse(left.observedAt) - Date.parse(right.observedAt) || left.id.localeCompare(right.id))
    .slice(-limit);
  return { snapshot: { houseId: house.id, at, states }, observations, history: merged, from, to };
}

export async function openingActivity(runtime: McpRuntime, args: Record<string, unknown>): Promise<object> {
  const { database, telemetryReader } = runtime;
  const house = requireMcpHouse(database, requiredToolString(args, "houseId"));
  const to = mcpDateTime(args, "to", new Date());
  const from = mcpDateTime(args, "from", new Date(Date.parse(to) - 24 * 3_600_000));
  const durationMs = Date.parse(to) - Date.parse(from);
  if (durationMs <= 0 || durationMs > 366 * 86_400_000) {
    throw new Error("Opening activity must cover more than zero and at most 366 days");
  }
  let elementIds: string[] | undefined;
  if (args.elementIds !== undefined) {
    if (!Array.isArray(args.elementIds)) throw new Error("elementIds must be an array");
    if (args.elementIds.length > 500) throw new Error("elementIds must contain at most 500 identifiers");
    if (!args.elementIds.every((item) => typeof item === "string" && item.length > 0 && item.length <= 200)) {
      throw new Error("Each elementId must be a non-empty string of at most 200 characters");
    }
    if (new Set(args.elementIds).size !== args.elementIds.length) {
      throw new Error("elementIds must contain unique identifiers");
    }
    elementIds = args.elementIds;
  }
  return getOpeningActivity({
    house,
    request: {
      apiVersion: "1.0",
      requestId: `mcp-opening-${Date.now().toString(36)}`,
      houseId: house.id,
      dataMode: database.isRealDataMode() ? "live" : "demo",
      range: { start: from, end: to },
      ...(elementIds ? { elementIds } : {}),
    },
    telemetryReader,
    generatedAt: new Date().toISOString(),
  });
}
