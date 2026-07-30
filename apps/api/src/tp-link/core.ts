import { spawn, type ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { networkInterfaces } from "node:os";
import { createInterface } from "node:readline";
import type { OpeningStateObservation, Reading, TpLinkDiscoveredDevice } from "@climate-twin/contracts";
import type { AppConfig } from "../config.js";
import type { ClimateDatabase } from "../db.js";
import type {
  SensorGapRecoveryAdapter,
  SensorHistoryRecoveryResult,
  SensorMetricAvailability,
} from "../sensor-gap-recovery.js";
import { MeasurementService, RuntimeStatus, TelemetryService } from "../services.js";
import {
  installRegisteredMethods,
  type AssertNoMethodKeys,
  type IncompatibleMethodKeys,
  type RegisteredMethodSet,
} from "../method-registry.js";
import { CachedTpLinkDevice, LastIngestedDevice, LastIngestedMeasurement, LastIngestedOpeningState, PendingTpLinkHistoryRequest, TpLinkConnectionUpdate, TpLinkStatusHost } from "./support/01-tp-link-local-climate-history-capability-revision-to.js";

export const tpLinkConnectionBridgeState = Symbol("TpLinkConnectionBridge.state");

export interface TpLinkConnectionBridgeState {
  child: ChildProcess | null;
  restartTimer: NodeJS.Timeout | null;
  historyQueue: Promise<void>;
  running: boolean;
  attempt: number;
  stderr: string;
  mappingWarning: string | null;
  legacyMappings: Map<string, string>;
  discovered: Map<string, CachedTpLinkDevice>;
  currentDevices: Map<string, CachedTpLinkDevice>;
  lastIngested: Map<string, LastIngestedDevice>;
  lastIngestedMeasurements: Map<string, LastIngestedMeasurement>;
  lastIngestedOpeningStates: Map<string, LastIngestedOpeningState>;
  lastStatusSignature: string | null;
  lastStatusPublishedAt: number;
  lastAvailabilitySignature: string | null;
  contactEventsEnabled: boolean | null;
  pendingHistory: Map<string, PendingTpLinkHistoryRequest>;
  config: AppConfig;
  telemetry: TelemetryService;
  measurements: MeasurementService;
  database: ClimateDatabase;
  status: TpLinkStatusHost;
  connection: { id: string; houseId: string; acceptUnscoped: boolean } | undefined;
  managedConnection: {
      id: string;
      houseId: string;
      host: string;
      deviceId?: string;
      sourceType?: "hub" | "energy-device";
      sourceModel?: string;
      sourceAlias?: string;
      onUpdate?: (update: TpLinkConnectionUpdate) => void;
      onAvailabilityChange?: () => void;
      onOpeningStateRecorded?: (observation: OpeningStateObservation) => void;
    } | undefined;
}

export function createTpLinkConnectionBridgeState(): TpLinkConnectionBridgeState {
  return {
    child: null,
    restartTimer: null,
    historyQueue: Promise.resolve(),
    running: false,
    attempt: 0,
    stderr: "",
    mappingWarning: null,
    legacyMappings: new Map<string, string>(),
    discovered: new Map<string, CachedTpLinkDevice>(),
    currentDevices: new Map<string, CachedTpLinkDevice>(),
    lastIngested: new Map<string, LastIngestedDevice>(),
    lastIngestedMeasurements: new Map<string, LastIngestedMeasurement>(),
    lastIngestedOpeningStates: new Map<string, LastIngestedOpeningState>(),
    lastStatusSignature: null,
    lastStatusPublishedAt: 0,
    lastAvailabilitySignature: null,
    contactEventsEnabled: null,
    pendingHistory: new Map<string, PendingTpLinkHistoryRequest>(),
    config: undefined as unknown as AppConfig,
    telemetry: undefined as unknown as TelemetryService,
    measurements: undefined as unknown as MeasurementService,
    database: undefined as unknown as ClimateDatabase,
    status: undefined as unknown as TpLinkStatusHost,
    connection: undefined as unknown as { id: string; houseId: string; acceptUnscoped: boolean },
    managedConnection: undefined as unknown as {
      id: string;
      houseId: string;
      host: string;
      deviceId?: string;
      sourceType?: "hub" | "energy-device";
      sourceModel?: string;
      sourceAlias?: string;
      onUpdate?: (update: TpLinkConnectionUpdate) => void;
      onAvailabilityChange?: () => void;
      onOpeningStateRecorded?: (observation: OpeningStateObservation) => void;
    },
  };
}

export interface TpLinkConnectionBridgeInternals {
  readonly [tpLinkConnectionBridgeState]: TpLinkConnectionBridgeState;
}

export type TpLinkConnectionBridgeMethodSet = RegisteredMethodSet<TpLinkConnectionBridgeInternals>;

export class TpLinkConnectionBridgeCore {
  readonly [tpLinkConnectionBridgeState] = createTpLinkConnectionBridgeState();
  constructor(
      config: AppConfig,
      telemetry: TelemetryService,
      measurements: MeasurementService,
      database: ClimateDatabase,
      status: TpLinkStatusHost,
      connection?: { id: string; houseId: string; acceptUnscoped: boolean },
      managedConnection?: {
        id: string;
        houseId: string;
        host: string;
        deviceId?: string;
        sourceType?: "hub" | "energy-device";
        sourceModel?: string;
        sourceAlias?: string;
        onUpdate?: (update: TpLinkConnectionUpdate) => void;
        onAvailabilityChange?: () => void;
        onOpeningStateRecorded?: (observation: OpeningStateObservation) => void;
      },
    ) {
      const service = this as unknown as TpLinkConnectionBridgeInternals;
      this[tpLinkConnectionBridgeState].config = config;
      this[tpLinkConnectionBridgeState].telemetry = telemetry;
      this[tpLinkConnectionBridgeState].measurements = measurements;
      this[tpLinkConnectionBridgeState].database = database;
      this[tpLinkConnectionBridgeState].status = status;
      this[tpLinkConnectionBridgeState].connection = connection;
      this[tpLinkConnectionBridgeState].managedConnection = managedConnection;}
}

type TpLinkPublicMethodMismatch = AssertNoMethodKeys<
  IncompatibleMethodKeys<TpLinkConnectionBridgeCore, TpLinkConnectionBridgeInternals>
>;

export function registerTpLinkConnectionBridgeMethods(methods: TpLinkConnectionBridgeMethodSet): void {
  installRegisteredMethods("TpLinkConnectionBridge", TpLinkConnectionBridgeCore.prototype, methods);
}
