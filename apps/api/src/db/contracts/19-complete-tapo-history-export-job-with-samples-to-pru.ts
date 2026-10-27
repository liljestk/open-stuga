import type { TapoHistoryExportCompletionOptions, TapoHistoryExportStageResult, TapoHistoryExportStagedSample, TapoHistoryExportStagedSampleFilter, TapoHistoryExportStagedSampleInput } from "../tapo-history-export-types.js";
import "../core.js";

declare module "../core.js" {
  interface DatabaseInternals {
    completeTapoHistoryExportJobWithSamples(id: string, samples: TapoHistoryExportStagedSampleInput[], options?: TapoHistoryExportCompletionOptions): TapoHistoryExportStageResult;
    listTapoHistoryExportStagedSamples(filter?: TapoHistoryExportStagedSampleFilter): TapoHistoryExportStagedSample[];
    markTapoHistoryExportStagedSamplesConsumed(jobId: string, sampleIds: number[], consumedAt?: string): number;
    pruneTapoHistoryExportHistory(options: {
            consumedBefore: string;
            completedBefore: string;
            canaryBefore: string;
        }): {
            samples: number;
            jobs: number;
        };
  }

  interface ClimateDatabaseCore {
    completeTapoHistoryExportJobWithSamples(id: string, samples: TapoHistoryExportStagedSampleInput[], options?: TapoHistoryExportCompletionOptions): TapoHistoryExportStageResult;
    listTapoHistoryExportStagedSamples(filter?: TapoHistoryExportStagedSampleFilter): TapoHistoryExportStagedSample[];
    markTapoHistoryExportStagedSamplesConsumed(jobId: string, sampleIds: number[], consumedAt?: string): number;
    pruneTapoHistoryExportHistory(options: {
            consumedBefore: string;
            completedBefore: string;
            canaryBefore: string;
        }): {
            samples: number;
            jobs: number;
        };
  }
}
