import type {
  EnergyCostAggregateQuery,
  EnergyCostAggregateRecord,
  PowerCostAggregateQuery,
} from "./types.js";
import { AnalyticsCapacityError } from "../analytics/work-limiter.js";
import { aborted, IncompleteTelemetryHistoryError, RollupsMaterializingError } from "./read-support.js";

type CostAggregateQuery = EnergyCostAggregateQuery | PowerCostAggregateQuery;
type CostAggregateMetric = "energy" | "power";

/**
 * Keep the archive fallback bounded even when SQLite runs in its read-only
 * worker. Longer windows surface archive state and retry after reconciliation.
 */
export const LOCAL_COST_FALLBACK_MAX_WINDOW_MS = 72 * 3_600_000;

interface LocalCostAggregateReader {
  energyCostAggregate?(query: EnergyCostAggregateQuery): EnergyCostAggregateRecord;
  powerCostAggregate?(query: PowerCostAggregateQuery): EnergyCostAggregateRecord;
  costAggregateAsync?(metric: CostAggregateMetric, query: CostAggregateQuery): Promise<EnergyCostAggregateRecord>;
}

interface ArchiveCostAggregateReader {
  energyCostAggregate?(query: EnergyCostAggregateQuery): Promise<EnergyCostAggregateRecord>;
  powerCostAggregate?(query: PowerCostAggregateQuery): Promise<EnergyCostAggregateRecord>;
}

function windowWithinLocalFallback(query: CostAggregateQuery): boolean {
  const windowMs = Date.parse(query.to) - Date.parse(query.from);
  return Number.isFinite(windowMs) && windowMs <= LOCAL_COST_FALLBACK_MAX_WINDOW_MS;
}

export async function readCostAggregate(input: {
  query: CostAggregateQuery;
  metric: CostAggregateMetric;
  local: LocalCostAggregateReader;
  archive: ArchiveCostAggregateReader | null;
  archivePhase: string;
  localHistoryComplete: boolean;
  requestReconciliation: () => void;
}): Promise<EnergyCostAggregateRecord> {
  const cancellation = aborted(input.query.signal);
  if (cancellation) throw cancellation;
  const synchronousRead = input.metric === "energy"
    ? input.local.energyCostAggregate
    : input.local.powerCostAggregate;
  const localRead = input.local.costAggregateAsync
    ? () => input.local.costAggregateAsync!(input.metric, input.query)
    : synchronousRead ? () => synchronousRead.call(input.local, input.query) : undefined;
  const archiveRead = input.metric === "energy"
    ? input.archive?.energyCostAggregate
    : input.archive?.powerCostAggregate;
  if (!input.archive || !archiveRead) {
    if (!input.localHistoryComplete) throw new IncompleteTelemetryHistoryError("not-configured");
    if (!localRead) throw new Error(`Local ${input.metric}-cost aggregation is unavailable`);
    return { ...await localRead(), archiveState: "local-only" };
  }
  const localFallbackReady = input.localHistoryComplete
    && localRead !== undefined
    && windowWithinLocalFallback(input.query);
  // A synchronizing archive still has a consistent committed prefix. Use it
  // without merging the SQLite tail, and expose the result as pending.
  const archiveIsSynchronizing = input.archivePhase === "syncing";
  if (input.archivePhase !== "ready" && !archiveIsSynchronizing) {
    input.requestReconciliation();
    if (!localFallbackReady) {
      throw new IncompleteTelemetryHistoryError("not-ready");
    }
    return { ...await localRead!(), archiveState: "pending" };
  }
  try {
    return {
      ...await archiveRead.call(input.archive, input.query),
      archiveState: archiveIsSynchronizing ? "pending" : "archived",
    };
  } catch (error) {
    const afterFailureCancellation = aborted(input.query.signal);
    if (afterFailureCancellation) throw afterFailureCancellation;
    // Materializing rollups and shed load resolve on their own; waking
    // archive reconciliation for them would only add work to a busy host.
    const retryable = error instanceof RollupsMaterializingError
      || error instanceof AnalyticsCapacityError;
    if (!retryable) input.requestReconciliation();
    if (localFallbackReady) {
      return { ...await localRead!(), archiveState: "pending" };
    }
    if (retryable) throw error;
    throw new IncompleteTelemetryHistoryError("failed");
  }
}
