import type { HomeEnergyProjection, House, Sensor } from "@climate-twin/contracts";
import { LruTtlCache, type CacheStats } from "../cache.js";
import type { AnalyticsWorkLimiter } from "../analytics/work-limiter.js";
import { outdoorLocationKey, type ClimateDatabase } from "../db.js";
import type { EnergySummaryCache } from "../energy-summary-cache.js";
import type { HybridTelemetryReader } from "../timeseries/read-facade.js";
import { EnergyProjectionService } from "./projection-service.js";

/**
 * One projection per Home and hour, shared by the projection route and the
 * analytics diagnostics. It changes with new days, weather forecasts, tariffs
 * and imported history, not with each reading.
 */
export class EnergyProjectionCache {
  readonly #service: EnergyProjectionService;
  readonly #cache = new LruTtlCache<HomeEnergyProjection | null>({
    maxEntries: 64, maxBytes: 2 * 1024 * 1024, defaultTtlMs: 15 * 60_000,
  });

  constructor(
    private readonly database: ClimateDatabase,
    telemetryReader: HybridTelemetryReader,
    summaries: EnergySummaryCache,
    private readonly limiter: AnalyticsWorkLimiter,
  ) {
    this.#service = new EnergyProjectionService(database, telemetryReader, summaries);
  }

  stats(): CacheStats {
    return this.#cache.stats();
  }

  clear(): void {
    this.#cache.clear();
  }

  get(house: House, sensors: readonly Sensor[], signal?: AbortSignal): Promise<HomeEnergyProjection | null> {
    const key = JSON.stringify([
      "energy-projection-v1", house.id, Math.floor(Date.now() / 3_600_000),
      sensors.map((sensor) => [sensor.id, sensor.energyMeterRole ?? "standalone"]),
      this.database.getPropertyElectricityTariff(house.propertyId)?.revision ?? 0,
      this.database.telemetryHistoryRevision(),
      house.location ? this.database.getWeatherSnapshot(house.id, outdoorLocationKey(house.location))?.weather?.fetchedAt ?? null : null,
    ]);
    return this.#cache.getOrLoad(key, (loadSignal) => this.limiter.run(
      "energy-projection",
      () => this.#service.project(house, sensors, loadSignal),
      loadSignal,
    ), { serveStale: false, ...(signal ? { signal } : {}) });
  }
}
