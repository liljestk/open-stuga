import { createHash, randomUUID } from "node:crypto";
import { spawn, type ChildProcess } from "node:child_process";
import { isIP } from "node:net";
import { createInterface } from "node:readline";
import type {
  ConnectedDeviceCapabilities,
  ConnectedDeviceColor,
  ConnectedDeviceCommand,
  ConnectedDeviceKind,
  ConnectedDeviceState,
  IntegrationStatus,
  TuyaDiscoveredDevice,
} from "@climate-twin/contracts";
import type { AppConfig } from "./config.js";
import type { ConnectedDeviceStore } from "./connected-device-store.js";
import type { ClimateDatabase } from "./db.js";
import type { TelemetryBus } from "./events.js";
import type { TuyaConnectionSecret } from "./integration-secrets.js";
import type { MeasurementService } from "./telemetry/ingest.js";
import type { RuntimeStatus } from "./runtime-status.js";

const VERSIONS = new Set(["3.1", "3.2", "3.3", "3.4", "3.5"]);
const KINDS = new Set<ConnectedDeviceKind>(["light", "outlet", "switch"]);
const STATE_UNCHANGED_HEARTBEAT_MS = 5 * 60_000;
const STATUS_UNCHANGED_HEARTBEAT_MS = 60_000;

/** True for loopback, link-local, private and CGNAT IPv4 addresses: hosts a LAN-only Tuya device may use. */
export function localIpv4(value: string): boolean {
  if (isIP(value) !== 4) return false;
  const [first, second] = value.split(".").map(Number);
  return first === 10
    || first === 100 && second! >= 64 && second! <= 127
    || first === 127
    || first === 169 && second === 254
    || first === 172 && second! >= 16 && second! <= 31
    || first === 192 && second === 168;
}

interface StatePayload {
  observedAt: string;
  available: boolean;
  power: boolean | null;
  brightnessPercent: number | null;
  colorTemperatureKelvin: number | null;
  color: ConnectedDeviceColor | null;
  workMode: string | null;
  powerWatts: number | null;
  energyKwh: number | null;
  currentAmps: number | null;
  voltageVolts: number | null;
}

export interface TuyaVerifiedDevice {
  host: string;
  profileId: string;
  kind: ConnectedDeviceKind;
  capabilities: ConnectedDeviceCapabilities;
  state: StatePayload;
}

interface Worker {
  child: ChildProcess;
  connection: TuyaConnectionSecret;
  closed: boolean;
  connected: boolean;
  failures: number;
  lastPollAt: string | null;
  error: string | null;
  restartDelayMs: number;
  pending: Map<string, {
    resolve: (state: ConnectedDeviceState) => void;
    reject: (error: Error) => void;
    timer: NodeJS.Timeout;
  }>;
}

interface TuyaBridgeOptions {
  discover?: () => Promise<TuyaDiscoveredDevice[]>;
  probe?: (input: {
    host: string;
    deviceId: string;
    localKey: string;
    protocolVersion: string;
  }) => Promise<TuyaVerifiedDevice>;
  onConnectionUpdate?: (connection: TuyaConnectionSecret) => void;
}

function text(value: unknown, maximum = 200): string | null {
  return typeof value === "string" && value.trim() && value.length <= maximum ? value.trim() : null;
}

function nullableNumber(
  value: unknown,
  minimum: number,
  maximum: number,
): number | null | undefined {
  if (value === null) return null;
  return typeof value === "number" && Number.isFinite(value) && value >= minimum && value <= maximum
    ? value
    : undefined;
}

function nullableBoolean(value: unknown): boolean | null | undefined {
  return value === null || typeof value === "boolean" ? value : undefined;
}

function capabilities(value: unknown): ConnectedDeviceCapabilities | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const item = value as Record<string, unknown>;
  if (["power", "brightness", "colorTemperature", "color", "measuredPower", "measuredEnergy"]
    .some((key) => typeof item[key] !== "boolean")) return null;
  return {
    power: item.power as boolean,
    brightness: item.brightness as boolean,
    colorTemperature: item.colorTemperature as boolean,
    color: item.color as boolean,
    measuredPower: item.measuredPower as boolean,
    measuredEnergy: item.measuredEnergy as boolean,
  };
}

