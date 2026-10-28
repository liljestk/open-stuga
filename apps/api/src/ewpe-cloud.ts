import {
  createCipheriv,
  createDecipheriv,
  createHash,
  randomBytes,
} from "node:crypto";
import { connectAsync, type MqttClient } from "mqtt";
import type { GreeDiscoveredDevice, HeatPumpDiagnostics, HeatPumpMode } from "@climate-twin/contracts";
import { abortableDelay } from "./abortable-delay.js";
import type { GreeBindingResult, GreeStatePayload } from "./gree-protocol.js";
import type { GreeConnectionSecret } from "./integration-secrets.js";

const API_BASE = "https://eugrih.gree.com";
const APP_ID = "4920681951525131286";
const APP_HASH = "0fa513124aa97781d1f3f40d61ca1a89";
const API_AES_KEY = Buffer.from("#G$&^jgfujy6ujxt", "utf8");
const GAEN1 = "5ac2bdf935bcca70";
const PUBLIC_DEVICE_KEY = "a3K8Bx%2r8Y7GREE";
const RESPONSE_LIMIT = 1024 * 1024;

const FALLBACK_BROKERS: BrokerAddress[] = [
  { host: "mqtt-eu.gree.com", port: 1984 },
  { host: "mqtt-eu.gree.com", port: 1994 },
];

const FALLBACK_COLS = [
  "Pow", "Mod", "SetTem", "WdSpd", "Air", "Blo", "Health", "SwhSlp", "SlpMod",
  "Lig", "SwingLfRig", "SwUpDn", "Quiet", "Tur", "StHt", "TemUn",
  "HeatCoolType", "TemRec", "SvSt", "TemSen", "InTem", "OutTem",
  "Dwet", "DwatSen", "Dfltr", "DwatFul", "Dmod",
  "CompressorFqy", "EnvTem", "CompTem", "WatSen", "AllEle", "Elec",
  "ErrCode", "AllErr", "ShutDownErr", "SubErr", "wifiStatus",
];

interface BrokerAddress {
  host: string;
  port: number;
}

interface CloudSession {
  uid: string;
  token: string;
}

interface InventoryDevice {
  record: Record<string, unknown>;
  mac: string;
  key: string;
  cols: string[];
  homeName: string | null;
  roomName: string | null;
}

export interface EwpeCloudSnapshot {
  device: GreeDiscoveredDevice;
  state: GreeStatePayload;
}

export interface EwpeMonitorSession<Link> {
  connect(): Promise<Link>;
  query(link: Link): Promise<EwpeCloudSnapshot>;
  close(link: Link): Promise<void>;
}

export interface EwpeMonitorOptions {
  pollIntervalMs: number;
  retryDelayMs?: number;
  /** Called for every failed poll or reconnect, including the one that ends the session. */
  onPollFailure?: (error: unknown) => void;
}

export interface EwpeCloudTransport {
  discover(username: string, password: string): Promise<GreeDiscoveredDevice[]>;
  bind(username: string, password: string, mac: string): Promise<GreeBindingResult>;
  monitor(
    connection: GreeConnectionSecret,
    pollIntervalMs: number,
    signal: AbortSignal,
    onSnapshot: (snapshot: EwpeCloudSnapshot) => void,
    onPollFailure?: (error: unknown) => void,
  ): Promise<void>;
}

// The EWPE cloud API defines its request signatures and login hash with MD5.
// Stugu never uses this digest to protect anything of its own.
function md5(value: string): string {
  return createHash("md5").update(value, "utf8").digest("hex");
}

function timestamp(now: Date): string {
  return now.toISOString().replace("T", " ").slice(0, 19);
}

function compactJson(value: unknown): string {
  return JSON.stringify(value);
}

function aesAlgorithm(key: Buffer): string {
  if (key.length === 16) return "aes-128-ecb";
  if (key.length === 24) return "aes-192-ecb";
  if (key.length === 32) return "aes-256-ecb";
  throw new Error("EWPE returned an unsupported encryption key");
}

function encryptText(value: string, key: Buffer): string {
  const cipher = createCipheriv(aesAlgorithm(key), key, null);
  cipher.setAutoPadding(true);
  return Buffer.concat([cipher.update(value, "utf8"), cipher.final()]).toString("base64");
}

