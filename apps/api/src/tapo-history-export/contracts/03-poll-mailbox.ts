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
import { CANARY_JOB_RETENTION_MS, CONSUMED_STAGE_RETENTION_MS, EXPORT_JOB_RETENTION_MS, MAX_GMAIL_SEARCH_MS, TAPO_HISTORY_CSV_PARSER_VERSION, TAPO_TARGET_RECLAIM_GRACE_MS, TapoHistoryFormatError } from "../support/01-max-csv-bytes-to-tapo-csv-schema-signature.js";
import { assertTapoCanaryMatchesLive, assertTapoHistoryCsvCoverage, parseTapoHistoryCsv } from "../support/02-finite-csv-number-to-gmail-header.js";
import { GmailAuthenticationUnavailable, GmailSearchBudgetExceeded, gmailSearchBudget } from "../support/03-bounded-response-bytes-to-tapo-private-history-clien.js";
import { safeError, stageMeasurement } from "../support/04-private-history-payload-to-staged-measurement.js";
import "../core.js";

declare module "../core.js" {
  interface TapoHistoryExportServiceInternals {
    pollMailbox(): Promise<void>;
  }
}
