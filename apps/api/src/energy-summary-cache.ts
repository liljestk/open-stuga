import { withSignal } from "@climate-twin/contracts";
import { createHash } from "node:crypto";
import type { EnergyMeterRole, HomeEnergySummary } from "@climate-twin/contracts";
import { LruTtlCache, type CacheStats } from "./cache.js";
import type { ClimateDatabase } from "./db.js";
import type { EnergyCostService } from "./energy-cost.js";
import type { AnalyticsWorkLimiter } from "./analytics/work-limiter.js";

const SUMMARY_TTL_MS = 60_000;
/**
 * A summary still missing sources is shared briefly rather than recomputed
 * for every tab and household client until its sources arrive.
 */
const INCOMPLETE_TTL_MS = 15_000;

export interface EnergySummaryRequest {
  houseId: string;
  propertyId: string;
  timeZone: string;
  sensors: ReadonlyArray<{ id: string; energyMeterRole?: EnergyMeterRole | null }>;
  from: string;
  to: string;
  signal?: AbortSignal;
}

/** One cache of Home energy summaries, shared by the summary route and the optimizer. */
export class EnergySummaryCache {
  readonly #cache = new LruTtlCache<HomeEnergySummary>({
    maxEntries: 128,
    maxBytes: 16 * 1024 * 1024,
    defaultTtlMs: SUMMARY_TTL_MS,
  });

  constructor(
    private readonly database: ClimateDatabase,
    private readonly energyCost: EnergyCostService,
    private readonly limiter: AnalyticsWorkLimiter,
  ) {}

  stats(): CacheStats {
    return this.#cache.stats();
  }

  clear(): void {
    this.#cache.clear();
  }

  async get(request: EnergySummaryRequest): Promise<{ summary: HomeEnergySummary; source: "hit" | "coalesced" | "miss" }> {
    const key = createHash("sha256").update(JSON.stringify([
      "energy-summary-v3",
      request.houseId,
      request.propertyId,
      this.database.getPropertyElectricityTariff(request.propertyId)?.revision ?? 0,
      request.timeZone,
      request.sensors.map((sensor) => [sensor.id, sensor.energyMeterRole ?? "standalone"]),
      request.from,
      request.to,
    ])).digest("hex");
    const hit = this.#cache.has(key);
    const coalesced = !hit && this.#cache.isLoading(key);
    const summary = await this.#cache.getOrLoad(key, (signal) => this.limiter.run(
      "energy-summary",
      () => this.energyCost.summarize({
        houseId: request.houseId,
        propertyId: request.propertyId,
        sensorIds: request.sensors.map((sensor) => sensor.id),
        from: request.from,
        to: request.to,
        signal,
      }),
      signal,
    ), {
      serveStale: false,
      ttlMs: SUMMARY_TTL_MS,
      ...withSignal(request.signal),
    });
    if (!summary.complete && !hit && !coalesced) this.#cache.set(key, summary, { ttlMs: INCOMPLETE_TTL_MS });
    return { summary, source: hit ? "hit" : coalesced ? "coalesced" : "miss" };
  }
}
