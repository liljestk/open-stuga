import type {
  HostSystemForecastConfidence,
  HostSystemStorageForecast,
} from "@climate-twin/contracts";

const DAY_MS = 86_400_000;
const GIBIBYTE = 1_073_741_824;
const MINIMUM_SAMPLE_COUNT = 4;
const MINIMUM_OBSERVATION_MS = 6 * 60 * 60_000;
const MAXIMUM_FORECAST_MS = 10 * 365 * DAY_MS;

export interface HostStorageSample {
  sampledAtMs: number;
  totalBytes: number;
  availableBytes: number;
}

export interface HostStorageHistory {
  observe(sample: HostStorageSample): HostStorageSample[];
}

export class InMemoryHostStorageHistory implements HostStorageHistory {
  readonly #samples: HostStorageSample[] = [];

  observe(sample: HostStorageSample): HostStorageSample[] {
    this.#samples.push(sample);
    const cutoff = sample.sampledAtMs - 30 * DAY_MS;
    while (this.#samples[0] && this.#samples[0].sampledAtMs < cutoff) this.#samples.shift();
    return [...this.#samples];
  }
}

function confidenceFor(observedMs: number, coefficientOfDetermination: number): HostSystemForecastConfidence {
  const durationConfidence: HostSystemForecastConfidence = observedMs >= 7 * DAY_MS
    ? "high"
    : observedMs >= DAY_MS
      ? "medium"
      : "low";
  if (coefficientOfDetermination < 0.35) return "low";
  if (coefficientOfDetermination < 0.7 && durationConfidence === "high") return "medium";
  return durationConfidence;
}

function projectedAt(nowMs: number, availableBytes: number, thresholdBytes: number, growthBytesPerDay: number): string | null {
  if (availableBytes <= thresholdBytes || growthBytesPerDay <= 0) return null;
  const untilMs = (availableBytes - thresholdBytes) / growthBytesPerDay * DAY_MS;
  if (!Number.isFinite(untilMs) || untilMs <= 0 || untilMs > MAXIMUM_FORECAST_MS) return null;
  return new Date(nowMs + untilMs).toISOString();
}

export function estimateStorageForecast(
  samples: readonly HostStorageSample[],
  nowMs: number,
  totalBytes: number | null,
  availableBytes: number | null,
): HostSystemStorageForecast {
  const valid = samples
    .filter((sample) => Number.isFinite(sample.sampledAtMs)
      && Number.isFinite(sample.availableBytes)
      && (totalBytes === null || Math.abs(sample.totalBytes - totalBytes) <= totalBytes * 0.02)
      && sample.sampledAtMs <= nowMs)
    .sort((left, right) => left.sampledAtMs - right.sampledAtMs);
  const first = valid[0];
  const last = valid.at(-1);
  const observedMs = first && last ? Math.max(0, last.sampledAtMs - first.sampledAtMs) : 0;
  const collecting = (): HostSystemStorageForecast => ({
    state: "collecting",
    sampleCount: valid.length,
    observedSeconds: Math.round(observedMs / 1_000),
    growthBytesPerDay: null,
    warningAt: null,
    criticalAt: null,
    confidence: null,
  });
  if (valid.length < MINIMUM_SAMPLE_COUNT || observedMs < MINIMUM_OBSERVATION_MS
    || totalBytes === null || availableBytes === null || totalBytes <= 0) return collecting();

  const origin = first!.sampledAtMs;
  const points = valid.map((sample) => ({
    x: (sample.sampledAtMs - origin) / DAY_MS,
    y: sample.availableBytes,
  }));
  const meanX = points.reduce((sum, point) => sum + point.x, 0) / points.length;
  const meanY = points.reduce((sum, point) => sum + point.y, 0) / points.length;
  const varianceX = points.reduce((sum, point) => sum + (point.x - meanX) ** 2, 0);
  if (varianceX <= 0) return collecting();
  const slope = points.reduce((sum, point) => sum + (point.x - meanX) * (point.y - meanY), 0) / varianceX;
  const fittedIntercept = meanY - slope * meanX;
  const residual = points.reduce((sum, point) => sum + (point.y - (fittedIntercept + slope * point.x)) ** 2, 0);
  const totalVariance = points.reduce((sum, point) => sum + (point.y - meanY) ** 2, 0);
  const rSquared = totalVariance <= 0 ? 1 : Math.max(0, Math.min(1, 1 - residual / totalVariance));
  const measuredGrowth = Math.max(0, -slope);
  const meaningfulGrowth = Math.max(10 * 1_048_576, totalBytes * 0.0001);
  const confidence = confidenceFor(observedMs, rSquared);
  if (measuredGrowth < meaningfulGrowth) {
    return {
      state: "stable",
      sampleCount: valid.length,
      observedSeconds: Math.round(observedMs / 1_000),
      growthBytesPerDay: Math.round(measuredGrowth),
      warningAt: null,
      criticalAt: null,
      confidence,
    };
  }

  const warningAvailableBytes = Math.max(5 * GIBIBYTE, totalBytes * 0.15);
  const criticalAvailableBytes = Math.max(GIBIBYTE, totalBytes * 0.05);
  const warningAt = projectedAt(nowMs, availableBytes, warningAvailableBytes, measuredGrowth);
  const criticalAt = projectedAt(nowMs, availableBytes, criticalAvailableBytes, measuredGrowth);
  return {
    state: warningAt || criticalAt ? "projected" : "stable",
    sampleCount: valid.length,
    observedSeconds: Math.round(observedMs / 1_000),
    growthBytesPerDay: Math.round(measuredGrowth),
    warningAt,
    criticalAt,
    confidence,
  };
}