function decryptText(value: string, key: Buffer): string {
  const decipher = createDecipheriv(aesAlgorithm(key), key, null);
  decipher.setAutoPadding(true);
  return Buffer.concat([decipher.update(Buffer.from(value, "base64")), decipher.final()]).toString("utf8");
}

export function buildEwpeRequestBody(
  payload: Record<string, string | number>,
  hashProperties: readonly string[],
  now = new Date(),
): Record<string, unknown> {
  const time = timestamp(now);
  const nonce = Math.floor(now.getTime() / 1_000);
  return {
    api: {
      appId: APP_ID,
      r: nonce,
      t: time,
      vc: md5(`${APP_ID}_${APP_HASH}_${time}_${nonce}`),
    },
    datVc: md5(`${APP_HASH}_${hashProperties.map((name) => payload[name]).join("_")}`),
    ...payload,
  };
}

function responseObject(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("EWPE cloud returned an invalid response");
  }
  return value as Record<string, unknown>;
}

function boundedJson(text: string): Record<string, unknown> {
  if (Buffer.byteLength(text, "utf8") > RESPONSE_LIMIT) {
    throw new Error("EWPE cloud returned an oversized response");
  }
  return responseObject(JSON.parse(text));
}

async function apiPost(
  endpoint: string,
  body: Record<string, unknown>,
  signal?: AbortSignal,
): Promise<Record<string, unknown>> {
  const requestSignal = signal
    ? AbortSignal.any([signal, AbortSignal.timeout(30_000)])
    : AbortSignal.timeout(30_000);
  const response = await fetch(`${API_BASE}${endpoint}`, {
    method: "POST",
    redirect: "error",
    signal: requestSignal,
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
      Gaen1: GAEN1,
      Charset: "utf-8",
    },
    body: encryptText(compactJson(body), API_AES_KEY),
  });
  if (!response.ok) throw new Error("EWPE cloud request failed");
  const wrapper = boundedJson(await response.text());
  if (typeof wrapper.enRes !== "string" || wrapper.enRes.length > RESPONSE_LIMIT * 2) {
    throw new Error("EWPE cloud returned an invalid encrypted response");
  }
  return boundedJson(decryptText(wrapper.enRes, API_AES_KEY));
}

async function login(username: string, password: string, signal?: AbortSignal): Promise<CloudSession> {
  const now = new Date();
  const time = timestamp(now);
  const first = md5(password);
  const passwordHash = md5(`${md5(`${first}${password}`)}${time}`);
  const payload = { psw: passwordHash, t: time, user: username };
  const result = await apiPost(
    "/App/UserLoginV2",
    buildEwpeRequestBody(payload, ["user", "psw", "t"], now),
    signal,
  );
  if ((typeof result.uid !== "number" && typeof result.uid !== "string")
    || typeof result.token !== "string" || !result.token) {
    throw new Error("EWPE cloud rejected the account credentials");
  }
  return { uid: String(result.uid), token: result.token };
}

function array(value: unknown, maximum = 256): Record<string, unknown>[] {
  return Array.isArray(value)
    ? value.slice(0, maximum).filter((item): item is Record<string, unknown> => (
        Boolean(item) && typeof item === "object" && !Array.isArray(item)
      ))
    : [];
}

function optionalText(value: unknown, maximum = 200): string | null {
  return typeof value === "string" && value.trim() && value.length <= maximum ? value.trim() : null;
}

function normalizeMac(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const mac = value.replace(/[:-]/g, "").trim().toUpperCase();
  return /^[0-9A-F]{12}$/u.test(mac) ? mac : null;
}

