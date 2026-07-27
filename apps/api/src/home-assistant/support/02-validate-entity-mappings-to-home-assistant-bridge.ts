import { existsSync, readFileSync } from "node:fs";
import { Agent as HttpAgent } from "node:http";
import { Agent as HttpsAgent } from "node:https";
import type { Socket } from "node:net";
import { resolve } from "node:path";
import WebSocket from "ws";
import { hasLocalHouseAuthority, type MeasurementSample, type OpeningState, type OpeningStateObservation, type Reading } from "@climate-twin/contracts";
import type { AppConfig } from "../../config.js";
import type { ClimateDatabase } from "../../db.js";
import type {
  SensorGapRecoveryAdapter,
  SensorHistoryRecoveryResult,
  SensorMetricAvailability,
} from "../../sensor-gap-recovery.js";
import type { MeasurementService, RuntimeStatus, TelemetryService } from "../../services.js";
import { HaMessage, HomeAssistantBridgeOptions, HomeAssistantEntityMapping, validateEntityMapping } from "./01-home-assistant-measurement-binding-to-validate-entit.js";
import { HomeAssistantConnectionBridgeCore as HomeAssistantConnectionBridge } from "../core.js";

export function validateEntityMappings(value: unknown): HomeAssistantEntityMapping[] {
  if (!Array.isArray(value)) throw new Error("Home Assistant entity map must contain an entities array");
  const mappings = value.map(validateEntityMapping);
  assertUniqueEntityIds(mappings);
  assertUniqueSensorMetricClaims(mappings);
  return mappings.sort((left, right) => {
    const leftJson = JSON.stringify(left);
    const rightJson = JSON.stringify(right);
    return leftJson < rightJson ? -1 : leftJson > rightJson ? 1 : 0;
  });
}

export function mappedEntityIds(mapping: HomeAssistantEntityMapping): string[] {
  const measurements = Object.values(mapping.measurements ?? {}).map((binding) => (
    typeof binding === "string" ? binding : binding.entityId
  ));
  return [mapping.temperature, mapping.humidity, mapping.battery, ...measurements]
    .filter((entityId): entityId is string => Boolean(entityId));
}

export function assertUniqueEntityIds(mappings: HomeAssistantEntityMapping[]): void {
  const entityIds = new Set<string>();
  for (const mapping of mappings) {
    for (const entityId of mappedEntityIds(mapping)) {
      const normalized = entityId.trim();
      if (entityIds.has(normalized)) throw new Error(`Home Assistant entity ${normalized} is mapped more than once`);
      entityIds.add(normalized);
    }
  }
}

export function mappingMetricKeys(mapping: HomeAssistantEntityMapping): string[] {
  return [
    ...(mapping.temperature ? ["temperature"] : []),
    ...(mapping.humidity ? ["humidity"] : []),
    ...(mapping.battery ? ["battery"] : []),
    ...Object.keys(mapping.measurements ?? {}),
  ];
}

export function sensorMetricKey(sensorId: string, metric: string): string {
  return `${sensorId.trim()}\u0000${metric}`;
}

export function assertUniqueSensorMetricClaims(mappings: HomeAssistantEntityMapping[]): void {
  const claims = new Set<string>();
  for (const mapping of mappings) {
    for (const metric of mappingMetricKeys(mapping)) {
      const claim = sensorMetricKey(mapping.sensorId, metric);
      if (claims.has(claim)) {
        throw new Error(`Home Assistant sensor ${mapping.sensorId} metric ${metric} is mapped more than once`);
      }
      claims.add(claim);
    }
  }
}

export function mappingFingerprint(mappings: HomeAssistantEntityMapping[]): string {
  const normalized = mappings.map((mapping) => ({
    sensorId: mapping.sensorId.trim(),
    temperature: mapping.temperature?.trim() ?? null,
    humidity: mapping.humidity?.trim() ?? null,
    battery: mapping.battery?.trim() ?? null,
    measurements: Object.entries(mapping.measurements ?? {})
      .sort(([left], [right]) => left < right ? -1 : left > right ? 1 : 0)
      .map(([metric, configured]) => {
        const binding = typeof configured === "string" ? { entityId: configured } : configured;
        return [metric, {
          entityId: binding.entityId.trim(),
          unit: binding.unit?.trim() ?? null,
          scale: binding.scale ?? null,
          offset: binding.offset ?? null,
        }];
      }),
  }));
  normalized.sort((left, right) => {
    const leftJson = JSON.stringify(left);
    const rightJson = JSON.stringify(right);
    return leftJson < rightJson ? -1 : leftJson > rightJson ? 1 : 0;
  });
  return JSON.stringify(normalized);
}

export function parseHaMessage(raw: string): HaMessage | null {
  try {
    return JSON.parse(raw) as HaMessage;
  } catch {
    return null;
  }
}

export function loadEntityMappings(path: string): HomeAssistantEntityMapping[] {
  const parsed = JSON.parse(readFileSync(resolve(path), "utf8")) as { entities?: unknown };
  return validateEntityMappings(parsed.entities);
}

export function importEntityMappingFile(database: ClimateDatabase, path: string): HomeAssistantEntityMapping[] {
  const mappings = loadEntityMappings(path);
  database.saveIntegrationMappingSet("home-assistant", mappings);
  return mappings;
}

export interface HomeAssistantStatusHost {
  value: RuntimeStatus["value"];
  changed(): void;
}

