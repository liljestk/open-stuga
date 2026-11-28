import type { AnalyticsDistribution } from "./measurement-analytics.js";

export function isAnalyticsDistribution(value: unknown): value is AnalyticsDistribution {
  if (!value || typeof value !== "object") return false;
  const item = value as Record<string, unknown>;
  if (!["raw-observations", "display-buckets"].includes(String(item.basis)) || item.weighting !== "equal-values") return false;
  if (!Number.isSafeInteger(item.count) || Number(item.count) < 0 || !Number.isSafeInteger(item.excludedCount) || Number(item.excludedCount) < 0) return false;
  const statistics = [item.minimum, item.p05, item.p25, item.median, item.p75, item.p95, item.maximum];
  if (!Array.isArray(item.bins) || item.bins.length > 100) return false;
  if (item.count === 0) return item.bins.length === 0 && statistics.every((number) => number === null);
  if (statistics.some((number) => typeof number !== "number" || !Number.isFinite(number))) return false;
  if (statistics.some((number, index) => index > 0 && Number(number) < Number(statistics[index - 1]))) return false;
  let count = 0;
  let previous = item.minimum;
  for (const bin of item.bins) {
    if (!validBin(bin) || bin.lower !== previous) return false;
    count += bin.count;
    previous = bin.upper;
  }
  return count === item.count && previous === item.maximum && item.bins.length > 0;
}
function validBin(value: unknown): value is { lower: number; upper: number; count: number } {
  if (!value || typeof value !== "object") return false;
  const bin = value as Record<string, unknown>;
  return typeof bin.lower === "number" && Number.isFinite(bin.lower) && typeof bin.upper === "number" && Number.isFinite(bin.upper)
    && bin.lower <= bin.upper && Number.isSafeInteger(bin.count) && Number(bin.count) >= 0;
}
