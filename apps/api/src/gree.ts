import { spawn, type ChildProcess } from "node:child_process";
import { createInterface } from "node:readline";
import type {
  GreeDiscoveredDevice,
  HeatPumpMode,
  HeatPumpState,
  IntegrationStatus,
} from "@climate-twin/contracts";
import type { AppConfig } from "./config.js";
import type { TelemetryBus } from "./events.js";
import type { GreeConnectionSecret } from "./integration-secrets.js";
import type { HeatPumpStateStore } from "./heat-pump-state.js";
import type { RuntimeStatus } from "./services.js";
import { tpLinkDiscoveryTargets } from "./tp-link.js";
import {
  EwpeCloudClient,
  type EwpeCloudSnapshot,
  type EwpeCloudTransport,
} from "./ewpe-cloud.js";
import { compareCodeUnits } from "./text-order.js";
import type { GreeBindingResult, GreeStatePayload } from "./gree-protocol.js";

interface GreeBridgeOptions {
  discover?: () => Promise<GreeDiscoveredDevice[]>;
  bind?: (mac: string) => Promise<GreeBindingResult>;
  cloud?: EwpeCloudTransport;
  onConnectionUpdate?: (connection: GreeConnectionSecret) => void;
  onStateRecorded?: () => void;
  unavailableMarkDelayMs?: number;
}

/**
 * How long a connection must stay down before the durable heat-pump journal
 * records it as unavailable. Worker restarts routinely recover within seconds;
 * journaling each of those blips as an availability gap poisons the
 * verified-off evidence that passive analytics depend on.
 */
const UNAVAILABLE_MARK_DELAY_MS = 3 * 60_000;

interface Worker {
  child: ChildProcess;
  connection: GreeConnectionSecret;
  closed: boolean;
  connected: boolean;
  lastPollAt: string | null;
  error: string | null;
  failures: number;
  restartDelayMs: number;
}

interface CloudWorker {
  controller: AbortController;
  connection: GreeConnectionSecret;
  closed: boolean;
  connected: boolean;
  lastPollAt: string | null;
  error: string | null;
  restartDelayMs: number;
}

/** The fields the shared close policy touches on either transport's worker. */
type ClosedWorker = Pick<Worker, "connection" | "closed" | "connected" | "error" | "restartDelayMs">;

function normalizedMac(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const normalized = value.replace(/[:-]/g, "").trim().toUpperCase();
  return /^[0-9A-F]{12}$/u.test(normalized) ? normalized : null;
}

function optionalText(value: unknown, maximum = 200): string | null {
  return typeof value === "string" && value.trim() && value.length <= maximum ? value.trim() : null;
}

function finiteNullable(value: unknown, minimum: number, maximum: number): number | null | undefined {
  if (value === null) return null;
  return typeof value === "number" && Number.isFinite(value) && value >= minimum && value <= maximum
    ? value
    : undefined;
}

function boolNullable(value: unknown): boolean | null | undefined {
  return value === null || typeof value === "boolean" ? value : undefined;
}

function parseDevice(value: unknown): GreeDiscoveredDevice | null {
  const item = value as Record<string, unknown>;
  const mac = normalizedMac(item?.mac);
  if (!item || !mac || typeof item.host !== "string" || !item.host.trim() || item.host.length > 253
    || typeof item.port !== "number" || !Number.isInteger(item.port) || item.port < 1 || item.port > 65_535) {
    return null;
  }
  return {
    transport: item.transport === "ewpe-cloud" ? "ewpe-cloud" : "local",
    host: item.host.trim(),
    port: item.port,
    mac,
    name: optionalText(item.name),
    brand: optionalText(item.brand),
    model: optionalText(item.model),
    version: optionalText(item.version),
    ...(item.transport === "ewpe-cloud" ? {
      cloudHomeName: optionalText(item.cloudHomeName),
      cloudRoomName: optionalText(item.cloudRoomName),
    } : {}),
  };
}

