import WebSocket from "ws";
import type { OpeningState } from "@climate-twin/contracts";
import type { AppConfig } from "../config.js";
import type { ClimateDatabase } from "../db.js";
import type { MeasurementService, TelemetryService } from "../services.js";
import {
  installRegisteredMethods,
  type RegisteredMethodSet,
} from "../method-registry.js";
import { CachedSensorState, EntityTarget, HaState, HomeAssistantBridgeOptions, OpeningTarget, HomeAssistantStatusHost } from "./support/01-home-assistant-measurement-binding-to-validate-entit.js";

export const homeAssistantConnectionBridgeState = Symbol("HomeAssistantConnectionBridge.state");

export interface HomeAssistantConnectionBridgeState {
  socket: WebSocket | null;
  reconnectTimer: NodeJS.Timeout | null;
  handshakeTimer: NodeJS.Timeout | null;
  snapshotTimer: NodeJS.Timeout | null;
  livenessTimer: NodeJS.Timeout | null;
  running: boolean;
  attempt: number;
  lastMessageAt: number;
  databaseDataVersion: number;
  snapshotPending: boolean;
  bufferedEvents: Array<{ state: HaState; fallbackTimestamp?: string }>;
  mappingFingerprint: string | null;
  mappingWarning: string | null;
  entities: Map<string, EntityTarget>;
  openings: Map<string, OpeningTarget>;
  openingStateCache: Map<string, { target: OpeningTarget; state: OpeningState }>;
  cache: Map<string, CachedSensorState>;
  entityAvailability: Map<string, boolean>;
  lastOpeningHeartbeatAt: number;
  config: AppConfig;
  telemetry: TelemetryService;
  measurements: MeasurementService;
  database: ClimateDatabase;
  status: HomeAssistantStatusHost;
  houseId: string | undefined;
  options: HomeAssistantBridgeOptions;
}

export function createHomeAssistantConnectionBridgeState(
  config: AppConfig,
  telemetry: TelemetryService,
  measurements: MeasurementService,
  database: ClimateDatabase,
  status: HomeAssistantStatusHost,
  houseId: string | undefined,
  options: HomeAssistantBridgeOptions,
): HomeAssistantConnectionBridgeState {
  return {
    socket: null,
    reconnectTimer: null,
    handshakeTimer: null,
    snapshotTimer: null,
    livenessTimer: null,
    running: false,
    attempt: 0,
    lastMessageAt: 0,
    databaseDataVersion: 0,
    snapshotPending: false,
    bufferedEvents: [],
    mappingFingerprint: null,
    mappingWarning: null,
    entities: new Map<string, EntityTarget>(),
    openings: new Map<string, OpeningTarget>(),
    openingStateCache: new Map<string, { target: OpeningTarget; state: OpeningState }>(),
    cache: new Map<string, CachedSensorState>(),
    entityAvailability: new Map<string, boolean>(),
    lastOpeningHeartbeatAt: 0,
    config,
    telemetry,
    measurements,
    database,
    status,
    houseId,
    options,
  };
}

export interface HomeAssistantConnectionBridgeInternals {
  readonly [homeAssistantConnectionBridgeState]: HomeAssistantConnectionBridgeState;
}

export type HomeAssistantConnectionBridgeMethodSet = RegisteredMethodSet<HomeAssistantConnectionBridgeInternals>;

export class HomeAssistantConnectionBridgeCore {
  readonly [homeAssistantConnectionBridgeState]: HomeAssistantConnectionBridgeState;

  constructor(
      config: AppConfig,
      telemetry: TelemetryService,
      measurements: MeasurementService,
      database: ClimateDatabase,
      status: HomeAssistantStatusHost,
      houseId?: string,
      options: HomeAssistantBridgeOptions = {},
    ) {
      this[homeAssistantConnectionBridgeState] = createHomeAssistantConnectionBridgeState(
        config,
        telemetry,
        measurements,
        database,
        status,
        houseId,
        options,
      );
    }
}

export function registerHomeAssistantConnectionBridgeMethods(methods: HomeAssistantConnectionBridgeMethodSet): void {
  installRegisteredMethods(
    "HomeAssistantConnectionBridge",
    HomeAssistantConnectionBridgeCore.prototype,
    methods,
  );
}