function parsedJson(value: unknown): unknown {
  if (typeof value !== "string" || !/^[\[{]/u.test(value.trim())) return value;
  try { return JSON.parse(value); } catch { return value; }
}

function inventoryCols(record: Record<string, unknown>): string[] {
  for (const [name, value] of Object.entries(record)) {
    const parsed = parsedJson(value);
    const candidate = name.toLowerCase() === "cols" && Array.isArray(parsed)
      ? parsed
      : parsed && typeof parsed === "object" && !Array.isArray(parsed)
        ? (parsed as Record<string, unknown>).cols
        : null;
    if (!Array.isArray(candidate)) continue;
    const cols = candidate.slice(0, 256).flatMap((item) => (
      typeof item === "string" || typeof item === "number" ? [String(item)] : []
    ));
    if (cols.includes("Pow") && cols.includes("SetTem")) return cols;
  }
  return [...FALLBACK_COLS];
}

function inventoryKey(record: Record<string, unknown>): string | null {
  for (const name of ["key", "privateKey", "privatekey"]) {
    const value = optionalText(record[name], 256);
    if (value) return value;
  }
  return null;
}

async function inventory(session: CloudSession, signal?: AbortSignal): Promise<InventoryDevice[]> {
  const homesPayload = { token: session.token, uid: session.uid };
  const homesResult = await apiPost(
    "/App/GetHomes",
    buildEwpeRequestBody(homesPayload, ["token", "uid"]),
    signal,
  );
  const devices: InventoryDevice[] = [];
  for (const home of array(homesResult.home, 64)) {
    const homeId = typeof home.id === "number" || typeof home.id === "string" ? home.id : null;
    if (homeId === null) continue;
    const payload = { token: session.token, homeId, uid: session.uid };
    const result = await apiPost(
      "/App/GetDevsInRoomsOfHomeV2",
      buildEwpeRequestBody(payload, ["token", "uid", "homeId"]),
      signal,
    );
    for (const room of array(result.rooms, 256)) {
      for (const record of array(room.devs, 256)) {
        const mac = normalizeMac(record.mac);
        const key = inventoryKey(record);
        if (!mac || !key) continue;
        devices.push({
          record,
          mac,
          key,
          cols: inventoryCols(record),
          homeName: optionalText(home.name),
          roomName: optionalText(room.name),
        });
      }
    }
  }
  return devices;
}

function validBroker(host: string, port: number): BrokerAddress | null {
  const normalized = host.trim().toLowerCase();
  if (!/^(?:[a-z0-9-]+\.)+gree\.com$/u.test(normalized)
    || !Number.isInteger(port) || port < 1 || port > 65_535) return null;
  return { host: normalized, port };
}

function collectBrokerAddresses(value: unknown, addresses: BrokerAddress[], key = ""): void {
  if (addresses.length >= 16) return;
  if (typeof value === "string") {
    for (const match of value.matchAll(/(?:ssl|mqtts):\/\/([^\s/:]+):(\d{1,5})/giu)) {
      const address = validBroker(match[1]!, Number(match[2]));
      if (address) addresses.push(address);
    }
    if (/ssl|mqtt/iu.test(key)) {
      const match = /^([^\s/:]+):(\d{1,5})$/u.exec(value.trim());
      const address = match ? validBroker(match[1]!, Number(match[2])) : null;
      if (address) addresses.push(address);
    }
    return;
  }
  if (Array.isArray(value)) {
    value.slice(0, 64).forEach((item) => collectBrokerAddresses(item, addresses, key));
    return;
  }
  if (!value || typeof value !== "object") return;
  Object.entries(value as Record<string, unknown>).slice(0, 64)
    .forEach(([name, item]) => collectBrokerAddresses(item, addresses, name));
}

async function brokerAddresses(signal?: AbortSignal): Promise<BrokerAddress[]> {
  try {
    const response = await fetch(`${API_BASE}/shadow/api/getAddressV3?ssl=true`, {
      method: "POST",
      redirect: "error",
      signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(15_000)]) : AbortSignal.timeout(15_000),
      headers: { Gaen1: GAEN1, Charset: "utf-8" },
    });
    if (!response.ok) throw new Error("broker lookup failed");
    const wrapper = boundedJson(await response.text());
    if (typeof wrapper.enRes !== "string") throw new Error("broker lookup failed");
    const result = boundedJson(decryptText(wrapper.enRes, API_AES_KEY));
    const found: BrokerAddress[] = [];
    collectBrokerAddresses(result, found);
    const unique = [...new Map(found.map((address) => [`${address.host}:${address.port}`, address])).values()];
    if (unique.length > 0) return unique;
  } catch (error) {
    if (signal?.aborted) throw error;
  }
  return FALLBACK_BROKERS.map((address) => ({ ...address }));
}

