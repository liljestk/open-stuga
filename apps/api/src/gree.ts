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

export interface GreeStatePayload {
  observedAt: string;
  available: boolean;
  power: boolean | null;
  selectedMode: HeatPumpMode | null;
  targetTemperatureC: number | null;
  currentTemperatureC: number | null;
  currentTemperatureSource: "reported" | "unavailable";
  fanSpeed: string | null;
  horizontalSwing: string | null;
  verticalSwing: string | null;
  quiet: boolean | null;
  turbo: boolean | null;
  xfan: boolean | null;
  activity: "off" | "unknown";
  activityEvidence: "protocol" | "unavailable";
}

export interface GreeBindingResult {
  device: GreeDiscoveredDevice;
  key: string;
  cipherVersion: 1 | 2;
  state: GreeStatePayload;
}

interface GreeBridgeOptions {
  discover?: () => Promise<GreeDiscoveredDevice[]>;
  bind?: (mac: string) => Promise<GreeBindingResult>;
  onConnectionUpdate?: (connection: GreeConnectionSecret) => void;
  onStateRecorded?: () => void;
}

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
    host: item.host.trim(),
    port: item.port,
    mac,
    name: optionalText(item.name),
    brand: optionalText(item.brand),
    model: optionalText(item.model),
    version: optionalText(item.version),
  };
}

function parseState(value: unknown): GreeStatePayload | null {
  const item = value as Record<string, unknown>;
  const target = finiteNullable(item?.targetTemperatureC, -60, 100);
  const current = finiteNullable(item?.currentTemperatureC, -60, 100);
  const power = boolNullable(item?.power);
  const quiet = boolNullable(item?.quiet);
  const turbo = boolNullable(item?.turbo);
  const xfan = boolNullable(item?.xfan);
  const modes: Array<HeatPumpMode | null> = [null, "auto", "cool", "dry", "fan", "heat"];
  if (!item || typeof item.observedAt !== "string" || !Number.isFinite(Date.parse(item.observedAt))
    || typeof item.available !== "boolean" || power === undefined || target === undefined || current === undefined
    || quiet === undefined || turbo === undefined || xfan === undefined
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
  if (fanSpeed === undefined || horizontalSwing === undefined || verticalSwing === undefined) return null;
  return {
    observedAt: new Date(item.observedAt).toISOString(),
    available: item.available,
    power,
    selectedMode: item.selectedMode as HeatPumpMode | null,
    targetTemperatureC: target,
    currentTemperatureC: current,
    currentTemperatureSource: item.currentTemperatureSource as GreeStatePayload["currentTemperatureSource"],
    fanSpeed,
    horizontalSwing,
    verticalSwing,
    quiet,
    turbo,
    xfan,
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
  readonly #restartTimers = new Map<string, NodeJS.Timeout>();
  #running = false;

  constructor(
    private readonly config: AppConfig,
    private readonly status: RuntimeStatus,
    private readonly states: HeatPumpStateStore,
    private readonly bus: TelemetryBus,
    private readonly options: GreeBridgeOptions = {},
  ) {
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
    for (const worker of this.#workers.values()) worker.child.kill();
    this.#workers.clear();
    this.aggregateStatus();
  }

  refreshConfiguration(): void {
    const running = this.#running;
    this.stop();
    if (running) this.start();
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

  recordInitial(connection: GreeConnectionSecret, payload: GreeStatePayload): HeatPumpState {
    const state = this.publicState(connection, payload);
    const changed = this.states.record(state);
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
      this.recordInitial(worker.connection, payload);
      this.aggregateStatus();
      return;
    }
    if (message.type === "error") {
      worker.failures += 1;
      if (worker.failures >= 3) {
        worker.connected = false;
          worker.error = optionalText(message.message, 500) ?? "Heat-pump polling is unavailable";
          const unavailable = this.states.markUnavailable(worker.connection.id);
          if (unavailable) {
            this.notifyStateRecorded();
            this.bus.publish({ type: "heat-pump", data: structuredClone(unavailable) });
          }
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
      ...payload,
      receivedAt: new Date().toISOString(),
    };
  }

  private workerClosed(worker: Worker, error: string): void {
    if (worker.closed || this.#workers.get(worker.connection.id)?.child !== worker.child) return;
    worker.closed = true;
    worker.connected = false;
      worker.error = error;
      const unavailable = this.states.markUnavailable(worker.connection.id);
      if (unavailable) {
        this.notifyStateRecorded();
        this.bus.publish({ type: "heat-pump", data: structuredClone(unavailable) });
      }
    this.aggregateStatus();
    if (!this.#running || !(this.config.greeConnections ?? []).some((item) => item.id === worker.connection.id)) {
      this.#workers.delete(worker.connection.id);
      return;
    }
    const delay = worker.restartDelayMs;
    const nextDelay = Math.min(60_000, delay * 2);
    const timer = setTimeout(() => {
      this.#restartTimers.delete(worker.connection.id);
      const latest = (this.config.greeConnections ?? []).find((item) => item.id === worker.connection.id);
      if (this.#workers.get(worker.connection.id)?.child === worker.child) {
        this.#workers.delete(worker.connection.id);
      }
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
      const worker = this.#workers.get(connection.id);
      return {
        id: connection.id,
        houseId: connection.houseId,
        equipmentId: connection.equipmentId ?? null,
        configured: true,
        connected: worker?.connected ?? false,
        lastPollAt: worker?.lastPollAt ?? null,
        error: worker?.error ?? null,
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
        .filter((value): value is string => Boolean(value)).sort().at(-1) ?? null,
      error: connections.map((connection) => connection.error).filter(Boolean).join("; ") || null,
      connections,
    };
    if (JSON.stringify(this.status.value.gree) === JSON.stringify(gree)) return;
    this.status.value.gree = gree;
    this.status.changed();
  }
}
