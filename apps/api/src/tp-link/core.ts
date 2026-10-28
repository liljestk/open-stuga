import { finiteOrNull } from "../json-values.js";
import type { TpLinkDiscoveredSource } from "@climate-twin/contracts";
import { hasLocalHouseAuthority, type OpeningStateObservation, type Reading, type TpLinkDiscoveredDevice } from "@climate-twin/contracts";
import { type ChildProcess, spawn } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { createInterface } from "node:readline";
import type { AppConfig } from "../config.js";
import type { ClimateDatabase } from "../db.js";
import type { SensorHistoryRecoveryResult, SensorMetricAvailability } from "../sensor-gap-recovery.js";
import { MeasurementService, TelemetryService } from "../telemetry/ingest.js";
import { compareCodeUnits } from "../text-order.js";
import { CachedTpLinkDevice, CLIMATE_UNCHANGED_HEARTBEAT_MS, importTpLinkMappingFile, ipv4Octets, isTpLinkHubModel, LastIngestedDevice, LastIngestedMeasurement, LastIngestedOpeningState, nonEmptyString, normalizeTpLinkTemperature, PendingTpLinkHistoryRequest, REDUNDANT_SOURCE_HANDOVER_MIN_MS, safeTpLinkHistoryFailure, STATE_UNCHANGED_HEARTBEAT_MS, STATUS_UNCHANGED_HEARTBEAT_MS, TapoOpeningTarget, TpLinkConnectionUpdate, TpLinkContactEventsMessage, TpLinkCredentialTestResult, tpLinkDeviceType, tpLinkDiscoveryTargets, TpLinkHelperMessage, TpLinkHistoryResultMessage, TpLinkHostChangeMessage, TpLinkSnapshotDevice, TpLinkSnapshotMessage, TpLinkSourceDiscoveryResult, TpLinkStatusHost, validateTpLinkDeviceMappings } from "./support/01-tp-link-local-climate-history-capability-revision-to.js";

interface SnapshotClock {
  timestamp: string;
  timestampMs: number;
}

const TP_LINK_DEVICE_METRICS = ["temperature", "humidity", "power", "energy"] as const;

function exposesDeviceMetric(device: CachedTpLinkDevice | undefined, metric: string): boolean {
  if (!device || !(TP_LINK_DEVICE_METRICS as readonly string[]).includes(metric)) return false;
  const value = device[metric as (typeof TP_LINK_DEVICE_METRICS)[number]];
  return value !== null && value !== undefined;
}

function cachedSnapshotDevice(rawDevice: TpLinkSnapshotDevice, deviceId: string, timestamp: string): CachedTpLinkDevice {
  const rawTemperature = finiteOrNull(rawDevice.temperature);
  return {
    deviceId,
    model: nonEmptyString(rawDevice.model) ?? "Unknown",
    alias: nonEmptyString(rawDevice.alias),
    status: nonEmptyString(rawDevice.status),
    temperature: rawTemperature === null ? null : normalizeTpLinkTemperature(rawTemperature, nonEmptyString(rawDevice.temperatureUnit)),
    humidity: finiteOrNull(rawDevice.humidity),
    battery: finiteOrNull(rawDevice.battery),
    contactOpen: typeof rawDevice.contactOpen === "boolean" ? rawDevice.contactOpen : null,
    power: finiteOrNull(rawDevice.power),
    energy: finiteOrNull(rawDevice.energy),
    lastSeenAt: timestamp,
  };
}

/** A house-scoped TP-Link source the bridge supervises, with callbacks for host moves and new readings. */
interface TpLinkManagedConnection {
  id: string;
  houseId: string;
  host: string;
  deviceId?: string;
  sourceType?: "hub" | "energy-device";
  sourceModel?: string;
  sourceAlias?: string;
  onUpdate?: (update: TpLinkConnectionUpdate) => void;
  onAvailabilityChange?: () => void;
  onOpeningStateRecorded?: (observation: OpeningStateObservation) => void;
}

export class TpLinkConnectionBridgeCore {
  #child: ChildProcess | null = null;
  #restartTimer: NodeJS.Timeout | null = null;
  #historyQueue: Promise<void> = Promise.resolve();
  #running: boolean = false;
  #attempt: number = 0;
  #stderr: string = "";
  #mappingWarning: string | null = null;
  readonly #legacyMappings: Map<string, string> = new Map<string, string>();
  readonly #discovered: Map<string, CachedTpLinkDevice> = new Map<string, CachedTpLinkDevice>();
  readonly #currentDevices: Map<string, CachedTpLinkDevice> = new Map<string, CachedTpLinkDevice>();
  readonly #lastIngested: Map<string, LastIngestedDevice> = new Map<string, LastIngestedDevice>();
  readonly #lastIngestedMeasurements: Map<string, LastIngestedMeasurement> = new Map<string, LastIngestedMeasurement>();
  readonly #lastIngestedOpeningStates: Map<string, LastIngestedOpeningState> = new Map<string, LastIngestedOpeningState>();
  #lastStatusSignature: string | null = null;
  #lastStatusPublishedAt: number = 0;
  #lastAvailabilitySignature: string | null = null;
  #contactEventsEnabled: boolean | null = null;
  readonly #pendingHistory: Map<string, PendingTpLinkHistoryRequest> = new Map<string, PendingTpLinkHistoryRequest>();
  readonly #config: AppConfig;
  readonly #telemetry: TelemetryService;
  readonly #measurements: MeasurementService;
  readonly #database: ClimateDatabase;
  readonly #status: TpLinkStatusHost;
  readonly #connection: { id: string; houseId: string; acceptUnscoped: boolean } | undefined;
  readonly #managedConnection: TpLinkManagedConnection | undefined;

  constructor(
    config: AppConfig,
    telemetry: TelemetryService,
    measurements: MeasurementService,
    database: ClimateDatabase,
    status: TpLinkStatusHost,
    connection?: { id: string; houseId: string; acceptUnscoped: boolean },
    managedConnection?: TpLinkManagedConnection,
  ) {
    this.#config = config;
    this.#telemetry = telemetry;
    this.#measurements = measurements;
    this.#database = database;
    this.#status = status;
    this.#connection = connection;
    this.#managedConnection = managedConnection;
  }

