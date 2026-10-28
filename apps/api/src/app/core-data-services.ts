import { RuntimeDisposers } from "./runtime-disposers.js";
import { reportBackgroundFailure } from "../system-error-log.js";
import type {
  TrackingFeatureFlags,
} from "@climate-twin/contracts";
import {
  ClimateDatabase,
  type SecurityAuditEventInput,
} from "../db.js";
import { TelemetryBus } from "../events.js";
import { recoverCoordinatedIntegrationSecrets } from "../integration-secrets-coordinator.js";
import { DataModeCoordinator } from "../demo/data-mode.js";
import { SYSTEM_VERSION } from "../version.js";
import { SystemUpdateService } from "../system-updates/service.js";
import { SystemStorageService } from "../system-storage.js";
import { HostSystemMonitor } from "../host-system/monitor.js";
import { HostDatabaseMetricsCollector, SqliteHostStorageHistory } from "../host-system/database-metrics.js";
import { SystemErrorLog } from "../system-error-log.js";
import {
  LocalAuthStore,
  type LocalAuthIdentity,
} from "../local-auth.js";
import { CloudflareAccessGroupSynchronizer } from "../cloudflare-access.js";
import {
  CloudflareSetupService,
} from "../cloudflare-setup.js";
import { DataOperationsService } from "../data-operations.js";
import { EnergyOptimizer } from "../electricity/optimizer.js";
import {
  isLocalTelemetryHistoryComplete,
} from "../timeseries/read-facade.js";
import { loadOrCreateStugubyNodeKeys } from "../stuguby/identity.js";
import { StugubyService } from "../stuguby/service.js";
import { StugubyStore } from "../stuguby/store.js";
import { TrackingSecretBox, loadOrCreateTrackingKey } from "../tracking/crypto.js";
import { TrackingService } from "../tracking/service.js";
import {
  TrackingStore,
} from "../tracking/store.js";
import { AuthAbuseLimiter } from "./support/auth-abuse-limits.js";
import { HttpError } from "../http-error.js";
import { initializeIntegrationMetadata } from "./support/integration-bootstrap.js";
import type { ApiConfigContext } from "./api-config.js";


/** Mutable flags and counters shared by the bridges, live streams, Telegram routes and shutdown. */
export interface ApiRuntimeState {
  shutdownStarted: boolean;
  closed: boolean;
  shutdownPromise: Promise<void> | null;
  closePromise: Promise<void> | null;
  activeEventStreamCount: number;
  /** Bumped when Telegram delivery settings change, so queued sends to the old chat are dropped. */
  telegramDeliveryGeneration: number;
  /** Bumped per Telegram configuration request, so a slower test cannot overwrite a newer save. */
  telegramConfigurationGeneration: number;
}

