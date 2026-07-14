import { spawn, type ChildProcess } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { createInterface } from "node:readline";
import type { Reading, TpLinkDiscoveredDevice } from "@climate-twin/contracts";
import type { AppConfig } from "./config.js";
import type { ClimateDatabase } from "./db.js";
import { RuntimeStatus, TelemetryService } from "./services.js";

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
}

interface TpLinkSnapshotMessage {
  type: "snapshot";
  timestamp: string;
  hubModel: string;
  devices: TpLinkSnapshotDevice[];
}

interface TpLinkErrorMessage {
  type: "error";
  message: string;
}

type TpLinkHelperMessage = TpLinkSnapshotMessage | TpLinkErrorMessage;

export interface TpLinkDiscoveredHub {
  host: string;
  model: "H100" | "H200";
  alias: string | null;
}

interface LastIngestedDevice {
  sensorId: string;
  temperature: number;
  humidity: number;
  battery: number | null;
  ingestedAt: number;
}

type CachedTpLinkDevice = Omit<TpLinkDiscoveredDevice, "mappedSensorId">;

const MAX_UNCHANGED_SAMPLE_AGE_MS = 5 * 60_000;

function nonEmptyString(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function finiteNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

export function loadTpLinkDeviceMappings(path: string): TpLinkDeviceMapping[] {
  const parsed = JSON.parse(readFileSync(path, "utf8")) as { devices?: unknown };
  if (!Array.isArray(parsed.devices) || parsed.devices.length === 0) {
    throw new Error("TP-Link device map must contain a non-empty devices array");
  }
  const deviceIds = new Set<string>();
  const sensorIds = new Set<string>();
  return parsed.devices.map((value, index) => {
    if (!value || typeof value !== "object") throw new Error(`Invalid TP-Link device mapping at index ${index}`);
    const entry = value as Record<string, unknown>;
    const deviceId = nonEmptyString(entry.deviceId);
    const sensorId = nonEmptyString(entry.sensorId);
    if (!deviceId || !sensorId) throw new Error(`TP-Link device mapping at index ${index} requires deviceId and sensorId`);
    if (deviceIds.has(deviceId)) throw new Error(`TP-Link child device ${deviceId} is mapped more than once`);
    if (sensorIds.has(sensorId)) throw new Error(`Stuga sensor ${sensorId} is mapped to more than one TP-Link child device`);
    deviceIds.add(deviceId);
    sensorIds.add(sensorId);
    return { deviceId, sensorId };
  });
}

export function normalizeTpLinkTemperature(value: number, unit: string | null): number | null {
  if (!Number.isFinite(value)) return null;
  const normalized = unit?.trim().toLowerCase();
  if (normalized === "celsius" || normalized === "c" || normalized === "°c") return value;
  if (normalized === "fahrenheit" || normalized === "f" || normalized === "°f") return (value - 32) * 5 / 9;
  return null;
}

export class TpLinkBridge {
  #child: ChildProcess | null = null;
  #restartTimer: NodeJS.Timeout | null = null;
  #running = false;
  #attempt = 0;
  #stderr = "";
  readonly #legacyMappings = new Map<string, string>();
  readonly #discovered = new Map<string, CachedTpLinkDevice>();
  readonly #lastIngested = new Map<string, LastIngestedDevice>();

  constructor(
    private readonly config: AppConfig,
    private readonly telemetry: TelemetryService,
    private readonly database: ClimateDatabase,
    private readonly status: RuntimeStatus,
  ) {}

  start(): void {
    if (this.#running) return;
    this.#running = true;
    if (!this.status.value.tpLink.configured) return;
    try {
      if (this.config.tpLinkDeviceMapFile && existsSync(this.config.tpLinkDeviceMapFile)) {
        for (const mapping of loadTpLinkDeviceMappings(this.config.tpLinkDeviceMapFile)) {
          const sensor = this.database.getSensor(mapping.sensorId);
          if (!sensor) throw new Error(`TP-Link mapping references unknown Stuga sensor ${mapping.sensorId}`);
          this.#legacyMappings.set(mapping.deviceId, mapping.sensorId);
        }
      }
      this.status.value.tpLink.mappedDevices = this.resolvedMappings().size;
      this.status.value.tpLink.error = null;
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
      .map((device) => ({ ...device, mappedSensorId: mappings.get(device.deviceId) ?? null }))
      .sort((first, second) => (first.alias ?? first.deviceId).localeCompare(second.alias ?? second.deviceId));
  }

  private resolvedMappings(): Map<string, string> {
    const mappings = new Map<string, string>();
    const mappedSensors = new Set<string>();
    for (const sensor of this.database.listSensors()) {
      if (!sensor.tpLinkDeviceId) continue;
      mappings.set(sensor.tpLinkDeviceId, sensor.id);
      mappedSensors.add(sensor.id);
    }
    for (const [deviceId, sensorId] of this.#legacyMappings) {
      if (mappings.has(deviceId) || mappedSensors.has(sensorId)) continue;
      mappings.set(deviceId, sensorId);
      mappedSensors.add(sensorId);
    }
    this.status.value.tpLink.mappedDevices = mappings.size;
    return mappings;
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
    this.#lastIngested.clear();
    this.status.value.tpLink.discoveredDevices = 0;
    this.status.value.tpLink.mappedDevices = 0;
    this.status.value.tpLink.hubModel = null;
    this.status.value.tpLink.error = null;
    this.start();
  }

  discoverHubs(timeoutMs = 12_000): Promise<TpLinkDiscoveredHub[]> {
    return new Promise((resolve, reject) => {
      const child = spawn(this.config.tpLinkPython, [this.config.tpLinkBridgeScript, "--discover"], {
        env: {
          ...process.env,
          ...(this.config.tpLinkUsername ? { TP_LINK_USERNAME: this.config.tpLinkUsername } : {}),
          ...(this.config.tpLinkPassword ? { TP_LINK_PASSWORD: this.config.tpLinkPassword } : {}),
        },
        stdio: ["ignore", "pipe", "pipe"],
        windowsHide: true,
      });
      let stdout = "";
      let stderr = "";
      let settled = false;
      const timer = setTimeout(() => finish(new Error("TP-Link discovery timed out")), timeoutMs);
      const finish = (error?: Error, hubs?: TpLinkDiscoveredHub[]): void => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        if (!child.killed) child.kill();
        if (error) reject(error);
        else resolve(hubs ?? []);
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
        if (code !== 0 || !message || !Array.isArray(message.hubs)) {
          finish(new Error(stderr.trim().split(/\r?\n/).at(-1) || "TP-Link discovery helper failed"));
          return;
        }
        const hubs = message.hubs.flatMap((value): TpLinkDiscoveredHub[] => {
          if (!value || typeof value !== "object") return [];
          const item = value as Record<string, unknown>;
          const host = nonEmptyString(item.host);
          const model = nonEmptyString(item.model)?.toUpperCase();
          if (!host || (model !== "H100" && model !== "H200")) return [];
          return [{ host, model, alias: nonEmptyString(item.alias) }];
        });
        finish(undefined, hubs.sort((a, b) => a.host.localeCompare(b.host)));
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
      },
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
    });
    this.#child = child;
    const lines = child.stdout ? createInterface({ input: child.stdout }) : null;
    lines?.on("line", (line) => this.handleLine(line));
    child.stderr?.on("data", (chunk: Buffer | string) => {
      this.#stderr = `${this.#stderr}${chunk.toString()}`.slice(-2_000);
    });
    child.once("error", (error) => {
      if (this.#child !== child) return;
      this.status.value.tpLink.connected = false;
      this.status.value.tpLink.error = `Could not start TP-Link helper: ${error.message}`;
      this.status.changed();
    });
    child.once("close", (code) => {
      lines?.close();
      if (this.#child !== child) return;
      this.#child = null;
      this.status.value.tpLink.connected = false;
      const stderr = this.#stderr.trim().split(/\r?\n/).at(-1);
      this.status.value.tpLink.error = stderr || `TP-Link helper stopped${code === null ? "" : ` with exit code ${code}`}`;
      this.status.changed();
      this.scheduleRestart();
    });
  }

  private handleLine(line: string): void {
    let message: TpLinkHelperMessage;
    try {
      message = JSON.parse(line) as TpLinkHelperMessage;
    } catch {
      this.status.value.tpLink.error = "TP-Link helper returned malformed data";
      this.status.changed();
      return;
    }
    if (message.type === "error") {
      this.status.value.tpLink.connected = false;
      this.status.value.tpLink.error = nonEmptyString(message.message) ?? "TP-Link connection failed";
      this.status.changed();
      return;
    }
    if (message.type !== "snapshot" || !Array.isArray(message.devices)) return;
    this.ingestSnapshot(message);
  }

  private ingestSnapshot(message: TpLinkSnapshotMessage): void {
    const timestamp = Number.isFinite(Date.parse(message.timestamp)) ? new Date(message.timestamp).toISOString() : new Date().toISOString();
    const hubModel = nonEmptyString(message.hubModel)?.toUpperCase() ?? "";
    if (hubModel !== "H100" && hubModel !== "H200") {
      this.status.value.tpLink.connected = false;
      this.status.value.tpLink.error = `Unsupported TP-Link hub model ${message.hubModel || "unknown"}`;
      this.status.changed();
      return;
    }

    this.#attempt = 0;
    this.status.value.tpLink.connected = true;
    this.status.value.tpLink.lastPollAt = timestamp;
    this.status.value.tpLink.hubModel = hubModel;
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
        lastSeenAt: timestamp,
      };
      devices.set(deviceId, device);
      this.#discovered.set(deviceId, device);
    }
    this.status.value.tpLink.discoveredDevices = this.#discovered.size;
    const mappings = this.resolvedMappings();
    const issues: string[] = [];

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
      if (temperature === null || humidity === null) {
        issues.push(`Mapped TP-Link child ${deviceId} does not expose valid temperature and humidity data`);
        continue;
      }

      const previous = this.#lastIngested.get(deviceId);
      const timestampMs = Date.parse(timestamp);
      const unchanged = previous?.sensorId === sensorId && previous.temperature === temperature
        && previous.humidity === humidity && previous.battery === battery;
      if (unchanged && timestampMs - previous.ingestedAt < MAX_UNCHANGED_SAMPLE_AGE_MS) continue;

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
        issues.push(`Could not ingest TP-Link child ${deviceId}: ${reason}`);
      }
    }

    this.status.value.tpLink.error = issues.length ? issues.join("; ") : null;
    this.status.changed();
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
