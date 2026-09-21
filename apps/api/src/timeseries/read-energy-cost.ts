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
 * The local engine runs one synchronous SQLite statement that blocks the Node
 * event loop for the whole scan. In hybrid deployments it therefore only
 * substitutes for the archive on windows it can serve in milliseconds; longer
 * windows surface the archive state so callers degrade per-source and retry
 * once the archive answers again.
 */
export const LOCAL_COST_FALLBACK_MAX_WINDOW_MS = 72 * 3_600_000;

interface LocalCostAggregateReader {
  energyCostAggregate?(query: EnergyCostAggregateQuery): EnergyCostAggregateRecord;
  powerCostAggregate?(query: PowerCostAggregateQuery): EnergyCostAggregateRecord;
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
  const localRead = input.metric === "energy"
    ? input.local.energyCostAggregate
    : input.local.powerCostAggregate;
  const archiveRead = input.metric === "energy"
    ? input.archive?.energyCostAggregate
    : input.archive?.powerCostAggregate;
  if (!input.archive || !archiveRead) {
    if (!input.localHistoryComplete) throw new IncompleteTelemetryHistoryError("not-configured");
    if (!localRead) throw new Error(`Local ${input.metric}-cost aggregation is unavailable`);
    return { ...localRead.call(input.local, input.query), archiveState: "local-only" };
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
    return { ...localRead!.call(input.local, input.query), archiveState: "pending" };
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
      return { ...localRead!.call(input.local, input.query), archiveState: "pending" };
    }
    if (retryable) throw error;
    throw new IncompleteTelemetryHistoryError("failed");
  }
}
