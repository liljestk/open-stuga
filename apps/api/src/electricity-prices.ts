import { lookup } from "node:dns/promises";
import { BlockList, isIP } from "node:net";
import {
  DEFAULT_ELECTRICITY_PRICE_ENDPOINT,
  type PropertyElectricityConfig,
  type PropertyElectricityPricePoint,
} from "@climate-twin/contracts";
import type { ClimateDatabase } from "./db.js";

const DEFAULT_REFRESH_INTERVAL_MS = 12 * 60 * 60_000;
const REQUEST_TIMEOUT_MS = 15_000;
const MAX_PRICE_POINTS = 500;
export const MAX_ELECTRICITY_RESPONSE_BYTES = 1_048_576;

export type ElectricityEndpointResolver = (hostname: string) => Promise<readonly string[]>;

export interface ElectricityEndpointPolicy {
  /**
   * Opt-in for a deliberately local feed. Redirect blocking, HTTPS, response
   * limits, and credential-in-URL restrictions remain enforced.
   */
  allowPrivateNetwork?: boolean;
  resolver?: ElectricityEndpointResolver;
}

export class ElectricityEndpointPolicyError extends Error {}
class ElectricityPriceSourceError extends Error {}

interface CompatiblePricePayload {
  prices?: unknown;
}

function normalizedHost(value: string): string {
  return value.trim().toLowerCase().replace(/^\[|\]$/g, "").replace(/\.$/, "");
}

const RESERVED_ADDRESSES = new BlockList();
for (const [network, prefix] of [
  ["0.0.0.0", 8], ["10.0.0.0", 8], ["100.64.0.0", 10], ["127.0.0.0", 8],
  ["169.254.0.0", 16], ["172.16.0.0", 12], ["192.0.0.0", 24], ["192.0.2.0", 24],
  ["192.168.0.0", 16], ["198.18.0.0", 15], ["198.51.100.0", 24], ["203.0.113.0", 24],
  ["224.0.0.0", 4], ["240.0.0.0", 4],
] as const) RESERVED_ADDRESSES.addSubnet(network, prefix, "ipv4");
for (const [network, prefix] of [
  ["::", 128], ["::1", 128], ["64:ff9b:1::", 48], ["100::", 64], ["2001:2::", 48],
  ["2001:10::", 28], ["2001:db8::", 32], ["fc00::", 7], ["fe80::", 10], ["ff00::", 8],
] as const) RESERVED_ADDRESSES.addSubnet(network, prefix, "ipv6");

function isPublicAddress(value: string): boolean {
  const address = normalizedHost(value);
  const family = isIP(address);
  return family > 0 && !RESERVED_ADDRESSES.check(address, family === 4 ? "ipv4" : "ipv6");
}

function obviouslyLocalHostname(hostname: string): boolean {
  const host = normalizedHost(hostname);
  return host === "localhost" || host.endsWith(".localhost") || host.endsWith(".local")
    || host.endsWith(".internal") || host === "home.arpa" || host.endsWith(".home.arpa");
}

/** Parse an endpoint and reject URL forms that must never reach fetch. */
export function validateElectricityEndpointUrl(endpointUrl: string, allowPrivateNetwork = false): URL {
  let endpoint: URL;
  try { endpoint = new URL(endpointUrl); } catch {
    throw new ElectricityEndpointPolicyError("Electricity price endpoint must be a valid URL");
  }
  if (endpoint.protocol !== "https:" || endpoint.username || endpoint.password) {
    throw new ElectricityEndpointPolicyError("Electricity price endpoint must use HTTPS without embedded credentials");
  }
  const host = normalizedHost(endpoint.hostname);
  if (!host) throw new ElectricityEndpointPolicyError("Electricity price endpoint must include a hostname");
  if (!allowPrivateNetwork && (obviouslyLocalHostname(host) || (isIP(host) > 0 && !isPublicAddress(host)))) {
    throw new ElectricityEndpointPolicyError("Electricity price endpoint may not target a private or reserved network");
  }
  return endpoint;
}