function parsedDiagnostics(value: unknown): HeatPumpState["diagnostics"] | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const allowed = new Set([
    "environmentTemperatureRaw", "indoorCoilTemperatureRaw", "outdoorTemperatureRaw",
    "compressorTemperatureRaw", "waterSensorRaw", "totalEnergyRaw", "energyConsumptionRaw",
    "sleepModeRaw", "temperatureUnitRaw", "temperatureRecordRaw", "heatCoolTypeRaw",
    "faultCode", "allErrors", "shutdownFaults", "subhealthFaults", "wifiStatus",
  ]);
  const diagnostics: HeatPumpState["diagnostics"] = {};
  for (const [name, candidate] of Object.entries(value as Record<string, unknown>)) {
    if (!allowed.has(name) || typeof candidate !== "number" || !Number.isFinite(candidate)) return null;
    Object.assign(diagnostics, { [name]: candidate });
  }
  return diagnostics;
}

function parseState(value: unknown): GreeStatePayload | null {
  const item = value as Record<string, unknown>;
  const target = finiteNullable(item?.targetTemperatureC, -60, 100);
  const current = finiteNullable(item?.currentTemperatureC, -60, 100);
  const currentHumidity = item?.currentHumidityPercent === undefined
    ? null
    : finiteNullable(item.currentHumidityPercent, 0, 100);
  const targetHumidity = item?.targetHumidityPercent === undefined
    ? null
    : finiteNullable(item.targetHumidityPercent, 0, 100);
  const power = boolNullable(item?.power);
  const freshAir = item?.freshAir === undefined ? null : boolNullable(item.freshAir);
  const anion = item?.anion === undefined ? null : boolNullable(item.anion);
  const sleep = item?.sleep === undefined ? null : boolNullable(item.sleep);
  const light = item?.light === undefined ? null : boolNullable(item.light);
  const quiet = boolNullable(item?.quiet);
  const turbo = boolNullable(item?.turbo);
  const xfan = boolNullable(item?.xfan);
  const steadyHeat = item?.steadyHeat === undefined ? null : boolNullable(item.steadyHeat);
  const powerSave = item?.powerSave === undefined ? null : boolNullable(item.powerSave);
  const cleanFilter = item?.cleanFilter === undefined ? null : boolNullable(item.cleanFilter);
  const waterFull = item?.waterFull === undefined ? null : boolNullable(item.waterFull);
  const compressorFrequency = item?.compressorFrequencyHz === undefined
    ? null
    : finiteNullable(item.compressorFrequencyHz, 0, 300);
  const diagnostics = item?.diagnostics === undefined ? {} : parsedDiagnostics(item.diagnostics);
  const modes: Array<HeatPumpMode | null> = [null, "auto", "cool", "dry", "fan", "heat"];
  if (!item || typeof item.observedAt !== "string" || !Number.isFinite(Date.parse(item.observedAt))
    || typeof item.available !== "boolean" || power === undefined || target === undefined || current === undefined
    || currentHumidity === undefined || targetHumidity === undefined
    || freshAir === undefined || anion === undefined || sleep === undefined || light === undefined
    || quiet === undefined || turbo === undefined || xfan === undefined
    || steadyHeat === undefined || powerSave === undefined || cleanFilter === undefined || waterFull === undefined
    || compressorFrequency === undefined || diagnostics === null
    || !modes.includes(item.selectedMode as HeatPumpMode | null)
    || !["reported", "unavailable"].includes(String(item.currentTemperatureSource))
    || !["off", "unknown"].includes(String(item.activity))
    || !["protocol", "unavailable"].includes(String(item.activityEvidence))) {
    return null;
  }
  const shortText = (candidate: unknown): string | null | undefined => (
    candidate === null ? null : optionalText(candidate, 100) ?? undefined
  );
  const fanSpeed = shortText(item.fanSpeed);
  const horizontalSwing = shortText(item.horizontalSwing);
  const verticalSwing = shortText(item.verticalSwing);
  const dehumidifierMode = item.dehumidifierMode === undefined ? null : shortText(item.dehumidifierMode);
  if (fanSpeed === undefined || horizontalSwing === undefined || verticalSwing === undefined
    || dehumidifierMode === undefined) return null;
  return {
    observedAt: new Date(item.observedAt).toISOString(),
    available: item.available,
    power,
    selectedMode: item.selectedMode as HeatPumpMode | null,
    targetTemperatureC: target,
    currentTemperatureC: current,
    currentTemperatureSource: item.currentTemperatureSource as GreeStatePayload["currentTemperatureSource"],
    currentHumidityPercent: currentHumidity,
    targetHumidityPercent: targetHumidity,
    fanSpeed,
    horizontalSwing,
    verticalSwing,
    freshAir,
    anion,
    sleep,
    light,
    quiet,
    turbo,
    xfan,
    steadyHeat,
    powerSave,
    cleanFilter,
    waterFull,
    dehumidifierMode,
    compressorFrequencyHz: compressorFrequency,
    diagnostics,
    activity: item.activity as GreeStatePayload["activity"],
    activityEvidence: item.activityEvidence as GreeStatePayload["activityEvidence"],
  };
}

