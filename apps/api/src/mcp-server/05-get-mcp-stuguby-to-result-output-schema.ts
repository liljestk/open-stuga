import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { resolvePlanElementOpeningState, withSignal } from "@climate-twin/contracts";
import { ClimateDatabase, outdoorLocationKey } from "../db.js";
import { publicElectricityConfiguration } from "../electricity-prices.js";
import { McpOperationTracker } from "../mcp-lifecycle.js";
import {
  mcpBoundedInteger,
  mcpIsoDate,
  mcpThermalDateRange,
  requireMcpHouse,
  requireMcpHouseSensor,
  requireMcpSensor,
  summarizeMcpHouse,
  summarizeMcpProperty,
  validateMcpDateRange,
} from "../mcp-validation.js";
import {
  isThermalIsolationTemperatureSensor,
  runThermalIsolationAsync,
} from "../thermal-isolation.js";
import { getOpeningActivity } from "../analytics/opening-activity/service.js";
import { DAILY_ANALYTICS_ALGORITHM_VERSION } from "../daily-analytics-findings.js";
import { SYSTEM_VERSION } from "../version.js";
import { config, dataOperations, database, energyCost, optionalToolString, requiredToolString, stugubyStore, telemetryReader } from "./01-config-to-get-house-weather.js";
import { activeStugubyGrant, recommendedOverviewGrant, stugubySide, summarizeMcpStuguby } from "./04-point-schema-to-summarize-mcp-stuguby.js";
import { chatgptMcpServerInstructions, isChatgptMcpProfile } from "./chatgpt-profile.js";
import { runMcpThermalWork } from "./thermal-work.js";
import {
  configuredHeatPumpConnectionIds,
  filterHeatPumpAffectedSampleMap,
  loadHeatPumpExclusionWindow,
} from "../analytics/heat-pump-evidence.js";

export function getMcpStuguby(args: Record<string, unknown>): object {
  const stugubyId = requiredToolString(args, "stugubyId");
  const summary = stugubyStore.getStuguby(stugubyId);
  if (!summary) throw new Error(`Unknown Stuguby: ${stugubyId}`);
  const adoption = stugubyStore.getPropertyAdoption(stugubyId);
  const adoptedProperty = adoption ? database.getProperty(adoption.localPropertyId) : null;
  const members = stugubyStore.listMembers(stugubyId);
  const sharedProperty = stugubyStore.getSharedProperty(stugubyId);
  return {
    stuguby: summarizeMcpStuguby(summary),
    members: members.map((member) => ({
      nodeId: member.nodeId,
      displayName: member.displayName,
      side: stugubySide(member.role),
      accessRole: member.role,
      state: member.state,
      isHost: member.nodeId === summary.coordinatorNodeId,
      joinedAt: member.joinedAt,
      updatedAt: member.updatedAt,
    })),
    property: {
      adoption,
      local: adoptedProperty ? summarizeMcpProperty(adoptedProperty) : null,
      shared: sharedProperty ? {
        revision: sharedProperty.revision,
        editPolicy: sharedProperty.editPolicy,
        locationConfigured: sharedProperty.location !== null,
        areaCount: sharedProperty.areas.length,
        equipmentCount: sharedProperty.equipment.length,
        noteCount: sharedProperty.notes.length,
        maintenanceTaskCount: sharedProperty.maintenance.length,
        updatedAt: sharedProperty.updatedAt,
      } : null,
      conflicts: stugubyStore.listPropertyConflicts(stugubyId).length,
      commands: stugubyStore.propertyCommandCounts(stugubyId),
    },
    homes: database.listHouses()
      .filter((house) => house.stuguby?.stugubyId === stugubyId)
      .map(summarizeMcpHouse),
    grants: stugubyStore.listGrants(stugubyId).map((grant) => ({
      id: grant.id,
      authorityNodeId: grant.authorityNodeId,
      publicationId: grant.publicationId,
      localHouseId: grant.localHouseId ?? null,
      audience: {
        kind: grant.audience.kind,
        recipientCount: grant.audience.kind === "all-members"
          ? Math.max(0, members.filter((member) => member.state === "active").length - 1)
          : grant.audience.nodeIds.length,
      },
      datasets: grant.datasets.filter((dataset) => dataset.enabled).map((dataset) => ({
        dataset: dataset.dataset,
        includeLocalIds: dataset.includeLocalIds,
        allowReplicaCache: dataset.allowReplicaCache,
        retentionDays: dataset.retentionDays,
        ...(dataset.telemetry ? { telemetry: dataset.telemetry } : {}),
      })),
      editPolicy: grant.housePolicy.editPolicy,
      recoveryMode: grant.housePolicy.recoveryMode,
      recommendedReadOnlyOverview: recommendedOverviewGrant(grant),
      active: activeStugubyGrant(grant),
      expiresAt: grant.expiresAt,
      revokedAt: grant.revokedAt,
      updatedAt: grant.updatedAt,
    })),
    homeCommands: stugubyStore.homeCommandCounts(stugubyId),
  };
}

