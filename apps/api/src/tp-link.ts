import { spawn, type ChildProcess } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { networkInterfaces } from "node:os";
import { createInterface } from "node:readline";
import type { Reading, TpLinkDiscoveredDevice } from "@climate-twin/contracts";
import type { AppConfig } from "./config.js";
import type { ClimateDatabase } from "./db.js";
import { MeasurementService, RuntimeStatus, TelemetryService } from "./services.js";

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

export interface TpLinkHubDiscoveryResult {
  hubs: TpLinkDiscoveredHub[];
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

const MAX_UNCHANGED_SAMPLE_AGE_MS = 5 * 60_000;

function nonEmptyString(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function finiteNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
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
  #running = false;
  #attempt = 0;
  #stderr = "";
  #mappingWarning: string | null = null;
  readonly #legacyMappings = new Map<string, string>();
  readonly #discovered = new Map<string, CachedTpLinkDevice>();
  readonly #lastIngested = new Map<string, LastIngestedDevice>();
  readonly #lastIngestedMeasurements = new Map<string, LastIngestedMeasurement>();
  readonly #lastIngestedOpeningStates = new Map<string, LastIngestedOpeningState>();

  constructor(
    private readonly config: AppConfig,
    private readonly telemetry: TelemetryService,
    private readonly measurements: MeasurementService,
    private readonly database: ClimateDatabase,
    private readonly status: TpLinkStatusHost,
    private readonly connection?: { id: string; houseId: string; acceptUnscoped: boolean },
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
      if (element.kind === "fireplace" || element.stateBinding?.provider !== "tapo") return [];
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

  discoverHubs(timeoutMs = 12_000): Promise<TpLinkHubDiscoveryResult> {
    return new Promise((resolve, reject) => {
      const configuredTargets = process.env.TP_LINK_DISCOVERY_TARGETS?.trim();
      const discoveryTargets = configuredTargets || tpLinkDiscoveryTargets().join(",");
      const child = spawn(this.config.tpLinkPython, [this.config.tpLinkBridgeScript, "--discover"], {
        env: {
          ...process.env,
          ...(discoveryTargets ? { TP_LINK_DISCOVERY_TARGETS: discoveryTargets } : {}),
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
      const finish = (error?: Error, result?: TpLinkHubDiscoveryResult): void => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        if (!child.killed) child.kill();
        if (error) reject(error);
        else resolve(result ?? { hubs: [], warnings: [] });
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
        const warnings = Array.isArray(message.warnings)
          ? message.warnings.flatMap((value): string[] => {
            const warning = nonEmptyString(value);
            return warning ? [warning.slice(0, 500)] : [];
          }).slice(0, 20)
          : [];
        finish(undefined, { hubs: hubs.sort((a, b) => a.host.localeCompare(b.host)), warnings });
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
          finish({
            ok: true,
            connected: true,
            message: "TP-Link credentials and local device polling are available.",
            details: {
              model: nonEmptyString(snapshot.hubModel),
              deviceCount: snapshot.devices.length,
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
      },
      stdio: ["ignore", "pipe", "pipe"],
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
    const sourceType = message.sourceType ?? "hub";
    const supportedHub = hubModel === "H100" || hubModel === "H200";
    if (!supportedHub && sourceType !== "energy-device") {
      this.status.value.tpLink.connected = false;
      this.status.value.tpLink.error = `Unsupported TP-Link source model ${message.hubModel || "unknown"}`;
      this.status.changed();
      return;
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
      if (previous?.state === state && timestampMs - previous.ingestedAt < MAX_UNCHANGED_SAMPLE_AGE_MS) continue;
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
        if (!unchanged || timestampMs - previous.ingestedAt >= MAX_UNCHANGED_SAMPLE_AGE_MS) {
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
    if (unchanged && timestampMs - previous.ingestedAt < MAX_UNCHANGED_SAMPLE_AGE_MS) return;
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
export class TpLinkBridge {
  readonly #workers = new Map<string, { bridge: TpLinkConnectionBridge; status: TpLinkStatusHost; houseId: string }>();
  readonly #tester: TpLinkConnectionBridge;
  #running = false;

  constructor(
    private readonly config: AppConfig,
    private readonly telemetry: TelemetryService,
    private readonly measurements: MeasurementService,
    private readonly database: ClimateDatabase,
    private readonly status: RuntimeStatus,
  ) {
    const testerStatus: TpLinkStatusHost = { value: structuredClone(status.value), changed: () => undefined };
    this.#tester = new TpLinkConnectionBridge(config, telemetry, measurements, database, testerStatus);
  }

  private configuredConnections(): Array<{ id: string; houseId: string; host: string; username: string; password: string }> {
    const explicit = (this.config.tpLinkConnections ?? []).filter((connection) => this.database.getHouse(connection.houseId));
    if (explicit.length > 0) return explicit.map((connection) => ({ ...connection }));
    const houseId = this.database.listHouses()[0]?.id;
    return !this.config.tpLinkLegacyDisabled && houseId && this.config.tpLinkHost && this.config.tpLinkUsername && this.config.tpLinkPassword
      ? [{ id: "legacy", houseId, host: this.config.tpLinkHost, username: this.config.tpLinkUsername, password: this.config.tpLinkPassword }]
      : [];
  }

  start(): void {
    if (this.#running) return;
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
    for (const connection of this.configuredConnections()) {
      const acceptUnscoped = this.configuredConnections()
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
        tpLinkDeviceMapFile: connection.id === "legacy" ? this.config.tpLinkDeviceMapFile : null,
      };
      const bridge = new TpLinkConnectionBridge(
        localConfig, this.telemetry, this.measurements, this.database, localStatus,
        connection.id === "legacy" ? undefined : { id: connection.id, houseId: connection.houseId, acceptUnscoped },
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

  discoverHubs(timeoutMs = 12_000): Promise<TpLinkHubDiscoveryResult> {
    return this.#tester.discoverHubs(timeoutMs);
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
