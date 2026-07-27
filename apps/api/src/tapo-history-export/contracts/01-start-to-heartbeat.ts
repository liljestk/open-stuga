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
import { TAPO_CANARY_APPROVAL_MAX_AGE_MS, TAPO_CANARY_RENEWAL_LEAD_MS, TAPO_TARGET_RECLAIM_GRACE_MS } from "../support/01-max-csv-bytes-to-tapo-csv-schema-signature.js";
import { assertTapoHistoryCsvCoverage, tapoExportRecipient } from "../support/02-finite-csv-number-to-gmail-header.js";
import { maxTapoHistoryJobSpanMs, recoveryKey, safeError, stageMeasurement, stagedMeasurement } from "../support/04-private-history-payload-to-staged-measurement.js";
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