async function resolveEndpoint(
  endpoint: URL,
  resolver: ElectricityEndpointResolver,
  allowPrivateNetwork: boolean,
): Promise<void> {
  const hostname = normalizedHost(endpoint.hostname);
  const addresses = isIP(hostname) > 0 ? [hostname] : await resolver(hostname);
  if (addresses.length === 0) {
    throw new ElectricityEndpointPolicyError("Electricity price endpoint hostname did not resolve");
  }
  if (!allowPrivateNetwork && addresses.some((address) => !isPublicAddress(address))) {
    throw new ElectricityEndpointPolicyError("Electricity price endpoint resolved to a private or reserved network");
  }
}

async function defaultResolver(hostname: string): Promise<readonly string[]> {
  const results = await lookup(hostname, { all: true, verbatim: true });
  return results.map((result) => result.address);
}

async function limitedJson(response: Response, controller: AbortController): Promise<unknown> {
  const declaredLength = response.headers.get("content-length");
  if (declaredLength !== null && /^\d+$/.test(declaredLength)
    && Number(declaredLength) > MAX_ELECTRICITY_RESPONSE_BYTES) {
    controller.abort();
    throw new ElectricityPriceSourceError("Electricity price response exceeds the 1 MiB limit");
  }
  if (!response.body) throw new ElectricityPriceSourceError("Electricity price source returned an empty response");
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  while (true) {
    const result = await reader.read();
    if (result.done) break;
    total += result.value.byteLength;
    if (total > MAX_ELECTRICITY_RESPONSE_BYTES) {
      controller.abort();
      await reader.cancel().catch(() => undefined);
      throw new ElectricityPriceSourceError("Electricity price response exceeds the 1 MiB limit");
    }
    chunks.push(result.value);
  }
  try {
    const bytes = Buffer.concat(chunks.map((chunk) => Buffer.from(chunk.buffer, chunk.byteOffset, chunk.byteLength)), total);
    return JSON.parse(new TextDecoder().decode(bytes)) as unknown;
  } catch (error) {
    if (error instanceof ElectricityPriceSourceError) throw error;
    throw new ElectricityPriceSourceError("Electricity price source returned invalid JSON");
  }
}

function finitePrice(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) && Math.abs(value) <= 10_000 ? value : null;
}

/** Validates and preserves upstream cents/kWh values without applying contract adjustments. */
export function parseElectricityPricePayload(payload: unknown): Array<{
  startAt: string;
  endAt: string;
  rawPriceCentsPerKwh: number;
}> {
  const candidates = (payload as CompatiblePricePayload | null)?.prices;
  if (!Array.isArray(candidates) || candidates.length === 0 || candidates.length > MAX_PRICE_POINTS) {
    throw new Error("Electricity price feed must contain between 1 and 500 prices");
  }
  const seen = new Set<string>();
  return candidates.map((candidate, index) => {
    if (!candidate || typeof candidate !== "object") throw new Error(`Invalid electricity price at index ${index}`);
    const value = candidate as Record<string, unknown>;
    const rawPriceCentsPerKwh = finitePrice(value.price);
    const startMs = typeof value.startDate === "string" ? Date.parse(value.startDate) : NaN;
    const endMs = typeof value.endDate === "string" ? Date.parse(value.endDate) : NaN;
    if (rawPriceCentsPerKwh === null || !Number.isFinite(startMs) || !Number.isFinite(endMs) || endMs <= startMs) {
      throw new Error(`Invalid electricity price fields at index ${index}`);
    }
    const startAt = new Date(startMs).toISOString();
    if (seen.has(startAt)) throw new Error(`Duplicate electricity price interval ${startAt}`);
    seen.add(startAt);
    return { startAt, endAt: new Date(endMs).toISOString(), rawPriceCentsPerKwh };
  }).sort((left, right) => left.startAt.localeCompare(right.startAt));
}

export class ElectricityPriceService {
  #timer: NodeJS.Timeout | null = null;
  #inFlight = new Map<string, Promise<PropertyElectricityPricePoint[]>>();

  constructor(
    private readonly database: ClimateDatabase,
    private readonly fetcher: typeof fetch = fetch,
    private readonly refreshIntervalMs = DEFAULT_REFRESH_INTERVAL_MS,
    private readonly endpointPolicy: ElectricityEndpointPolicy = {},
  ) {}

