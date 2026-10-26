import { createHash } from "node:crypto";
import type { AnalyticsQueryRequest, AnalyticsQueryResponse } from "@climate-twin/contracts";
import { LruTtlCache, type CacheStats } from "../../cache.js";
import type { ClimateDatabase } from "../../db.js";
import { SYSTEM_VERSION } from "../../version.js";
import { derivedEvidenceVersion } from "../derived-artifacts/compute.js";

export const ANALYTICS_QUERY_CACHE_KEY_VERSION = "analytics-query-v2";

/**
 * A range ending this long ago is closed: anything that still changes it
 * arrives as late history, which bumps the telemetry history revision.
 */
const CLOSED_AFTER_MS = 2 * 3_600_000;
const CLOSED_TTL_MS = 60 * 60_000;
/** The open tail keeps receiving readings, so it is shared only briefly. */
const OPEN_TTL_MS = 30_000;

export interface AnalyticsQueryCacheInput {
  request: AnalyticsQueryRequest;
  sensorIds: readonly string[];
  expectedIntervalSeconds: ReadonlyMap<string, number>;
}

/**
 * Shares identical analytics queries across tabs and household clients. The
 * key carries everything the answer depends on besides the clock: the request
 * without its id, the visible sensors, the house and registry revisions, the
 * late-history revision, each series' reporting interval and the release.
 */
export class AnalyticsQueryCache {
  readonly #cache = new LruTtlCache<AnalyticsQueryResponse>({
    maxEntries: 256,
    maxBytes: 32 * 1024 * 1024,
    defaultTtlMs: OPEN_TTL_MS,
    // Responses are serialized as they are; callers only wrap them.
    clone: false,
  });

  constructor(
    private readonly database: ClimateDatabase,
    private readonly now: () => number = Date.now,
  ) {}

  stats(): CacheStats {
    return this.#cache.stats();
  }

  clear(): void {
    this.#cache.clear();
  }

  key(input: AnalyticsQueryCacheInput): string {
    const { requestId: _requestId, ...request } = input.request;
    return createHash("sha256").update(JSON.stringify([
      ANALYTICS_QUERY_CACHE_KEY_VERSION,
      SYSTEM_VERSION,
      derivedEvidenceVersion(this.database, input.request.scope.id, "home-performance"),
      this.database.telemetryHistoryRevision(),
      request,
      [...input.sensorIds],
      [...input.expectedIntervalSeconds].sort(([left], [right]) => left.localeCompare(right)),
    ])).digest("hex");
  }

  /**
   * Serves a cached answer or computes one, reporting which happened. Answers
   * built without the merged archive are never shared.
   */
  async getOrCompute(
    input: AnalyticsQueryCacheInput,
    compute: (signal: AbortSignal) => Promise<AnalyticsQueryResponse>,
    signal?: AbortSignal,
  ): Promise<AnalyticsQueryResponse> {
    const key = this.key(input);
    const hit = this.#cache.has(key);
    const closed = Date.parse(input.request.range.end) <= this.now() - CLOSED_AFTER_MS;
    const response = await this.#cache.getOrLoad(key, compute, {
      ttlMs: closed ? CLOSED_TTL_MS : OPEN_TTL_MS,
      serveStale: false,
      ...(signal ? { signal } : {}),
    });
    if (response.provenance.some((item) => item.archiveState === "failed" || item.archiveState === "not-ready")) {
      this.#cache.invalidate(key);
    }
    return {
      ...response,
      requestId: input.request.requestId,
      cache: { hit, keyVersion: ANALYTICS_QUERY_CACHE_KEY_VERSION },
    };
  }
}
