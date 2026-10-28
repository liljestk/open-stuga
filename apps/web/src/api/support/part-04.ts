import { decodeTelemetryEvent } from "./telemetry-events";
import type {
  MeasurementSample,
  TelemetryEvent,
} from "@climate-twin/contracts";
import {
  parseSpatialLayerSnapshotEvent,
  type SpatialLayerSnapshotEvent,
} from "../../spatialLayers";
import { API_BASE, API_V2_BASE, STREAM_STABILITY_DELAY_MS, authorizationChange, notifyAuthorizationChange } from "./part-02";

type ApiEventStreamState = "live" | "reconnecting";

/**
 * Receives one stream message. `reportReconnecting` cancels a pending "live"
 * report and reports "reconnecting", e.g. when a heartbeat says the server
 * has fallen back to polling.
 */
type ApiEventStreamListener = (message: MessageEvent<string>, reportReconnecting: () => void) => void;

interface ApiEventStreamOptions {
  onState: (state: ApiEventStreamState) => void;
  onOpen?: (() => void) | undefined;
  /** Handles unnamed messages (`onmessage`); Stugu streams name every event. */
  onMessage?: ApiEventStreamListener;
  /** Handlers for named events, keyed by event type. */
  listeners: Record<string, ApiEventStreamListener>;
}

/**
 * Opens a credentialed live-update stream. "live" is reported only once the
 * connection has stayed open for STREAM_STABILITY_DELAY_MS; errors report
 * "reconnecting" at once. An `authorization` event closes the stream before
 * the session change is announced, so the stream cannot outlive its session.
 */
function openApiEventStream(url: string, options: ApiEventStreamOptions): () => void {
  const { onState, onOpen, onMessage, listeners } = options;
  const source = new EventSource(url, { withCredentials: true });
  let stabilityTimer: ReturnType<typeof setTimeout> | null = null;
  const cancelStabilityTimer = () => {
    if (stabilityTimer !== null) clearTimeout(stabilityTimer);
    stabilityTimer = null;
  };
  const reportReconnecting = () => {
    cancelStabilityTimer();
    onState("reconnecting");
  };
  source.onopen = () => {
    onOpen?.();
    cancelStabilityTimer();
    stabilityTimer = setTimeout(() => {
      stabilityTimer = null;
      onState("live");
    }, STREAM_STABILITY_DELAY_MS);
  };
  source.onerror = () => reportReconnecting();
  if (onMessage) source.onmessage = (message) => onMessage(message, reportReconnecting);
  for (const [type, listener] of Object.entries(listeners)) {
    source.addEventListener(type, (message) => listener(message as MessageEvent<string>, reportReconnecting));
  }
  source.addEventListener("authorization", (message) => {
    cancelStabilityTimer();
    source.close();
    onState("reconnecting");
    notifyAuthorizationChange(authorizationChange(message as MessageEvent<string>));
  });
  return () => {
    cancelStabilityTimer();
    source.close();
  };
}

export function subscribeToSpatialLayerEvents(
  requestedScope: string | { kind: "house" | "property"; id: string },
  onSnapshot: (event: SpatialLayerSnapshotEvent) => void,
  onState: (state: "live" | "reconnecting") => void,
  onOpen?: () => void,
): () => void {
  const scope = typeof requestedScope === "string" ? { kind: "house" as const, id: requestedScope } : requestedScope;
  const query = new URLSearchParams({ scopeKind: scope.kind, scopeId: scope.id });
  const consume = (message: MessageEvent<string>) => {
    try {
      const event = parseSpatialLayerSnapshotEvent(JSON.parse(message.data) as unknown);
      if (event && event.scope.kind === scope.kind && event.scope.id === scope.id) onSnapshot(event);
    } catch {
      // Experimental engines may be upgraded independently. Ignore malformed
      // notifications and retain the last validated snapshot.
    }
  };
  return openApiEventStream(`${API_BASE}/layers/events?${query.toString()}`, {
    onState,
    onOpen,
    onMessage: consume,
    listeners: { "spatial-layer-snapshot": consume },
  });
}

export function subscribeToMeasurementEvents(
  onSample: (sample: MeasurementSample) => void,
  onState: (state: "live" | "reconnecting") => void,
  onOpen?: () => void,
): () => void {
  const consume = (message: MessageEvent<string>) => {
    try {
      const event = decodeTelemetryEvent("measurement", JSON.parse(message.data));
      if (event?.type === "measurement") onSample(event.data);
    } catch {
      // A malformed sample is ignored; the stream remains connected.
    }
  };
  return openApiEventStream(`${API_V2_BASE}/measurements/events`, {
    onState,
    onOpen,
    listeners: { measurement: consume },
  });
}

export function subscribeToEvents(
  onEvent: (event: TelemetryEvent) => void,
  onState: (state: "live" | "reconnecting") => void,
  onOpen?: () => void,
): () => void {
  const consume = (message: MessageEvent<string>, type: TelemetryEvent["type"]) => {
    try {
      const event = decodeTelemetryEvent(type, JSON.parse(message.data));
      if (event) onEvent(event);
    } catch {
      // A malformed event is ignored; the stream remains connected.
    }
  };
  const eventTypes = ["reading", "alert", "integration", "weather", "opening", "heat-pump", "connected-device", "mutation", "heartbeat"] as const;
  return openApiEventStream(`${API_BASE}/stream`, {
    onState,
    onOpen,
    listeners: Object.fromEntries(eventTypes.map((type): [string, ApiEventStreamListener] => [
      type,
      (message) => consume(message, type),
    ])),
  });
}
