import type { TapoHistoryClaimOptions, TapoHistoryExportClaim, TapoHistoryExportJob, TapoHistoryExportProvider, TapoHistoryExportTransition } from "../tapo-history-export-types.js";
import "../core.js";

declare module "../core.js" {
  interface DatabaseInternals {
    claimNextTapoHistoryExportJob(leaseOwner: string, claimedAt: string, leaseUntil: string, providers?: readonly TapoHistoryExportProvider[], reclaimNotAfter?: string, options?: TapoHistoryClaimOptions): TapoHistoryExportClaim | null;
    expireExhaustedTapoHistoryExportLeases(now?: string, reclaimNotAfter?: string): number;
    heartbeatTapoHistoryExportJob(id: string, leaseToken: string, heartbeatAt: string, leaseUntil: string): TapoHistoryExportJob | null;
    rotateTapoHistoryExportRecipient(id: string, leaseToken: string, expectedRecipient: string, rotatedAt?: string): TapoHistoryExportJob | null;
    transitionTapoHistoryExportJob(id: string, transition: TapoHistoryExportTransition): TapoHistoryExportJob | null;
    cancelTapoHistoryExportJob(id: string, cancelledAt?: string): TapoHistoryExportJob | null;
    requeueTapoHistoryExportJob(id: string, availableAt?: string, resetAttempts?: boolean): TapoHistoryExportJob | null;
    attachTapoHistoryExportMailboxMessage(id: string, mailboxMessageId: string, receivedAt?: string): TapoHistoryExportJob | null;
    listTapoHistoryExportMailboxMessageIds(jobId?: string): string[];
  }

  interface ClimateDatabaseCore {
    claimNextTapoHistoryExportJob(leaseOwner: string, claimedAt: string, leaseUntil: string, providers?: readonly TapoHistoryExportProvider[], reclaimNotAfter?: string, options?: TapoHistoryClaimOptions): TapoHistoryExportClaim | null;
    expireExhaustedTapoHistoryExportLeases(now?: string, reclaimNotAfter?: string): number;
    heartbeatTapoHistoryExportJob(id: string, leaseToken: string, heartbeatAt: string, leaseUntil: string): TapoHistoryExportJob | null;
    rotateTapoHistoryExportRecipient(id: string, leaseToken: string, expectedRecipient: string, rotatedAt?: string): TapoHistoryExportJob | null;
    transitionTapoHistoryExportJob(id: string, transition: TapoHistoryExportTransition): TapoHistoryExportJob | null;
    cancelTapoHistoryExportJob(id: string, cancelledAt?: string): TapoHistoryExportJob | null;
    requeueTapoHistoryExportJob(id: string, availableAt?: string, resetAttempts?: boolean): TapoHistoryExportJob | null;
    attachTapoHistoryExportMailboxMessage(id: string, mailboxMessageId: string, receivedAt?: string): TapoHistoryExportJob | null;
    listTapoHistoryExportMailboxMessageIds(jobId?: string): string[];
  }
}