function color(value: unknown): ConnectedDeviceColor | null | undefined {
  if (value === null) return null;
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const item = value as Record<string, unknown>;
  const hue = nullableNumber(item.hue, 0, 360);
  const saturation = nullableNumber(item.saturation, 0, 100);
  const brightness = nullableNumber(item.value, 0, 100);
  if (hue === undefined || hue === null || saturation === undefined || saturation === null
    || brightness === undefined || brightness === null) return undefined;
  return { hue, saturation, value: brightness };
}

function statePayload(value: unknown): StatePayload | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const item = value as Record<string, unknown>;
  const power = nullableBoolean(item.power);
  const brightnessPercent = nullableNumber(item.brightnessPercent, 0, 100);
  const colorTemperatureKelvin = nullableNumber(item.colorTemperatureKelvin, 1_000, 20_000);
  const parsedColor = color(item.color);
  const powerWatts = nullableNumber(item.powerWatts, 0, 1_000_000);
  const energyKwh = nullableNumber(item.energyKwh, 0, 1_000_000_000);
  const currentAmps = nullableNumber(item.currentAmps, 0, 100_000);
  const voltageVolts = nullableNumber(item.voltageVolts, 0, 100_000);
  const workMode = item.workMode === null ? null : text(item.workMode, 100);
  if (!text(item.observedAt, 100) || !Number.isFinite(Date.parse(String(item.observedAt)))
    || typeof item.available !== "boolean" || power === undefined || brightnessPercent === undefined
    || colorTemperatureKelvin === undefined || parsedColor === undefined || powerWatts === undefined
    || energyKwh === undefined || currentAmps === undefined || voltageVolts === undefined
    || (item.workMode !== null && workMode === null)) return null;
  return {
    observedAt: new Date(String(item.observedAt)).toISOString(),
    available: item.available,
    power,
    brightnessPercent,
    colorTemperatureKelvin,
    color: parsedColor,
    workMode,
    powerWatts,
    energyKwh,
    currentAmps,
    voltageVolts,
  };
}

function discoveredDevice(value: unknown): TuyaDiscoveredDevice | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const item = value as Record<string, unknown>;
  const host = text(item.host, 253);
  const deviceId = text(item.deviceId);
  const protocolVersion = text(item.protocolVersion, 10);
  const productKey = item.productKey === null ? null : text(item.productKey);
  const mac = item.mac === null ? null : text(item.mac, 32);
  if (!host || !localIpv4(host) || !deviceId || !protocolVersion || !VERSIONS.has(protocolVersion)
    || productKey === null && item.productKey !== null
    || mac === null && item.mac !== null) return null;
  return { host, deviceId, protocolVersion, productKey, mac };
}

function verifiedDevice(value: Record<string, unknown>): TuyaVerifiedDevice | null {
  if (value.type !== "verified") return null;
  const host = text(value.host, 253);
  const profileValue = value.profile as Record<string, unknown>;
  const profileId = text(profileValue?.id, 100);
  const kind = profileValue?.kind as ConnectedDeviceKind;
  const parsedCapabilities = capabilities(profileValue?.capabilities);
  const state = statePayload(value.state);
  if (!host || !localIpv4(host) || !profileId || !KINDS.has(kind) || !parsedCapabilities || !state) return null;
  return { host, profileId, kind, capabilities: parsedCapabilities, state };
}

function safeError(value: unknown): string {
  return text(value, 500) ?? "Tuya LAN request failed";
}

function helperEnvironment(): NodeJS.ProcessEnv {
  const environment: NodeJS.ProcessEnv = {
    PYTHONIOENCODING: "utf-8",
    PYTHONUNBUFFERED: "1",
  };
  for (const key of [
    "PATH", "Path", "PATHEXT", "SystemRoot", "SYSTEMROOT", "WINDIR",
    "TEMP", "TMP", "LANG", "LC_ALL", "TZ", "VIRTUAL_ENV",
    "LD_LIBRARY_PATH", "DYLD_LIBRARY_PATH",
  ]) {
    if (process.env[key] !== undefined) environment[key] = process.env[key];
  }
  return environment;
}