export function mcpDateTime(args: Record<string, unknown>, key: string, fallback: Date): string {
  const value = optionalToolString(args, key);
  return value === undefined ? fallback.toISOString() : mcpIsoDate(value, key);
}

export function dailyAnalyticsFindings(args: Record<string, unknown>): object {
  const house = requireMcpHouse(database, requiredToolString(args, "houseId"));
  const dataMode = database.isRealDataMode() ? "live" : "demo";
  const stored = database.dailyAnalyticsFindings(house.id, dataMode);
  const staleAlgorithm = Boolean(
    stored?.snapshot
    && stored.snapshot.algorithmVersion !== DAILY_ANALYTICS_ALGORITHM_VERSION,
  );
  return {
    snapshot: stored?.snapshot ?? null,
    status: {
      state: stored?.lastError
        ? "failed"
        : staleAlgorithm
          ? "stale-algorithm"
          : stored?.snapshot
            ? "ready"
            : "pending",
      lastAttemptAt: stored?.lastAttemptAt ?? null,
      lastError: stored?.lastError ?? null,
      ...(staleAlgorithm && stored?.snapshot
        ? {
            expectedAlgorithmVersion: DAILY_ANALYTICS_ALGORITHM_VERSION,
            actualAlgorithmVersion: stored.snapshot.algorithmVersion,
          }
        : {}),
    },
  };
}

