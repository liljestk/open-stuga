import { HomeAssistantBridge } from "../home-assistant.js";
import { mergeTpLinkHistoryRecovery, TpLinkBridge, type TpLinkConnectionUpdate } from "../tp-link.js";
import { GreeBridge } from "../gree.js";
import { TuyaBridge } from "../tuya.js";
import {
  updateIntegrationSecrets,
  type GreeConnectionSecret,
  type TpLinkConnectionSecret,
  type TuyaConnectionSecret,
} from "../integration-secrets.js";
import {
  AlertEngine,
  MeasurementService,
  MockEngine,
  ReplayEngine,
  TelemetryService,
} from "../services.js";
import { SensorGapRecoveryCoordinator } from "../sensor-gap-recovery.js";
import {
  TapoHistoryExportService,
} from "../tapo-history-export.js";
import { TelegramService } from "../telegram.js";
import { NotificationOutboxWorker } from "../outbox.js";
import { enqueueHostSystemAlertNotifications } from "../host-system-notifications.js";
import { Nexus433Service } from "../nexus433/index.js";
import { testHomeAssistantCredentials } from "../home-assistant.js";
import type { SpatialLayerServices } from "./spatial-layer-services.js";
type PendingTpLinkConnectionUpdate = Omit<TpLinkConnectionUpdate, "previousHost">;

function applyTpLinkConnectionUpdate(
  current: TpLinkConnectionSecret,
  update: PendingTpLinkConnectionUpdate,
): TpLinkConnectionSecret {
  const next: TpLinkConnectionSecret = {
    ...current,
    host: update.host,
    ...(update.deviceId ? { deviceId: update.deviceId } : {}),
    ...(update.sourceType ? { sourceType: update.sourceType } : {}),
    ...(update.sourceModel ? { sourceModel: update.sourceModel } : {}),
    ...(update.sourceAlias ? { sourceAlias: update.sourceAlias } : {}),
  };
  if (update.sourceAlias === null) delete next.sourceAlias;
  return next;
}

function tpLinkConnectionsConflict(connections: TpLinkConnectionSecret[]): boolean {
  const ids = new Set<string>();
  const houseHosts = new Set<string>();
  const deviceIds = new Set<string>();
  for (const connection of connections) {
    const houseHost = `${connection.houseId.trim()}\u0000${connection.host.trim().toLowerCase()}`;
    const deviceId = connection.deviceId?.trim().toUpperCase();
    if (ids.has(connection.id) || houseHosts.has(houseHost) || (deviceId && deviceIds.has(deviceId))) return true;
    ids.add(connection.id);
    houseHosts.add(houseHost);
    if (deviceId) deviceIds.add(deviceId);
  }
  return false;
}