/** Supervised, local-only Tuya workers with typed projections and absolute commands. */
export class TuyaBridge {
  readonly #workers = new Map<string, Worker>();
  readonly #restartTimers = new Map<string, NodeJS.Timeout>();
  readonly #lastIngestedPower = new Map<string, { sensorId: string; value: number; ingestedAt: number }>();
  #statusTimer: NodeJS.Timeout | null = null;
  #lastStatusSignature = "";
  #lastStatusPublishedAt = Number.NEGATIVE_INFINITY;
  #running = false;

  constructor(
    private readonly config: AppConfig,
    private readonly status: RuntimeStatus,
    private readonly states: ConnectedDeviceStore,
    private readonly database: ClimateDatabase,
    private readonly measurements: MeasurementService,
    private readonly bus: TelemetryBus,
    private readonly options: TuyaBridgeOptions = {},
  ) {
    this.aggregateStatus();
  }

  static connectionId(deviceId: string): string {
    return `tuya-${createHash("sha256").update(deviceId).digest("hex").slice(0, 24)}`;
  }

  start(): void {
    if (this.#running) return;
    this.#running = true;
    const connections = this.config.tuyaConnections ?? [];
    const configuredIds = new Set(connections.map((connection) => connection.id));
    for (const connectionId of this.#lastIngestedPower.keys()) {
      if (!configuredIds.has(connectionId)) this.#lastIngestedPower.delete(connectionId);
    }
    for (const connection of connections) this.startWorker(connection);
    this.aggregateStatus();
  }

  stop(): void {
    this.#running = false;
    if (this.#statusTimer) {
      clearTimeout(this.#statusTimer);
      this.#statusTimer = null;
    }
    for (const timer of this.#restartTimers.values()) clearTimeout(timer);
    this.#restartTimers.clear();
    for (const worker of this.#workers.values()) {
      worker.closed = true;
      for (const pending of worker.pending.values()) {
        clearTimeout(pending.timer);
        pending.reject(new Error("Tuya connection stopped"));
      }
      worker.pending.clear();
      worker.child.kill();
    }
    this.#workers.clear();
    this.aggregateStatus();
  }

  refreshConfiguration(): void {
    const running = this.#running;
    this.stop();
    if (running) this.start();
  }

  async discoverSources(houseId?: string, expectedDeviceId?: string): Promise<TuyaDiscoveredDevice[]> {
    const devices = this.options.discover
      ? await this.options.discover()
      : await this.oneShot(["--discover"], undefined, 12_000, (message) => {
          if (message.type !== "discovery" || !Array.isArray(message.devices)) return null;
          return message.devices.map(discoveredDevice)
            .filter((device): device is TuyaDiscoveredDevice => Boolean(device));
        });
    const configured = new Map((this.config.tuyaConnections ?? [])
      .map((connection) => [connection.deviceId, connection]));
    return devices.flatMap((device) => {
      if (expectedDeviceId && device.deviceId !== expectedDeviceId) return [];
      const connection = configured.get(device.deviceId);
      if (!connection) return [device];
      if (houseId && connection.houseId !== houseId) return [];
      return [{ ...device, configuredConnectionId: connection.id }];
    });
  }

  verify(input: {
    host: string;
    deviceId: string;
    localKey: string;
    protocolVersion: string;
  }): Promise<TuyaVerifiedDevice> {
    if (this.options.probe) return this.options.probe(input);
    return this.oneShot(["--probe"], input, 12_000, verifiedDevice);
  }

  recordInitial(connection: TuyaConnectionSecret, payload: StatePayload): ConnectedDeviceState {
    return this.record(connection, payload);
  }

  command(connectionId: string, command: ConnectedDeviceCommand): Promise<ConnectedDeviceState> {
    const worker = this.#workers.get(connectionId);
    if (!worker || worker.closed || !worker.child.stdin?.writable) {
      return Promise.reject(new Error("The Tuya device connection is not ready"));
    }
    if (worker.pending.size >= 32) {
      return Promise.reject(new Error("The Tuya device command queue is full"));
    }
    const requestId = randomUUID();
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        worker.pending.delete(requestId);
        reject(new Error("The Tuya device did not confirm the command"));
      }, 15_000);
      timer.unref();
      worker.pending.set(requestId, { resolve, reject, timer });
      const {
        operationId: _operationId,
        ...absoluteCommand
      } = command;
      const payload = `${JSON.stringify({ type: "command", requestId, command: absoluteCommand })}\n`;
      worker.child.stdin!.write(payload, (error) => {
        if (!error) return;
        const pending = worker.pending.get(requestId);
        if (!pending) return;
        worker.pending.delete(requestId);
        clearTimeout(pending.timer);
        reject(new Error("The Tuya command could not be sent"));
      });
    });
  }

  private oneShot<T>(
    args: string[],
    input: Record<string, unknown> | undefined,
    timeoutMs: number,
    accept: (message: Record<string, unknown>) => T | null,
  ): Promise<T> {
    return new Promise((resolve, reject) => {
      const child = spawn(
        this.config.tuyaPython ?? this.config.tpLinkPython,
        [this.config.tuyaBridgeScript ?? "./apps/api/python/tuya_bridge.py", ...args],
        { stdio: ["pipe", "pipe", "ignore"], env: helperEnvironment() },
      );
      let settled = false;
      const finish = (error?: Error, result?: T): void => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        lines.close();
        child.kill();
        if (error) reject(error);
        else resolve(result as T);
      };
      const timer = setTimeout(() => finish(new Error("Tuya helper timed out")), timeoutMs);
      timer.unref();
      const lines = createInterface({ input: child.stdout! });
      lines.on("line", (line) => {
        if (settled || Buffer.byteLength(line, "utf8") > 256 * 1024) return;
        try {
          const message = JSON.parse(line) as Record<string, unknown>;
          if (message.type === "fatal") {
            finish(new Error(safeError(message.message)));
            return;
          }
          const result = accept(message);
          if (result !== null) finish(undefined, result);
        } catch {
          // Ignore malformed helper output; timeout remains authoritative.
        }
      });
      child.once("error", () => finish(new Error("Tuya helper could not be started")));
      child.once("close", () => finish(new Error("Tuya helper returned no valid response")));
      if (input) child.stdin!.end(`${JSON.stringify(input)}\n`);
      else child.stdin!.end();
    });
  }

  private startWorker(connection: TuyaConnectionSecret, restartDelayMs = 1_000): void {
    if (this.#workers.has(connection.id)) return;
    if (!this.database.getHouse(connection.houseId)) return;
    const child = spawn(
      this.config.tuyaPython ?? this.config.tpLinkPython,
      [this.config.tuyaBridgeScript ?? "./apps/api/python/tuya_bridge.py", "--worker"],
      { stdio: ["pipe", "pipe", "ignore"], env: helperEnvironment() },
    );
    const worker: Worker = {
      child,
      connection,
      closed: false,
      connected: false,
      failures: 0,
      lastPollAt: null,
      error: null,
      restartDelayMs,
      pending: new Map(),
    };
    this.#workers.set(connection.id, worker);
    createInterface({ input: child.stdout! }).on("line", (line) => this.handleLine(worker, line));
    child.once("error", () => this.workerClosed(worker, "Tuya helper could not be started"));
    child.once("close", () => this.workerClosed(worker, "Tuya connection stopped"));
    child.stdin!.write(`${JSON.stringify({
      host: connection.host,
      deviceId: connection.deviceId,
      localKey: connection.localKey,
      protocolVersion: connection.protocolVersion,
      profileId: connection.profileId,
      pollIntervalMs: this.config.tuyaPollIntervalMs ?? 5_000,
    })}\n`, (error) => {
      if (error) this.workerClosed(worker, "Tuya helper configuration failed");
    });
  }

  private handleLine(worker: Worker, line: string): void {
    if (worker.closed || this.#workers.get(worker.connection.id)?.child !== worker.child
      || Buffer.byteLength(line, "utf8") > 256 * 1024) return;
    let message: Record<string, unknown>;
    try {
      message = JSON.parse(line) as Record<string, unknown>;
    } catch {
      return;
    }
    if (message.type === "snapshot") {
      const payload = statePayload(message.state);
      const host = text(message.host, 253);
      if (!payload || !host) return;
      worker.connected = true;
      worker.failures = 0;
      worker.lastPollAt = payload.observedAt;
      worker.error = null;
      worker.restartDelayMs = 1_000;
      try {
        this.record(worker.connection, payload);
      } catch {
        worker.connected = false;
        worker.error = "Tuya state could not be stored for its configured Home";
      }
      this.scheduleAggregateStatus();
      return;
    }
    if (message.type === "command-result") {
      const requestId = text(message.requestId);
      const pending = requestId ? worker.pending.get(requestId) : undefined;
      if (!requestId || !pending) return;
      let state: ConnectedDeviceState | null = null;
      try {
        if (worker.connected) state = this.states.get(worker.connection.id);
      } catch {
        worker.connected = false;
        worker.error = "The confirmed Tuya state could not be read";
        this.scheduleAggregateStatus();
      }
      worker.pending.delete(requestId);
      clearTimeout(pending.timer);
      if (!worker.connected || !state) {
        pending.reject(new Error("The confirmed Tuya state could not be stored"));
        return;
      }
      pending.resolve(state);
      return;
    }
    if (message.type === "error") {
      const requestId = text(message.requestId);
      const pending = requestId ? worker.pending.get(requestId) : undefined;
      if (requestId && pending) {
        worker.pending.delete(requestId);
        clearTimeout(pending.timer);
        pending.reject(new Error(safeError(message.message)));
      }
      worker.failures += 1;
      if (worker.failures >= 3) {
        worker.connected = false;
        worker.error = safeError(message.message);
        try {
          const unavailable = this.states.markUnavailable(worker.connection.id);
          if (unavailable) this.bus.publish({ type: "connected-device", data: structuredClone(unavailable) });
        } catch {
          worker.error = "Tuya availability could not be stored";
        }
        this.scheduleAggregateStatus();
      }
      return;
    }
    if (message.type === "host-change") {
      const previousHost = text(message.previousHost, 253);
      const host = text(message.host, 253);
      if (!previousHost || !host || !localIpv4(host) || previousHost !== worker.connection.host) return;
      worker.connection = { ...worker.connection, host };
      try {
        this.options.onConnectionUpdate?.({ ...worker.connection });
      } catch {
        // The active worker remains useful; recovery will run again after restart.
      }
    }
  }

  private record(connection: TuyaConnectionSecret, payload: StatePayload): ConnectedDeviceState {
    const state: ConnectedDeviceState = {
      id: connection.id,
      connectionId: connection.id,
      houseId: connection.houseId,
      equipmentId: connection.equipmentId ?? null,
      provider: "tuya-local",
      kind: connection.profileId.includes("light") ? "light"
        : connection.profileId.includes("outlet") ? "outlet" : "switch",
      profileId: connection.profileId,
      name: connection.name,
      model: connection.model ?? null,
      capabilities: this.profileCapabilities(connection.profileId),
      ...this.states.placement(connection.id),
      ...payload,
      receivedAt: new Date().toISOString(),
    };
    const changed = this.states.record(state);
    if (changed) this.bus.publish({ type: "connected-device", data: structuredClone(state) });
    this.ingestEnergy(connection, state);
    return state;
  }

  private profileCapabilities(profileId: string): ConnectedDeviceCapabilities {
    const light = profileId === "tuya-light-dp20-v1";
    const metered = profileId === "tuya-outlet-dp1-meter-v1";
    return {
      power: true,
      brightness: light,
      colorTemperature: light,
      color: light,
      measuredPower: metered,
      measuredEnergy: false,
    };
  }

  private ingestEnergy(connection: TuyaConnectionSecret, state: ConnectedDeviceState): void {
    if (!connection.sensorId || !state.observedAt || state.powerWatts === null) return;
    if (!this.database.getSensor(connection.sensorId)?.enabled) {
      this.#lastIngestedPower.delete(connection.id);
      return;
    }
    const observedAt = Date.parse(state.observedAt);
    const previous = this.#lastIngestedPower.get(connection.id);
    if (previous?.sensorId === connection.sensorId && previous.value === state.powerWatts
      && observedAt >= previous.ingestedAt
      && observedAt - previous.ingestedAt < STATE_UNCHANGED_HEARTBEAT_MS) return;
    try {
      this.measurements.ingest({
        sensorId: connection.sensorId,
        metric: "power",
        value: state.powerWatts,
        canonicalUnit: "W",
        timestamp: state.observedAt,
        source: "tuya",
        quality: "good",
      });
      this.#lastIngestedPower.set(connection.id, {
        sensorId: connection.sensorId,
        value: state.powerWatts,
        ingestedAt: observedAt,
      });
    } catch {
      // Device control/state stays healthy if an optional energy projection is misconfigured.
    }
  }

  private workerClosed(worker: Worker, message: string): void {
    if (worker.closed || this.#workers.get(worker.connection.id)?.child !== worker.child) return;
    worker.closed = true;
    worker.connected = false;
    worker.error = message;
    for (const pending of worker.pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(new Error(message));
    }
    worker.pending.clear();
    try {
      const unavailable = this.states.markUnavailable(worker.connection.id);
      if (unavailable) this.bus.publish({ type: "connected-device", data: structuredClone(unavailable) });
    } catch {
      worker.error = "Tuya availability could not be stored";
    }
    this.scheduleAggregateStatus();
    const configured = (this.config.tuyaConnections ?? []).some((item) => item.id === worker.connection.id);
    if (!this.#running || !configured) {
      this.#workers.delete(worker.connection.id);
      return;
    }
    const delay = worker.restartDelayMs;
    const nextDelay = Math.min(60_000, delay * 2);
    const timer = setTimeout(() => {
      this.#restartTimers.delete(worker.connection.id);
      const latest = (this.config.tuyaConnections ?? []).find((item) => item.id === worker.connection.id);
      if (this.#workers.get(worker.connection.id)?.child === worker.child) {
        this.#workers.delete(worker.connection.id);
      }
      if (this.#running && latest) this.startWorker(latest, nextDelay);
    }, delay);
    timer.unref();
    this.#restartTimers.set(worker.connection.id, timer);
  }

  private aggregateStatus(): void {
    if (this.#statusTimer) {
      clearTimeout(this.#statusTimer);
      this.#statusTimer = null;
    }
    const configured = this.config.tuyaConnections ?? [];
    if (configured.length === 0) {
      if (this.status.value.tuya) {
        delete this.status.value.tuya;
        this.#lastStatusSignature = "";
        this.#lastStatusPublishedAt = Date.now();
        this.status.changed();
      }
      return;
    }
    const houseIds = new Set(this.database.listHouses().map((house) => house.id));
    const connections = configured.map((connection) => {
      const worker = this.#workers.get(connection.id);
      const houseExists = houseIds.has(connection.houseId);
      return {
        id: connection.id,
        houseId: connection.houseId,
        equipmentId: connection.equipmentId ?? null,
        configured: true,
        connected: houseExists && (worker?.connected ?? false),
        lastPollAt: worker?.lastPollAt ?? null,
        error: houseExists ? worker?.error ?? null : "Configured Home no longer exists",
        host: worker?.connection.host ?? connection.host,
        kind: connection.profileId.includes("light") ? "light" as const
          : connection.profileId.includes("outlet") ? "outlet" as const : "switch" as const,
        profileId: connection.profileId,
        name: connection.name,
        model: connection.model ?? null,
        capabilities: this.profileCapabilities(connection.profileId),
      };
    });
    const tuya: NonNullable<IntegrationStatus["tuya"]> = {
      configured: true,
      connected: connections.some((connection) => connection.connected),
      lastPollAt: connections.reduce<string | null>((latest, connection) => (
        connection.lastPollAt && (!latest || connection.lastPollAt > latest)
          ? connection.lastPollAt
          : latest
      ), null),
      error: connections.map((connection) => connection.error).filter(Boolean).join("; ") || null,
      connections,
    };
    this.status.value.tuya = tuya;
    const signature = JSON.stringify([
      tuya.configured,
      tuya.connected,
      tuya.error,
      tuya.connections.map(({ lastPollAt: _lastPollAt, ...connection }) => connection),
    ]);
    const now = Date.now();
    if (signature === this.#lastStatusSignature
      && now - this.#lastStatusPublishedAt < STATUS_UNCHANGED_HEARTBEAT_MS) return;
    this.#lastStatusSignature = signature;
    this.#lastStatusPublishedAt = now;
    this.status.changed();
  }

  private scheduleAggregateStatus(): void {
    if (this.#statusTimer) return;
    this.#statusTimer = setTimeout(() => {
      this.#statusTimer = null;
      this.aggregateStatus();
    }, 500);
    this.#statusTimer.unref();
  }
}
