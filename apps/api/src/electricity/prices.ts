import { lookup } from "node:dns/promises";
import { isIP } from "node:net";
import { isPublicIpAddress } from "../reserved-network-addresses.js";
import {
  DEFAULT_ELECTRICITY_PRICE_ENDPOINT,
  type PropertyElectricityConfig,
  type PropertyElectricityPricePoint,
} from "@climate-twin/contracts";
import type { ClimateDatabase } from "../db.js";

const DEFAULT_REFRESH_INTERVAL_MS = 12 * 60 * 60_000;
const FAILURE_RETRY_INTERVAL_MS = 30 * 60_000;
const NEAR_HORIZON_RETRY_INTERVAL_MS = 60 * 60_000;
const REQUEST_TIMEOUT_MS = 15_000;
const MAX_PRICE_POINTS = 500;
const PRICE_BOUNDARY_GRID_MS = 60_000;
const PRICE_BOUNDARY_TOLERANCE_MS = 1_000;
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
/**
 * Every failure whose message is safe to show an operator. Anything else is
 * reported as a generic refresh failure, because a provider's endpoint query
 * string may carry credentials that must never reach the stored error.
 */
class ElectricityPriceSourceError extends Error {}

interface CompatiblePricePayload {
  prices?: unknown;
}

function normalizedHost(value: string): string {
  return value.trim().toLowerCase().replace(/^\[|\]$/g, "").replace(/\.$/, "");
}