/** Alerting, notification delivery, demo data and the device integration bridges (Home Assistant, TP-Link, Gree, Tuya, Nexus433, Tapo history), their credential testers and sensor-gap recovery. */
export function createIntegrationBridges(context: SpatialLayerServices) {
  const config = context.config;
  const { heatPumpStates, connectedDevices, telemetryArchive, telemetryReader, measurementSnapshotCache, status } = context;
  const storedTelegramIdentity = context.integrationMetadata.get("telegram", "singleton");
  if (status.value.telegram?.configured && storedTelegramIdentity?.active) {
      status.value.telegram.botUsername = storedTelegramIdentity.label;
      status.value.telegram.chatLabel = storedTelegramIdentity.secondaryLabel;
    }
  const telegram = context.options.telegram ?? new TelegramService();
  const alertEngine = new AlertEngine(context.database, context.bus, config, status, telegram, telemetryReader);
  const telemetry = new TelemetryService(context.database, context.bus, alertEngine, context.dataMode);
  const nexus433 = new Nexus433Service(config, context.database, telemetry);
  const measurements = new MeasurementService(context.database, context.bus, alertEngine, context.dataMode);
  heatPumpStates.setMeasurementSink((samples) => {
    measurements.ingestBatch(samples, { allowDisabledSensors: true });
  });
  const notificationOutbox = new NotificationOutboxWorker(
      context.database,
      config,
      status,
      {
        telegram,
        fetchImpl: fetch,
        telegramConfigurationGeneration: () => context.runtimeState.telegramDeliveryGeneration,
        onDeliveryFailure: (failure) => context.systemErrorLog.record({
          level: failure.terminal ? "error" : "warning",
          source: `notifications.${failure.channel}`,
          code: failure.terminal ? "DELIVERY_DEAD_LETTERED" : "DELIVERY_FAILED",
          message: failure.message,
        }),
      },
    );
  context.hostSystem.setAlertSnapshotHandler((snapshot) => {
      if (enqueueHostSystemAlertNotifications(context.database, config, snapshot) > 0) {
        notificationOutbox.wake();
      }
    });
  const mock = new MockEngine(context.database, telemetry, config, context.dataMode);
  const replay = new ReplayEngine(context.database, context.bus);
  // Recovery and the TP-Link bridge reference each other through callbacks, so
  // both are declared before either is built.
  let sensorGapRecovery: SensorGapRecoveryCoordinator | null = null;
  let tpLink: TpLinkBridge | undefined;
  const wakeSensorGapRecovery = (): void => sensorGapRecovery?.wake();
  const tapoHistory = new TapoHistoryExportService(config, context.database, {
      telemetryReader,
      systemErrorLog: context.systemErrorLog,
      onHistoryReady: wakeSensorGapRecovery,
      ...(context.options.tapoHistoryNow ? { now: context.options.tapoHistoryNow } : {}),
      deviceNameFor: context.options.tapoHistoryDeviceNameFor
        ?? ((sensorId, deviceId) => tpLink?.tapoAppDeviceName(sensorId, deviceId) ?? null),
    });
  const tapoHistoryFallbackKeys = new Set<string>();
  const historyFallbackKey = (sensorId: string, metric: string, from: string, to: string): string => (
      JSON.stringify([sensorId, metric, from, to])
    );
  const homeAssistant = new HomeAssistantBridge(config, telemetry, measurements, context.database, status, {
      onAvailabilityChange: wakeSensorGapRecovery,
      onOpeningStateRecorded: (observation) => context.notifyOpeningStateRecorded(observation),
      // Direct polling defaults to 2 s versus HA's current 5 s integration poll.
      // Prefer it only while this exact metric is healthy; HA then fails over
      // without requiring a configuration change or a second Sensor row.
      shouldIngestLiveMeasurement: (sensorId, metric) => (
        !tpLink?.isMetricAvailable(sensorId, metric)
        && !nexus433.isMetricAvailable(sensorId, metric)
      ),
    });
  const pendingTpLinkConnectionUpdates = new Map<string, PendingTpLinkConnectionUpdate>();
  tpLink = new TpLinkBridge(config, telemetry, measurements, context.database, status, {
      onAvailabilityChange: wakeSensorGapRecovery,
      onOpeningStateRecorded: (observation) => context.notifyOpeningStateRecorded(observation),
      historyFallback: {
        recoverHistory: async (sensorId, metric, from, to) => {
          const key = historyFallbackKey(sensorId, metric, from, to);
          tapoHistoryFallbackKeys.delete(key);
          let homeAssistantResult;
          try {
            homeAssistantResult = await homeAssistant.recoverHistory(sensorId, metric, from, to);
          } catch {
            homeAssistantResult = {
              state: "not-supported" as const,
              samples: [],
              error: "Home Assistant recorder history is temporarily unavailable",
            };
          }
          if (homeAssistantResult.state === "complete" && homeAssistantResult.samples.length > 0) {
            return homeAssistantResult;
          }
          tapoHistoryFallbackKeys.add(key);
          const tapoResult = await tapoHistory.recoverHistory(sensorId, metric, from, to);
          return mergeTpLinkHistoryRecovery(homeAssistantResult, tapoResult);
        },
        consumeRecovered: (sensorId, metric, from, to) => {
          const key = historyFallbackKey(sensorId, metric, from, to);
          if (!tapoHistoryFallbackKeys.delete(key)) return;
          tapoHistory.consumeRecovered(sensorId, metric, from, to);
        },
      },
      onConnectionUpdate: (update) => {
        const existing = config.tpLinkConnections ?? [];
        const current = existing.find((connection) => connection.id === update.id);
        if (!current || current.houseId !== update.houseId) return;
        const pending = pendingTpLinkConnectionUpdates.get(update.id);
        const effectiveCurrent = pending ? applyTpLinkConnectionUpdate(current, pending) : current;
        if (update.host !== effectiveCurrent.host && effectiveCurrent.host !== update.previousHost) return;
        if (update.deviceId && update.deviceId.length > 1_024) return;
        if (update.sourceModel && update.sourceModel.length > 128) return;
        if (update.sourceAlias && update.sourceAlias.length > 512) return;
        if (effectiveCurrent.deviceId && update.deviceId
          && effectiveCurrent.deviceId.trim().toUpperCase() !== update.deviceId.trim().toUpperCase()) return;
        const staged: PendingTpLinkConnectionUpdate = {
          id: current.id,
          houseId: current.houseId,
          host: update.host,
          ...(update.deviceId ? { deviceId: update.deviceId } : pending?.deviceId ? { deviceId: pending.deviceId } : {}),
          ...(update.sourceType ? { sourceType: update.sourceType } : pending?.sourceType ? { sourceType: pending.sourceType } : {}),
          ...(update.sourceModel ? { sourceModel: update.sourceModel } : pending?.sourceModel ? { sourceModel: pending.sourceModel } : {}),
          ...(update.sourceAlias !== undefined
            ? { sourceAlias: update.sourceAlias }
            : pending && "sourceAlias" in pending ? { sourceAlias: pending.sourceAlias } : {}),
        };
        const nextConnection = applyTpLinkConnectionUpdate(current, staged);
        if (JSON.stringify(nextConnection) === JSON.stringify(current)) pendingTpLinkConnectionUpdates.delete(current.id);
        else pendingTpLinkConnectionUpdates.set(current.id, staged);
        const connections = existing.map((connection) => {
          const connectionUpdate = pendingTpLinkConnectionUpdates.get(connection.id);
          return connectionUpdate ? applyTpLinkConnectionUpdate(connection, connectionUpdate) : connection;
        });
        if (tpLinkConnectionsConflict(connections) || pendingTpLinkConnectionUpdates.size === 0) return;
        const committedUpdates = [...pendingTpLinkConnectionUpdates.values()];
        updateIntegrationSecrets(config.integrationSecretsFile, { tpLinkConnections: connections });
        config.tpLinkConnections = connections;
        pendingTpLinkConnectionUpdates.clear();
        for (const committed of committedUpdates) {
          context.integrationMetadata.saveTpLink({
            id: committed.id,
            houseId: committed.houseId,
            host: committed.host,
            reason: "identity-refreshed",
          });
        }
      },
    });
  const tpLinkBridge = tpLink;
  const gree = new GreeBridge(config, status, heatPumpStates, context.bus, {
      onStateRecorded: () => {
        void telemetryArchive?.reconcileNow().catch(() => undefined);
      },
      onConnectionUpdate: (update) => {
        const existing = config.greeConnections ?? [];
        const current = existing.find((connection) => connection.id === update.id);
        if (!current || current.houseId !== update.houseId || current.mac !== update.mac
          || current.key !== update.key || current.cipherVersion !== update.cipherVersion) return;
        const nextConnection: GreeConnectionSecret = {
          ...current,
          host: update.host,
          port: update.port,
          ...(update.name ? { name: update.name } : {}),
          ...(update.brand ? { brand: update.brand } : {}),
          ...(update.model ? { model: update.model } : {}),
          ...(update.version ? { version: update.version } : {}),
        };
        if (JSON.stringify(current) === JSON.stringify(nextConnection)) return;
        const connections = existing.map((connection) => (
          connection.id === current.id ? nextConnection : connection
        ));
        updateIntegrationSecrets(config.integrationSecretsFile, { greeConnections: connections });
        config.greeConnections = connections;
      },
    });
  const tuya = new TuyaBridge(
      config,
      status,
      connectedDevices,
      context.database,
      measurements,
      context.bus,
      {
        onConnectionUpdate: (update) => {
          const existing = config.tuyaConnections ?? [];
          const current = existing.find((connection) => connection.id === update.id);
          if (!current || current.houseId !== update.houseId
            || current.deviceId !== update.deviceId || current.localKey !== update.localKey
            || current.protocolVersion !== update.protocolVersion
            || current.profileId !== update.profileId) return;
          const nextConnection: TuyaConnectionSecret = { ...current, host: update.host };
          if (nextConnection.host === current.host) return;
          const connections = existing.map((connection) => (
            connection.id === current.id ? nextConnection : connection
          ));
          updateIntegrationSecrets(config.integrationSecretsFile, { tuyaConnections: connections });
          config.tuyaConnections = connections;
        },
      },
    );
  sensorGapRecovery = new SensorGapRecoveryCoordinator(context.database, measurements, [homeAssistant, tpLink], {
      telemetryReader,
      systemErrorLog: context.systemErrorLog,
      onRecovered: () => {
        measurementSnapshotCache.clear();
        return telemetryArchive?.reconcileNow();
      },
    });
  const recovery = sensorGapRecovery;
  const homeAssistantCredentialTester = context.options.homeAssistantCredentialTester ?? testHomeAssistantCredentials;
  const tpLinkCredentialTester = context.options.tpLinkCredentialTester
      ?? ((host: string, username: string, password: string) => tpLinkBridge.testCredentials(host, username, password));
  context.dataMode.onActivated(() => {
      mock.stop();
      replay.reset();
      context.derivedAnalytics.handleDataModeActivated();
      context.notifySpatial((runtime) => runtime.handleDataModeActivated("real"));
      context.telemetryArchive?.enforceRealDataBoundary();
      context.status.refreshDataMode();
    });
  return Object.assign(context, { telegram, alertEngine, telemetry, nexus433, measurements, notificationOutbox, mock, replay, tapoHistory, homeAssistant, gree, tuya, tpLink: tpLinkBridge, sensorGapRecovery: recovery, homeAssistantCredentialTester, tpLinkCredentialTester });
}

export type IntegrationBridges = ReturnType<typeof createIntegrationBridges>;