export async function propertyElectricity(args: Record<string, unknown>): Promise<object> {
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

export function listPropertyNotes(args: Record<string, unknown>): unknown {
  return database.listPropertyNotes({
    ...(args.propertyId === undefined ? {} : { propertyId: requiredToolString(args, "propertyId") }),
    ...(args.houseId === undefined ? {} : { houseId: requiredToolString(args, "houseId") }),
    ...(args.areaId === undefined ? {} : { areaId: requiredToolString(args, "areaId") }),
    ...(args.equipmentId === undefined ? {} : { equipmentId: requiredToolString(args, "equipmentId") }),
    limit: mcpBoundedInteger(args.limit, "limit", 200, 1, 500),
  });
}

export async function houseOpeningStates(args: Record<string, unknown>): Promise<object> {
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

export async function openingActivity(args: Record<string, unknown>): Promise<object> {
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

export async function houseElectricityPrice(args: Record<string, unknown>): Promise<object> {
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

export async function houseEnergyCost(args: Record<string, unknown>): Promise<unknown> {
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

export async function houseEnergySummary(args: Record<string, unknown>): Promise<unknown> {
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

export async function outdoorTemperatureHistory(args: Record<string, unknown>): Promise<object> {
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

export async function thermalIsolation(
  args: Record<string, unknown>,
  signal?: AbortSignal,
): Promise<unknown> {
  const house = requireMcpHouse(database, requiredToolString(args, "houseId"));
  const { from, to } = mcpThermalDateRange(optionalToolString(args, "from"), optionalToolString(args, "to"));
  const sensorCandidates = database.listSensors(house.id).filter((sensor) => sensor.enabled);
  const sensorsWithTemperatureHistory = new Set(
    (await telemetryReader.measurementCoverage({
      sensorIds: sensorCandidates.map((sensor) => sensor.id),
      metrics: ["temperature"],
      ...withSignal(signal),
    })).records.map((coverage) => coverage.sensorId),
  );
  signal?.throwIfAborted();
  const sensors = sensorCandidates.filter((sensor) =>
    isThermalIsolationTemperatureSensor(sensor, sensorsWithTemperatureHistory.has(sensor.id)));
  if (sensors.length > 64) throw new Error("Thermal isolation comparison supports at most 64 temperature sensors");
  const boundaryPaddingMs = 2 * 3_600_000;
  return runMcpThermalWork({
    subjects: sensors,
    ...withSignal(signal),
    readOutdoor: (readSignal) => telemetryReader.outdoorTemperatureHistory({
      houseId: house.id,
      locationKey: outdoorLocationKey(house.location),
      from: new Date(Date.parse(from) - boundaryPaddingMs).toISOString(),
      to: new Date(Date.parse(to) + boundaryPaddingMs).toISOString(),
      limit: 50_000,
      ...withSignal(readSignal),
    }),
    readIndoor: (subject, readSignal) => telemetryReader.thermalMeasurementHistory({
      sensorId: subject.id,
      metrics: ["temperature"],
      from,
      to,
      bucketMinutes: 5,
      limitPerMetric: 5_000,
      ...withSignal(readSignal),
    }),
    complete: ({ indoor, outdoor }, completionSignal) => {
      const heatPumpWindow = loadHeatPumpExclusionWindow(
        database,
        house.id,
        from,
        to,
        configuredHeatPumpConnectionIds(config.greeConnections, house.id),
      );
      const filtered = filterHeatPumpAffectedSampleMap(new Map(sensors.map((sensor, index) => [
        sensor.id,
        indoor[index]!.records,
      ])), heatPumpWindow, 5 * 60_000);
      return runThermalIsolationAsync({
        house,
        sensors,
        indoorSamplesBySensor: filtered.samplesBySensor,
        outdoorSamples: outdoor.records,
        from,
        to,
        hvacExclusion: filtered.summary,
        ...(heatPumpWindow.summary.evidenceState === "not-present" ? {} : { passiveIntervals: heatPumpWindow.passiveIntervals }),
      }, withSignal(completionSignal));
    },
  });
}

export function backupStatus(): object {
  const { backupPath, ...backup } = dataOperations.backupStatus();
  return { ...backup, backupPathConfigured: backupPath !== null };
}

export function sensorDataGaps(args: Record<string, unknown>): unknown {
  const houseId = optionalToolString(args, "houseId");
  if (houseId) requireMcpHouse(database, houseId);
  const sensorId = optionalToolString(args, "sensorId");
  if (sensorId) requireMcpSensor(database, sensorId);
  return database.listSensorDataGaps(
    sensorId,
    mcpBoundedInteger(args.limit, "limit", 100, 1, 1_000),
  ).filter((gap) => !houseId || database.getSensor(gap.sensorId)?.houseId === houseId);
}

export function createMcpServer(): Server {
  return new Server(
    { name: isChatgptMcpProfile ? "stugu-chatgpt" : "stugu-local", version: SYSTEM_VERSION },
    {
      capabilities: { tools: {} },
      instructions: isChatgptMcpProfile
        ? chatgptMcpServerInstructions
        : [
            "This Stugu MCP is a read-only inspection surface over its configured local SQLite workspace.",
            "It cannot inspect a separately running API process's in-memory connections or event bus.",
            "Create, update, delete, import, migration, sharing, synchronization, control, raw credentials, SSE streams, and binary asset downloads are intentionally excluded.",
          ].join(" "),
    },
  );
}

export const operations = new McpOperationTracker();

export const resultOutputSchema = {
  type: "object",
  properties: { result: { oneOf: [{ type: "object" }, { type: "array" }] } },
  required: ["result"],
  additionalProperties: false,
} as const;
