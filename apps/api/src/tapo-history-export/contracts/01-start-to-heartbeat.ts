import type {
  TapoHistoryExportClaim,
  TapoHistoryExportJob,
} from "../../db.js";
import type { SensorHistoryRecoveryResult } from "../../sensor-gap-recovery.js";
import "../core.js";

declare module "../core.js" {
  interface TapoHistoryExportServiceInternals {
    start(): void;
    stop(): Promise<void>;
    wake(): void;
    recoverHistory(sensorId: string, metric: string, from: string, to: string): Promise<SensorHistoryRecoveryResult>;
    consumeRecovered(sensorId: string, metric: string, from: string, to: string): void;
    listJobs(limit?: number): TapoHistoryExportJob[];
    claim(workerId: string, deploymentFingerprint: string): (TapoHistoryExportClaim & {
            serverNow: string;
        }) | null;
    heartbeat(jobId: string, leaseToken: string): {
            job: TapoHistoryExportJob;
            serverNow: string;
        } | null;
  }

  interface TapoHistoryExportServiceCore {
    start(): void;
    stop(): Promise<void>;
    wake(): void;
    recoverHistory(sensorId: string, metric: string, from: string, to: string): Promise<SensorHistoryRecoveryResult>;
    consumeRecovered(sensorId: string, metric: string, from: string, to: string): void;
    listJobs(limit?: number): TapoHistoryExportJob[];
    claim(workerId: string, deploymentFingerprint: string): (TapoHistoryExportClaim & {
            serverNow: string;
        }) | null;
    heartbeat(jobId: string, leaseToken: string): {
            job: TapoHistoryExportJob;
            serverNow: string;
        } | null;
  }
}
