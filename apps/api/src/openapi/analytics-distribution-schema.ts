export const analyticsDistributionSchema = {
  type: "object", additionalProperties: false,
  description: "Unweighted distribution of returned values at the requested resolution, not a raw-sample or elapsed-time estimate when bucketed. Missing values are excluded. Bins are half-open except the final upper endpoint.",
  required: ["basis", "weighting", "count", "excludedCount", "minimum", "maximum", "p05", "p25", "median", "p75", "p95", "bins"],
  properties: {
    basis: { enum: ["raw-observations", "display-buckets"] }, weighting: { const: "equal-values" },
    count: { type: "integer", minimum: 0 }, excludedCount: { type: "integer", minimum: 0 },
    minimum: { type: ["number", "null"] }, maximum: { type: ["number", "null"] },
    p05: { type: ["number", "null"] }, p25: { type: ["number", "null"] }, median: { type: ["number", "null"] },
    p75: { type: ["number", "null"] }, p95: { type: ["number", "null"] },
    bins: {
      type: "array", maxItems: 100,
      items: {
        type: "object", additionalProperties: false, required: ["lower", "upper", "count"],
        properties: { lower: { type: "number" }, upper: { type: "number" }, count: { type: "integer", minimum: 0 } },
      },
    },
  },
} as const;
