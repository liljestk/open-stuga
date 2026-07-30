import type {
  EnergyCostAggregateQuery,
  EnergyCostAggregateRecord,
  PowerCostAggregateQuery,
} from "./types.js";
import { aborted, IncompleteTelemetryHistoryError } from "./read-support.js";

type CostAggregateQuery = EnergyCostAggregateQuery | PowerCostAggregateQuery;
type CostAggregateMetric = "energy" | "power";

interface LocalCostAggregateReader {
  energyCostAggregate?(query: EnergyCostAggregateQuery): EnergyCostAggregateRecord;
  powerCostAggregate?(query: PowerCostAggregateQuery): EnergyCostAggregateRecord;
}

interface ArchiveCostAggregateReader {
  energyCostAggregate?(query: EnergyCostAggregateQuery): Promise<EnergyCostAggregateRecord>;
  powerCostAggregate?(query: PowerCostAggregateQuery): Promise<EnergyCostAggregateRecord>;
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
  if (input.localHistoryComplete) {
    if (!localRead) throw new Error(`Local ${input.metric}-cost aggregation is unavailable`);
    return localRead.call(input.local, input.query);
  }
  const archiveRead = input.metric === "energy"
    ? input.archive?.energyCostAggregate
    : input.archive?.powerCostAggregate;
  if (!input.archive || !archiveRead) throw new IncompleteTelemetryHistoryError("not-configured");
  if (input.archivePhase !== "ready" && input.archivePhase !== "syncing") {
    throw new IncompleteTelemetryHistoryError("not-ready");
  }
  try {
    return await archiveRead.call(input.archive, input.query);
  } catch {
    const afterFailureCancellation = aborted(input.query.signal);
    if (afterFailureCancellation) throw afterFailureCancellation;
    input.requestReconciliation();
    throw new IncompleteTelemetryHistoryError("failed");
  }
}
