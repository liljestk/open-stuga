import { createHash, createHmac, randomBytes, randomUUID } from "node:crypto";
import { lookup } from "node:dns/promises";
import { readFileSync, readdirSync } from "node:fs";
import { request as httpsRequest } from "node:https";
import { BlockList, isIP } from "node:net";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import type { MeasurementSample } from "@climate-twin/contracts";
import type { AppConfig } from "../../config.js";
import type {
  ClimateDatabase,
  SensorDataGapRecord,
  TapoHistoryExportClaim,
  TapoHistoryExportJob,
  TapoHistoryExportJobStatus,
  TapoHistoryExportProvider,
  TapoHistoryExportStagedSample,
  TapoHistoryExportStagedSampleInput,
} from "../../db.js";
import type { SensorHistoryRecoveryResult } from "../../sensor-gap-recovery.js";
import { TAPO_HISTORY_ACCEPTANCE_REVISION, TAPO_HISTORY_API_IMPLEMENTATION_SHA256, TAPO_HISTORY_CSV_PARSER_VERSION, TAPO_TARGET_RECLAIM_GRACE_MS, TapoHistoryCanaryError, apiImplementationSha256 } from "../support/01-max-csv-bytes-to-tapo-csv-schema-signature.js";
import { tapoExportRecipient } from "../support/02-finite-csv-number-to-gmail-header.js";
import { GmailAuthenticationUnavailable, GmailSearchBudgetExceeded } from "../support/03-bounded-response-bytes-to-tapo-private-history-clien.js";
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
