import type { TapoHistoryExportEnqueueResult, TapoHistoryExportJob, TapoHistoryExportJobFilter, TapoHistoryExportJobInput } from "../tapo-history-export-types.js";
import "../core.js";

declare module "../core.js" {
  interface DatabaseInternals {
    enqueueTapoHistoryExportJob(input: TapoHistoryExportJobInput, createdAt?: string): TapoHistoryExportEnqueueResult;
    getTapoHistoryExportJob(id: string): TapoHistoryExportJob | null;
    getTapoHistoryExportJobByDedupeKey(dedupeKey: string): TapoHistoryExportJob | null;
    listTapoHistoryExportJobs(filter?: TapoHistoryExportJobFilter): TapoHistoryExportJob[];
    hasOpenTapoHistoryCanary(): boolean;
    countWaitingTapoHistoryExportEmails(): number;
    hasRecentTapoHistoryCanaryApproval(deploymentFingerprint: string, notBefore: string): boolean;
    approveTapoHistoryDeploymentFromCanary(canaryJobId: string, acceptanceRevision: string, approvedAt?: string): void;
    revokeTapoHistoryCanaryApprovalsForTarget(canaryJobId: string): number;
    revokeTapoHistoryCanaryApprovalsForJobTarget(jobId: string): number;
    tapoHistoryCanaryRenewalTarget(deploymentFingerprint: string, acceptanceRevision: string, approvedNotAfter: string): TapoHistoryExportJob | null;
  }

  interface ClimateDatabaseCore {
    enqueueTapoHistoryExportJob(input: TapoHistoryExportJobInput, createdAt?: string): TapoHistoryExportEnqueueResult;
    getTapoHistoryExportJob(id: string): TapoHistoryExportJob | null;
    getTapoHistoryExportJobByDedupeKey(dedupeKey: string): TapoHistoryExportJob | null;
    listTapoHistoryExportJobs(filter?: TapoHistoryExportJobFilter): TapoHistoryExportJob[];
    hasOpenTapoHistoryCanary(): boolean;
    countWaitingTapoHistoryExportEmails(): number;
    hasRecentTapoHistoryCanaryApproval(deploymentFingerprint: string, notBefore: string): boolean;
    approveTapoHistoryDeploymentFromCanary(canaryJobId: string, acceptanceRevision: string, approvedAt?: string): void;
    revokeTapoHistoryCanaryApprovalsForTarget(canaryJobId: string): number;
    revokeTapoHistoryCanaryApprovalsForJobTarget(jobId: string): number;
    tapoHistoryCanaryRenewalTarget(deploymentFingerprint: string, acceptanceRevision: string, approvedNotAfter: string): TapoHistoryExportJob | null;
  }
}