function isPublicAddress(value: string): boolean {
  return isPublicIpAddress(normalizedHost(value));
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
  signal: AbortSignal,
): Promise<void> {
  const hostname = normalizedHost(endpoint.hostname);
  const addresses = isIP(hostname) > 0 ? [hostname] : await waitForOperation(resolver(hostname), signal);
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

function abortReason(signal: AbortSignal): Error {
  return signal.reason instanceof Error
    ? signal.reason
    : new ElectricityPriceSourceError("Electricity price request timed out");
}

function waitForOperation<T>(operation: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) return Promise.reject(abortReason(signal));
  return new Promise<T>((resolve, reject) => {
    const aborted = (): void => {
      signal.removeEventListener("abort", aborted);
      reject(abortReason(signal));
    };
    signal.addEventListener("abort", aborted, { once: true });
    void operation.then(
      (value) => {
        signal.removeEventListener("abort", aborted);
        resolve(value);
      },
      (error) => {
        signal.removeEventListener("abort", aborted);
        reject(error);
      },
    );
  });
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
    const result = await waitForOperation(reader.read(), controller.signal);
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

/**
 * Feeds commonly encode inclusive interval boundaries ("…:14:59.999"). The
 * cost planner and rollup eligibility treat intervals as half-open on exact
 * minute edges, so a boundary within one second of a minute edge is that edge.
 */
function snappedBoundaryMs(value: number): number {
  const offset = ((value % PRICE_BOUNDARY_GRID_MS) + PRICE_BOUNDARY_GRID_MS) % PRICE_BOUNDARY_GRID_MS;
  if (offset === 0) return value;
  if (offset >= PRICE_BOUNDARY_GRID_MS - PRICE_BOUNDARY_TOLERANCE_MS) {
    return value + (PRICE_BOUNDARY_GRID_MS - offset);
  }
  if (offset <= PRICE_BOUNDARY_TOLERANCE_MS) return value - offset;
  return value;
}

/** Validates and preserves upstream cents/kWh values without applying contract adjustments. */
export function parseElectricityPricePayload(payload: unknown): Array<{
  startAt: string;
  endAt: string;
  rawPriceCentsPerKwh: number;
}> {
  const candidates = (payload as CompatiblePricePayload | null)?.prices;
  if (!Array.isArray(candidates) || candidates.length === 0 || candidates.length > MAX_PRICE_POINTS) {
    throw new ElectricityPriceSourceError("Electricity price feed must contain between 1 and 500 prices");
  }
  const seen = new Set<string>();
  const prices = candidates.map((candidate, index) => {
    if (!candidate || typeof candidate !== "object") {
      throw new ElectricityPriceSourceError(`Invalid electricity price at index ${index}`);
    }
    const value = candidate as Record<string, unknown>;
    const rawPriceCentsPerKwh = finitePrice(value.price);
    const parsedStartMs = typeof value.startDate === "string" ? Date.parse(value.startDate) : NaN;
    const parsedEndMs = typeof value.endDate === "string" ? Date.parse(value.endDate) : NaN;
    const startMs = Number.isFinite(parsedStartMs) ? snappedBoundaryMs(parsedStartMs) : NaN;
    const endMs = Number.isFinite(parsedEndMs) ? snappedBoundaryMs(parsedEndMs) : NaN;
    if (rawPriceCentsPerKwh === null || !Number.isFinite(startMs) || !Number.isFinite(endMs) || endMs <= startMs) {
      throw new ElectricityPriceSourceError(`Invalid electricity price fields at index ${index}`);
    }
    const startAt = new Date(startMs).toISOString();
    if (seen.has(startAt)) throw new ElectricityPriceSourceError(`Duplicate electricity price interval ${startAt}`);
    seen.add(startAt);
    return { startAt, endAt: new Date(endMs).toISOString(), rawPriceCentsPerKwh };
  }).sort((left, right) => left.startAt.localeCompare(right.startAt));
  for (let index = 1; index < prices.length; index += 1) {
    const previous = prices[index - 1]!;
    const current = prices[index]!;
    if (Date.parse(previous.endAt) > Date.parse(current.startAt)) {
      throw new ElectricityPriceSourceError(`Electricity price intervals overlap at ${current.startAt}`);
    }
  }
  return prices;
}

export class ElectricityPriceService {
  #timer: NodeJS.Timeout | null = null;
  #started = false;
  #generation = 0;
  #inFlight = new Map<string, Promise<PropertyElectricityPricePoint[]>>();

  constructor(
    private readonly database: ClimateDatabase,
    private readonly fetcher: typeof fetch = fetch,
    private readonly refreshIntervalMs = DEFAULT_REFRESH_INTERVAL_MS,
    private readonly endpointPolicy: ElectricityEndpointPolicy = {},
    private readonly onPricesStored?: (propertyId: string) => void | Promise<void>,
  ) {}

  start(): void {
    if (this.#started) return;
    this.#started = true;
    this.#generation += 1;
    void this.#runScheduledCycle(this.#generation);
  }

  stop(): void {
    this.#started = false;
    if (this.#timer) clearTimeout(this.#timer);
    this.#timer = null;
  }

  async refreshAll(): Promise<void> {
    await this.#refreshCycle();
  }

  async #runScheduledCycle(generation: number): Promise<void> {
    let delayMs = Math.min(this.refreshIntervalMs, FAILURE_RETRY_INTERVAL_MS);
    try {
      delayMs = await this.#refreshCycle();
    } catch {
      // #refreshCycle only reads local state outside of settled fetches;
      // treat an unexpected failure like a fetch failure and retry soon.
    }
    // A stop()+start() during the awaited cycle starts a fresh chain; this
    // stale one must end instead of doubling the schedule forever.
    if (!this.#started || generation !== this.#generation) return;
    this.#timer = setTimeout(() => {
      this.#timer = null;
      void this.#runScheduledCycle(generation);
    }, delayMs);
    this.#timer.unref();
  }

  /**
   * Refresh every enabled Property and choose the next attempt from the
   * outcome. Spot feeds publish roughly a day and a half ahead, so a blindly
   * fixed 12-hour cadence turns one failed attempt into a same-day coverage
   * hole: retry failures soon, and keep retrying hourly while the stored
   * horizon does not yet cover the next scheduled refresh.
   */
  async #refreshCycle(): Promise<number> {
    const enabled = this.database.listPropertyElectricityConfigs()
      .filter((config) => config.enabled);
    const outcomes = await Promise.allSettled(
      enabled.map((config) => this.refresh(config.propertyId)),
    );
    if (outcomes.some((outcome) => outcome.status === "rejected")) {
      return Math.min(this.refreshIntervalMs, FAILURE_RETRY_INTERVAL_MS);
    }
    const horizonAt = new Date(Date.now() + this.refreshIntervalMs).toISOString();
    const nearHorizon = enabled.some((config) => (
      this.database.getCurrentPropertyElectricityPrice(config.propertyId, horizonAt) === null
    ));
    return nearHorizon
      ? Math.min(this.refreshIntervalMs, NEAR_HORIZON_RETRY_INTERVAL_MS)
      : this.refreshIntervalMs;
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
    const timeout = setTimeout(() => controller.abort(
      new ElectricityPriceSourceError("Electricity price request timed out"),
    ), REQUEST_TIMEOUT_MS);
    timeout.unref();
    try {
      const endpoint = validateElectricityEndpointUrl(config.endpointUrl, allowPrivateNetwork);
      if (config.provider === "porssisahko" && endpoint.toString() !== DEFAULT_ELECTRICITY_PRICE_ENDPOINT) {
        throw new ElectricityEndpointPolicyError("The Porssisahko provider must use its canonical endpoint");
      }
      // `fetch` resolves the hostname again, so a hostile authority could in
      // principle answer differently for the two lookups. The endpoint is
      // operator-configured rather than caller-supplied, and Node offers no
      // connect-time address hook here, so this pre-check plus the redirect ban
      // is the boundary we enforce.
      await resolveEndpoint(endpoint, this.endpointPolicy.resolver ?? defaultResolver, allowPrivateNetwork, controller.signal);
      const response = await waitForOperation(
        this.fetcher(endpoint.toString(), {
          headers: { accept: "application/json", "user-agent": "Stugu electricity-price integration" },
          redirect: "error",
          signal: controller.signal,
        }),
        controller.signal,
      );
      if (response.redirected) throw new ElectricityPriceSourceError("Electricity price source redirects are not allowed");
      if (!response.ok) {
        throw new ElectricityPriceSourceError(`Electricity price source returned HTTP ${response.status}`);
      }
      const payload = await limitedJson(response, controller);
      const prices = parseElectricityPricePayload(payload);
      const fetchedAt = new Date().toISOString();
      this.database.storePropertyElectricityPrices(propertyId, prices, fetchedAt);
      try {
        const wake = this.onPricesStored?.(propertyId);
        if (wake) void wake.catch(() => undefined);
      } catch {
        // SQLite remains the crash-safe buffer when a best-effort archive wake fails.
      }
      return this.database.listPropertyElectricityPrices(
        propertyId,
        prices[0]!.startAt,
        prices.at(-1)!.endAt,
      );
    } catch (error) {
      // Only the two deliberately public error types carry their message
      // through. Matching on message text instead silently dropped parse and
      // interval failures into the generic branch, because none of those
      // messages actually start with "Electricity price".
      const message = error instanceof Error && error.name === "AbortError"
        ? "Electricity price request timed out"
        : error instanceof ElectricityEndpointPolicyError || error instanceof ElectricityPriceSourceError
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