function connectionId(mac: string): string {
  return `gree-${mac.toLowerCase()}`;
}

function urlHost(value: string | null | undefined): string | null {
  if (!value) return null;
  try {
    return new URL(value).hostname;
  } catch {
    return null;
  }
}

/** Owns direct, read-only Gree/Wilfa workers. No HVAC command path is exposed. */
export class GreeBridge {
  readonly #workers = new Map<string, Worker>();
  readonly #cloudWorkers = new Map<string, CloudWorker>();
  readonly #restartTimers = new Map<string, NodeJS.Timeout>();
  readonly #pendingUnavailableMarks = new Map<string, {
    timer: NodeJS.Timeout;
    outageStartIso: string;
    dueAtMs: number;
  }>();
  readonly #cloud: EwpeCloudTransport;
  #running = false;

  constructor(
    private readonly config: AppConfig,
    private readonly status: RuntimeStatus,
    private readonly states: HeatPumpStateStore,
    private readonly bus: TelemetryBus,
    private readonly options: GreeBridgeOptions = {},
  ) {
    this.#cloud = options.cloud ?? new EwpeCloudClient();
    this.aggregateStatus();
  }

  static connectionId(mac: string): string {
    const normalized = normalizedMac(mac);
    if (!normalized) throw new Error("Invalid Gree device identity");
    return connectionId(normalized);
  }

  start(): void {
    if (this.#running) return;
    this.#running = true;
    for (const connection of this.config.greeConnections ?? []) this.startWorker(connection);
    this.aggregateStatus();
  }

  stop(): void {
    this.#running = false;
    for (const timer of this.#restartTimers.values()) clearTimeout(timer);
    this.#restartTimers.clear();
    this.clearPendingUnavailableMarks();
    for (const worker of this.#workers.values()) worker.child.kill();
    this.#workers.clear();
    for (const worker of this.#cloudWorkers.values()) worker.controller.abort();
    this.#cloudWorkers.clear();
    this.aggregateStatus();
  }

  refreshConfiguration(): void {
    const running = this.#running;
    // An outage that began before a configuration change does not end with
    // it: connections that stay configured keep their pending mark, with the
    // original outage start and the remaining debounce, across the restart.
    const carried = [...this.#pendingUnavailableMarks].map(([id, pending]) => ({
      id,
      outageStartIso: pending.outageStartIso,
      dueAtMs: pending.dueAtMs,
    }));
    this.stop();
    if (!running) return;
    const configured = new Set((this.config.greeConnections ?? []).map((item) => item.id));
    for (const pending of carried) {
      if (!configured.has(pending.id)) continue;
      this.armUnavailableMark(pending.id, pending.outageStartIso, Math.max(0, pending.dueAtMs - Date.now()));
    }
    this.start();
  }

  async discoverSources(houseId?: string): Promise<GreeDiscoveredDevice[]> {
    const devices = this.options.discover
      ? await this.options.discover()
      : await this.oneShot(["--discover"], {}, 12_000, (message) => {
          if (message.type !== "discovery" || !Array.isArray(message.devices)) return null;
          const parsed = message.devices.map(parseDevice).filter((device): device is GreeDiscoveredDevice => Boolean(device));
          return parsed;
        });
    const configured = new Map((this.config.greeConnections ?? [])
      .map((connection) => [connection.mac, connection]));
    return devices.flatMap((device) => {
      const connection = configured.get(device.mac);
      if (!connection) return [device];
      if (houseId && connection.houseId !== houseId) return [];
      return [{ ...device, configuredConnectionId: connection.id }];
    });
  }

  async discoverCloud(
    username: string,
    password: string,
    houseId?: string,
  ): Promise<GreeDiscoveredDevice[]> {
    const devices = await this.#cloud.discover(username, password);
    return this.withConfiguredConnections(devices, houseId);
  }

  private withConfiguredConnections(
    devices: GreeDiscoveredDevice[],
    houseId?: string,
  ): GreeDiscoveredDevice[] {
    const configured = new Map((this.config.greeConnections ?? [])
      .map((connection) => [connection.mac, connection]));
    return devices.flatMap((device) => {
      const connection = configured.get(device.mac);
      if (!connection) return [device];
      if (houseId && connection.houseId !== houseId) return [];
      return [{ ...device, configuredConnectionId: connection.id }];
    });
  }

  bind(mac: string): Promise<GreeBindingResult> {
    const target = normalizedMac(mac);
    if (!target) return Promise.reject(new Error("Invalid Gree device identity"));
    if (this.options.bind) return this.options.bind(target);
    return this.oneShot(["--bind"], { GREE_MAC: target }, 35_000, (message) => {
      if (message.type !== "bound") return null;
      const device = parseDevice(message.device);
      const state = parseState(message.state);
      if (!device || device.mac !== target || !state || typeof message.key !== "string"
        || !message.key || message.key.length > 256
        || (message.cipherVersion !== 1 && message.cipherVersion !== 2)) return null;
      return {
        device,
        key: message.key,
        cipherVersion: message.cipherVersion,
        state,
      };
    });
  }

  bindCloud(username: string, password: string, mac: string): Promise<GreeBindingResult> {
    const target = normalizedMac(mac);
    if (!target) return Promise.reject(new Error("Invalid Gree device identity"));
    return this.#cloud.bind(username, password, target);
  }

  recordInitial(
    connection: GreeConnectionSecret,
    payload: GreeStatePayload,
    reclaimDetached = false,
  ): HeatPumpState {
    const state = this.publicState(connection, payload);
    const changed = this.states.record(state, { reclaimDetached });
    this.notifyStateRecorded();
    if (changed) this.bus.publish({ type: "heat-pump", data: structuredClone(state) });
    return state;
  }

  private notifyStateRecorded(): void {
    try {
      this.options.onStateRecorded?.();
    } catch {
      // The SQLite journal is already durable. A later checkpointed archive
      // pass will retry even if the low-latency wake-up hook fails.
    }
  }

  private noteConnectionDown(connectionId: string): void {
    if (this.#pendingUnavailableMarks.has(connectionId)) return;
    this.armUnavailableMark(
      connectionId,
      new Date().toISOString(),
      this.options.unavailableMarkDelayMs ?? UNAVAILABLE_MARK_DELAY_MS,
    );
  }

  private armUnavailableMark(connectionId: string, outageStartIso: string, delayMs: number): void {
    const timer = setTimeout(() => {
      this.#pendingUnavailableMarks.delete(connectionId);
      const unavailable = this.states.markUnavailable(connectionId, outageStartIso);
      if (unavailable) {
        this.notifyStateRecorded();
        this.bus.publish({ type: "heat-pump", data: structuredClone(unavailable) });
      }
    }, delayMs);
    timer.unref();
    this.#pendingUnavailableMarks.set(connectionId, { timer, outageStartIso, dueAtMs: Date.now() + delayMs });
  }

  private noteConnectionUp(connectionId: string): void {
    const pending = this.#pendingUnavailableMarks.get(connectionId);
    if (!pending) return;
    clearTimeout(pending.timer);
    this.#pendingUnavailableMarks.delete(connectionId);
  }

  private clearPendingUnavailableMarks(): void {
    for (const pending of this.#pendingUnavailableMarks.values()) clearTimeout(pending.timer);
    this.#pendingUnavailableMarks.clear();
  }

  private oneShot<T>(
    args: string[],
    extraEnvironment: NodeJS.ProcessEnv,
    timeoutMs: number,
    accept: (message: Record<string, unknown>) => T | null,
  ): Promise<T> {
    return new Promise((resolve, reject) => {
      const child = spawn(
        this.config.greePython ?? this.config.tpLinkPython,
        [this.config.greeBridgeScript ?? "./apps/api/python/gree_bridge.py", ...args],
        { stdio: ["ignore", "pipe", "ignore"], env: this.environment(extraEnvironment) },
      );
      let settled = false;
      const timer = setTimeout(() => {
        child.kill();
        if (!settled) reject(new Error("Gree helper timed out"));
        settled = true;
      }, timeoutMs);
      timer.unref();
      const lines = createInterface({ input: child.stdout! });
      lines.on("line", (line) => {
        if (settled || Buffer.byteLength(line, "utf8") > 256 * 1024) return;
        try {
          const message = JSON.parse(line) as Record<string, unknown>;
          const result = accept(message);
          if (result === null) return;
          settled = true;
          clearTimeout(timer);
          lines.close();
          child.kill();
          resolve(result);
        } catch {
          // Ignore malformed helper output; the bounded timeout remains authoritative.
        }
      });
      child.once("error", () => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        reject(new Error("Gree helper could not be started"));
      });
      child.once("close", () => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        reject(new Error("Gree helper did not return a valid response"));
      });
    });
  }

  private environment(extra: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv {
    const peerHosts = [
      ...(this.config.greeConnections ?? []).map((item) => item.host),
      ...(this.config.tpLinkConnections ?? []).map((item) => item.host),
      this.config.tpLinkHost,
      ...(this.config.homeAssistantConnections ?? []).map((item) => urlHost(item.url)),
      urlHost(this.config.haUrl),
    ].filter((host): host is string => Boolean(host));
    const computedTargets = tpLinkDiscoveryTargets(peerHosts);
    const targets = [...new Set([...(this.config.greeDiscoveryTargets ?? []), ...computedTargets])];
    return {
      ...process.env,
      GREE_DISCOVERY_TARGETS: targets.join(","),
      GREE_POLL_INTERVAL_MS: String(this.config.greePollIntervalMs ?? 60_000),
      ...extra,
    };
  }

  private startWorker(connection: GreeConnectionSecret, restartDelayMs = 1_000): void {
    if (connection.transport === "ewpe-cloud") {
      this.startCloudWorker(connection, restartDelayMs);
      return;
    }
    if (this.#workers.has(connection.id)) return;
    const child = spawn(
      this.config.greePython ?? this.config.tpLinkPython,
      [this.config.greeBridgeScript ?? "./apps/api/python/gree_bridge.py"],
      {
        stdio: ["ignore", "pipe", "ignore"],
        env: this.environment({
          GREE_HOST: connection.host,
          GREE_PORT: String(connection.port),
          GREE_MAC: connection.mac,
          GREE_KEY: connection.key,
          GREE_CIPHER_VERSION: String(connection.cipherVersion),
          GREE_NAME: connection.name ?? "",
          GREE_BRAND: connection.brand ?? "",
          GREE_MODEL: connection.model ?? "",
          GREE_VERSION: connection.version ?? "",
        }),
      },
    );
    const worker: Worker = {
      child, connection, closed: false, connected: false, lastPollAt: null, error: null,
      failures: 0, restartDelayMs,
    };
    this.#workers.set(connection.id, worker);
    createInterface({ input: child.stdout! }).on("line", (line) => this.handleWorkerLine(worker, line));
    child.once("error", () => this.workerClosed(worker, "Heat-pump helper could not be started"));
    child.once("close", () => this.workerClosed(worker, "Heat-pump connection stopped"));
  }

  private startCloudWorker(connection: GreeConnectionSecret, restartDelayMs = 1_000): void {
    if (this.#cloudWorkers.has(connection.id)) return;
    const worker: CloudWorker = {
      controller: new AbortController(),
      connection,
      closed: false,
      connected: false,
      lastPollAt: null,
      error: null,
      restartDelayMs,
    };
    this.#cloudWorkers.set(connection.id, worker);
    void this.#cloud.monitor(
      connection,
      this.config.greePollIntervalMs ?? 60_000,
      worker.controller.signal,
      (snapshot) => this.handleCloudSnapshot(worker, snapshot),
      () => this.handleCloudPollFailure(worker),
    ).then(() => {
      if (!worker.controller.signal.aborted) this.cloudWorkerClosed(worker, "EWPE cloud connection stopped");
    }).catch(() => {
      if (!worker.controller.signal.aborted) this.cloudWorkerClosed(worker, "EWPE cloud polling is unavailable");
    });
  }

  private handleCloudSnapshot(worker: CloudWorker, snapshot: EwpeCloudSnapshot): void {
    if (worker.closed || this.#cloudWorkers.get(worker.connection.id) !== worker
      || snapshot.device.mac !== worker.connection.mac) return;
    worker.connection = {
      ...worker.connection,
      host: snapshot.device.host,
      port: snapshot.device.port,
      ...(snapshot.device.name ? { name: snapshot.device.name } : {}),
      ...(snapshot.device.brand ? { brand: snapshot.device.brand } : {}),
      ...(snapshot.device.model ? { model: snapshot.device.model } : {}),
      ...(snapshot.device.version ? { version: snapshot.device.version } : {}),
    };
    worker.connected = true;
    worker.lastPollAt = snapshot.state.observedAt;
    worker.error = null;
    worker.restartDelayMs = 1_000;
    this.noteConnectionUp(worker.connection.id);
    this.recordInitial(worker.connection, snapshot.state);
    try { this.options.onConnectionUpdate?.({ ...worker.connection }); } catch { /* retry after restart */ }
    this.aggregateStatus();
  }

  private handleCloudPollFailure(worker: CloudWorker): void {
    if (worker.closed || this.#cloudWorkers.get(worker.connection.id) !== worker) return;
    // As for the local transport, the outage clock starts at the first failed
    // poll while the session keeps retrying; the runtime status flips only
    // once the session gives up.
    this.noteConnectionDown(worker.connection.id);
  }

  private handleWorkerLine(worker: Worker, line: string): void {
    if (worker.closed || this.#workers.get(worker.connection.id)?.child !== worker.child) return;
    if (Buffer.byteLength(line, "utf8") > 256 * 1024) return;
    let message: Record<string, unknown>;
    try {
      message = JSON.parse(line) as Record<string, unknown>;
    } catch {
      return;
    }
    if (message.type === "snapshot") {
      const device = parseDevice(message.device);
      const payload = parseState(message.state);
      if (!device || !payload || device.mac !== worker.connection.mac) return;
      worker.connection = {
        ...worker.connection,
        host: device.host,
        ...(device.name ? { name: device.name } : {}),
        ...(device.brand ? { brand: device.brand } : {}),
        ...(device.model ? { model: device.model } : {}),
        ...(device.version ? { version: device.version } : {}),
      };
      worker.connected = true;
      worker.lastPollAt = payload.observedAt;
      worker.error = null;
      worker.failures = 0;
      worker.restartDelayMs = 1_000;
      this.noteConnectionUp(worker.connection.id);
      this.recordInitial(worker.connection, payload);
      this.aggregateStatus();
      return;
    }
    if (message.type === "error") {
      worker.failures += 1;
      // The outage clock starts at the first failed poll; the durable journal
      // records unavailability (backdated to that moment) only if no snapshot
      // interrupts the debounce window.
      this.noteConnectionDown(worker.connection.id);
      if (worker.failures >= 3) {
        worker.connected = false;
        worker.error = optionalText(message.message, 500) ?? "Heat-pump polling is unavailable";
        this.aggregateStatus();
      }
      return;
    }
    if (message.type === "host-change" && typeof message.previousHost === "string"
      && typeof message.host === "string" && message.previousHost === worker.connection.host
      && message.host.trim() && message.host.length <= 253) {
      worker.connection = { ...worker.connection, host: message.host.trim() };
      try {
        this.options.onConnectionUpdate?.({ ...worker.connection });
      } catch {
        // The active worker can keep using the recovered address; retrying
        // discovery after a restart remains safer than crashing on a disk error.
      }
    }
  }

  private publicState(connection: GreeConnectionSecret, payload: GreeStatePayload): HeatPumpState {
    return {
      connectionId: connection.id,
      houseId: connection.houseId,
      equipmentId: connection.equipmentId ?? null,
      deviceId: connection.mac,
      name: connection.name ?? null,
      brand: connection.brand ?? null,
      model: connection.model ?? null,
      transport: connection.transport === "ewpe-cloud" ? "ewpe-cloud" : "local",
      floorId: null,
      roomId: null,
      x: null,
      y: null,
      z: null,
      ...payload,
      receivedAt: new Date().toISOString(),
    };
  }

  private cloudWorkerClosed(worker: CloudWorker, error: string): void {
    if (worker.closed || this.#cloudWorkers.get(worker.connection.id) !== worker) return;
    if (!this.settleClosedWorker(worker, error)) {
      this.#cloudWorkers.delete(worker.connection.id);
      return;
    }
    this.scheduleWorkerRestart(worker, () => {
      if (this.#cloudWorkers.get(worker.connection.id) === worker) this.#cloudWorkers.delete(worker.connection.id);
    });
  }

  private workerClosed(worker: Worker, error: string): void {
    if (worker.closed || this.#workers.get(worker.connection.id)?.child !== worker.child) return;
    if (!this.settleClosedWorker(worker, error)) {
      this.#workers.delete(worker.connection.id);
      return;
    }
    this.scheduleWorkerRestart(worker, () => {
      if (this.#workers.get(worker.connection.id)?.child === worker.child) this.#workers.delete(worker.connection.id);
    });
  }

  /**
   * The close policy shared by both transports. A connection that stays
   * configured while the bridge runs keeps (or starts) its outage clock and is
   * restarted with backoff; any other close cancels a pending mark and drops
   * the worker. Returns whether the worker should be restarted.
   */
  private settleClosedWorker(worker: ClosedWorker, error: string): boolean {
    worker.closed = true;
    worker.connected = false;
    worker.error = error;
    const configured = (this.config.greeConnections ?? []).some((item) => item.id === worker.connection.id);
    const restart = this.#running && configured;
    if (restart) this.noteConnectionDown(worker.connection.id);
    else this.noteConnectionUp(worker.connection.id);
    this.aggregateStatus();
    return restart;
  }

  private scheduleWorkerRestart(worker: ClosedWorker, release: () => void): void {
    const delay = worker.restartDelayMs;
    const nextDelay = Math.min(60_000, delay * 2);
    const timer = setTimeout(() => {
      this.#restartTimers.delete(worker.connection.id);
      const latest = (this.config.greeConnections ?? []).find((item) => item.id === worker.connection.id);
      release();
      if (this.#running && latest) this.startWorker(latest, nextDelay);
    }, delay);
    timer.unref();
    this.#restartTimers.set(worker.connection.id, timer);
  }

  private aggregateStatus(): void {
    const configured = this.config.greeConnections ?? [];
    if (configured.length === 0) {
      if (this.status.value.gree) {
        delete this.status.value.gree;
        this.status.changed();
      }
      return;
    }
    const connections = configured.map((connection) => {
      const worker = connection.transport === "ewpe-cloud"
        ? this.#cloudWorkers.get(connection.id)
        : this.#workers.get(connection.id);
      return {
        id: connection.id,
        houseId: connection.houseId,
        equipmentId: connection.equipmentId ?? null,
        configured: true,
        connected: worker?.connected ?? false,
        lastPollAt: worker?.lastPollAt ?? null,
        error: worker?.error ?? null,
        transport: connection.transport === "ewpe-cloud" ? "ewpe-cloud" as const : "local" as const,
        host: worker?.connection.host ?? connection.host,
        mac: connection.mac,
        name: connection.name ?? null,
        brand: connection.brand ?? null,
        model: connection.model ?? null,
        version: connection.version ?? null,
      };
    });
    const gree: NonNullable<IntegrationStatus["gree"]> = {
      configured: true,
      connected: connections.some((connection) => connection.connected),
      lastPollAt: connections.map((connection) => connection.lastPollAt)
        .filter((value): value is string => Boolean(value)).sort(compareCodeUnits).at(-1) ?? null,
      error: connections.map((connection) => connection.error).filter(Boolean).join("; ") || null,
      connections,
    };
    if (JSON.stringify(this.status.value.gree) === JSON.stringify(gree)) return;
    this.status.value.gree = gree;
    this.status.changed();
  }
}