function deviceKeyCandidates(value: string): Buffer[] {
  const candidates: Buffer[] = [];
  const add = (candidate: Buffer) => {
    if ([16, 24, 32].includes(candidate.length)
      && !candidates.some((current) => current.equals(candidate))) candidates.push(candidate);
  };
  add(Buffer.from(value, "utf8"));
  if (/^(?:[0-9a-f]{2})+$/iu.test(value)) add(Buffer.from(value, "hex"));
  try { add(Buffer.from(value, "base64")); } catch { /* invalid base64 */ }
  return candidates;
}

function encryptDevice(payload: Record<string, unknown>, key: string): string {
  const candidate = deviceKeyCandidates(key)[0];
  if (!candidate) throw new Error("EWPE returned an unsupported device key");
  return encryptText(compactJson(payload), candidate);
}

function decryptDevice(pack: string, key: string, publicKey: boolean): Record<string, unknown> | null {
  const candidates = deviceKeyCandidates(publicKey ? PUBLIC_DEVICE_KEY : key);
  for (const candidate of candidates) {
    try { return responseObject(JSON.parse(decryptText(pack, candidate))); } catch { /* try next encoding */ }
  }
  return null;
}

function inventoryString(record: Record<string, unknown>, names: string[]): string | null {
  for (const name of names) {
    const value = optionalText(record[name]);
    if (value) return value;
  }
  return null;
}

function publicDevice(device: InventoryDevice, broker: BrokerAddress): GreeDiscoveredDevice {
  const name = inventoryString(device.record, ["devNoteName", "name", "deviceName", "ssid"]);
  return {
    transport: "ewpe-cloud",
    host: broker.host,
    port: broker.port,
    mac: device.mac,
    name,
    brand: inventoryString(device.record, ["brand", "manufacturer"]) ?? "Gree/Wilfa",
    model: inventoryString(device.record, ["prodModel", "model", "mid"]),
    version: inventoryString(device.record, ["ver", "version", "hid"]),
    cloudHomeName: device.homeName,
    cloudRoomName: device.roomName,
  };
}

const clientAbortHandlers = new WeakMap<MqttClient, { signal: AbortSignal; onAbort: () => void }>();

/**
 * End the client as soon as the signal aborts. The signal outlives the client
 * (one per monitor session, many links per session), so stopClient removes
 * the handler again; otherwise every reconnect would leak a listener that
 * keeps the ended client reachable for the rest of the session.
 */
export function attachAbortToClient(client: MqttClient, signal: AbortSignal): void {
  const onAbort = () => { void client.endAsync(true); };
  signal.addEventListener("abort", onAbort, { once: true });
  clientAbortHandlers.set(client, { signal, onAbort });
}

async function connectBroker(
  session: CloudSession,
  addresses: BrokerAddress[],
  signal?: AbortSignal,
): Promise<{ client: MqttClient; broker: BrokerAddress }> {
  let lastError: unknown;
  for (const broker of addresses) {
    if (signal?.aborted) throw signal.reason;
    try {
      const client = await connectAsync(`mqtts://${broker.host}:${broker.port}`, {
        username: session.uid,
        password: session.token,
        clientId: randomBytes(16).toString("hex").slice(0, 22),
        protocolVersion: 4,
        clean: true,
        keepalive: 60,
        connectTimeout: 12_000,
        reconnectPeriod: 0,
        rejectUnauthorized: true,
      });
      if (signal) attachAbortToClient(client, signal);
      return { client, broker };
    } catch (error) {
      lastError = error;
    }
  }
  throw new Error(`EWPE MQTT connection failed${lastError ? "" : " before a broker was available"}`);
}

async function subscribe(client: MqttClient, mac: string): Promise<void> {
  const topicMac = mac.toLowerCase();
  await client.subscribeAsync({
    [`response/${topicMac}`]: { qos: 1 },
    [`response/${topicMac}/#`]: { qos: 1 },
    [`status/${topicMac}`]: { qos: 1 },
    [`status/${topicMac}/#`]: { qos: 1 },
    [`connect/${topicMac}`]: { qos: 1 },
  });
}

