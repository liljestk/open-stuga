import type {
  ConnectionState,
  MeasurementSample,
  TelemetryEvent,
} from "@climate-twin/contracts";
import type { Query, QueryClient } from "@tanstack/react-query";
import {
  subscribeToEvents,
  subscribeToMeasurementEvents,
} from "../../api";
import { queryClient } from "../queryClient";

type StreamName = "legacy" | "measurements";
const MONITORING_INVALIDATION_DEBOUNCE_MS = 2_000;
const MONITORING_INVALIDATION_THROTTLE_MS = 15_000;

export interface LiveEventHandlers {
  onTelemetry: (event: TelemetryEvent) => void;
  onMeasurement: (sample: MeasurementSample) => void;
  onConnection: (stream: StreamName, state: ConnectionState) => void;
  onOpen: (stream: StreamName) => void;
  houseIdForSensor?: (sensorId: string) => string | null;
}

interface LiveEventTransports {
  legacy: typeof subscribeToEvents;
  measurements: typeof subscribeToMeasurementEvents;
}

function isMonitoringCollectionQuery(query: Query): boolean {
  const key = query.queryKey;
  return key[0] === "monitoring" && key[1] === "houses";
}

function isMonitoringQuery(query: Query, houseId?: string): boolean {
  const key = query.queryKey;
  return isMonitoringCollectionQuery(query)
    || (key[0] === "house"
      && key[2] === "monitoring"
      && (houseId === undefined || key[1] === houseId));
}

function isOpeningActivityQuery(query: Query, houseId?: string): boolean {
  return query.queryKey[0] === "analytics"
    && query.queryKey[1] === "opening-activity"
    && (houseId === undefined || query.queryKey[2] === houseId);
}

function isCalendarComparisonQuery(query: Query, houseId?: string): boolean {
  return query.queryKey[0] === "analytics"
    && query.queryKey[1] === "calendar-comparison"
    && (houseId === undefined || query.queryKey[2] === houseId);
}

function isHomePerformanceQuery(query: Query, houseId?: string): boolean {
  return query.queryKey[0] === "house"
    && query.queryKey[2] === "analytics"
    && query.queryKey[3] === "home-performance"
    && (houseId === undefined || query.queryKey[1] === houseId);
}

function invalidate(
  client: QueryClient,
  predicate: (query: Query) => boolean,
): void {
  void client.invalidateQueries({ predicate });
}

export function invalidateForMeasurement(client: QueryClient, houseId?: string): void {
  // Monitoring is explicitly current-state data. Home Performance keeps its
  // 60-second server/client TTL and is not invalidated by routine ingestion.
  invalidate(client, (query) => isMonitoringQuery(query, houseId));
}

export function invalidateForTelemetry(
  client: QueryClient,
  event: TelemetryEvent,
  houseId?: string,
): void {
  switch (event.type) {
  case "reading":
  case "measurement":
  case "alert":
    invalidate(client, (query) => isMonitoringQuery(query, houseId));
    break;
  case "opening":
    invalidate(client, (query) => (
      isMonitoringQuery(query, houseId)
      || isOpeningActivityQuery(query, houseId)
      || isHomePerformanceQuery(query, houseId)
    ));
    break;
  case "weather":
  case "heat-pump":
    invalidate(client, (query) => (
      isMonitoringQuery(query, houseId) || isHomePerformanceQuery(query, houseId)
    ));
    break;
  case "integration":
    invalidate(client, (query) => (
      isMonitoringQuery(query) || isHomePerformanceQuery(query)
    ));
    break;
  case "mutation":
    invalidate(client, (query) => (
      isMonitoringQuery(query)
      || isOpeningActivityQuery(query)
      || isCalendarComparisonQuery(query)
      || isHomePerformanceQuery(query)
    ));
    break;
  case "heartbeat":
    break;
  }
}

function telemetryHouseId(
  event: TelemetryEvent,
  houseIdForSensor?: (sensorId: string) => string | null,
): string | undefined {
  switch (event.type) {
  case "reading":
  case "alert":
    return houseIdForSensor?.(event.data.sensorId) ?? undefined;
  case "measurement":
    return houseIdForSensor?.(event.data.sensorId) ?? undefined;
  case "opening":
  case "weather":
  case "heat-pump":
    return event.data.houseId;
  default:
    return undefined;
  }
}

