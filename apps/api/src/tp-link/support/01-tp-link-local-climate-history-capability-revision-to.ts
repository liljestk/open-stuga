import { type ChildProcess } from "node:child_process";
import { readFileSync } from "node:fs";
import { networkInterfaces } from "node:os";
import type { OpeningStateObservation, TpLinkDiscoveredDevice, TpLinkDiscoveredSource } from "@climate-twin/contracts";
import type { ClimateDatabase } from "../../db.js";
import type {
  SensorHistoryRecoveryResult,
} from "../../sensor-gap-recovery.js";
import { RuntimeStatus } from "../../services.js";
import { compareCodeUnits } from "../../text-order.js";

export const TP_LINK_LOCAL_CLIMATE_HISTORY_CAPABILITY_REVISION = "t310-t315-retained-history-v1";
export const TP_LINK_HUB_MODELS = ["H100", "H200", "H500"] as const;
export function isTpLinkHubModel(value: string): value is typeof TP_LINK_HUB_MODELS[number] {
  return (TP_LINK_HUB_MODELS as readonly string[]).includes(value);
}

export interface TpLinkDeviceMapping {
  deviceId: string;
  sensorId: string;
}

export interface TpLinkSnapshotDevice {
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

export interface TpLinkSnapshotMessage {
  type: "snapshot";
  timestamp: string;
  hubModel: string;
  sourceType?: "hub" | "energy-device";
  sourceDeviceId?: string | null;
  sourceAlias?: string | null;
  reportedChildCount?: number | null;
  warning?: string | null;
  devices: TpLinkSnapshotDevice[];
}

export interface TpLinkContactEvent {
  deviceId: string;
  eventId: string;
  sequence?: number;
  state: "open" | "closed";
  timestamp: string;
}

export interface TpLinkContactEventsMessage {
  type: "contact-events";
  timestamp: string;
  events: TpLinkContactEvent[];
}

export interface TpLinkErrorMessage {
  type: "error";
  message: string;
  requestId?: string;
}

export interface TpLinkHostChangeMessage {
  type: "host-change";
  previousHost: string;
  host: string;
  sourceDeviceId?: string | null;
}

export type TpLinkHelperMessage = TpLinkSnapshotMessage | TpLinkContactEventsMessage | TpLinkErrorMessage | TpLinkHostChangeMessage | TpLinkHistoryResultMessage;

export interface TpLinkHistorySample {
  deviceId: string;
  metric: string;
  value: number;
  canonicalUnit: string;
  timestamp: string;
  quality: "good" | "estimated" | "stale";
}

export interface TpLinkHistoryResultMessage {
  type: "history-result";
  requestId?: string;
  deviceId: string;
  metric: string;
  state: SensorHistoryRecoveryResult["state"];
  samples: TpLinkHistorySample[];
  error: string | null;
}

export interface PendingTpLinkHistoryRequest {
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
  sourceType?: "hub" | "energy-device";
  sourceModel?: string;
  sourceAlias?: string | null;
}

export interface TpLinkBridgeOptions {
  onConnectionUpdate?: (update: TpLinkConnectionUpdate) => void;
  onAvailabilityChange?: () => void;
  onOpeningStateRecorded?: (observation: OpeningStateObservation) => void;
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

export function ipv4Octets(value: string): number[] | null {
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

export function tpLinkDiscoveryTargets(referenceHosts: string[] = []): string[] {
  const targets = new Set<string>();
  for (const entries of Object.values(networkInterfaces())) {
    for (const entry of entries ?? []) {
      if (entry.family !== "IPv4" || entry.internal) continue;
      const broadcast = ipv4BroadcastAddress(entry.address, entry.netmask);
      if (broadcast && broadcast !== entry.address) targets.add(broadcast);
    }
  }
  for (const host of referenceHosts) {
    const octets = ipv4Octets(host);
    if (!octets) continue;
    const [first, second] = octets;
    const isPrivate = first === 10
      || (first === 172 && second! >= 16 && second! <= 31)
      || (first === 192 && second === 168);
    if (isPrivate) targets.add(`${octets[0]}.${octets[1]}.${octets[2]}.255`);
  }
  return [...targets].sort((left, right) => left.localeCompare(right));
}

export interface LastIngestedDevice {
  sensorId: string;
  temperature: number;
  humidity: number;
  battery: number | null;
  ingestedAt: number;
}

export interface LastIngestedMeasurement {
  sensorId: string;
  value: number;
  ingestedAt: number;
}

export interface TapoOpeningTarget {
  houseId: string;
  floorId: string;
  elementId: string;
  deviceId: string;
  connectionId: string;
  kind: "door" | "window" | "vent";
  label: string | null;
}

export interface LastIngestedOpeningState {
  state: "open" | "closed";
  ingestedAt: number;
}

export type CachedTpLinkDevice = Omit<TpLinkDiscoveredDevice, "mappedSensorId">;

export const CLIMATE_UNCHANGED_HEARTBEAT_MS = 60_000;

export const STATE_UNCHANGED_HEARTBEAT_MS = 5 * 60_000;

export const STATUS_UNCHANGED_HEARTBEAT_MS = 60_000;

export const REDUNDANT_SOURCE_HANDOVER_MIN_MS = 15_000;

export function nonEmptyString(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

export function tpLinkDeviceType(
  device: Pick<TpLinkSnapshotDevice, "model" | "contactOpen" | "temperature" | "humidity" | "power" | "energy">,
): NonNullable<TpLinkDiscoveredDevice["deviceType"]> {
  const model = device.model.trim().toUpperCase();
  if (typeof device.contactOpen === "boolean" || /\bT110\b/u.test(model)) return "contact";
  if (typeof device.power === "number" || typeof device.energy === "number") return "energy";
  if (typeof device.temperature === "number" || typeof device.humidity === "number"
    || /^T3(?:10|15)(?:\b|\s|\()/u.test(model)) return "climate";
  return "unknown";
}

export function safeTpLinkHistoryFailure(value: unknown): string | null {
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

export function validateTpLinkDeviceMappings(value: unknown): TpLinkDeviceMapping[] {
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
    if (sensorIds.has(sensorId)) throw new Error(`Stugu sensor ${sensorId} is mapped to more than one TP-Link child device`);
    deviceIds.add(deviceId);
    sensorIds.add(sensorId);
    return { deviceId, sensorId };
  }).sort((left, right) => compareCodeUnits(left.deviceId, right.deviceId) || compareCodeUnits(left.sensorId, right.sensorId));
}

export function importTpLinkMappingFile(database: ClimateDatabase, path: string): TpLinkDeviceMapping[] {
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

export interface TpLinkStatusHost {
  value: RuntimeStatus["value"];
  changed(): void;
  synchronized?(): void;
}