function queryState(
  client: MqttClient,
  session: CloudSession,
  device: InventoryDevice,
  signal?: AbortSignal,
): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    let settled = false;
    const finish = (error?: unknown, result?: Record<string, unknown>) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      client.off("message", onMessage);
      signal?.removeEventListener("abort", onAbort);
      if (error) reject(error);
      else resolve(result!);
    };
    const onAbort = () => finish(signal?.reason ?? new Error("EWPE query stopped"));
    const onMessage = (_topic: string, payload: Buffer) => {
      if (payload.length > RESPONSE_LIMIT) return;
      try {
        const envelope = responseObject(JSON.parse(payload.toString("utf8")));
        if (typeof envelope.pack !== "string") return;
        const decoded = decryptDevice(envelope.pack, device.key, Number(envelope.i ?? 0) === 1);
        if (!decoded || !Array.isArray(decoded.cols) || !Array.isArray(decoded.dat)) return;
        finish(undefined, decoded);
      } catch {
        // Ignore unrelated or malformed broker messages until the bounded timeout.
      }
    };
    const timer = setTimeout(() => finish(new Error("EWPE live-state response timed out")), 15_000);
    timer.unref();
    client.on("message", onMessage);
    signal?.addEventListener("abort", onAbort, { once: true });
    const topicMac = device.mac.toLowerCase();
    const plaintext = { cols: device.cols, mac: topicMac, t: "status" };
    const envelope = {
      pack: encryptDevice(plaintext, device.key),
      i: 0,
      tcid: topicMac,
      uid: session.uid,
      cid: Array.from(randomBytes(10), (value) => String(value % 10)).join(""),
    };
    void client.publishAsync(`request/${topicMac}`, compactJson(envelope), { qos: 2, retain: false })
      .catch((error) => finish(error));
  });
}

function valuesFromResponse(response: Record<string, unknown>): Record<string, unknown> {
  const cols = Array.isArray(response.cols) ? response.cols : [];
  const data = Array.isArray(response.dat) ? response.dat : [];
  return Object.fromEntries(cols.slice(0, 512).flatMap((name, index) => (
    typeof name === "string" && index < data.length ? [[name, data[index]]] : []
  )));
}

function numberValue(value: unknown, minimum = -1_000_000, maximum = 1_000_000): number | null {
  if ((typeof value !== "number" && typeof value !== "string") || value === "") return null;
  const number = Number(value);
  return Number.isFinite(number) && number >= minimum && number <= maximum ? number : null;
}

function numberField(values: Record<string, unknown>, names: string[]): number | null {
  for (const name of names) {
    const value = numberValue(values[name]);
    if (value !== null) return value;
  }
  return null;
}

function boolField(values: Record<string, unknown>, name: string): boolean | null {
  const value = numberValue(values[name], 0, 1);
  return value === null ? null : value === 1;
}

function label(value: unknown, labels: Record<number, string>): string | null {
  const number = numberValue(value, 0, 100);
  return number === null ? null : labels[number] ?? `unknown-${number}`;
}

function currentTemperature(values: Record<string, unknown>, version: string | null): number | null {
  let value = numberValue(values.TemSen, -200, 300);
  if (value === null) return null;
  const major = version ? Number.parseInt(version.split(".", 1)[0]!, 10) : Number.NaN;
  if (major !== 4) {
    if (value === 0) return null;
    value -= 40;
  }
  if (numberValue(values.TemUn, 0, 1) === 1) value = (value - 32) * 5 / 9;
  return value >= -60 && value <= 60 ? Number(value.toFixed(1)) : null;
}

function targetHumidity(value: unknown): number | null {
  const encoded = numberValue(value, 0, 100);
  if (encoded === null) return null;
  const percent = encoded <= 13 ? 15 + encoded * 5 : encoded;
  return percent <= 100 ? percent : null;
}

