import { spawn, type ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { networkInterfaces } from "node:os";
import { createInterface } from "node:readline";
import type { Reading, TpLinkDiscoveredDevice } from "@climate-twin/contracts";
import type { AppConfig } from "./config.js";
import type { ClimateDatabase } from "./db.js";
import type {
  SensorGapRecoveryAdapter,
  SensorHistoryRecoveryResult,
  SensorMetricAvailability,
} from "./sensor-gap-recovery.js";
import { MeasurementService, RuntimeStatus, TelemetryService } from "./services.js";

const TP_LINK_LOCAL_CLIMATE_HISTORY_CAPABILITY_REVISION = "t310-t315-retained-history-v1";

export interface TpLinkDeviceMapping {
  deviceId: string;
  sensorId: string;
}

interface TpLinkSnapshotDevice {
  deviceId: string;
  model: string;
  alias: string | null;
  status: string | null;
  temperature: number | null;
  temperatureUnit: string | null;
  humidity: number | null;
  battery: number | null;
  contactOpen?: boolean | null;
  power?: number | null;
  energy?: number | null;
}

interface TpLinkSnapshotMessage {
  type: "snapshot";
  timestamp: string;
  hubModel: string;
  sourceType?: "hub" | "energy-device";
  sourceDeviceId?: string | null;
  devices: TpLinkSnapshotDevice[];
}

interface TpLinkErrorMessage {
  type: "error";
  message: string;
  requestId?: string;
}

interface TpLinkHostChangeMessage {
  type: "host-change";
  previousHost: string;
  host: string;
  sourceDeviceId?: string | null;
}

type TpLinkHelperMessage = TpLinkSnapshotMessage | TpLinkErrorMessage | TpLinkHostChangeMessage | TpLinkHistoryResultMessage;

interface TpLinkHistorySample {
  deviceId: string;
  metric: string;
  value: number;
  canonicalUnit: string;
  timestamp: string;
  quality: "good" | "estimated" | "stale";
}

interface TpLinkHistoryResultMessage {
  type: "history-result";
  requestId?: string;
  deviceId: string;
  metric: string;
  state: SensorHistoryRecoveryResult["state"];
  samples: TpLinkHistorySample[];
  error: string | null;
}

interface PendingTpLinkHistoryRequest {
  child: ChildProcess;
  requestId: string;
  deviceId: string;
  sensorId: string;
  metric: string;
  fromMs: number;
  toMs: number;
  canonicalUnit: string;
  timer: NodeJS.Timeout;
  resolve: (result: SensorHistoryRecoveryResult) => void;
  reject: (error: Error) => void;
}

export interface TpLinkConnectionUpdate {
  id: string;
  houseId: string;
  previousHost: string;
  host: string;
  deviceId?: string;
}

export interface TpLinkBridgeOptions {
  onConnectionUpdate?: (update: TpLinkConnectionUpdate) => void;
  onAvailabilityChange?: () => void;
  historyFallback?: {
    recoverHistory(sensorId: string, metric: string, from: string, to: string): Promise<SensorHistoryRecoveryResult>;
    consumeRecovered?(sensorId: string, metric: string, from: string, to: string): void | Promise<void>;
  };
}

/** Merge a best-effort fallback without replacing higher-confidence local rows. */
export function mergeTpLinkHistoryRecovery(
  local: SensorHistoryRecoveryResult,
  fallback: SensorHistoryRecoveryResult,
): SensorHistoryRecoveryResult {
  const samples = new Map(fallback.samples
    .map((sample) => [`${sample.metric}\u0000${sample.timestamp}`, sample] as const));
  for (const sample of local.samples) samples.set(`${sample.metric}\u0000${sample.timestamp}`, sample);
  const state = fallback.state === "complete"
    ? "complete"
    : local.state === "partial" || fallback.state === "partial" || samples.size > 0
      ? "partial"
      : "not-supported";
  return {
    state,
    samples: [...samples.values()].sort((left, right) => left.timestamp.localeCompare(right.timestamp)),
    error: [local.error, fallback.error].filter(Boolean).join("; ") || null,
  };
}

export interface TpLinkDiscoveredSource {
  host: string;
  model: string;
  alias: string | null;
  sourceType: "hub" | "energy-device";
}

export interface TpLinkSourceDiscoveryResult {
  sources: TpLinkDiscoveredSource[];
  warnings: string[];
}

export interface TpLinkCredentialTestResult {
  ok: boolean;
  connected: boolean;
  message: string;
  details?: Record<string, unknown>;
}

function ipv4Octets(value: string): number[] | null {
  const parts = value.split(".");
  if (parts.length !== 4 || parts.some((part) => !/^\d{1,3}$/.test(part))) return null;
  const octets = parts.map(Number);
  return octets.every((octet) => octet >= 0 && octet <= 255) ? octets : null;
}

export function ipv4BroadcastAddress(address: string, netmask: string): string | null {
  const addressOctets = ipv4Octets(address);
  const maskOctets = ipv4Octets(netmask);
  if (!addressOctets || !maskOctets) return null;
  return addressOctets.map((octet, index) => octet | ((~maskOctets[index]!) & 255)).join(".");
}

function tpLinkDiscoveryTargets(): string[] {
  const targets = new Set<string>();
  for (const entries of Object.values(networkInterfaces())) {
    for (const entry of entries ?? []) {
      if (entry.family !== "IPv4" || entry.internal) continue;
      const broadcast = ipv4BroadcastAddress(entry.address, entry.netmask);
      if (broadcast && broadcast !== entry.address) targets.add(broadcast);
    }
  }
  return [...targets].sort((left, right) => left.localeCompare(right));
}

interface LastIngestedDevice {
  sensorId: string;
  temperature: number;
  humidity: number;
  battery: number | null;
  ingestedAt: number;
}

interface LastIngestedMeasurement {
  sensorId: string;
  value: number;
  ingestedAt: number;
}

interface TapoOpeningTarget {
  houseId: string;
  floorId: string;
  elementId: string;
  deviceId: string;
  connectionId: string;
}

interface LastIngestedOpeningState {
  state: "open" | "closed";
  ingestedAt: number;
}

type CachedTpLinkDevice = Omit<TpLinkDiscoveredDevice, "mappedSensorId">;

const CLIMATE_UNCHANGED_HEARTBEAT_MS = 60_000;
const STATE_UNCHANGED_HEARTBEAT_MS = 5 * 60_000;

function nonEmptyString(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function finiteNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function safeTpLinkHistoryFailure(value: unknown): string | null {
  const message = nonEmptyString(value);
  if (!message) return null;
  if (/unable to decrypt response|invalid padding bytes/iu.test(message)) {
    return "TP-Link encrypted session was replaced during the local history request";
  }
  if (/status 500 after handshake|another session is created/iu.test(message)) {
    return "TP-Link hub rejected an overlapping encrypted session";
  }
  // Protocol failures can include the full encrypted response. It is neither
  // useful to an operator nor appropriate to persist in the gap ledger.
  return message.replace(/,\s*response:\s*.*$/isu, "").trim().slice(0, 500);
}

export function loadTpLinkDeviceMappings(path: string): TpLinkDeviceMapping[] {
  const parsed = JSON.parse(readFileSync(path, "utf8")) as { devices?: unknown };
  return validateTpLinkDeviceMappings(parsed.devices);
}

function validateTpLinkDeviceMappings(value: unknown): TpLinkDeviceMapping[] {
  if (!Array.isArray(value)) throw new Error("TP-Link device map must contain a devices array");
  const deviceIds = new Set<string>();
  const sensorIds = new Set<string>();
  return value.map((candidate, index) => {
    if (!candidate || typeof candidate !== "object") throw new Error(`Invalid TP-Link device mapping at index ${index}`);
    const entry = candidate as Record<string, unknown>;
    const deviceId = nonEmptyString(entry.deviceId);
    const sensorId = nonEmptyString(entry.sensorId);
    if (!deviceId || !sensorId) throw new Error(`TP-Link device mapping at index ${index} requires deviceId and sensorId`);
    if (deviceIds.has(deviceId)) throw new Error(`TP-Link child device ${deviceId} is mapped more than once`);
    if (sensorIds.has(sensorId)) throw new Error(`Stuga sensor ${sensorId} is mapped to more than one TP-Link child device`);
    deviceIds.add(deviceId);
    sensorIds.add(sensorId);
    return { deviceId, sensorId };
  }).sort((left, right) => left.deviceId < right.deviceId ? -1 : left.deviceId > right.deviceId ? 1
    : left.sensorId < right.sensorId ? -1 : left.sensorId > right.sensorId ? 1 : 0);
}

function importTpLinkMappingFile(database: ClimateDatabase, path: string): TpLinkDeviceMapping[] {
  const mappings = loadTpLinkDeviceMappings(path);
  database.saveIntegrationMappingSet("tp-link", mappings);
  return mappings;
}

export function normalizeTpLinkTemperature(value: number, unit: string | null): number | null {
  if (!Number.isFinite(value)) return null;
  const normalized = unit?.trim().toLowerCase();
  if (normalized === "celsius" || normalized === "c" || normalized === "°c") return value;
  if (normalized === "fahrenheit" || normalized === "f" || normalized === "°f") return (value - 32) * 5 / 9;
  return null;
}

interface TpLinkStatusHost {
  value: RuntimeStatus["value"];
  changed(): void;
}

class TpLinkConnectionBridge {
  #child: ChildProcess | null = null;
  #restartTimer: NodeJS.Timeout | null = null;
  #historyQueue: Promise<void> = Promise.resolve();
  #running = false;
  #attempt = 0;
  #stderr = "";
  #mappingWarning: string | null = null;
  readonly #legacyMappings = new Map<string, string>();
  readonly #discovered = new Map<string, CachedTpLinkDevice>();
  readonly #currentDevices = new Map<string, CachedTpLinkDevice>();
  readonly #lastIngested = new Map<string, LastIngestedDevice>();
  readonly #lastIngestedMeasurements = new Map<string, LastIngestedMeasurement>();
  readonly #lastIngestedOpeningStates = new Map<string, LastIngestedOpeningState>();
  readonly #pendingHistory = new Map<string, PendingTpLinkHistoryRequest>();

  constructor(
    private readonly config: AppConfig,
    private readonly telemetry: TelemetryService,
    private readonly measurements: MeasurementService,
    private readonly database: ClimateDatabase,
    private readonly status: TpLinkStatusHost,
    private readonly connection?: { id: string; houseId: string; acceptUnscoped: boolean },
    private readonly managedConnection?: {
      id: string;
      houseId: string;
      host: string;
      deviceId?: string;
      onUpdate?: (update: TpLinkConnectionUpdate) => void;
      onAvailabilityChange?: () => void;
    },
  ) {}

  start(): void {
    if (this.#running) return;
    this.#running = true;
    if (!this.status.value.tpLink.configured) return;
    try {
      if (this.connection === undefined) {
        const path = this.config.tpLinkDeviceMapFile;
        const fromFile = Boolean(path && existsSync(path));
        const stored = fromFile ? null : this.database.getIntegrationMappingSet<unknown>("tp-link");
        const legacyMappings = fromFile
          ? importTpLinkMappingFile(this.database, path!)
          : stored ? validateTpLinkDeviceMappings(stored.mappings) : [];
        const missingSensorIds = [...new Set(legacyMappings
          .filter((mapping) => !this.database.getSensor(mapping.sensorId))
          .map((mapping) => mapping.sensorId))].sort();
        this.#mappingWarning = missingSensorIds.length > 0
          ? `Ignored TP-Link mappings for unknown sensors: ${missingSensorIds.join(", ")}`
          : null;
        for (const mapping of legacyMappings) {
          this.#legacyMappings.set(mapping.deviceId, mapping.sensorId);
        }
      }
      this.status.value.tpLink.mappedDevices = new Set([...this.resolvedMappings().keys(), ...this.configuredOpeningTargets().map((target) => target.deviceId)]).size;
      this.status.value.tpLink.error = this.#mappingWarning;
      this.status.changed();
      this.spawnHelper();
    } catch (error) {
      this.status.value.tpLink.error = error instanceof Error ? error.message : "Could not load TP-Link device mappings";
      this.status.changed();
    }
  }

  listDiscoveredDevices(): TpLinkDiscoveredDevice[] {
    const mappings = this.resolvedMappings();
    return [...this.#discovered.values()]
      .map((device) => ({
        ...device,
        ...(this.connection ? { connectionId: this.connection.id, houseId: this.connection.houseId } : {}),
        mappedSensorId: mappings.get(device.deviceId) ?? null,
      }))
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

  private async recoverHistoryIsolated(
    sensorId: string,
    metric: string,
    from: string,
    to: string,
  ): Promise<SensorHistoryRecoveryResult> {
    const mapping = [...this.resolvedMappings()].find(([, mappedSensorId]) => mappedSensorId === sensorId);
    if (!mapping || !this.config.tpLinkHost || !this.config.tpLinkUsername || !this.config.tpLinkPassword) {
      return {
        state: "not-supported", samples: [], error: "The sensor has no active local TP-Link history binding",
      };
    }
    const definition = this.database.getMeasurementDefinition(metric);
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

  private runLiveHistoryRequest(
    child: ChildProcess,
    requestId: string,
    deviceId: string,
    sensorId: string,
    metric: string,
    fromMs: number,
    toMs: number,
    canonicalUnit: string,
  ): Promise<SensorHistoryRecoveryResult> {
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
      try {
        child.stdin!.write(line, (error) => {
          if (error) this.settlePendingHistory(pending, new Error(`Could not send TP-Link history request: ${error.message}`));
        });
      } catch (error) {
        this.settlePendingHistory(pending, error instanceof Error ? error : new Error("Could not send TP-Link history request"));
      }
    });
  }

  private settlePendingHistory(
    pending: PendingTpLinkHistoryRequest,
    result: SensorHistoryRecoveryResult | Error,
  ): void {
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

  private runHistoryHelper(
    requestId: string,
    deviceId: string,
    sensorId: string,
    metric: string,
    fromMs: number,
    toMs: number,
    canonicalUnit: string,
  ): Promise<SensorHistoryRecoveryResult> {
    return new Promise((resolve, reject) => {
      const child = spawn(this.config.tpLinkPython, [this.config.tpLinkBridgeScript, "--history"], {
        env: {
          ...process.env,
          TP_LINK_HOST: this.config.tpLinkHost!,
          TP_LINK_USERNAME: this.config.tpLinkUsername!,
          TP_LINK_PASSWORD: this.config.tpLinkPassword!,
          ...(this.managedConnection?.deviceId ? { TP_LINK_DEVICE_ID: this.managedConnection.deviceId } : {}),
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

  private validateHistoryResult(
    message: TpLinkHistoryResultMessage,
    requestId: string,
    deviceId: string,
    sensorId: string,
    metric: string,
    fromMs: number,
    toMs: number,
    canonicalUnit: string,
  ): SensorHistoryRecoveryResult {
    if (message.requestId !== requestId || nonEmptyString(message.deviceId)?.toUpperCase() !== deviceId.toUpperCase()
      || message.metric !== metric || !["complete", "partial", "not-supported"].includes(message.state)
      || !Array.isArray(message.samples) || message.samples.length > 100_000) {
      throw new Error("TP-Link history helper returned a mismatched response identity");
    }
    const definition = this.database.getMeasurementDefinition(metric);
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
    for (const sensor of this.database.listSensors(this.connection?.houseId)) {
      if (!sensor.tpLinkDeviceId) continue;
      if (this.connection && sensor.tpLinkConnectionId !== this.connection.id
        && !(this.connection.acceptUnscoped && sensor.tpLinkConnectionId === undefined)) continue;
      mappings.set(sensor.tpLinkDeviceId, sensor.id);
      mappedSensors.add(sensor.id);
    }
    const missingSensorIds = [...new Set([...this.#legacyMappings.values()]
      .filter((sensorId) => !this.database.getSensor(sensorId)))].sort();
    this.#mappingWarning = missingSensorIds.length > 0
      ? `Ignored TP-Link mappings for unknown sensors: ${missingSensorIds.join(", ")}`
      : null;
    for (const [deviceId, sensorId] of this.#legacyMappings) {
      if (!this.database.getSensor(sensorId)) continue;
      if (mappings.has(deviceId) || mappedSensors.has(sensorId)) continue;
      mappings.set(deviceId, sensorId);
      mappedSensors.add(sensorId);
    }
    this.status.value.tpLink.mappedDevices = new Set([...mappings.keys(), ...this.configuredOpeningTargets().map((target) => target.deviceId)]).size;
    return mappings;
  }

  private configuredOpeningTargets(): TapoOpeningTarget[] {
    const houseId = this.connection?.houseId ?? this.database.listHouses()[0]?.id;
    const house = houseId ? this.database.getHouse(houseId) : null;
    if (!house) return [];
    const connectionId = this.connection?.id ?? "legacy";
    return house.floors.flatMap((floor) => (floor.planElements ?? []).flatMap((element) => {
      if ((element.kind !== "door" && element.kind !== "window" && element.kind !== "vent") || element.stateBinding?.provider !== "tapo") return [];
      if (element.stateBinding.connectionId && element.stateBinding.connectionId !== connectionId) return [];
      if (!element.stateBinding.connectionId && this.connection && !this.connection.acceptUnscoped) return [];
      return [{ houseId: house.id, floorId: floor.id, elementId: element.id,
        deviceId: element.stateBinding.externalId, connectionId }];
    }));
  }

  stop(): void {
    this.#running = false;
    if (this.#restartTimer) clearTimeout(this.#restartTimer);
    this.#restartTimer = null;
    const child = this.#child;
    this.#child = null;
    child?.kill();
    this.status.value.tpLink.connected = false;
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
    this.#mappingWarning = null;
    this.status.value.tpLink.discoveredDevices = 0;
    this.status.value.tpLink.mappedDevices = 0;
    this.status.value.tpLink.hubModel = null;
    this.status.value.tpLink.error = null;
    this.start();
  }

  discoverSources(
    timeoutMs = 35_000,
    preferredConnection?: { username: string; password: string },
  ): Promise<TpLinkSourceDiscoveryResult> {
    return new Promise((resolve, reject) => {
      const configuredTargets = process.env.TP_LINK_DISCOVERY_TARGETS?.trim();
      const discoveryTargets = configuredTargets || tpLinkDiscoveryTargets().join(",");
      const savedConnection = this.config.tpLinkConnections?.[0];
      const recoveryHosts = (this.config.tpLinkConnections ?? []).map((connection) => connection.host)
        .concat(this.config.tpLinkHost ?? []).filter(Boolean).join(",");
      const username = preferredConnection?.username ?? this.config.tpLinkUsername ?? savedConnection?.username;
      const password = preferredConnection?.password ?? this.config.tpLinkPassword ?? savedConnection?.password;
      const child = spawn(this.config.tpLinkPython, [this.config.tpLinkBridgeScript, "--discover"], {
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
            : model === "H100" || model === "H200" ? "hub" : null;
          if (!host || !model || !sourceType) return [];
          if (sourceType === "hub" && model !== "H100" && model !== "H200") return [];
          return [{ host, model, alias: nonEmptyString(item.alias), sourceType }];
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
  testCredentials(
    host: string,
    username: string,
    password: string,
    timeoutMs = 15_000,
  ): Promise<TpLinkCredentialTestResult> {
    return new Promise((resolveTest) => {
      const child = spawn(this.config.tpLinkPython, [this.config.tpLinkBridgeScript, "--list"], {
        env: {
          ...process.env,
          TP_LINK_HOST: host,
          TP_LINK_USERNAME: username,
          TP_LINK_PASSWORD: password,
          TP_LINK_POLL_INTERVAL_MS: String(this.config.tpLinkPollIntervalMs),
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
          finish({
            ok: true,
            connected: true,
            message: "TP-Link credentials and local device polling are available.",
            details: {
              model: nonEmptyString(snapshot.hubModel),
              deviceCount: snapshot.devices.length,
              sourceDeviceId: nonEmptyString(snapshot.sourceDeviceId),
              deviceIds: [...new Set(deviceIds)].slice(0, 2_048),
            },
          });
          return;
        }
        finish({ ok: false, connected: false, message: "TP-Link rejected the draft connection or credentials." });
      });
    });
  }

  private spawnHelper(): void {
    if (!this.#running || this.#child || !this.config.tpLinkHost || !this.config.tpLinkUsername || !this.config.tpLinkPassword) return;
    this.#stderr = "";
    const child = spawn(this.config.tpLinkPython, [this.config.tpLinkBridgeScript], {
      env: {
        ...process.env,
        TP_LINK_HOST: this.config.tpLinkHost,
        TP_LINK_USERNAME: this.config.tpLinkUsername,
        TP_LINK_PASSWORD: this.config.tpLinkPassword,
        TP_LINK_POLL_INTERVAL_MS: String(this.config.tpLinkPollIntervalMs),
        ...(this.managedConnection?.deviceId ? { TP_LINK_DEVICE_ID: this.managedConnection.deviceId } : {}),
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
    child.once("error", (error) => {
      this.failPendingHistory(child, `TP-Link helper failed: ${error.message}`);
      if (this.#child !== child) return;
      this.status.value.tpLink.connected = false;
      this.status.value.tpLink.error = `Could not start TP-Link helper: ${error.message}`;
      this.status.changed();
      this.managedConnection?.onAvailabilityChange?.();
    });
    child.once("close", (code) => {
      lines?.close();
      this.failPendingHistory(child, `TP-Link helper stopped with exit code ${code ?? "unknown"}`);
      if (this.#child !== child) return;
      this.#child = null;
      this.status.value.tpLink.connected = false;
      const stderr = this.#stderr.trim().split(/\r?\n/).at(-1);
      this.status.value.tpLink.error = stderr || `TP-Link helper stopped${code === null ? "" : ` with exit code ${code}`}`;
      this.status.changed();
      this.managedConnection?.onAvailabilityChange?.();
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
      this.status.value.tpLink.error = "TP-Link helper returned malformed data";
      this.status.changed();
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
      this.status.value.tpLink.connected = false;
      this.status.value.tpLink.error = nonEmptyString(message.message) ?? "TP-Link connection failed";
      this.status.changed();
      this.managedConnection?.onAvailabilityChange?.();
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
    if (message.type !== "snapshot" || !Array.isArray(message.devices)) return;
    this.ingestSnapshot(message);
  }

  private handleHostChange(message: TpLinkHostChangeMessage): void {
    const previousHost = nonEmptyString(message.previousHost);
    const host = nonEmptyString(message.host);
    if (!previousHost || !host || !ipv4Octets(host) || previousHost !== this.config.tpLinkHost) return;
    const reportedDeviceId = nonEmptyString(message.sourceDeviceId);
    const knownDeviceId = this.managedConnection?.deviceId;
    if (knownDeviceId && (!reportedDeviceId
      || knownDeviceId.trim().toUpperCase() !== reportedDeviceId.trim().toUpperCase())) {
      this.status.value.tpLink.connected = false;
      this.status.value.tpLink.error = "TP-Link address recovery reported a different source identity; the saved connection was not changed";
      this.status.changed();
      this.managedConnection?.onAvailabilityChange?.();
      return;
    }
    if (reportedDeviceId && reportedDeviceId.length > 1_024) {
      this.status.value.tpLink.connected = false;
      this.status.value.tpLink.error = "TP-Link address recovery returned an invalid source identity";
      this.status.changed();
      this.managedConnection?.onAvailabilityChange?.();
      return;
    }
    const deviceId = reportedDeviceId ?? knownDeviceId;
    this.config.tpLinkHost = host;
    if (this.managedConnection) {
      this.managedConnection.host = host;
      if (deviceId) this.managedConnection.deviceId = deviceId;
      this.managedConnection.onUpdate?.({
        id: this.managedConnection.id,
        houseId: this.managedConnection.houseId,
        previousHost,
        host,
        ...(deviceId ? { deviceId } : {}),
      });
    }
    this.status.value.tpLink.error = `TP-Link source moved from ${previousHost} to ${host}; connection recovery is in progress`;
    this.status.changed();
  }

  private ingestSnapshot(message: TpLinkSnapshotMessage): void {
    const timestamp = Number.isFinite(Date.parse(message.timestamp)) ? new Date(message.timestamp).toISOString() : new Date().toISOString();
    const hubModel = nonEmptyString(message.hubModel)?.toUpperCase() ?? "";
    const sourceType = message.sourceType ?? "hub";
    const supportedHub = hubModel === "H100" || hubModel === "H200";
    if (!supportedHub && sourceType !== "energy-device") {
      this.status.value.tpLink.connected = false;
      this.status.value.tpLink.error = `Unsupported TP-Link source model ${message.hubModel || "unknown"}`;
      this.status.changed();
      return;
    }

    const sourceDeviceId = nonEmptyString(message.sourceDeviceId);
    if (sourceDeviceId && sourceDeviceId.length > 1_024) {
      this.status.value.tpLink.connected = false;
      this.status.value.tpLink.error = "TP-Link helper returned an invalid source identity";
      this.status.changed();
      this.managedConnection?.onAvailabilityChange?.();
      return;
    }
    if (this.managedConnection?.deviceId && (!sourceDeviceId
      || this.managedConnection.deviceId.trim().toUpperCase() !== sourceDeviceId.trim().toUpperCase())) {
      this.status.value.tpLink.connected = false;
      this.status.value.tpLink.error = "TP-Link helper returned a missing or different source identity at the saved address; polling was stopped to protect device bindings";
      this.status.changed();
      this.managedConnection.onAvailabilityChange?.();
      return;
    }
    if (sourceDeviceId && this.managedConnection && !this.managedConnection.deviceId) {
      const previousHost = this.managedConnection.host;
      this.managedConnection.deviceId = sourceDeviceId;
      this.managedConnection.onUpdate?.({
        id: this.managedConnection.id,
        houseId: this.managedConnection.houseId,
        previousHost,
        host: previousHost,
        deviceId: sourceDeviceId,
      });
    }

    this.#attempt = 0;
    this.status.value.tpLink.connected = true;
    this.status.value.tpLink.lastPollAt = timestamp;
    this.status.value.tpLink.hubModel = supportedHub ? hubModel : null;
    const devices = new Map<string, CachedTpLinkDevice>();
    for (const rawDevice of message.devices) {
      const deviceId = nonEmptyString(rawDevice?.deviceId);
      if (!deviceId) continue;
      const rawTemperature = finiteNumber(rawDevice.temperature);
      const device: CachedTpLinkDevice = {
        deviceId,
        model: nonEmptyString(rawDevice.model) ?? "Unknown",
        alias: nonEmptyString(rawDevice.alias),
        status: nonEmptyString(rawDevice.status),
        temperature: rawTemperature === null ? null : normalizeTpLinkTemperature(rawTemperature, nonEmptyString(rawDevice.temperatureUnit)),
        humidity: finiteNumber(rawDevice.humidity),
        battery: finiteNumber(rawDevice.battery),
        contactOpen: typeof rawDevice.contactOpen === "boolean" ? rawDevice.contactOpen : null,
        power: finiteNumber(rawDevice.power),
        energy: finiteNumber(rawDevice.energy),
        lastSeenAt: timestamp,
      };
      devices.set(deviceId, device);
      this.#discovered.set(deviceId, device);
    }
    this.#currentDevices.clear();
    for (const [deviceId, device] of devices) this.#currentDevices.set(deviceId, device);
    this.status.value.tpLink.discoveredDevices = this.#discovered.size;
    const mappings = this.resolvedMappings();
    const issues: string[] = [];
    const timestampMs = Date.parse(timestamp);

    for (const target of this.configuredOpeningTargets()) {
      const device = devices.get(target.deviceId);
      if (!device) {
        issues.push(`Mapped Tapo contact ${target.deviceId} was not found`);
        continue;
      }
      if (device.status && device.status.toLowerCase() !== "online") continue;
      if (typeof device.contactOpen !== "boolean") {
        issues.push(`Mapped Tapo contact ${target.deviceId} does not expose contact state`);
        continue;
      }
      const state = device.contactOpen ? "open" : "closed";
      const targetKey = `${target.floorId}\u0000${target.elementId}`;
      const previous = this.#lastIngestedOpeningStates.get(targetKey);
      if (previous?.state === state && timestampMs - previous.ingestedAt < STATE_UNCHANGED_HEARTBEAT_MS) continue;
      try {
        this.database.recordOpeningStateObservation(target.houseId, {
          floorId: target.floorId,
          elementId: target.elementId,
          state,
          source: "tapo",
          observedAt: timestamp,
          externalId: target.deviceId,
          connectionId: target.connectionId,
        });
        this.#lastIngestedOpeningStates.set(targetKey, { state, ingestedAt: timestampMs });
      } catch (error) {
        const reason = error instanceof Error ? error.message : "ingestion failed";
        issues.push(`Could not ingest Tapo contact ${target.deviceId}: ${reason}`);
      }
    }

    for (const [deviceId, sensorId] of mappings) {
      const sensor = this.database.getSensor(sensorId);
      if (!sensor) {
        issues.push(`Mapped TP-Link child ${deviceId} references unknown sensor ${sensorId}`);
        continue;
      }
      // Archived sensors retain ownership of their physical child device so it
      // cannot be accidentally offered or assigned elsewhere, but do not ingest.
      if (!sensor.enabled) continue;
      const device = devices.get(deviceId);
      if (!device) {
        issues.push(`Mapped TP-Link child ${deviceId} was not found`);
        continue;
      }
      if (device.status && device.status.toLowerCase() !== "online") {
        issues.push(`Mapped TP-Link child ${deviceId} is ${device.status}`);
        continue;
      }
      const temperature = device.temperature;
      const humidity = device.humidity;
      const battery = device.battery;
      const power = device.power ?? null;
      const energy = device.energy ?? null;
      const hasClimate = temperature !== null && humidity !== null;
      const hasEnergy = power !== null || energy !== null;
      if (!hasClimate && !hasEnergy) {
        issues.push(`Mapped TP-Link device ${deviceId} does not expose valid climate or energy data`);
        continue;
      }

      if (hasClimate) {
        const previous = this.#lastIngested.get(deviceId);
        const unchanged = previous?.sensorId === sensorId && previous.temperature === temperature
          && previous.humidity === humidity && previous.battery === battery;
        if (!unchanged || timestampMs - previous.ingestedAt >= CLIMATE_UNCHANGED_HEARTBEAT_MS) {
          const reading: Reading = {
            sensorId,
            timestamp,
            temperature,
            humidity,
            battery,
            source: "tp-link",
            quality: "good",
          };
          try {
            this.telemetry.ingest(reading);
            this.#lastIngested.set(deviceId, { sensorId, temperature, humidity, battery, ingestedAt: timestampMs });
          } catch (error) {
            const reason = error instanceof Error ? error.message : "ingestion failed";
            issues.push(`Could not ingest TP-Link climate device ${deviceId}: ${reason}`);
          }
        }
      }
      if (power !== null) this.ingestElectricityMeasurement(deviceId, sensorId, "power", power, "W", timestamp, timestampMs, issues);
      if (energy !== null) this.ingestElectricityMeasurement(deviceId, sensorId, "energy", energy, "kWh", timestamp, timestampMs, issues);
    }

    this.status.value.tpLink.error = [this.#mappingWarning, ...issues].filter(Boolean).join("; ") || null;
    this.status.changed();
    this.managedConnection?.onAvailabilityChange?.();
  }

  availability(now = new Date()): SensorMetricAvailability[] {
    const observedAt = now.toISOString();
    const lastPollMs = this.status.value.tpLink.lastPollAt ? Date.parse(this.status.value.tpLink.lastPollAt) : Number.NaN;
    const connectionFresh = this.status.value.tpLink.connected && Number.isFinite(lastPollMs)
      && now.getTime() - lastPollMs <= Math.max(60_000, this.config.tpLinkPollIntervalMs * 3);
    const availability: SensorMetricAvailability[] = [];
    for (const [deviceId, sensorId] of this.resolvedMappings()) {
      const sensor = this.database.getSensor(sensorId);
      if (!sensor?.enabled) continue;
      const device = this.#currentDevices.get(deviceId);
      const metrics = new Set(this.database.sensorSourceMetrics(sensorId, "tp-link"));
      if (device?.temperature !== null && device?.temperature !== undefined) metrics.add("temperature");
      if (device?.humidity !== null && device?.humidity !== undefined) metrics.add("humidity");
      if (device?.power !== null && device?.power !== undefined) metrics.add("power");
      if (device?.energy !== null && device?.energy !== undefined) metrics.add("energy");
      if (metrics.size === 0 && /T3(?:10|15)/i.test(sensor.model)) {
        metrics.add("temperature");
        metrics.add("humidity");
      }
      const online = connectionFresh && Boolean(device)
        && (!device?.status || device.status.toLowerCase() === "online");
      for (const metric of metrics) {
        const exposesMetric = metric === "temperature" ? device?.temperature !== null && device?.temperature !== undefined
          : metric === "humidity" ? device?.humidity !== null && device?.humidity !== undefined
            : metric === "power" ? device?.power !== null && device?.power !== undefined
              : metric === "energy" ? device?.energy !== null && device?.energy !== undefined
                : false;
        availability.push({ sensorId, metric, source: "tp-link", available: online && exposesMetric, observedAt });
      }
    }
    return availability;
  }

  private ingestElectricityMeasurement(
    deviceId: string,
    sensorId: string,
    metric: "power" | "energy",
    value: number,
    canonicalUnit: "W" | "kWh",
    timestamp: string,
    timestampMs: number,
    issues: string[],
  ): void {
    const key = `${deviceId}\u0000${metric}`;
    const previous = this.#lastIngestedMeasurements.get(key);
    const unchanged = previous?.sensorId === sensorId && previous.value === value;
    if (unchanged && timestampMs - previous.ingestedAt < STATE_UNCHANGED_HEARTBEAT_MS) return;
    try {
      this.measurements.ingest({
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
    legacyEnvironment: boolean;
  }> {
    const explicit = (this.config.tpLinkConnections ?? []).filter((connection) => this.database.getHouse(connection.houseId));
    if (explicit.length > 0) return explicit.map((connection) => ({ ...connection, legacyEnvironment: false }));
    const houseId = this.database.listHouses()[0]?.id;
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
      };
      const localStatus: TpLinkStatusHost = { value: localValue, changed: () => this.aggregateStatus() };
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
          ...(this.options.onConnectionUpdate ? { onUpdate: this.options.onConnectionUpdate } : {}),
          ...(this.options.onAvailabilityChange ? { onAvailabilityChange: this.options.onAvailabilityChange } : {}),
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
   * Stuga sensor label. Ambiguous aliases are unsafe because app CSV exports
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

  async recoverHistory(sensorId: string, metric: string, from: string, to: string): Promise<SensorHistoryRecoveryResult> {
    const sensor = this.database.getSensor(sensorId);
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
    timeoutMs = 35_000,
  ): Promise<TpLinkSourceDiscoveryResult> {
    const preferredConnection = credentials ?? (houseId
      ? this.config.tpLinkConnections?.find((connection) => connection.houseId === houseId)
      : undefined);
    return this.#tester.discoverSources(timeoutMs, preferredConnection);
  }

  testCredentials(host: string, username: string, password: string, timeoutMs = 15_000): Promise<TpLinkCredentialTestResult> {
    return this.#tester.testCredentials(host, username, password, timeoutMs);
  }

  private aggregateStatus(): void {
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
    }));
    const aggregate = this.status.value.tpLink;
    aggregate.connections = connections;
    aggregate.configured = connections.length > 0 || this.configuredConnections().length > 0;
    aggregate.connected = connections.some((connection) => connection.connected);
    aggregate.lastPollAt = connections.map((connection) => connection.lastPollAt).filter((value): value is string => Boolean(value)).sort().at(-1) ?? null;
    aggregate.mappedDevices = connections.reduce((total, connection) => total + connection.mappedDevices, 0);
    aggregate.discoveredDevices = connections.reduce((total, connection) => total + connection.discoveredDevices, 0);
    aggregate.hubModel = connections.length === 1 ? connections[0]!.hubModel : null;
    aggregate.error = connections.length > 0 && connections.every((connection) => connection.error)
      ? connections.map((connection) => connection.error).filter(Boolean).join("; ")
      : null;
    this.status.changed();
  }
}