/** The SQLite control plane and the services that only need it: tracking, system updates and storage, host metrics, Cloudflare setup, data operations, Stuguby. */
export function createCoreDataServices(context: ApiConfigContext) {
  const config = context.config;
  if (config.timeseriesRequired && !config.timeseriesEnabled) {
      throw new Error("timeseriesRequired=true requires timeseriesEnabled=true");
    }
  const database = context.options.database ?? new ClimateDatabase(config.databasePath);
  const systemErrorLog = new SystemErrorLog(database);
  const recoveredSecrets = recoverCoordinatedIntegrationSecrets(config.integrationSecretsFile, database);
  if (recoveredSecrets) {
    config.homeAssistantConnections = recoveredSecrets.homeAssistantConnections ?? [];
    config.tpLinkConnections = recoveredSecrets.tpLinkConnections ?? [];
    config.greeConnections = recoveredSecrets.greeConnections ?? [];
    config.tuyaConnections = recoveredSecrets.tuyaConnections ?? [];
    config.appleNotesGrants = recoveredSecrets.appleNotesGrants ?? [];
  }
  const trackingFlags: TrackingFeatureFlags = {
      "tracking.enabled": config.trackingEnabled,
      "tracking.mobileObserver.enabled": config.trackingMobileObserverEnabled,
      "tracking.mobileObserver.iosBackground.enabled": config.trackingIosBackgroundEnabled,
      "tracking.mobileObserver.androidBackground.enabled": config.trackingAndroidBackgroundEnabled,
      "tracking.androidGatewayMode.enabled": config.trackingAndroidGatewayModeEnabled,
      "tracking.liveMap.enabled": config.trackingLiveMapEnabled,
      "tracking.movementTrails.enabled": config.trackingMovementTrailsEnabled,
      "tracking.exitAlerts.enabled": config.trackingExitAlertsEnabled,
      "tracking.userLocationSharing.enabled": config.trackingUserLocationSharingEnabled,
    };
  if (config.trackingUserLocationSharingEnabled
      && (!config.trackingEnabled || !config.trackingLiveMapEnabled)) {
      throw new Error("TRACKING_USER_LOCATION_SHARING_REQUIRES_LIVE_MAP");
    }
  const trackingStore = new TrackingStore(
      database,
      new TrackingSecretBox(loadOrCreateTrackingKey(
        config.trackingEnabled ? config.trackingSecretKeyFile : null,
      )),
    );
  const tracking = new TrackingService(
      trackingStore,
      {
        flags: trackingFlags,
      },
    );
  const systemUpdates = new SystemUpdateService({
      currentVersion: SYSTEM_VERSION,
      repository: config.systemUpdateRepository,
      imagePrefix: config.systemUpdateImagePrefix,
      operationsDirectory: config.systemUpdateOperationsDirectory,
    });
  const systemStorage = new SystemStorageService({
      operationsDirectory: config.systemUpdateOperationsDirectory,
    });
  const hostDatabaseMetrics = new HostDatabaseMetricsCollector(database, {
      databasePath: config.databasePath,
      telemetryEnabled: config.timeseriesEnabled,
      telemetryRequired: config.timeseriesRequired,
    });
  const hostSystem = new HostSystemMonitor({
      storagePath: config.timeseriesStoragePath ?? config.databasePath,
      storageHistory: new SqliteHostStorageHistory(database),
      databaseMetrics: () => hostDatabaseMetrics.snapshot(),
    });
  const cloudflareSetup = context.options.cloudflareSetup ?? new CloudflareSetupService({
      operationsDirectory: config.systemUpdateOperationsDirectory,
      deploymentFile: config.cloudflareSetupDeploymentFile,
      runtimeToken: config.cloudflareAccessApiToken,
      ownerEmail: config.cloudflareAccessStaticEmails[0] ?? null,
      oauthClientId: config.cloudflareSetupOAuthClientId,
      ...(context.options.cloudflareSetupFetcher ? { fetchImpl: context.options.cloudflareSetupFetcher } : {}),
    });
  const dataOperations = new DataOperationsService(database, config);
  const energyOptimizer = new EnergyOptimizer(database);
  const integrationMetadata = initializeIntegrationMetadata(config, database);
  const localAuth = new LocalAuthStore(database);
  const recordSecurityAudit = (
      actor: Pick<LocalAuthIdentity, "userId" | "role"> | null,
      event: Omit<SecurityAuditEventInput, "actorUserId" | "actorRole">,
    ): void => {
      database.recordSecurityAuditEvent({
        ...event,
        actorUserId: actor?.userId ?? null,
        actorRole: actor?.role ?? null,
      });
    };
  const cloudflareAccess = config.cloudflareAccessAccountId
      && config.cloudflareAccessGroupId
      && config.cloudflareAccessGroupName
      && config.cloudflareAccessApiToken
      && config.cloudflareAccessStaticEmails.length > 0
      ? new CloudflareAccessGroupSynchronizer({
        accountId: config.cloudflareAccessAccountId,
        groupId: config.cloudflareAccessGroupId,
        groupName: config.cloudflareAccessGroupName,
        apiToken: config.cloudflareAccessApiToken,
        syncIntervalMs: config.cloudflareAccessSyncIntervalMs,
      }, () => {
        if (!localAuth.isInitialized()) return null;
        const directory = localAuth.listWorkspaceMembers();
        // The Cloudflare identity used by the installation owner may differ from
        // their local Stugu login. Keep configured operators permanently allowed,
        // and reconcile every invited/non-owner local account around them.
        return [
          ...(config.cloudflareAccessStaticEmails ?? []),
          ...directory.members.filter((entry) => entry.role !== "owner").map((entry) => entry.email),
          ...directory.invitations.map((entry) => entry.email),
        ];
      }, context.options.cloudflareAccessFetcher, () => {
        // This intentionally omits account, group, email, and provider details.
        reportBackgroundFailure(systemErrorLog, {
          level: "warning", source: "cloudflare-access", code: "SYNC_PENDING", message: "Member allowlist synchronization is pending",
        });
      })
      : null;
  const authAbuseLimiter = new AuthAbuseLimiter();
  const trackingObserverAbuseLimiter = new AuthAbuseLimiter();
  const dataMode = new DataModeCoordinator(database);
  if ((config.homeAssistantConnections?.length ?? 0) > 0
      || (!config.homeAssistantLegacyDisabled && config.haUrl && config.haToken)
      || (config.tpLinkConnections?.length ?? 0) > 0
      || (!config.tpLinkLegacyDisabled && config.tpLinkHost && config.tpLinkUsername && config.tpLinkPassword)
      || (config.greeConnections?.length ?? 0) > 0) {
      dataMode.activate();
    }
  const bus = new TelemetryBus();
  const stuguby = (() => {
      const keys = loadOrCreateStugubyNodeKeys(config.stugubyIdentityFile ?? null, config.stugubyNodeName);
      const store = new StugubyStore(database.db, keys.identity.nodeId);
      return new StugubyService({
        database,
        store,
        keys,
        bus,
        assetDirectory: config.assetDirectory,
        syncIntervalMs: config.stugubySyncIntervalMs,
        publicOrigin: config.stugubyPublicOrigin,
        suggestedPublicOrigin: config.stugubySuggestedPublicOrigin ?? null,
        allowUiPublicOrigin: !config.stugubyCoordinatorProvisioningRequired,
        localTelemetryHistoryComplete: (from) => isLocalTelemetryHistoryComplete({
          timeseriesEnabled: config.timeseriesEnabled,
          retentionDays: config.retentionDays,
          ...(from === undefined ? {} : { from }),
        }),
        ...(context.options.stugubyFetcher ? { fetcher: context.options.stugubyFetcher } : {}),
      });
    })();
  const assertSensorHouseMoveAllowed = (sourceHouseId: string, targetHouseId: string): void => {
      const managed = [sourceHouseId, targetHouseId].some((houseId) => {
        const link = database.getHouse(houseId)?.stuguby;
        return link?.ownership === "shared" && link.syncState !== "detached";
      });
      if (managed) {
        throw new HttpError(
          409,
          "STUGBY_SENSOR_HOME_MANAGED",
          "A sensor in a shared Home remains with that Home until permanent disconnect",
        );
      }
    };
  const runtimeState: ApiRuntimeState = {
    shutdownStarted: false,
    closed: false,
    shutdownPromise: null,
    closePromise: null,
    activeEventStreamCount: 0,
    telegramDeliveryGeneration: 0,
    telegramConfigurationGeneration: 0,
  };
  const extended = Object.assign(context, { disposers: new RuntimeDisposers(), runtimeState, database, systemErrorLog, trackingFlags, trackingStore, tracking, systemUpdates, systemStorage, hostDatabaseMetrics, hostSystem, cloudflareSetup, dataOperations, energyOptimizer, integrationMetadata, localAuth, recordSecurityAudit, cloudflareAccess, authAbuseLimiter, trackingObserverAbuseLimiter, dataMode, bus, stuguby, assertSensorHouseMoveAllowed });
  return extended;
}

export type CoreDataServices = ReturnType<typeof createCoreDataServices>;