function diagnostics(values: Record<string, unknown>): HeatPumpDiagnostics {
  const fields: Array<[keyof HeatPumpDiagnostics, string[]]> = [
    ["environmentTemperatureRaw", ["EnvTem"]],
    ["indoorCoilTemperatureRaw", ["InTem"]],
    ["outdoorTemperatureRaw", ["OutTem"]],
    ["compressorTemperatureRaw", ["CompTem"]],
    ["waterSensorRaw", ["WatSen"]],
    ["totalEnergyRaw", ["AllEle", "TotalEle"]],
    ["energyConsumptionRaw", ["Elec", "Energy"]],
    ["sleepModeRaw", ["SlpMod"]],
    ["temperatureUnitRaw", ["TemUn"]],
    ["temperatureRecordRaw", ["TemRec"]],
    ["heatCoolTypeRaw", ["HeatCoolType"]],
    ["faultCode", ["ErrCode", "Err"]],
    ["allErrors", ["AllErr"]],
    ["shutdownFaults", ["ShutDownErr", "StopErr"]],
    ["subhealthFaults", ["SubErr", "Subhealth"]],
    ["wifiStatus", ["wifiStatus", "WifiStatus"]],
  ];
  return Object.fromEntries(fields.flatMap(([name, aliases]) => {
    const value = numberField(values, aliases);
    return value === null ? [] : [[name, value]];
  }));
}

export function normalizeEwpeState(
  values: Record<string, unknown>,
  version: string | null,
  now = new Date(),
): GreeStatePayload {
  const current = currentTemperature(values, version);
  const power = boolField(values, "Pow");
  const mode = label(values.Mod, { 0: "auto", 1: "cool", 2: "dry", 3: "fan", 4: "heat" }) as HeatPumpMode | null;
  const compressorFrequency = numberField(values, ["CompressorFqy", "CompFqy"]);
  const wifiStatus = numberField(values, ["wifiStatus", "WifiStatus"]);
  return {
    observedAt: now.toISOString(),
    available: wifiStatus !== 0,
    power,
    selectedMode: mode,
    targetTemperatureC: numberValue(values.SetTem, -60, 100),
    currentTemperatureC: current,
    currentTemperatureSource: current === null ? "unavailable" : "reported",
    currentHumidityPercent: numberValue(values.DwatSen, 0, 100),
    targetHumidityPercent: targetHumidity(values.Dwet),
    fanSpeed: label(values.WdSpd, { 0: "auto", 1: "low", 2: "medium-low", 3: "medium", 4: "medium-high", 5: "high" }),
    horizontalSwing: label(values.SwingLfRig, { 0: "fixed", 1: "full", 2: "left", 3: "middle-left", 4: "middle", 5: "middle-right", 6: "right" }),
    verticalSwing: label(values.SwUpDn, { 0: "fixed", 1: "full", 2: "top", 3: "middle-top", 4: "middle", 5: "middle-bottom", 6: "bottom" }),
    freshAir: boolField(values, "Air"),
    anion: boolField(values, "Health"),
    sleep: boolField(values, "SwhSlp"),
    light: boolField(values, "Lig"),
    quiet: boolField(values, "Quiet"),
    turbo: boolField(values, "Tur"),
    xfan: boolField(values, "Blo"),
    steadyHeat: boolField(values, "StHt"),
    powerSave: boolField(values, "SvSt"),
    cleanFilter: boolField(values, "Dfltr"),
    waterFull: boolField(values, "DwatFul"),
    dehumidifierMode: label(values.Dmod, { 0: "default", 9: "anion-only" }),
    compressorFrequencyHz: compressorFrequency !== null && compressorFrequency >= 0 && compressorFrequency <= 300
      ? compressorFrequency
      : null,
    diagnostics: diagnostics(values),
    activity: power === false ? "off" : "unknown",
    activityEvidence: power === false ? "protocol" : "unavailable",
  };
}

export async function stopClient(client: MqttClient): Promise<void> {
  const abortHandler = clientAbortHandlers.get(client);
  if (abortHandler) {
    abortHandler.signal.removeEventListener("abort", abortHandler.onAbort);
    clientAbortHandlers.delete(client);
  }
  try { await client.endAsync(true); } catch { /* the socket is already closed */ }
}

const MAX_CONSECUTIVE_POLL_FAILURES = 3;
const DEFAULT_RETRY_DELAY_MS = 5_000;

/**
 * Poll one device until aborted, absorbing transient failures in-session.
 *
 * The MQTT link never reconnects on its own (`reconnectPeriod: 0`), so a
 * single dropped socket used to end the whole monitor, and the caller then
 * journaled a heat-pump availability gap for every ~2-second restart. Instead,
 * drop the link and rebuild it on the next attempt; a failed rebuild counts
 * toward the same streak, and only a sustained streak ends the session.
 */