  start(): void {
    if (this.#timer) return;
    void this.refreshAll();
    this.#timer = setInterval(() => void this.refreshAll(), this.refreshIntervalMs);
    this.#timer.unref();
  }

  stop(): void {
    if (this.#timer) clearInterval(this.#timer);
    this.#timer = null;
  }

  async refreshAll(): Promise<void> {
    await Promise.allSettled(this.database.listPropertyElectricityConfigs()
      .filter((config) => config.enabled)
      .map((config) => this.refresh(config.propertyId)));
  }

  refresh(propertyId: string): Promise<PropertyElectricityPricePoint[]> {
    const active = this.#inFlight.get(propertyId);
    if (active) return active;
    const operation = this.fetchAndStore(propertyId).finally(() => this.#inFlight.delete(propertyId));
    this.#inFlight.set(propertyId, operation);
    return operation;
  }

  private async fetchAndStore(propertyId: string): Promise<PropertyElectricityPricePoint[]> {
    const config = this.database.getPropertyElectricityConfig(propertyId);
    if (!config) throw new Error("Property electricity configuration not found");
    if (!config.enabled) return [];
    const allowPrivateNetwork = this.endpointPolicy.allowPrivateNetwork === true;
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
    timeout.unref();
    try {
      const endpoint = validateElectricityEndpointUrl(config.endpointUrl, allowPrivateNetwork);
      if (config.provider === "porssisahko" && endpoint.toString() !== DEFAULT_ELECTRICITY_PRICE_ENDPOINT) {
        throw new ElectricityEndpointPolicyError("The Porssisahko provider must use its canonical endpoint");
      }
      await resolveEndpoint(endpoint, this.endpointPolicy.resolver ?? defaultResolver, allowPrivateNetwork);
      const response = await this.fetcher(endpoint.toString(), {
        headers: { accept: "application/json", "user-agent": "Stuga electricity-price integration" },
        redirect: "error",
        signal: controller.signal,
      });
      if (response.redirected) throw new ElectricityPriceSourceError("Electricity price source redirects are not allowed");
      if (!response.ok) throw new Error(`Electricity price source returned HTTP ${response.status}`);
      const payload = await limitedJson(response, controller);
      const prices = parseElectricityPricePayload(payload);
      const fetchedAt = new Date().toISOString();
      this.database.storePropertyElectricityPrices(propertyId, prices, fetchedAt);
      return this.database.listPropertyElectricityPrices(
        propertyId,
        prices[0]!.startAt,
        prices.at(-1)!.endAt,
      );
    } catch (error) {
      const message = error instanceof Error && error.name === "AbortError"
        ? "Electricity price request timed out"
        : error instanceof ElectricityEndpointPolicyError || error instanceof ElectricityPriceSourceError
          ? error.message
          : error instanceof Error && /^Electricity price (?:feed|source returned HTTP|at index|fields|interval)/.test(error.message)
            ? error.message
            : "Electricity price refresh failed";
      this.database.setPropertyElectricityFetchError(propertyId, message);
      throw new Error(message);
    } finally {
      clearTimeout(timeout);
    }
  }
}

export function publicElectricityConfiguration(
  config: PropertyElectricityConfig,
  redactEndpointQuery = false,
): PropertyElectricityConfig {
  if (!redactEndpointQuery) return { ...config };
  try {
    const endpoint = new URL(config.endpointUrl);
    endpoint.search = "";
    endpoint.hash = "";
    return {
      ...config,
      endpointUrl: endpoint.toString(),
      // Historical/custom fetch errors are not guaranteed to be free of a
      // provider's query credentials. Guests need the failure state, not the
      // upstream diagnostic detail.
      lastError: config.lastError === null ? null : "Electricity price source last refresh failed",
    };
  } catch {
    // Persisted values are validated on write, but fail closed for historical
    // data instead of exposing a malformed value verbatim to a Guest.
    return {
      ...config,
      endpointUrl: "[redacted]",
      lastError: config.lastError === null ? null : "Electricity price source last refresh failed",
    };
  }
}
