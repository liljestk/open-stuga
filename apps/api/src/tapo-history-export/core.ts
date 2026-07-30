import { createHash, createHmac, randomBytes, randomUUID } from "node:crypto";
import { lookup } from "node:dns/promises";
import { readFileSync, readdirSync } from "node:fs";
import { request as httpsRequest } from "node:https";
import { BlockList, isIP } from "node:net";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import type { MeasurementSample } from "@climate-twin/contracts";
import type { AppConfig } from "../config.js";
import {
  installRegisteredMethods,
  type AssertNoMethodKeys,
  type IncompatibleMethodKeys,
  type RegisteredMethodSet,
} from "../method-registry.js";
import type {
  ClimateDatabase,
  SensorDataGapRecord,
  TapoHistoryExportClaim,
  TapoHistoryExportJob,
  TapoHistoryExportJobStatus,
  TapoHistoryExportProvider,
  TapoHistoryExportStagedSample,
  TapoHistoryExportStagedSampleInput,
} from "../db.js";
import type { SensorHistoryRecoveryResult } from "../sensor-gap-recovery.js";
import { TAPO_HISTORY_CSV_PARSER_VERSION } from "./support/01-max-csv-bytes-to-tapo-csv-schema-signature.js";
import { GmailTapoMailbox } from "./support/03-bounded-response-bytes-to-tapo-private-history-clien.js";
import { TapoHistoryMailboxHealth, TapoHistoryServiceOptions, TapoPrivateHistoryClient } from "./support/04-private-history-payload-to-staged-measurement.js";

export const tapoHistoryExportServiceState = Symbol("TapoHistoryExportService.state");

export interface TapoHistoryExportServiceState {
  mailbox: GmailTapoMailbox | null;
  privateClient: TapoPrivateHistoryClient | null;
  fetcher: typeof fetch;
  now: () => Date;
  pendingConsumption: Map<string, { jobId: string; sampleIds: number[] }>;
  mailboxHealth: TapoHistoryMailboxHealth;
  timer: NodeJS.Timeout | null;
  polling: Promise<void> | null;
  lastMaintenanceAt: number;
  config: AppConfig;
  database: ClimateDatabase;
  options: TapoHistoryServiceOptions;
}

export function createTapoHistoryExportServiceState(): TapoHistoryExportServiceState {
  return {
    mailbox: undefined as unknown as GmailTapoMailbox | null,
    privateClient: undefined as unknown as TapoPrivateHistoryClient | null,
    fetcher: undefined as unknown as typeof fetch,
    now: undefined as unknown as () => Date,
    pendingConsumption: new Map<string, { jobId: string; sampleIds: number[] }>(),
    mailboxHealth: {
    lastSuccessfulPollAt: null,
    lastErrorAt: null,
    lastErrorCode: null,
    consecutiveFailures: 0,
    budgetExhaustions: 0,
  },
    timer: null,
    polling: null,
    lastMaintenanceAt: 0,
    config: undefined as unknown as AppConfig,
    database: undefined as unknown as ClimateDatabase,
    options: undefined as unknown as TapoHistoryServiceOptions,
  };
}

export interface TapoHistoryExportServiceInternals {
  readonly [tapoHistoryExportServiceState]: TapoHistoryExportServiceState;
  get enabled(): boolean;
  get operational(): boolean;
  get mailboxHealth(): Readonly<TapoHistoryMailboxHealth>;
}

export type TapoHistoryExportServiceMethodSet = RegisteredMethodSet<TapoHistoryExportServiceInternals>;

export class TapoHistoryExportServiceCore {
  readonly [tapoHistoryExportServiceState] = createTapoHistoryExportServiceState();
  constructor(
      config: AppConfig,
      database: ClimateDatabase,
      options: TapoHistoryServiceOptions = {},
    ) {
      const service = this as unknown as TapoHistoryExportServiceInternals;
      this[tapoHistoryExportServiceState].config = config;
      this[tapoHistoryExportServiceState].database = database;
      this[tapoHistoryExportServiceState].options = options;
      this[tapoHistoryExportServiceState].fetcher = options.fetcher ?? fetch;
      this[tapoHistoryExportServiceState].now = options.now ?? (() => new Date());
      this[tapoHistoryExportServiceState].mailbox = config.tapoHistoryGmailClientId && config.tapoHistoryGmailClientSecret && config.tapoHistoryGmailRefreshToken
        ? new GmailTapoMailbox({
            clientId: config.tapoHistoryGmailClientId,
            clientSecret: config.tapoHistoryGmailClientSecret,
            refreshToken: config.tapoHistoryGmailRefreshToken,
            expectedEmail: config.tapoHistoryGmailAccountEmail ?? config.tapoHistoryExportEmail!,
            fetcher: this[tapoHistoryExportServiceState].fetcher,
          }) : null;
      this[tapoHistoryExportServiceState].privateClient = config.tapoHistoryPrivateEndpoint && config.tapoHistoryPrivateToken
        ? new TapoPrivateHistoryClient({
            endpoint: config.tapoHistoryPrivateEndpoint,
            token: config.tapoHistoryPrivateToken,
            ...(options.fetcher ? { fetcher: options.fetcher } : {}),
            ...(options.privateResolver ? { resolver: options.privateResolver } : {}),
          })
        : null;
      if (this.operational) {
        const appReady = Boolean(config.tapoHistoryExportEmail && config.tapoHistoryWorkerToken && this[tapoHistoryExportServiceState].mailbox);
        const capabilityRevision = createHash("sha256").update(JSON.stringify({
          schema: 2,
          appReady,
          privateEndpoint: this[tapoHistoryExportServiceState].privateClient ? config.tapoHistoryPrivateEndpoint : null,
          parser: TAPO_HISTORY_CSV_PARSER_VERSION,
        })).digest("hex");
        this[tapoHistoryExportServiceState].database.rearmNotSupportedSensorDataGaps(
          "tp-link",
          capabilityRevision,
          this[tapoHistoryExportServiceState].now().toISOString(),
        );
      }
    }
  get enabled(): boolean { return this[tapoHistoryExportServiceState].config.tapoHistoryEnabled === true; }
  get operational(): boolean {
      const appReady = Boolean(this[tapoHistoryExportServiceState].config.tapoHistoryExportEmail
        && this[tapoHistoryExportServiceState].config.tapoHistoryWorkerToken && this[tapoHistoryExportServiceState].mailbox);
      return this.enabled && (appReady || this[tapoHistoryExportServiceState].privateClient !== null);
    }
  get mailboxHealth(): Readonly<TapoHistoryMailboxHealth> {
      return { ...this[tapoHistoryExportServiceState].mailboxHealth };
    }
}

type TapoHistoryExportPublicMethodMismatch = AssertNoMethodKeys<
  IncompatibleMethodKeys<TapoHistoryExportServiceCore, TapoHistoryExportServiceInternals>
>;

export function registerTapoHistoryExportServiceMethods(methods: TapoHistoryExportServiceMethodSet): void {
  installRegisteredMethods(
    "TapoHistoryExportService",
    TapoHistoryExportServiceCore.prototype,
    methods,
  );
}