/** Maintains one independent Home Assistant WebSocket session per house. */
export class HomeAssistantBridge implements SensorGapRecoveryAdapter {
  readonly source = "home-assistant" as const;
  readonly #workers = new Map<string, { bridge: HomeAssistantConnectionBridge; status: HomeAssistantStatusHost }>();
  #running = false;

  constructor(
    private readonly config: AppConfig,
    private readonly telemetry: TelemetryService,
    private readonly measurements: MeasurementService,
    private readonly database: ClimateDatabase,
    private readonly status: RuntimeStatus,
    private readonly options: HomeAssistantBridgeOptions = {},
  ) {}

  private configuredConnections(): Array<{ houseId: string; url: string; token: string }> {
    const explicit = (this.config.homeAssistantConnections ?? [])
      .filter((connection) => {
        const house = this.database.getHouse(connection.houseId);
        return Boolean(house && hasLocalHouseAuthority(house));
      });
    if (explicit.length > 0) return explicit.map((connection) => ({ ...connection }));
    const houseId = this.database.listHouses().find(hasLocalHouseAuthority)?.id;
    return !this.config.homeAssistantLegacyDisabled && houseId && this.config.haUrl && this.config.haToken
      ? [{ houseId, url: this.config.haUrl, token: this.config.haToken }]
      : [];
  }

  start(): void {
    if (this.#running) return;
    const mappingPath = this.config.haEntityMapFile;
    if (mappingPath && existsSync(mappingPath)) {
      let mappings: HomeAssistantEntityMapping[] | undefined;
      try {
        mappings = loadEntityMappings(mappingPath);
      } catch {
        // A legacy worker, when present, reports the invalid file and remains
        // fail-closed. Never replace the last-good SQLite revision here.
      }
      // Persistence failures are operational failures, not source-validation
      // failures: do not claim a healthy manager while the valid map is file-only.
      if (mappings) this.database.saveIntegrationMappingSet("home-assistant", mappings);
    }
    this.#running = true;
    for (const connection of this.configuredConnections()) {
      const localValue = structuredClone(this.status.value);
      localValue.homeAssistant = {
        configured: true,
        connected: false,
        lastEventAt: null,
        mappedEntities: 0,
        error: null,
        connections: [],
      };
      const localStatus: HomeAssistantStatusHost = { value: localValue, changed: () => this.aggregateStatus() };
      const localConfig: AppConfig = {
        ...this.config,
        haUrl: connection.url,
        haToken: connection.token,
        homeAssistantConnections: [],
        // The legacy file cannot safely describe more than one house.
        haEntityMapFile: this.config.homeAssistantConnections?.length ? null : this.config.haEntityMapFile,
      };
      const bridge = new HomeAssistantConnectionBridge(
        localConfig,
        this.telemetry,
        this.measurements,
        this.database,
        localStatus,
        (this.config.homeAssistantConnections?.length ?? 0) > 0 ? connection.houseId : undefined,
        this.options,
      );
      this.#workers.set(connection.houseId, { bridge, status: localStatus });
      bridge.start();
    }
    this.aggregateStatus();
  }

  stop(): void {
    this.#running = false;
    for (const worker of this.#workers.values()) worker.bridge.stop();
    this.#workers.clear();
    this.aggregateStatus();
  }

  restart(): void {
    this.stop();
    this.start();
  }

  refreshMappings(): void {
    for (const worker of this.#workers.values()) worker.bridge.refreshMappings();
  }

  availability(now = new Date()): SensorMetricAvailability[] {
    return [...this.#workers.values()].flatMap((worker) => worker.bridge.availability(now));
  }

  recoverHistory(sensorId: string, metric: string, from: string, to: string): Promise<SensorHistoryRecoveryResult> {
    const houseId = this.database.getSensor(sensorId)?.houseId;
    const house = houseId ? this.database.getHouse(houseId) : null;
    const worker = houseId && house && hasLocalHouseAuthority(house) ? this.#workers.get(houseId) : undefined;
    if (!worker) {
      return Promise.resolve({ state: "not-supported", samples: [], error: "No Home Assistant connection owns this sensor" });
    }
    return worker.bridge.recoverHistory(sensorId, metric, from, to);
  }

  private aggregateStatus(): void {
    const connections = [...this.#workers.entries()].map(([houseId, worker]) => ({
      houseId,
      configured: true,
      connected: worker.status.value.homeAssistant.connected,
      lastEventAt: worker.status.value.homeAssistant.lastEventAt,
      mappedEntities: worker.status.value.homeAssistant.mappedEntities,
      error: worker.status.value.homeAssistant.error,
    }));
    const aggregate = this.status.value.homeAssistant;
    aggregate.connections = connections;
    aggregate.configured = connections.length > 0 || this.configuredConnections().length > 0;
    aggregate.connected = connections.some((connection) => connection.connected);
    aggregate.lastEventAt = connections.map((connection) => connection.lastEventAt)
      .filter((value): value is string => Boolean(value)).sort().at(-1) ?? null;
    aggregate.mappedEntities = connections.reduce((total, connection) => total + connection.mappedEntities, 0);
    aggregate.error = connections.length > 0 && connections.every((connection) => connection.error)
      ? connections.map((connection) => connection.error).filter(Boolean).join("; ")
      : null;
    this.status.changed();
  }
}