export async function runEwpeMonitorLoop<Link>(
  session: EwpeMonitorSession<Link>,
  options: EwpeMonitorOptions,
  signal: AbortSignal,
  onSnapshot: (snapshot: EwpeCloudSnapshot) => void,
): Promise<void> {
  const retryDelayMs = options.retryDelayMs ?? DEFAULT_RETRY_DELAY_MS;
  let link: Link | null = await session.connect();
  let consecutiveFailures = 0;
  try {
    while (!signal.aborted) {
      try {
        link ??= await session.connect();
        const snapshot = await session.query(link);
        if (signal.aborted) break;
        onSnapshot(snapshot);
        consecutiveFailures = 0;
      } catch (error) {
        if (signal.aborted) break;
        consecutiveFailures += 1;
        options.onPollFailure?.(error);
        if (consecutiveFailures >= MAX_CONSECUTIVE_POLL_FAILURES) throw error;
        if (link !== null) {
          const stale = link;
          link = null;
          await session.close(stale);
        }
        await abortableDelay(retryDelayMs, signal);
        continue;
      }
      await abortableDelay(options.pollIntervalMs, signal);
    }
  } finally {
    if (link !== null) await session.close(link);
  }
}

export class EwpeCloudClient implements EwpeCloudTransport {
  async discover(username: string, password: string): Promise<GreeDiscoveredDevice[]> {
    const session = await login(username, password);
    const [devices, addresses] = await Promise.all([inventory(session), brokerAddresses()]);
    const broker = addresses[0]!;
    return devices.map((device) => publicDevice(device, broker));
  }

  async bind(username: string, password: string, mac: string): Promise<GreeBindingResult> {
    const normalized = normalizeMac(mac);
    if (!normalized) throw new Error("Invalid EWPE device identity");
    const session = await login(username, password);
    const [devices, addresses] = await Promise.all([inventory(session), brokerAddresses()]);
    const target = devices.find((device) => device.mac === normalized);
    if (!target) throw new Error("The heat pump was not found in this EWPE account");
    const { client, broker } = await connectBroker(session, addresses);
    try {
      await subscribe(client, target.mac);
      const device = publicDevice(target, broker);
      const response = await queryState(client, session, target);
      return {
        device,
        key: target.key,
        cipherVersion: 1,
        state: normalizeEwpeState(valuesFromResponse(response), device.version),
      };
    } finally {
      await stopClient(client);
    }
  }

  async monitor(
    connection: GreeConnectionSecret,
    pollIntervalMs: number,
    signal: AbortSignal,
    onSnapshot: (snapshot: EwpeCloudSnapshot) => void,
    onPollFailure?: (error: unknown) => void,
  ): Promise<void> {
    if (!connection.cloudUsername || !connection.cloudPassword) {
      throw new Error("EWPE cloud credentials are unavailable");
    }
    const session = await login(connection.cloudUsername, connection.cloudPassword, signal);
    const [devices, addresses] = await Promise.all([inventory(session, signal), brokerAddresses(signal)]);
    const target = devices.find((device) => device.mac === connection.mac);
    if (!target) throw new Error("The heat pump is no longer present in this EWPE account");
    await runEwpeMonitorLoop({
      connect: async () => {
        const { client, broker } = await connectBroker(session, addresses, signal);
        try {
          await subscribe(client, target.mac);
        } catch (error) {
          await stopClient(client);
          throw error;
        }
        return { client, broker };
      },
      query: async (link: { client: MqttClient; broker: BrokerAddress }) => {
        const device = publicDevice(target, link.broker);
        const response = await queryState(link.client, session, target, signal);
        return { device, state: normalizeEwpeState(valuesFromResponse(response), device.version) };
      },
      close: (link: { client: MqttClient; broker: BrokerAddress }) => stopClient(link.client),
    }, {
      pollIntervalMs: Math.max(10_000, pollIntervalMs),
      ...(onPollFailure ? { onPollFailure } : {}),
    }, signal, onSnapshot);
  }
}
