import type {
  SensorDataGapRecord,
  TapoHistoryExportJob,
  TapoHistoryExportJobStatus,
  TapoHistoryExportProvider,
} from "../../db.js";
import { TapoWorkerStatusUpdate } from "../support/04-private-history-payload-to-staged-measurement.js";
import "../core.js";

declare module "../core.js" {
  interface TapoHistoryExportServiceInternals {
    updateFromWorker(jobId: string, leaseToken: string, update: TapoWorkerStatusUpdate): TapoHistoryExportJob | null;
    retry(jobId: string): TapoHistoryExportJob | null;
    cancel(jobId: string): TapoHistoryExportJob | null;
    requestBackfill(sensorId: string, metric: "temperature" | "humidity", from: string, to: string): SensorDataGapRecord;
    createCanary(sensorId: string, metric: "temperature" | "humidity", from: string, to: string): TapoHistoryExportJob;
    createCanaryJob(
        sensorId: string,
        metric: "temperature" | "humidity",
        from: string,
        to: string,
        automaticRenewal: boolean,
      ): TapoHistoryExportJob;
    enqueue(
        sensorId: string,
        metric: string,
        from: string,
        to: string,
        provider: TapoHistoryExportProvider,
        deviceName: string,
        canary?: boolean ,
        automaticRenewal?: boolean ,
      ): TapoHistoryExportJob;
    findJob(
        sensorId: string,
        expectedDeviceId: string,
        timeZone: string,
        from: string,
        to: string,
        statuses: TapoHistoryExportJobStatus[],
        provider?: TapoHistoryExportProvider,
        deviceName?: string,
        intervalMinutes?: number,
        metric?: string,
      ): TapoHistoryExportJob | null;
    boundDeviceId(sensorId: string): string | null;
    acceptanceRevision(): string;
    targetAliasMatches(job: TapoHistoryExportJob): boolean;
    recordMailboxSuccess(at?: string): void;
    recordMailboxFailure(error: unknown, at?: string): void;
  }

  interface TapoHistoryExportServiceCore {
    updateFromWorker(jobId: string, leaseToken: string, update: TapoWorkerStatusUpdate): TapoHistoryExportJob | null;
    retry(jobId: string): TapoHistoryExportJob | null;
    cancel(jobId: string): TapoHistoryExportJob | null;
    requestBackfill(sensorId: string, metric: "temperature" | "humidity", from: string, to: string): SensorDataGapRecord;
    createCanary(sensorId: string, metric: "temperature" | "humidity", from: string, to: string): TapoHistoryExportJob;
  }
}
