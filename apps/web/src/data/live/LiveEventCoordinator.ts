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

export interface LiveEventHandlers {
  onTelemetry: (event: TelemetryEvent) => void;
  onMeasurement: (sample: MeasurementSample) => void;
  onConnection: (stream: StreamName, state: ConnectionState) => void;
  onOpen: (stream: StreamName) => void;
}

interface LiveEventTransports {
  legacy: typeof subscribeToEvents;
  measurements: typeof subscribeToMeasurementEvents;
}

function isMonitoringQuery(query: Query): boolean {
  const key = query.queryKey;
  return (key[0] === "monitoring" && key[1] === "houses")
    || (key[0] === "house" && key[2] === "monitoring");
}

function isOpeningActivityQuery(query: Query): boolean {
  return query.queryKey[0] === "analytics"
    && query.queryKey[1] === "opening-activity";
}

function isCalendarComparisonQuery(query: Query): boolean {
  return query.queryKey[0] === "analytics"
    && query.queryKey[1] === "calendar-comparison";
}

function isHomePerformanceQuery(query: Query): boolean {
  return query.queryKey[0] === "house"
    && query.queryKey[2] === "analytics"
    && query.queryKey[3] === "home-performance";
}

function invalidate(
  client: QueryClient,
  predicate: (query: Query) => boolean,
): void {
  void client.invalidateQueries({ predicate });
}

export function invalidateForMeasurement(client: QueryClient): void {
  // Monitoring is explicitly current-state data. Home Performance keeps its
  // 60-second server/client TTL and is not invalidated by routine ingestion.
  invalidate(client, isMonitoringQuery);
}

export function invalidateForTelemetry(
  client: QueryClient,
  event: TelemetryEvent,
): void {
  switch (event.type) {
  case "reading":
  case "alert":
    invalidate(client, isMonitoringQuery);
    break;
  case "opening":
    invalidate(client, (query) => (
      isMonitoringQuery(query)
      || isOpeningActivityQuery(query)
      || isHomePerformanceQuery(query)
    ));
    break;
  case "weather":
  case "integration":
  case "heat-pump":
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
    const stopLegacy = this.transports.legacy(
      (event) => {
        handlers.onTelemetry(event);
        invalidateForTelemetry(this.client, event);
      },
      (state) => handlers.onConnection("legacy", state),
      () => handlers.onOpen("legacy"),
    );
    const stopMeasurements = this.transports.measurements(
      (sample) => {
        handlers.onMeasurement(sample);
        invalidateForMeasurement(this.client);
      },
      (state) => handlers.onConnection("measurements", state),
      () => handlers.onOpen("measurements"),
    );
    let stopped = false;
    const stop = () => {
      if (stopped) return;
      stopped = true;
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
