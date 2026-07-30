import { createHash, randomBytes, randomUUID } from "node:crypto";
import { EventEmitter } from "node:events";
import { existsSync, readFileSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import {
  installRegisteredMethods,
  type AssertNoMethodKeys,
  type IncompatibleMethodKeys,
  type RegisteredMethodSet,
} from "../../method-registry.js";
import type {
  AreaEquipment,
  Floor,
  House,
  MaintenanceTask,
  MeasurementSample,
  Property,
  PropertyArea,
  PropertyAreaKind,
  PropertyNote,
  Sensor,
  StugubyHouseLink,
  StugubyPropertyLink,
} from "@climate-twin/contracts";
import {
  STUGBY_MAX_BATCH_EVENTS,
  STUGBY_MAX_BLOB_BYTES,
  STUGBY_MAX_CLOCK_SKEW_SECONDS,
  STUGBY_MAX_EVENT_PAGE_BYTES,
  STUGBY_MEDIA_TYPE,
  STUGBY_PROTOCOL_VERSION,
  assertSafeFederationPayload,
  canonicalJson,
  eventSigningValue,
  isStugubyDataset,
  isStugubyRole,
  requestSigningValue,
  validateDatasetPayload,
  validateHomeCommand,
  validateHomeCommandResult,
  validatePropertyCommand,
  validatePropertyCommandResult,
  validateShareGrant,
  validateSharedProperty,
  validateSignedEvent,
  type JsonObject,
  type JsonValue,
  type StugubyDataset,
  type StugubyDatasetGrant,
  type StugubyDeletionReceipt,
  type StugubyBlobMediaType,
  type StugubyBlobReference,
  type StugubyEventBatch,
  type StugubyEventPage,
  type StugubyGrantAudience,
  type StugubyHomeCommand,
  type StugubyHomeCommandResult,
  type StugubyHomeCommandSnapshot,
  type StugubyHomeDirectoryPayload,
  type StugubyHomeFloorPlanPayload,
  type StugubyHomeLocationPayload,
  type StugubyHomeNotesPayload,
  type StugubyHomeObservationsPayload,
  type StugubyHomeRecoveryKind,
  type StugubyHomeRecoveryPayload,
  type StugubyHomeStructurePayload,
  type StugubyInvitation,
  type StugubyJoinRequest,
  type StugubyJoinResponse,
  type StugubyMember,
  type StugubyMemberState,
  type StugubyNodeIdentity,
  type StugubyPropertyCommand,
  type StugubyPropertyCommandResult,
  type StugubyPropertyConflict,
  type StugubyPropertyEntityKind,
  type StugubyRole,
  type StugubySensorCatalogPayload,
  type StugubyShareGrant,
  type StugubySharedProperty,
  type StugubySignedEvent,
  type StugubySummary,
  type StugubyTelemetryPayload,
  type StugubyWireEvent,
} from "@climate-twin/stuguby-protocol";
import type { ClimateDatabase } from "../../db.js";
import type { TelemetryBus } from "../../events.js";
import type { StugubyNodeKeys } from "../identity.js";
import { publicKeyFingerprint } from "../identity.js";
import { durableAtomicWriteFileSync } from "../durable-write.js";
import {
  StugubyStore,
  type StugubyAuthorityTransfer,
  type StugubyHomeProjection,
  type StugubyLocalInvitation,
  type StugubyLocalMember,
  type StugubyOutboxItem,
  type StugubyPropertyAdoption,
} from "../store.js";
import { Notification, StugubyServiceOptions, normalizedBaseUrl } from "./support/01-stuguby-error-to-without-local-grant-identity.js";

export const stugubyServiceState = Symbol("StugubyService.state");

export interface StugubyServiceState {
  deploymentPublicOrigin: boolean;
  uiPublicOriginAllowed: boolean;
  publicOrigin: string | null;
  bus: TelemetryBus;
  assetDirectory: string;
  fetcher: typeof fetch;
  notifications: EventEmitter;
  syncIntervalMs: number;
  timer: NodeJS.Timeout | null;
  syncing: Promise<void> | null;
  lifecycleController: AbortController;
  activeSyncs: Set<Promise<unknown>>;
  removeMeasurementListener: (() => void) | null;
  streamControllers: Map<string, AbortController>;
  streamTasks: Map<string, Promise<void>>;
  incomingNotificationStreams: Map<string, () => void>;
  deferredNotifications: Notification[] | null;
  started: boolean;
}

export function createStugubyServiceState(): StugubyServiceState {
  return {
    deploymentPublicOrigin: undefined as unknown as boolean,
    uiPublicOriginAllowed: undefined as unknown as boolean,
    publicOrigin: undefined as unknown as string | null,
    bus: undefined as unknown as TelemetryBus,
    assetDirectory: undefined as unknown as string,
    fetcher: undefined as unknown as typeof fetch,
    notifications: new EventEmitter(),
    syncIntervalMs: undefined as unknown as number,
    timer: null,
    syncing: null,
    lifecycleController: new AbortController(),
    activeSyncs: new Set<Promise<unknown>>(),
    removeMeasurementListener: null,
    streamControllers: new Map<string, AbortController>(),
    streamTasks: new Map<string, Promise<void>>(),
    incomingNotificationStreams: new Map<string, () => void>(),
    deferredNotifications: null,
    started: false,
  };
}

export interface StugubyServiceInternals {
  readonly [stugubyServiceState]: StugubyServiceState;
  readonly database: ClimateDatabase;
  readonly store: StugubyStore;
  readonly keys: StugubyNodeKeys;
  readonly suggestedPublicOrigin: string | null;
  readonly localTelemetryHistoryComplete: (from?: string) => boolean;
  get publicOrigin(): string | null;
  get publicOriginConfigurable(): boolean;
  get identity(): StugubyNodeIdentity;
}

export type StugubyServiceMethodSet = RegisteredMethodSet<StugubyServiceInternals>;

export class StugubyServiceCore {
  readonly database: ClimateDatabase;
  readonly store: StugubyStore;
  readonly keys: StugubyNodeKeys;
  readonly suggestedPublicOrigin: string | null;
  readonly localTelemetryHistoryComplete: (from?: string) => boolean;
  readonly [stugubyServiceState] = createStugubyServiceState();
  constructor(options: StugubyServiceOptions) {
      const service = this as unknown as StugubyServiceInternals;

      this.database = options.database;
      this.store = options.store;
      this.keys = options.keys;
      this.localTelemetryHistoryComplete = options.localTelemetryHistoryComplete ?? (() => true);
      this[stugubyServiceState].bus = options.bus;
      this[stugubyServiceState].assetDirectory = join(options.assetDirectory, "stuguby");
      this[stugubyServiceState].fetcher = options.fetcher ?? fetch;
      this[stugubyServiceState].syncIntervalMs = Math.max(2_000, options.syncIntervalMs ?? 15_000);
      this[stugubyServiceState].deploymentPublicOrigin = Boolean(options.publicOrigin);
      this[stugubyServiceState].uiPublicOriginAllowed = options.allowUiPublicOrigin ?? true;
      this.suggestedPublicOrigin = options.suggestedPublicOrigin
        ? normalizedBaseUrl(options.suggestedPublicOrigin)
        : null;
      const storedPublicOrigin = this[stugubyServiceState].deploymentPublicOrigin ? null : this.store.getNodePublicOrigin();
      this[stugubyServiceState].publicOrigin = options.publicOrigin
        ? normalizedBaseUrl(options.publicOrigin)
        : storedPublicOrigin
          ? normalizedBaseUrl(storedPublicOrigin)
          : null;
      if (this.publicOrigin) this.store.reconcileUnjoinedCoordinatorOrigins(this.publicOrigin);
    }
  get publicOrigin(): string | null {
      return this[stugubyServiceState].publicOrigin;
    }
  get publicOriginConfigurable(): boolean {
      return !this[stugubyServiceState].deploymentPublicOrigin && this[stugubyServiceState].uiPublicOriginAllowed;
    }
  get identity(): StugubyNodeIdentity {
      return this.keys.identity;
    }
}

type StugubyServicePublicMethodMismatch = AssertNoMethodKeys<
  IncompatibleMethodKeys<StugubyServiceCore, StugubyServiceInternals>
>;

export function registerStugubyServiceMethods(methods: StugubyServiceMethodSet): void {
  installRegisteredMethods("StugubyService", StugubyServiceCore.prototype, methods);
}
