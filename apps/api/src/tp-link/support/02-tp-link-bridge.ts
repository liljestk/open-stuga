import { spawn, type ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { networkInterfaces } from "node:os";
import { createInterface } from "node:readline";
import { hasLocalHouseAuthority, type OpeningStateObservation, type Reading, type TpLinkDiscoveredDevice } from "@climate-twin/contracts";
import type { AppConfig } from "../../config.js";
import type { ClimateDatabase } from "../../db.js";
import type {
  SensorGapRecoveryAdapter,
  SensorHistoryRecoveryResult,
  SensorMetricAvailability,
} from "../../sensor-gap-recovery.js";
import { MeasurementService, RuntimeStatus, TelemetryService } from "../../services.js";
import { TP_LINK_LOCAL_CLIMATE_HISTORY_CAPABILITY_REVISION, TpLinkBridgeOptions, TpLinkCredentialTestResult, TpLinkDeviceMapping, TpLinkSourceDiscoveryResult, TpLinkStatusHost, loadTpLinkDeviceMappings, mergeTpLinkHistoryRecovery } from "./01-tp-link-local-climate-history-capability-revision-to.js";
import { TpLinkConnectionBridgeCore as TpLinkConnectionBridge } from "../core.js";

/** Runs one independent local helper per house-scoped TP-Link host. */
export class TpLinkBridge implements SensorGapRecoveryAdapter {
  readonly source = "tp-link" as const;
  readonly #workers = new Map<string, { bridge: TpLinkConnectionBridge; status: TpLinkStatusHost; houseId: string }>();
  readonly #tester: TpLinkConnectionBridge;
  #running = false;

  constructor(
    private readonly config: AppConfig,
    private readonly telemetry: TelemetryService,
    private readonly measurements: MeasurementService,
    private readonly database: ClimateDatabase,
    private readonly status: RuntimeStatus,
    private readonly options: TpLinkBridgeOptions = {},
  ) {
    const testerStatus: TpLinkStatusHost = { value: structuredClone(status.value), changed: () => undefined };
    this.#tester = new TpLinkConnectionBridge(config, telemetry, measurements, database, testerStatus);
  }

  private rearmLocalClimateHistoryGaps(): void {
    if (this.configuredConnections().length === 0) return;
    this.database.rearmRetainedTpLinkClimateHistoryGaps(
      TP_LINK_LOCAL_CLIMATE_HISTORY_CAPABILITY_REVISION,
    );
  }

  private configuredConnections(): Array<{
    id: string;
    houseId: string;
    host: string;
    username: string;
    password: string;
    deviceId?: string;
    sourceType?: "hub" | "energy-device";
    sourceModel?: string;
    sourceAlias?: string;
    legacyEnvironment: boolean;
  }> {
    const explicit = (this.config.tpLinkConnections ?? []).filter((connection) => {
      const house = this.database.getHouse(connection.houseId);
      return Boolean(house && hasLocalHouseAuthority(house));
    });
    if (explicit.length > 0) return explicit.map((connection) => ({ ...connection, legacyEnvironment: false }));
    const houseId = this.database.listHouses().find(hasLocalHouseAuthority)?.id;
    return !this.config.tpLinkLegacyDisabled && houseId && this.config.tpLinkHost && this.config.tpLinkUsername && this.config.tpLinkPassword
      ? [{
          id: "legacy",
          houseId,
          host: this.config.tpLinkHost,
          username: this.config.tpLinkUsername,
          password: this.config.tpLinkPassword,
          legacyEnvironment: true,
        }]
      : [];
  }

  start(): void {
    if (this.#running) return;
    this.rearmLocalClimateHistoryGaps();
    const mappingPath = this.config.tpLinkDeviceMapFile;
    if (mappingPath && existsSync(mappingPath)) {
      let mappings: TpLinkDeviceMapping[] | undefined;
      try {
        mappings = loadTpLinkDeviceMappings(mappingPath);
      } catch {
        // Preserve the last-good revision; a legacy worker reports the invalid
        // source and remains fail-closed when one is configured.
      }
      // A database failure must fail manager startup; otherwise a valid current
      // map could silently remain file-only while status appears healthy.
      if (mappings) this.database.saveIntegrationMappingSet("tp-link", mappings);
    }
    this.#running = true;
    const configuredConnections = this.configuredConnections();
    for (const connection of configuredConnections) {
      const acceptUnscoped = configuredConnections
        .filter((candidate) => candidate.houseId === connection.houseId).length === 1;
      const localValue = structuredClone(this.status.value);
      localValue.tpLink = {
        configured: true, connected: false, lastPollAt: null, mappedDevices: 0,
        discoveredDevices: 0, hubModel: null, error: null, connections: [],
        host: connection.host,
        sourceType: connection.sourceType ?? null,
        sourceModel: connection.sourceModel ?? null,
        sourceAlias: connection.sourceAlias ?? null,
      };
      const localStatus: TpLinkStatusHost = {
        value: localValue,
        changed: () => this.aggregateStatus(true),
        synchronized: () => this.aggregateStatus(false),
      };
      const localConfig: AppConfig = {
        ...this.config,
        tpLinkHost: connection.host,
        tpLinkUsername: connection.username,
        tpLinkPassword: connection.password,
        tpLinkConnections: [],
        // A legacy map is global and is safe only for the compatibility connection.
        tpLinkDeviceMapFile: connection.legacyEnvironment ? this.config.tpLinkDeviceMapFile : null,
      };
      const bridge = new TpLinkConnectionBridge(
        localConfig, this.telemetry, this.measurements, this.database, localStatus,
        connection.legacyEnvironment ? undefined : { id: connection.id, houseId: connection.houseId, acceptUnscoped },
        {
          id: connection.id,
          houseId: connection.houseId,
          host: connection.host,
          ...(connection.deviceId ? { deviceId: connection.deviceId } : {}),
          ...(connection.sourceType ? { sourceType: connection.sourceType } : {}),
          ...(connection.sourceModel ? { sourceModel: connection.sourceModel } : {}),
          ...(connection.sourceAlias ? { sourceAlias: connection.sourceAlias } : {}),
          ...(this.options.onConnectionUpdate ? { onUpdate: this.options.onConnectionUpdate } : {}),
          ...(this.options.onAvailabilityChange ? { onAvailabilityChange: this.options.onAvailabilityChange } : {}),
          ...(this.options.onOpeningStateRecorded ? { onOpeningStateRecorded: this.options.onOpeningStateRecorded } : {}),
        },
      );
      this.#workers.set(connection.id, { bridge, status: localStatus, houseId: connection.houseId });
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

  listDiscoveredDevices(houseId?: string): TpLinkDiscoveredDevice[] {
    return [...this.#workers.values()]
      .filter((worker) => !houseId || worker.houseId === houseId)
      // The legacy environment-backed bridge has no persisted connection id,
      // but it is still assigned to the first Home by configuredConnections().
      // Preserve that Home ownership in discovery responses so clients never
      // have to expose an ambiguous workspace-global device.
      .flatMap((worker) => worker.bridge.listDiscoveredDevices().map((device) => ({
        ...device,
        houseId: device.houseId ?? worker.houseId,
      })))
      .sort((left, right) => `${left.houseId ?? ""}\u0000${left.alias ?? left.deviceId}`
        .localeCompare(`${right.houseId ?? ""}\u0000${right.alias ?? right.deviceId}`));
  }

  /**
   * Resolve the exact alias the mobile app displays without falling back to a
   * Stugu sensor label. Ambiguous aliases are unsafe because app CSV exports
   * carry no immutable device id of their own.
   */
  tapoAppDeviceName(sensorId: string, deviceId: string): string | null {
    const sensor = this.database.getSensor(sensorId);
    if (!sensor || sensor.tpLinkDeviceId !== deviceId) return null;
    const devices = this.listDiscoveredDevices();
    const candidates = devices.filter((device) => device.deviceId === deviceId
      && (!sensor.tpLinkConnectionId || device.connectionId === sensor.tpLinkConnectionId));
    if (candidates.length !== 1) return null;
    const alias = candidates[0]!.alias?.trim();
    if (!alias) return null;
    const normalized = alias.normalize("NFKC").toLocaleLowerCase();
    const collision = devices.some((device) => device.deviceId !== deviceId
      && device.alias?.trim().normalize("NFKC").toLocaleLowerCase() === normalized);
    return collision ? null : alias;
  }

  availability(now = new Date()): SensorMetricAvailability[] {
    return [...this.#workers.values()].flatMap((worker) => worker.bridge.availability(now));
  }

  /** True only while the exact direct binding is healthy and exposing this metric. */
  isMetricAvailable(sensorId: string, metric: string, now = new Date()): boolean {
    return this.availability(now).some((item) => item.sensorId === sensorId
      && item.metric === metric && item.available);
  }

  async recoverHistory(sensorId: string, metric: string, from: string, to: string): Promise<SensorHistoryRecoveryResult> {
    const sensor = this.database.getSensor(sensorId);
    const house = sensor ? this.database.getHouse(sensor.houseId) : null;
    if (!house || !hasLocalHouseAuthority(house)) {
      return { state: "not-supported", samples: [], error: "TP-Link history recovery requires local Home authority" };
    }
    const candidates = [...this.#workers.entries()].filter(([, worker]) => worker.houseId === sensor?.houseId);
    const owned = sensor?.tpLinkConnectionId
      ? this.#workers.get(sensor.tpLinkConnectionId)?.bridge
      : candidates.length === 1 ? candidates[0]![1].bridge
        : candidates.map(([, worker]) => worker.bridge).find((bridge) => bridge.ownsSensor(sensorId));
    const local = owned
      ? await owned.recoverHistory(sensorId, metric, from, to)
      : { state: "not-supported" as const, samples: [], error: "No local TP-Link connection owns this sensor" };
    if (local.state === "complete" || !this.options.historyFallback) return local;

    const fallback = await this.options.historyFallback.recoverHistory(sensorId, metric, from, to);
    return mergeTpLinkHistoryRecovery(local, fallback);
  }

  recoveryAccepted(sensorId: string, metric: string, from: string, to: string): void | Promise<void> {
    return this.options.historyFallback?.consumeRecovered?.(sensorId, metric, from, to);
  }

  discoverSources(
    houseId?: string,
    credentials?: { username: string; password: string },
    timeoutMs = 50_000,
  ): Promise<TpLinkSourceDiscoveryResult> {
    const credentialCandidates = credentials
      ? [credentials]
      : this.configuredConnections()
          .filter((connection) => !houseId || connection.houseId === houseId)
          .map((connection) => ({ username: connection.username, password: connection.password }));
    const uniqueCredentials = [...new Map(credentialCandidates.map((candidate) => [
      `${candidate.username}\u0000${candidate.password}`,
      candidate,
    ])).values()];
    const attempts = uniqueCredentials.length > 0
      ? uniqueCredentials.map((candidate) => this.#tester.discoverSources(timeoutMs, candidate))
      : [this.#tester.discoverSources(timeoutMs)];
    return Promise.allSettled(attempts).then((attemptResults) => {
      const successful = attemptResults.flatMap((result) => result.status === "fulfilled" ? [result.value] : []);
      if (successful.length === 0) {
        const failure = attemptResults.find((result) => result.status === "rejected");
        throw failure?.status === "rejected" ? failure.reason : new Error("TP-Link discovery failed");
      }
      const discovered = new Map<string, TpLinkSourceDiscoveryResult["sources"][number]>();
      for (const result of successful) {
        for (const source of result.sources) {
          const identity = source.deviceId?.trim().toUpperCase();
          const key = identity ? `device:${identity}` : `host:${source.host}`;
          if (!discovered.has(key)) discovered.set(key, source);
        }
      }
      const result: TpLinkSourceDiscoveryResult = {
        sources: [...discovered.values()].sort((left, right) => left.host.localeCompare(right.host)),
        warnings: [...new Set(successful.flatMap((candidate) => candidate.warnings))],
      };
      const connections = this.configuredConnections();
      const identity = (value: string | null | undefined) => value?.trim().toUpperCase() || null;
      return {
        ...result,
        sources: result.sources.map((source) => {
          const sourceIdentity = identity(source.deviceId);
          const configured = connections.find((connection) => {
            const connectionIdentity = identity(connection.deviceId);
            if (sourceIdentity && connectionIdentity) return sourceIdentity === connectionIdentity;
            return connection.host === source.host;
          });
          return configured
            ? { ...source, configuredConnectionId: configured.id }
            : source;
        }),
      };
    });
  }

  testCredentials(host: string, username: string, password: string, timeoutMs = 15_000): Promise<TpLinkCredentialTestResult> {
    return this.#tester.testCredentials(host, username, password, timeoutMs);
  }

  private aggregateStatus(publish = true): void {
    const connections = [...this.#workers.entries()].map(([id, worker]) => ({
      id,
      houseId: worker.houseId,
      configured: true,
      connected: worker.status.value.tpLink.connected,
      lastPollAt: worker.status.value.tpLink.lastPollAt,
      mappedDevices: worker.status.value.tpLink.mappedDevices,
      discoveredDevices: worker.status.value.tpLink.discoveredDevices,
      hubModel: worker.status.value.tpLink.hubModel,
      error: worker.status.value.tpLink.error,
      host: worker.status.value.tpLink.host ?? null,
      sourceType: worker.status.value.tpLink.sourceType ?? null,
      sourceModel: worker.status.value.tpLink.sourceModel ?? null,
      sourceAlias: worker.status.value.tpLink.sourceAlias ?? null,
    }));
    const aggregate = this.status.value.tpLink;
    aggregate.connections = connections;
    aggregate.configured = connections.length > 0 || this.configuredConnections().length > 0;
    aggregate.connected = connections.some((connection) => connection.connected);
    aggregate.lastPollAt = connections.map((connection) => connection.lastPollAt).filter((value): value is string => Boolean(value)).sort().at(-1) ?? null;
    aggregate.mappedDevices = connections.reduce((total, connection) => total + connection.mappedDevices, 0);
    aggregate.discoveredDevices = connections.reduce((total, connection) => total + connection.discoveredDevices, 0);
    aggregate.hubModel = connections.length === 1 ? connections[0]!.hubModel : null;
    aggregate.host = connections.length === 1 ? connections[0]!.host : null;
    aggregate.sourceType = connections.length === 1 ? connections[0]!.sourceType : null;
    aggregate.sourceModel = connections.length === 1 ? connections[0]!.sourceModel : null;
    aggregate.sourceAlias = connections.length === 1 ? connections[0]!.sourceAlias : null;
    aggregate.error = connections.length > 0 && connections.every((connection) => connection.error)
      ? connections.map((connection) => connection.error).filter(Boolean).join("; ")
      : null;
    if (publish) this.status.changed();
  }
}