export class LiveEventCoordinator {
  private stopCurrent: (() => void) | null = null;

  constructor(
    private readonly client: QueryClient = queryClient,
    private readonly transports: LiveEventTransports = {
      legacy: subscribeToEvents,
      measurements: subscribeToMeasurementEvents,
    },
  ) {}

  start(handlers: LiveEventHandlers): () => void {
    this.stop();
    let monitoringInvalidationTimer: ReturnType<typeof setTimeout> | null = null;
    let lastMonitoringInvalidationAt = Number.NEGATIVE_INFINITY;
    const pendingMonitoringHouseIds = new Set<string>();
    let invalidateEveryMonitoringHouse = false;
    const hasPendingMonitoringInvalidation = () => (
      invalidateEveryMonitoringHouse || pendingMonitoringHouseIds.size > 0
    );
    const flushMonitoringInvalidation = () => {
      monitoringInvalidationTimer = null;
      if (typeof document !== "undefined" && document.hidden) return;
      if (!hasPendingMonitoringInvalidation()) return;
      if (invalidateEveryMonitoringHouse) {
        invalidateForMeasurement(this.client);
      } else {
        const selected = new Set(pendingMonitoringHouseIds);
        invalidate(this.client, (query) => (
          isMonitoringCollectionQuery(query)
          || (query.queryKey[0] === "house"
            && query.queryKey[2] === "monitoring"
            && typeof query.queryKey[1] === "string"
            && selected.has(query.queryKey[1]))
        ));
      }
      lastMonitoringInvalidationAt = Date.now();
      pendingMonitoringHouseIds.clear();
      invalidateEveryMonitoringHouse = false;
    };
    const scheduleMonitoringTimer = () => {
      if (
        monitoringInvalidationTimer !== null
        || !hasPendingMonitoringInvalidation()
        || (typeof document !== "undefined" && document.hidden)
      ) return;
      const throttleDelay = lastMonitoringInvalidationAt
        + MONITORING_INVALIDATION_THROTTLE_MS
        - Date.now();
      monitoringInvalidationTimer = setTimeout(
        flushMonitoringInvalidation,
        Math.max(MONITORING_INVALIDATION_DEBOUNCE_MS, throttleDelay),
      );
    };
    const scheduleMonitoringInvalidation = (sensorId: string) => {
      const houseId = handlers.houseIdForSensor?.(sensorId) ?? null;
      if (houseId) pendingMonitoringHouseIds.add(houseId);
      else invalidateEveryMonitoringHouse = true;
      scheduleMonitoringTimer();
    };
    const handleVisibilityChange = () => {
      if (document.hidden) {
        if (monitoringInvalidationTimer !== null) {
          clearTimeout(monitoringInvalidationTimer);
          monitoringInvalidationTimer = null;
        }
        return;
      }
      scheduleMonitoringTimer();
    };
    if (typeof document !== "undefined") {
      document.addEventListener("visibilitychange", handleVisibilityChange);
    }
    const stopLegacy = this.transports.legacy(
      (event) => {
        handlers.onTelemetry(event);
        if (event.type === "reading" || event.type === "measurement") {
          scheduleMonitoringInvalidation(event.data.sensorId);
        }
        else invalidateForTelemetry(
          this.client,
          event,
          telemetryHouseId(event, handlers.houseIdForSensor),
        );
      },
      (state) => handlers.onConnection("legacy", state),
      () => handlers.onOpen("legacy"),
    );
    const stopMeasurements = this.transports.measurements(
      (sample) => {
        handlers.onMeasurement(sample);
        scheduleMonitoringInvalidation(sample.sensorId);
      },
      (state) => handlers.onConnection("measurements", state),
      () => handlers.onOpen("measurements"),
    );
    let stopped = false;
    const stop = () => {
      if (stopped) return;
      stopped = true;
      if (monitoringInvalidationTimer !== null) {
        clearTimeout(monitoringInvalidationTimer);
        monitoringInvalidationTimer = null;
      }
      pendingMonitoringHouseIds.clear();
      if (typeof document !== "undefined") {
        document.removeEventListener("visibilitychange", handleVisibilityChange);
      }
      stopLegacy();
      stopMeasurements();
      if (this.stopCurrent === stop) this.stopCurrent = null;
    };
    this.stopCurrent = stop;
    return stop;
  }

  stop(): void {
    this.stopCurrent?.();
  }
}
