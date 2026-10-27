import type {
  OpeningStateObservation,
  Sensor,
} from "@climate-twin/contracts";
import {
  createLocalSpatialLayerRuntime,
  type LocalSpatialLayerRuntime,
} from "../spatial-layers/index.js";
import type { TelemetryServices } from "./telemetry-services.js";
/** The optional spatial-layer engine and the change notifications that keep its inference current. Created before the bridges so they can report opening states directly. */
export function createSpatialLayerServices(context: TelemetryServices) {
  const config = context.config;
  let spatialLayers: LocalSpatialLayerRuntime | null = null;
  if (config.spatialLayersEnabled ?? false) {
      try {
        spatialLayers = createLocalSpatialLayerRuntime({
          coreDatabase: context.database,
          telemetryReader: context.telemetryReader,
          coreDatabasePath: config.databasePath,
          dataMode: context.database.isRealDataMode() ? "real" : "demo",
          startBackground: false,
          admission: {
            acquire: () => context.analyticsWorkLimiter.acquireLowPriority(
              "spatial-inference",
              context.admitLowPriority,
            ),
          },
          ...(config.spatialLayersDatabasePath === undefined ? {} : { statePath: config.spatialLayersDatabasePath }),
          ...(config.spatialLayersIntervalMs === undefined ? {} : { intervalMs: config.spatialLayersIntervalMs }),
          ...(config.spatialLayersRetentionDays === undefined ? {} : { retentionDays: config.spatialLayersRetentionDays }),
        });
      } catch (error) {
        // This optional research subsystem must never prevent the core API from
        // starting. Its routes remain available and report 503 while disabled.
        const message = error instanceof Error ? error.message : "unknown startup failure";
        console.error(`[spatial-layers] Optional engine unavailable: ${message}`);
      }
    }
  const notifySpatial = (operation: (runtime: LocalSpatialLayerRuntime) => void): void => {
      if (!spatialLayers) return;
      try {
        operation(spatialLayers);
      } catch (error) {
        const message = error instanceof Error ? error.message : "unknown notification failure";
        // Core writes are authoritative and may already be committed. An
        // optional derived subsystem must never turn that successful mutation
        // into an HTTP failure; its periodic scheduler can reconcile later.
        console.error(`[spatial-layers] Optional change notification failed: ${message}`);
      }
    };
  const notifyOpeningStateRecorded = (observation: OpeningStateObservation): void => {
      context.bus.publish({ type: "opening", data: observation });
      void context.telemetryArchive?.reconcileNow().catch(() => undefined);
      notifySpatial((runtime) => runtime.scheduler.wakeHouse(
        observation.houseId,
        null,
        observation.observedAt,
        "property-context-changed",
      ));
    };
  const notifySpatialSensorChange = (before: Sensor | null, after: Sensor | null): void => {
      const houseIds = [...new Set([before?.houseId, after?.houseId].filter((id): id is string => Boolean(id)))];
      if (houseIds.length === 0) return;
      const observedAt = new Date().toISOString();
      notifySpatial((runtime) => {
        for (const houseId of houseIds) {
          runtime.scheduler.wakeHouse(houseId, null, observedAt, "sensor-context-changed");
        }
      });
    };
  return Object.assign(context, { spatialLayers, notifySpatial, notifyOpeningStateRecorded, notifySpatialSensorChange });
}

export type SpatialLayerServices = ReturnType<typeof createSpatialLayerServices>;