  start(): void {
    if (this.#running) return;
    this.#running = true;
    if (!this.#status.value.tpLink.configured) return;
    try {
      if (this.#connection === undefined) {
        const path = this.#config.tpLinkDeviceMapFile;
        const fromFile = Boolean(path && existsSync(path));
        const stored = fromFile ? null : this.#database.getIntegrationMappingSet<unknown>("tp-link");
        const legacyMappings = fromFile
          ? importTpLinkMappingFile(this.#database, path!)
          : stored ? validateTpLinkDeviceMappings(stored.mappings) : [];
        const missingSensorIds = [...new Set(legacyMappings
          .filter((mapping) => !this.#database.getSensor(mapping.sensorId))
          .map((mapping) => mapping.sensorId))].sort(compareCodeUnits);
        this.#mappingWarning = missingSensorIds.length > 0
          ? `Ignored TP-Link mappings for unknown sensors: ${missingSensorIds.join(", ")}`
          : null;
        for (const mapping of legacyMappings) {
          this.#legacyMappings.set(mapping.deviceId, mapping.sensorId);
        }
      }
      this.#status.value.tpLink.mappedDevices = new Set([...this.resolvedMappings().keys(), ...this.configuredOpeningTargets().map((target) => target.deviceId)]).size;
      this.#status.value.tpLink.error = this.#mappingWarning;
      this.publishStatusIfNeeded();
      this.spawnHelper();
    } catch (error) {
      this.#status.value.tpLink.error = error instanceof Error ? error.message : "Could not load TP-Link device mappings";
      this.publishStatusIfNeeded();
    }
  }

  listDiscoveredDevices(): TpLinkDiscoveredDevice[] {
    const mappings = this.resolvedMappings();
    const openingTargets = new Map(this.configuredOpeningTargets()
      .map((target) => [target.deviceId, target] as const));
    return [...this.#discovered.values()]
      .map((device) => {
        const opening = openingTargets.get(device.deviceId);
        return {
          ...device,
          ...(this.#connection ? { connectionId: this.#connection.id, houseId: this.#connection.houseId } : {}),
          deviceType: tpLinkDeviceType(device),
          mappedSensorId: mappings.get(device.deviceId) ?? null,
          mappedOpening: opening ? {
            floorId: opening.floorId,
            elementId: opening.elementId,
            kind: opening.kind,
            label: opening.label,
          } : null,
        };
      })
      .sort((first, second) => (first.alias ?? first.deviceId).localeCompare(second.alias ?? second.deviceId));
  }

  ownsSensor(sensorId: string): boolean {
    return [...this.resolvedMappings().values()].includes(sensorId);
  }

  recoverHistory(sensorId: string, metric: string, from: string, to: string): Promise<SensorHistoryRecoveryResult> {
    const operation = this.#historyQueue.then(() => this.recoverHistoryIsolated(sensorId, metric, from, to));
    this.#historyQueue = operation.then(() => undefined, () => undefined);
    return operation;
  }

  private async recoverHistoryIsolated(sensorId: string, metric: string, from: string, to: string): Promise<SensorHistoryRecoveryResult> {
    const mapping = [...this.resolvedMappings()].find(([, mappedSensorId]) => mappedSensorId === sensorId);
    if (!mapping || !this.#config.tpLinkHost || !this.#config.tpLinkUsername || !this.#config.tpLinkPassword) {
      return {
        state: "not-supported", samples: [], error: "The sensor has no active local TP-Link history binding",
      };
    }
    const definition = this.#database.getMeasurementDefinition(metric);
    if (!definition?.enabled) {
      return { state: "not-supported", samples: [], error: `Measurement metric ${metric} is unavailable` };
    }
    const fromMs = Date.parse(from);
    const toMs = Date.parse(to);
    if (!Number.isFinite(fromMs) || !Number.isFinite(toMs) || toMs <= fromMs) {
      return { state: "complete", samples: [], error: null };
    }
    const requestId = randomUUID();
    const deviceId = mapping[0];
    const liveChild = this.#child;
    if (liveChild?.stdin?.writable) {
      return this.runLiveHistoryRequest(
        liveChild, requestId, deviceId, sensorId, metric, fromMs, toMs, definition.unit,
      );
    }

    await this.pausePollingForHistory();
    try {
      return await this.runHistoryHelper(requestId, deviceId, sensorId, metric, fromMs, toMs, definition.unit);
    } finally {
      // SSL/AES hubs may keep only one usable encrypted session per client.
      // Resume live polling only after the one-shot history process has exited.
      if (this.#running) this.spawnHelper();
    }
  }

  private runLiveHistoryRequest(child: ChildProcess, requestId: string, deviceId: string, sensorId: string, metric: string, fromMs: number, toMs: number, canonicalUnit: string): Promise<SensorHistoryRecoveryResult> {
    return new Promise((resolve, reject) => {
      let pending!: PendingTpLinkHistoryRequest;
      const timer = setTimeout(() => {
        this.settlePendingHistory(pending, new Error("TP-Link local history request timed out"));
        if (this.#child === child) child.kill();
      }, 45_000);
      timer.unref();
      pending = {
        child, requestId, deviceId, sensorId, metric, fromMs, toMs, canonicalUnit,
        timer, resolve, reject,
      };
      this.#pendingHistory.set(requestId, pending);
      const line = `${JSON.stringify({
        type: "history-request", requestId, deviceId, metric,
        from: new Date(fromMs).toISOString(), to: new Date(toMs).toISOString(),
      })}\n`;
      const input = child.stdin!;
      const onInputError = (error: Error) => {
        this.settlePendingHistory(pending, new Error(`Could not send TP-Link history request: ${error.message}`));
      };
      input.once("error", onInputError);
      try {
        input.write(line, (error) => {
          input.off("error", onInputError);
          if (error) this.settlePendingHistory(pending, new Error(`Could not send TP-Link history request: ${error.message}`));
        });
      } catch (error) {
        input.off("error", onInputError);
        this.settlePendingHistory(pending, error instanceof Error ? error : new Error("Could not send TP-Link history request"));
      }
    });
  }

  private settlePendingHistory(pending: PendingTpLinkHistoryRequest, result: SensorHistoryRecoveryResult | Error): void {
    if (this.#pendingHistory.get(pending.requestId) !== pending) return;
    this.#pendingHistory.delete(pending.requestId);
    clearTimeout(pending.timer);
    if (result instanceof Error) pending.reject(result);
    else pending.resolve(result);
  }

  private failPendingHistory(child: ChildProcess, message: string): void {
    for (const pending of this.#pendingHistory.values()) {
      if (pending.child === child) this.settlePendingHistory(pending, new Error(message));
    }
  }

  private runHistoryHelper(requestId: string, deviceId: string, sensorId: string, metric: string, fromMs: number, toMs: number, canonicalUnit: string): Promise<SensorHistoryRecoveryResult> {
    return new Promise((resolve, reject) => {
      const child = spawn(this.#config.tpLinkPython, [this.#config.tpLinkBridgeScript, "--history"], {
        env: {
          ...process.env,
          TP_LINK_HOST: this.#config.tpLinkHost!,
          TP_LINK_USERNAME: this.#config.tpLinkUsername!,
          TP_LINK_PASSWORD: this.#config.tpLinkPassword!,
          ...(this.#managedConnection?.deviceId ? { TP_LINK_DEVICE_ID: this.#managedConnection.deviceId } : {}),
        },
        stdio: ["pipe", "pipe", "pipe"],
        windowsHide: true,
      });
      let settled = false;
      let stdout = "";
      let stderr = "";
      const finish = (result: SensorHistoryRecoveryResult | Error) => {
        if (settled) return;
        settled = true;
        clearTimeout(timeout);
        if (!child.killed) child.kill();
        if (result instanceof Error) reject(result);
        else resolve(result);
      };
      const timeout = setTimeout(() => finish(new Error("TP-Link local history request timed out")), 45_000);
      timeout.unref();
      child.stdout?.on("data", (chunk: Buffer | string) => {
        stdout += chunk.toString();
        if (Buffer.byteLength(stdout, "utf8") > 2 * 1024 * 1024) {
          finish(new Error("TP-Link local history response exceeded 2 MiB"));
        }
      });
      child.stderr?.on("data", (chunk: Buffer | string) => { stderr = `${stderr}${chunk.toString()}`.slice(-2_000); });
      child.once("error", (error) => finish(new Error(`Could not start TP-Link history helper: ${error.message}`)));
      child.stdin?.once("error", () => finish(new Error("Could not send the TP-Link history request")));
      child.once("close", (code) => {
        if (settled) return;
        const lines = stdout.trim().split(/\r?\n/).filter(Boolean);
        let message: TpLinkHistoryResultMessage | null = null;
        let helperError: string | null = null;
        for (const line of lines) {
          try {
            const candidate = JSON.parse(line) as {
              type?: string;
              requestId?: string;
              message?: unknown;
            };
            if (candidate.type === "history-result") message = candidate as TpLinkHistoryResultMessage;
            if (candidate.type === "error" && (candidate.requestId === undefined || candidate.requestId === requestId)) {
              helperError = safeTpLinkHistoryFailure(candidate.message);
            }
          } catch { /* Reject below with a non-sensitive protocol error. */ }
        }
        if (!message || code !== 0) {
          const stderrDetail = safeTpLinkHistoryFailure(stderr.trim().split(/\r?\n/).at(-1));
          finish(new Error(helperError || stderrDetail || `TP-Link history helper stopped with exit code ${code ?? "unknown"}`));
          return;
        }
        try { finish(this.validateHistoryResult(message, requestId, deviceId, sensorId, metric, fromMs, toMs, canonicalUnit)); }
        catch (error) { finish(error instanceof Error ? error : new Error("TP-Link history response was invalid")); }
      });
      child.stdin?.end(`${JSON.stringify({
        type: "history-request", requestId, deviceId, metric,
        from: new Date(fromMs).toISOString(), to: new Date(toMs).toISOString(),
      })}\n`);
    });
  }

  private async pausePollingForHistory(): Promise<void> {
    if (this.#restartTimer) clearTimeout(this.#restartTimer);
    this.#restartTimer = null;
    const child = this.#child;
    if (!child) return;
    this.#child = null;
    try {
      await new Promise<void>((resolve, reject) => {
        let settled = false;
        const finish = (error?: Error): void => {
          if (settled) return;
          settled = true;
          clearTimeout(forceTimer);
          clearTimeout(failureTimer);
          child.off("close", closed);
          child.off("error", failed);
          if (error) reject(error);
          else resolve();
        };
        const closed = (): void => finish();
        const failed = (): void => finish();
        const forceTimer = setTimeout(() => child.kill("SIGKILL"), 2_000);
        const failureTimer = setTimeout(() => finish(new Error(
          "TP-Link live polling helper could not be paused for local history recovery",
        )), 5_000);
        forceTimer.unref();
        failureTimer.unref();
        child.once("close", closed);
        child.once("error", failed);
        if (child.exitCode !== null || child.signalCode !== null) finish();
        else child.kill();
      });
    } catch (error) {
      if (child.exitCode === null && child.signalCode === null) this.#child = child;
      throw error;
    }
  }

  private validateHistoryResult(message: TpLinkHistoryResultMessage, requestId: string, deviceId: string, sensorId: string, metric: string, fromMs: number, toMs: number, canonicalUnit: string): SensorHistoryRecoveryResult {
    if (message.requestId !== requestId || nonEmptyString(message.deviceId)?.toUpperCase() !== deviceId.toUpperCase()
      || message.metric !== metric || !["complete", "partial", "not-supported"].includes(message.state)
      || !Array.isArray(message.samples) || message.samples.length > 100_000) {
      throw new Error("TP-Link history helper returned a mismatched response identity");
    }
    const definition = this.#database.getMeasurementDefinition(metric);
    const samples = new Map<string, SensorHistoryRecoveryResult["samples"][number]>();
    for (const sample of message.samples) {
      const timestampMs = typeof sample.timestamp === "string" ? Date.parse(sample.timestamp) : NaN;
      if (nonEmptyString(sample.deviceId)?.toUpperCase() !== deviceId.toUpperCase() || sample.metric !== metric
        || typeof sample.value !== "number" || !Number.isFinite(sample.value)
        || !Number.isFinite(timestampMs) || timestampMs < fromMs || timestampMs > toMs
        || !["good", "estimated", "stale"].includes(sample.quality)
        || definition?.validMin !== null && definition?.validMin !== undefined && sample.value < definition.validMin
        || definition?.validMax !== null && definition?.validMax !== undefined && sample.value > definition.validMax) {
        throw new Error("TP-Link history helper returned an invalid measurement sample");
      }
      const timestamp = new Date(timestampMs).toISOString();
      samples.set(timestamp, {
        sensorId, metric, value: sample.value, canonicalUnit, timestamp,
        source: "tp-link", quality: sample.quality,
      });
    }
    return {
      state: message.state,
      samples: [...samples.values()].sort((left, right) => left.timestamp.localeCompare(right.timestamp)),
      error: message.error === null ? null : nonEmptyString(message.error)?.slice(0, 1_000) ?? "Local TP-Link history is incomplete",
    };
  }

  private resolvedMappings(): Map<string, string> {
    const mappings = new Map<string, string>();
    const mappedSensors = new Set<string>();
    const effectiveHouseId = this.#connection?.houseId
      ?? this.#database.listHouses().find(hasLocalHouseAuthority)?.id;
    for (const sensor of effectiveHouseId
      ? this.#database.listSensors(effectiveHouseId)
      : []) {
      if (!sensor.tpLinkDeviceId) continue;
      if (this.#connection && sensor.tpLinkConnectionId !== this.#connection.id
        && !(this.#connection.acceptUnscoped && sensor.tpLinkConnectionId === undefined)) continue;
      mappings.set(sensor.tpLinkDeviceId, sensor.id);
      mappedSensors.add(sensor.id);
    }
    const missingSensorIds = [...new Set([...this.#legacyMappings.values()]
      .filter((sensorId) => !this.#database.getSensor(sensorId)))].sort(compareCodeUnits);
    this.#mappingWarning = missingSensorIds.length > 0
      ? `Ignored TP-Link mappings for unknown sensors: ${missingSensorIds.join(", ")}`
      : null;
    for (const [deviceId, sensorId] of this.#legacyMappings) {
      const sensor = this.#database.getSensor(sensorId);
      const house = sensor ? this.#database.getHouse(sensor.houseId) : null;
      if (!sensor || sensor.houseId !== effectiveHouseId || !house || !hasLocalHouseAuthority(house)) continue;
      if (mappings.has(deviceId) || mappedSensors.has(sensorId)) continue;
      mappings.set(deviceId, sensorId);
      mappedSensors.add(sensorId);
    }
    this.#status.value.tpLink.mappedDevices = new Set([...mappings.keys(), ...this.configuredOpeningTargets().map((target) => target.deviceId)]).size;
    return mappings;
  }

  private configuredOpeningTargets(): TapoOpeningTarget[] {
    const houseId = this.#connection?.houseId
      ?? this.#database.listHouses().find(hasLocalHouseAuthority)?.id;
    const house = houseId ? this.#database.getHouse(houseId) : null;
    if (!house || !hasLocalHouseAuthority(house)) return [];
    const connectionId = this.#connection?.id ?? "legacy";
    return house.floors.flatMap((floor) => (floor.planElements ?? []).flatMap((element) => {
      if ((element.kind !== "door" && element.kind !== "window" && element.kind !== "vent") || element.stateBinding?.provider !== "tapo") return [];
      if (element.stateBinding.connectionId && element.stateBinding.connectionId !== connectionId) return [];
      if (!element.stateBinding.connectionId && this.#connection && !this.#connection.acceptUnscoped) return [];
      return [{ houseId: house.id, floorId: floor.id, elementId: element.id,
        deviceId: element.stateBinding.externalId, connectionId, kind: element.kind,
        label: element.label?.trim() || null }];
    }));
  }

  stop(): void {
    this.#running = false;
    if (this.#restartTimer) clearTimeout(this.#restartTimer);
    this.#restartTimer = null;
    const child = this.#child;
    this.#child = null;
    child?.kill();
    this.#status.value.tpLink.connected = false;
  }

  restart(): void {
    this.stop();
    this.#attempt = 0;
    this.#legacyMappings.clear();
    this.#discovered.clear();
    this.#currentDevices.clear();
    this.#lastIngested.clear();
    this.#lastIngestedMeasurements.clear();
    this.#lastIngestedOpeningStates.clear();
    this.#lastStatusSignature = null;
    this.#lastStatusPublishedAt = 0;
    this.#lastAvailabilitySignature = null;
    this.#mappingWarning = null;
    this.#status.value.tpLink.discoveredDevices = 0;
    this.#status.value.tpLink.mappedDevices = 0;
    this.#status.value.tpLink.hubModel = null;
    this.#status.value.tpLink.error = null;
    this.start();
  }

  discoverSources(timeoutMs = 50_000, preferredConnection?: { username: string; password: string }): Promise<TpLinkSourceDiscoveryResult> {
    return new Promise((resolve, reject) => {
      const configuredTargets = (this.#config.tpLinkDiscoveryTargets ?? []).join(",");
      const savedConnection = this.#config.tpLinkConnections?.[0];
      const recoveryHostList = (this.#config.tpLinkConnections ?? []).map((connection) => connection.host)
        .concat(this.#config.tpLinkHost ?? []).filter(Boolean);
      const discoveryTargets = configuredTargets || tpLinkDiscoveryTargets(recoveryHostList).join(",");
      const recoveryHosts = recoveryHostList.join(",");
      const username = preferredConnection?.username ?? this.#config.tpLinkUsername ?? savedConnection?.username;
      const password = preferredConnection?.password ?? this.#config.tpLinkPassword ?? savedConnection?.password;
      const child = spawn(this.#config.tpLinkPython, [this.#config.tpLinkBridgeScript, "--discover"], {
        env: {
          ...process.env,
          ...(discoveryTargets ? { TP_LINK_DISCOVERY_TARGETS: discoveryTargets } : {}),
          ...(recoveryHosts ? { TP_LINK_RECOVERY_HOSTS: recoveryHosts } : {}),
          ...(username ? { TP_LINK_USERNAME: username } : {}),
          ...(password ? { TP_LINK_PASSWORD: password } : {}),
        },
        stdio: ["ignore", "pipe", "pipe"],
        windowsHide: true,
      });
      let stdout = "";
      let stderr = "";
      let settled = false;
      const timer = setTimeout(() => finish(new Error("TP-Link discovery timed out")), timeoutMs);
      const finish = (error?: Error, result?: TpLinkSourceDiscoveryResult): void => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        if (!child.killed) child.kill();
        if (error) reject(error);
        else resolve(result ?? { sources: [], warnings: [] });
      };
      child.stdout?.on("data", (chunk: Buffer | string) => {
        stdout = `${stdout}${chunk.toString()}`.slice(-65_536);
      });
      child.stderr?.on("data", (chunk: Buffer | string) => {
        stderr = `${stderr}${chunk.toString()}`.slice(-2_000);
      });
      child.once("error", (error) => finish(error));
      child.once("close", (code) => {
        if (settled) return;
        const lines = stdout.trim().split(/\r?\n/).filter(Boolean);
        const message = lines.flatMap((line) => {
          try { return [JSON.parse(line) as Record<string, unknown>]; } catch { return []; }
        }).find((value) => value.type === "discovery");
        const rawSources = message && Array.isArray(message.sources)
          ? message.sources
          : message && Array.isArray(message.hubs) ? message.hubs : null;
        if (code !== 0 || !message || !rawSources) {
          finish(new Error(stderr.trim().split(/\r?\n/).at(-1) || "TP-Link discovery helper failed"));
          return;
        }
        const sources = rawSources.flatMap((value): TpLinkDiscoveredSource[] => {
          if (!value || typeof value !== "object") return [];
          const item = value as Record<string, unknown>;
          const host = nonEmptyString(item.host);
          const model = nonEmptyString(item.model)?.toUpperCase();
          const declaredSourceType = nonEmptyString(item.sourceType);
          const sourceType = declaredSourceType === "hub" || declaredSourceType === "energy-device"
            ? declaredSourceType
            : model && isTpLinkHubModel(model) ? "hub" : null;
          const rawDeviceId = nonEmptyString(item.deviceId);
          const deviceId = rawDeviceId && rawDeviceId.length <= 1_024 ? rawDeviceId : null;
          if (!host || !model || !sourceType) return [];
          if (sourceType === "hub" && !isTpLinkHubModel(model)) return [];
          return [{ host, model, alias: nonEmptyString(item.alias), sourceType, deviceId }];
        });
        const warnings = Array.isArray(message.warnings)
          ? message.warnings.flatMap((value): string[] => {
            const warning = nonEmptyString(value);
            return warning ? [warning.slice(0, 500)] : [];
          }).slice(0, 20)
          : [];
        finish(undefined, { sources: sources.sort((a, b) => a.host.localeCompare(b.host)), warnings });
      });
    });
  }

  /** Runs one isolated helper poll with draft credentials and never mutates the live bridge. */
  testCredentials(host: string, username: string, password: string, timeoutMs = 15_000): Promise<TpLinkCredentialTestResult> {
    return new Promise((resolveTest) => {
      const child = spawn(this.#config.tpLinkPython, [this.#config.tpLinkBridgeScript, "--list"], {
        env: {
          ...process.env,
          TP_LINK_HOST: host,
          TP_LINK_USERNAME: username,
          TP_LINK_PASSWORD: password,
          TP_LINK_POLL_INTERVAL_MS: String(this.#config.tpLinkPollIntervalMs),
        },
        stdio: ["ignore", "pipe", "pipe"],
        windowsHide: true,
      });
      let stdout = "";
      let settled = false;
      const finish = (result: TpLinkCredentialTestResult): void => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        if (!child.killed) child.kill();
        resolveTest(result);
      };
      const timer = setTimeout(() => finish({
        ok: false, connected: false, message: "TP-Link credential validation timed out.",
      }), timeoutMs);
      timer.unref();
      child.stdout?.on("data", (chunk: Buffer | string) => {
        stdout = `${stdout}${chunk.toString()}`.slice(-65_536);
      });
      child.once("error", () => finish({
        ok: false, connected: false, message: "Could not start the TP-Link validation helper.",
      }));
      child.once("close", (code) => {
        if (settled) return;
        const messages = stdout.trim().split(/\r?\n/).flatMap((line) => {
          try { return [JSON.parse(line) as Record<string, unknown>]; } catch { return []; }
        });
        const snapshot = messages.find((message) => message.type === "snapshot");
        if (code === 0 && snapshot && Array.isArray(snapshot.devices)) {
          const deviceIds = snapshot.devices.flatMap((candidate): string[] => {
            if (!candidate || typeof candidate !== "object") return [];
            const deviceId = nonEmptyString((candidate as Record<string, unknown>).deviceId);
            return deviceId && deviceId.length <= 1_024 ? [deviceId] : [];
          });
          const warning = nonEmptyString(snapshot.warning)?.slice(0, 500) ?? null;
          finish({
            ok: true,
            connected: true,
            message: warning ?? "TP-Link credentials and local device polling are available.",
            details: {
              model: nonEmptyString(snapshot.hubModel),
              sourceType: snapshot.sourceType === "hub" || snapshot.sourceType === "energy-device"
                ? snapshot.sourceType
                : null,
              sourceAlias: nonEmptyString(snapshot.sourceAlias)?.slice(0, 512),
              deviceCount: snapshot.devices.length,
              sourceDeviceId: nonEmptyString(snapshot.sourceDeviceId),
              deviceIds: [...new Set(deviceIds)].slice(0, 2_048),
              warning,
            },
          });
          return;
        }
        finish({ ok: false, connected: false, message: "TP-Link rejected the draft connection or credentials." });
      });
    });
  }

  private spawnHelper(): void {
    if (!this.#running || this.#child || !this.#config.tpLinkHost || !this.#config.tpLinkUsername || !this.#config.tpLinkPassword) return;
    this.#stderr = "";
    const configuredTargets = (this.#config.tpLinkDiscoveryTargets ?? []).join(",");
    const discoveryTargets = configuredTargets
      || tpLinkDiscoveryTargets([this.#config.tpLinkHost]).join(",");
    const contactEventsEnabled = this.configuredOpeningTargets().length > 0;
    this.#contactEventsEnabled = contactEventsEnabled;
    const child = spawn(this.#config.tpLinkPython, [this.#config.tpLinkBridgeScript], {
      env: {
        ...process.env,
        TP_LINK_HOST: this.#config.tpLinkHost,
        TP_LINK_USERNAME: this.#config.tpLinkUsername,
        TP_LINK_PASSWORD: this.#config.tpLinkPassword,
        TP_LINK_POLL_INTERVAL_MS: String(this.#config.tpLinkPollIntervalMs),
        TP_LINK_CONTACT_EVENTS_ENABLED: contactEventsEnabled ? "1" : "0",
        ...(this.#managedConnection?.deviceId ? { TP_LINK_DEVICE_ID: this.#managedConnection.deviceId } : {}),
        ...(discoveryTargets ? { TP_LINK_DISCOVERY_TARGETS: discoveryTargets } : {}),
      },
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true,
    });
    this.#child = child;
    const lines = child.stdout ? createInterface({ input: child.stdout }) : null;
    lines?.on("line", (line) => {
      if (this.#child === child) {
        this.handleLine(line);
      }
    });
    child.stderr?.on("data", (chunk: Buffer | string) => {
      this.#stderr = `${this.#stderr}${chunk.toString()}`.slice(-2_000);
    });
    child.stdin?.on("error", () => {
      this.failPendingHistory(child, "TP-Link helper input became unavailable");
    });
    child.once("error", (error) => {
      this.failPendingHistory(child, `TP-Link helper failed: ${error.message}`);
      if (this.#child !== child) return;
      this.#status.value.tpLink.connected = false;
      this.#status.value.tpLink.error = `Could not start TP-Link helper: ${error.message}`;
      this.publishStatusIfNeeded();
      this.notifyAvailabilityChangeIfNeeded();
    });
    child.once("close", (code) => {
      lines?.close();
      this.failPendingHistory(child, `TP-Link helper stopped with exit code ${code ?? "unknown"}`);
      if (this.#child !== child) return;
      this.#child = null;
      this.#status.value.tpLink.connected = false;
      const stderr = this.#stderr.trim().split(/\r?\n/).at(-1);
      this.#status.value.tpLink.error = stderr || `TP-Link helper stopped${code === null ? "" : ` with exit code ${code}`}`;
      this.publishStatusIfNeeded();
      this.notifyAvailabilityChangeIfNeeded();
      this.scheduleRestart();
    });
  }

  private handleLine(line: string): void {
    if (!this.#running) {
      return;
    }

    let message: TpLinkHelperMessage;
    try {
      message = JSON.parse(line) as TpLinkHelperMessage;
    } catch {
      this.#status.value.tpLink.error = "TP-Link helper returned malformed data";
      this.publishStatusIfNeeded();
      return;
    }
    if (message.type === "error") {
      const requestId = nonEmptyString(message.requestId);
      if (requestId) {
        const pending = this.#pendingHistory.get(requestId);
        if (pending) {
          this.settlePendingHistory(
            pending,
            new Error(safeTpLinkHistoryFailure(message.message) ?? "TP-Link history recovery failed"),
          );
        }
        return;
      }
      this.#status.value.tpLink.connected = false;
      this.#status.value.tpLink.error = nonEmptyString(message.message) ?? "TP-Link connection failed";
      this.publishStatusIfNeeded();
      this.notifyAvailabilityChangeIfNeeded();
      return;
    }
    if (message.type === "history-result") {
      const requestId = nonEmptyString(message.requestId);
      const pending = requestId ? this.#pendingHistory.get(requestId) : undefined;
      if (!pending) return;
      try {
        this.settlePendingHistory(pending, this.validateHistoryResult(
          message,
          pending.requestId,
          pending.deviceId,
          pending.sensorId,
          pending.metric,
          pending.fromMs,
          pending.toMs,
          pending.canonicalUnit,
        ));
      } catch (error) {
        this.settlePendingHistory(
          pending,
          error instanceof Error ? error : new Error("TP-Link history response was invalid"),
        );
      }
      return;
    }
    if (message.type === "host-change") {
      this.handleHostChange(message);
      return;
    }
    if (message.type === "contact-events") {
      if (Array.isArray(message.events)) this.ingestContactEvents(message);
      return;
    }
    if (message.type !== "snapshot" || !Array.isArray(message.devices)) return;
    this.ingestSnapshot(message);
  }

  private handleHostChange(message: TpLinkHostChangeMessage): void {
    const previousHost = nonEmptyString(message.previousHost);
    const host = nonEmptyString(message.host);
    if (!previousHost || !host || !ipv4Octets(host) || previousHost !== this.#config.tpLinkHost) return;
    const reportedDeviceId = nonEmptyString(message.sourceDeviceId);
    const knownDeviceId = this.#managedConnection?.deviceId;
    if (knownDeviceId && (!reportedDeviceId
      || knownDeviceId.trim().toUpperCase() !== reportedDeviceId.trim().toUpperCase())) {
      this.#status.value.tpLink.connected = false;
      this.#status.value.tpLink.error = "TP-Link address recovery reported a different source identity; the saved connection was not changed";
      this.publishStatusIfNeeded();
      this.notifyAvailabilityChangeIfNeeded();
      return;
    }
    if (reportedDeviceId && reportedDeviceId.length > 1_024) {
      this.#status.value.tpLink.connected = false;
      this.#status.value.tpLink.error = "TP-Link address recovery returned an invalid source identity";
      this.publishStatusIfNeeded();
      this.notifyAvailabilityChangeIfNeeded();
      return;
    }
    const deviceId = reportedDeviceId ?? knownDeviceId;
    this.#config.tpLinkHost = host;
    this.#status.value.tpLink.host = host;
    if (this.#managedConnection) {
      this.#managedConnection.host = host;
      if (deviceId) this.#managedConnection.deviceId = deviceId;
      this.#managedConnection.onUpdate?.({
        id: this.#managedConnection.id,
        houseId: this.#managedConnection.houseId,
        previousHost,
        host,
        ...(deviceId ? { deviceId } : {}),
      });
    }
    this.#status.value.tpLink.error = `TP-Link source moved from ${previousHost} to ${host}; connection recovery is in progress`;
    this.publishStatusIfNeeded();
  }

  private mappedSensorAvailability(deviceId: string, sensorId: string, connectionFresh: boolean, observedAt: string): SensorMetricAvailability[] {
    const sensor = this.#database.getSensor(sensorId);
    if (!sensor?.enabled) return [];
    const device = this.#currentDevices.get(deviceId);
    const metrics = new Set(this.#database.sensorSourceMetrics(sensorId, "tp-link"));
    for (const metric of TP_LINK_DEVICE_METRICS) {
      if (exposesDeviceMetric(device, metric)) metrics.add(metric);
    }
    if (metrics.size === 0 && /T3(?:10|15)/i.test(sensor.model)) {
      metrics.add("temperature");
      metrics.add("humidity");
    }
    const online = connectionFresh && Boolean(device)
      && (!device?.status || device.status.toLowerCase() === "online");
    return [...metrics].map((metric): SensorMetricAvailability => ({
      sensorId,
      metric,
      source: "tp-link",
      available: online && exposesDeviceMetric(device, metric),
      observedAt,
    }));
  }

  private snapshotSourceError(message: TpLinkSnapshotMessage, supportedHub: boolean, sourceType: NonNullable<TpLinkSnapshotMessage["sourceType"]>, sourceDeviceId: string | null): string | null {
    if (!supportedHub && sourceType !== "energy-device") return `Unsupported TP-Link source model ${message.hubModel || "unknown"}`;
    if (sourceDeviceId && sourceDeviceId.length > 1_024) return "TP-Link helper returned an invalid source identity";
    const savedDeviceId = this.#managedConnection?.deviceId;
    if (savedDeviceId && (!sourceDeviceId || savedDeviceId.trim().toUpperCase() !== sourceDeviceId.trim().toUpperCase())) {
      return "TP-Link helper returned a missing or different source identity at the saved address; polling was stopped to protect device bindings";
    }
    return null;
  }

  private learnSnapshotSource(source: { sourceDeviceId: string | null; sourceType: NonNullable<TpLinkSnapshotMessage["sourceType"]>; sourceModel: string; sourceAlias: string | null; }): void {
    const managedConnection = this.#managedConnection;
    if (!managedConnection) return;
    const { sourceDeviceId, sourceType, sourceModel, sourceAlias } = source;
    const previousHost = managedConnection.host;
    const metadataChanged = managedConnection.sourceType !== sourceType
      || managedConnection.sourceModel !== sourceModel
      || (managedConnection.sourceAlias ?? null) !== sourceAlias;
    const identityLearned = Boolean(sourceDeviceId && !managedConnection.deviceId);
    if (sourceDeviceId) managedConnection.deviceId = sourceDeviceId;
    managedConnection.sourceType = sourceType;
    managedConnection.sourceModel = sourceModel;
    if (sourceAlias) managedConnection.sourceAlias = sourceAlias;
    else delete managedConnection.sourceAlias;
    if (identityLearned || metadataChanged) managedConnection.onUpdate?.({
      id: managedConnection.id,
      houseId: managedConnection.houseId,
      previousHost,
      host: previousHost,
      ...(managedConnection.deviceId ? { deviceId: managedConnection.deviceId } : {}),
      sourceType,
      sourceModel,
      sourceAlias,
    });
  }

  private cacheSnapshotDevices(rawDevices: TpLinkSnapshotDevice[], timestamp: string): Map<string, CachedTpLinkDevice> {
    const devices = new Map<string, CachedTpLinkDevice>();
    for (const rawDevice of rawDevices) {
      const deviceId = nonEmptyString(rawDevice?.deviceId);
      if (!deviceId) continue;
      const device = cachedSnapshotDevice(rawDevice, deviceId, timestamp);
      devices.set(deviceId, device);
      this.#discovered.set(deviceId, device);
    }
    this.#currentDevices.clear();
    for (const [deviceId, device] of devices) this.#currentDevices.set(deviceId, device);
    this.#status.value.tpLink.discoveredDevices = this.#discovered.size;
    return devices;
  }

  // Returns the issue to report for this contact target, if any.
  private ingestSnapshotOpeningState(target: TapoOpeningTarget, device: CachedTpLinkDevice | undefined, clock: SnapshotClock): string | null {
    if (!device) return `Mapped Tapo contact ${target.deviceId} was not found`;
    if (device.status && device.status.toLowerCase() !== "online") return null;
    if (typeof device.contactOpen !== "boolean") return `Mapped Tapo contact ${target.deviceId} does not expose contact state`;
    const state = device.contactOpen ? "open" : "closed";
    const targetKey = `${target.floorId}\u0000${target.elementId}`;
    const previous = this.#lastIngestedOpeningStates.get(targetKey);
    if (previous?.state === state && clock.timestampMs - previous.ingestedAt < STATE_UNCHANGED_HEARTBEAT_MS) return null;
    try {
      const observation = this.#database.recordOpeningStateObservation(target.houseId, {
        floorId: target.floorId,
        elementId: target.elementId,
        state,
        source: "tapo",
        observedAt: clock.timestamp,
        externalId: target.deviceId,
        connectionId: target.connectionId,
      });
      this.#managedConnection?.onOpeningStateRecorded?.(observation);
      this.#lastIngestedOpeningStates.set(targetKey, { state, ingestedAt: clock.timestampMs });
      return null;
    } catch (error) {
      const reason = error instanceof Error ? error.message : "ingestion failed";
      return `Could not ingest Tapo contact ${target.deviceId}: ${reason}`;
    }
  }

  private ingestMappedSnapshotDevice(deviceId: string, sensorId: string, device: CachedTpLinkDevice | undefined, clock: SnapshotClock, issues: string[]): void {
    const sensor = this.#database.getSensor(sensorId);
    if (!sensor) {
      issues.push(`Mapped TP-Link child ${deviceId} references unknown sensor ${sensorId}`);
      return;
    }
    // Archived sensors retain ownership of their physical child device so it
    // cannot be accidentally offered or assigned elsewhere, but do not ingest.
    if (!sensor.enabled) return;
    if (!device) {
      issues.push(`Mapped TP-Link child ${deviceId} was not found`);
      return;
    }
    if (device.status && device.status.toLowerCase() !== "online") {
      issues.push(`Mapped TP-Link child ${deviceId} is ${device.status}`);
      return;
    }
    const temperature = device.temperature;
    const humidity = device.humidity;
    const power = device.power ?? null;
    const energy = device.energy ?? null;
    const hasClimate = temperature !== null && humidity !== null;
    const hasEnergy = power !== null || energy !== null;
    if (!hasClimate && !hasEnergy) {
      issues.push(`Mapped TP-Link device ${deviceId} does not expose valid climate or energy data`);
      return;
    }
    if (hasClimate) {
      this.ingestSnapshotClimate({ deviceId, sensorId, temperature, humidity, battery: device.battery }, clock, issues);
    }
    if (power !== null) this.ingestElectricityMeasurement(deviceId, sensorId, "power", power, "W", clock.timestamp, clock.timestampMs, issues);
    if (energy !== null) this.ingestElectricityMeasurement(deviceId, sensorId, "energy", energy, "kWh", clock.timestamp, clock.timestampMs, issues);
  }

  private ingestSnapshotClimate(climate: { deviceId: string; sensorId: string; temperature: number; humidity: number; battery: number | null }, clock: SnapshotClock, issues: string[]): void {
    const { deviceId, sensorId, temperature, humidity, battery } = climate;
    const { timestamp, timestampMs } = clock;
    const previous = this.#lastIngested.get(deviceId);
    const unchanged = previous?.sensorId === sensorId && previous.temperature === temperature
      && previous.humidity === humidity && previous.battery === battery;
    const due = !unchanged || timestampMs - previous.ingestedAt >= CLIMATE_UNCHANGED_HEARTBEAT_MS;
    if (!due) return;
    const reading: Reading = {
      sensorId,
      timestamp,
      temperature,
      humidity,
      battery,
      source: "tp-link",
      quality: "good",
    };
    const redundantHandover = this.isRecentHomeAssistantEquivalent(
      sensorId, "temperature", temperature, timestampMs,
    ) && this.isRecentHomeAssistantEquivalent(sensorId, "humidity", humidity, timestampMs);
    if (redundantHandover) {
      this.#lastIngested.set(deviceId, { sensorId, temperature, humidity, battery, ingestedAt: timestampMs });
      return;
    }
    try {
      this.#telemetry.ingest(reading);
      this.#lastIngested.set(deviceId, { sensorId, temperature, humidity, battery, ingestedAt: timestampMs });
    } catch (error) {
      const reason = error instanceof Error ? error.message : "ingestion failed";
      issues.push(`Could not ingest TP-Link climate device ${deviceId}: ${reason}`);
    }
  }

  private ingestContactEvents(message: TpLinkContactEventsMessage): void {
    const targets = new Map(this.configuredOpeningTargets()
      .map((target) => [target.deviceId, target] as const));
    const receivedAtMs = Date.now();
    const batchTimestampMs = Date.parse(message.timestamp);
    const latestAllowedMs = Math.min(
      receivedAtMs + 5 * 60_000,
      (Number.isFinite(batchTimestampMs) ? batchTimestampMs : receivedAtMs) + 5 * 60_000,
    );
    const events = message.events.slice(0, 2_048).flatMap((rawEvent) => {
      const deviceId = nonEmptyString(rawEvent?.deviceId);
      const eventId = nonEmptyString(rawEvent?.eventId);
      const observedAtMs = Date.parse(rawEvent?.timestamp);
      const sequence = finiteOrNull(rawEvent?.sequence);
      if (!deviceId || deviceId.length > 255 || !eventId || eventId.length > 512
        || (rawEvent?.state !== "open" && rawEvent?.state !== "closed")
        || !Number.isFinite(observedAtMs) || observedAtMs <= 0 || observedAtMs > latestAllowedMs) return [];
      return [{
        deviceId, eventId, state: rawEvent.state, observedAtMs,
        sequence: sequence === null ? -1 : sequence,
      }];
    }).sort((left, right) => left.observedAtMs - right.observedAtMs
      || left.deviceId.localeCompare(right.deviceId)
      || left.sequence - right.sequence
      || left.eventId.localeCompare(right.eventId));
    const handled = new Set<string>();
    for (const event of events) {
      const target = targets.get(event.deviceId);
      const eventKey = `${event.deviceId}\u0000${event.eventId}`;
      if (!target || handled.has(eventKey)) continue;
      handled.add(eventKey);
      const id = `tapo-event:${createHash("sha256")
        .update(`${target.connectionId}\u0000${event.deviceId}\u0000${event.eventId}`)
        .digest("hex")}`;
      try {
        const observation = this.#database.recordOpeningStateObservation(target.houseId, {
          id,
          floorId: target.floorId,
          elementId: target.elementId,
          state: event.state,
          source: "tapo",
          observedAt: new Date(event.observedAtMs).toISOString(),
          externalId: event.deviceId,
          connectionId: target.connectionId,
        });
        this.#managedConnection?.onOpeningStateRecorded?.(observation);
        const targetKey = `${target.floorId}\u0000${target.elementId}`;
        const previous = this.#lastIngestedOpeningStates.get(targetKey);
        if (!previous || event.observedAtMs >= previous.ingestedAt) {
          this.#lastIngestedOpeningStates.set(
            targetKey,
            { state: event.state, ingestedAt: event.observedAtMs },
          );
        }
      } catch (error) {
        if (error && typeof error === "object" && "code" in error
          && error.code === "OPENING_OBSERVATION_ID_CONFLICT") continue;
        const reason = error instanceof Error ? error.message : "ingestion failed";
        this.#status.value.tpLink.error = `Could not ingest Tapo contact ${event.deviceId}: ${reason}`;
        this.publishStatusIfNeeded();
      }
    }
  }

  private ingestSnapshot(message: TpLinkSnapshotMessage): void {
    const timestamp = Number.isFinite(Date.parse(message.timestamp)) ? new Date(message.timestamp).toISOString() : new Date().toISOString();
    const hubModel = nonEmptyString(message.hubModel)?.toUpperCase() ?? "";
    const sourceType = message.sourceType ?? "hub";
    const sourceModel = hubModel.slice(0, 128);
    const sourceAlias = nonEmptyString(message.sourceAlias)?.slice(0, 512) ?? null;
    const supportedHub = isTpLinkHubModel(hubModel);
    const sourceDeviceId = nonEmptyString(message.sourceDeviceId);
    const sourceError = this.snapshotSourceError(message, supportedHub, sourceType, sourceDeviceId);
    if (sourceError) {
      this.#status.value.tpLink.connected = false;
      this.#status.value.tpLink.error = sourceError;
      this.publishStatusIfNeeded();
      this.notifyAvailabilityChangeIfNeeded();
      return;
    }
    this.learnSnapshotSource({ sourceDeviceId, sourceType, sourceModel, sourceAlias });

    this.#attempt = 0;
    this.#status.value.tpLink.connected = true;
    this.#status.value.tpLink.lastPollAt = timestamp;
    this.#status.value.tpLink.hubModel = supportedHub ? hubModel : null;
    this.#status.value.tpLink.sourceType = sourceType;
    this.#status.value.tpLink.sourceModel = sourceModel;
    this.#status.value.tpLink.sourceAlias = sourceAlias;
    const devices = this.cacheSnapshotDevices(message.devices, timestamp);
    const mappings = this.resolvedMappings();
    const issues: string[] = [];
    const clock: SnapshotClock = { timestamp, timestampMs: Date.parse(timestamp) };

    for (const target of this.configuredOpeningTargets()) {
      const issue = this.ingestSnapshotOpeningState(target, devices.get(target.deviceId), clock);
      if (issue) issues.push(issue);
    }
    for (const [deviceId, sensorId] of mappings) {
      this.ingestMappedSnapshotDevice(deviceId, sensorId, devices.get(deviceId), clock, issues);
    }

    const helperWarning = nonEmptyString(message.warning)?.slice(0, 500) ?? null;
    this.#status.value.tpLink.error = [helperWarning, this.#mappingWarning, ...issues].filter(Boolean).join("; ") || null;
    this.publishStatusIfNeeded();
    this.notifyAvailabilityChangeIfNeeded();
    const contactEventsEnabled = this.#contactEventsEnabled;
    if (contactEventsEnabled !== null
      && contactEventsEnabled !== (this.configuredOpeningTargets().length > 0)) this.restart();
  }

  private publishStatusIfNeeded(nowMs = Date.now()): void {
    const status = this.#status.value.tpLink;
    const signature = JSON.stringify([
      status.configured,
      status.connected,
      status.mappedDevices,
      status.discoveredDevices,
      status.hubModel,
      status.host ?? null,
      status.sourceType ?? null,
      status.sourceModel ?? null,
      status.sourceAlias ?? null,
      status.error,
    ]);
    if (signature === this.#lastStatusSignature
      && nowMs - this.#lastStatusPublishedAt < STATUS_UNCHANGED_HEARTBEAT_MS) {
      this.#status.synchronized?.();
      return;
    }
    this.#lastStatusSignature = signature;
    this.#lastStatusPublishedAt = nowMs;
    this.#status.changed();
  }

  private notifyAvailabilityChangeIfNeeded(now = new Date()): void {
    const signature = JSON.stringify(this.availability(now)
      .map(({ sensorId, metric, source, available }) => JSON.stringify([sensorId, metric, source, available]))
      .sort(compareCodeUnits));
    if (signature === this.#lastAvailabilitySignature) return;
    this.#lastAvailabilitySignature = signature;
    this.#managedConnection?.onAvailabilityChange?.();
  }

  availability(now = new Date()): SensorMetricAvailability[] {
    const observedAt = now.toISOString();
    const lastPollMs = this.#status.value.tpLink.lastPollAt ? Date.parse(this.#status.value.tpLink.lastPollAt) : Number.NaN;
    const connectionFresh = this.#status.value.tpLink.connected && Number.isFinite(lastPollMs)
      && now.getTime() - lastPollMs <= Math.max(60_000, this.#config.tpLinkPollIntervalMs * 3);
    const availability: SensorMetricAvailability[] = [];
    for (const [deviceId, sensorId] of this.resolvedMappings()) {
      availability.push(...this.mappedSensorAvailability(deviceId, sensorId, connectionFresh, observedAt));
    }
    return availability;
  }

  private ingestElectricityMeasurement(deviceId: string, sensorId: string, metric: "power" | "energy", value: number, canonicalUnit: "W" | "kWh", timestamp: string, timestampMs: number, issues: string[]): void {
    const key = `${deviceId}\u0000${metric}`;
    const previous = this.#lastIngestedMeasurements.get(key);
    const unchanged = previous?.sensorId === sensorId && previous.value === value;
    if (unchanged && timestampMs - previous.ingestedAt < STATE_UNCHANGED_HEARTBEAT_MS) return;
    if (this.isRecentHomeAssistantEquivalent(sensorId, metric, value, timestampMs)) {
      this.#lastIngestedMeasurements.set(key, { sensorId, value, ingestedAt: timestampMs });
      return;
    }
    try {
      this.#measurements.ingest({
        sensorId,
        metric,
        value,
        canonicalUnit,
        timestamp,
        source: "tp-link",
        quality: "good",
      });
      this.#lastIngestedMeasurements.set(key, { sensorId, value, ingestedAt: timestampMs });
    } catch (error) {
      const reason = error instanceof Error ? error.message : "ingestion failed";
      issues.push(`Could not ingest TP-Link ${metric} from ${deviceId}: ${reason}`);
    }
  }

  private isRecentHomeAssistantEquivalent(sensorId: string, metric: string, value: number, timestampMs: number): boolean {
    const latest = this.#database.getLatestMeasurementSample(sensorId, metric);
    if (!latest || latest.source !== "home-assistant" || latest.value !== value) return false;
    const latestMs = Date.parse(latest.timestamp);
    const handoverWindowMs = Math.max(
      REDUNDANT_SOURCE_HANDOVER_MIN_MS,
      Math.min(CLIMATE_UNCHANGED_HEARTBEAT_MS, this.#config.tpLinkPollIntervalMs * 3),
    );
    return Number.isFinite(latestMs) && Math.abs(timestampMs - latestMs) <= handoverWindowMs;
  }

  private scheduleRestart(): void {
    if (!this.#running || this.#restartTimer) return;
    const delay = Math.min(60_000, 1_000 * 2 ** this.#attempt);
    this.#attempt = Math.min(this.#attempt + 1, 6);
    this.#restartTimer = setTimeout(() => {
      this.#restartTimer = null;
      this.spawnHelper();
    }, delay);
    this.#restartTimer.unref();
  }
}
