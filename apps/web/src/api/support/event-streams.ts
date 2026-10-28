import { SYSTEM_UPDATE_WORKFLOW_PHASES, type TrackingEvent, type MeasurementSample, type TelemetryEvent } from "@climate-twin/contracts";
import { parseSpatialLayerSnapshotEvent, type SpatialLayerSnapshotEvent } from "../../spatialLayers";
import { decodeTelemetryEvent } from "./telemetry-events";
import type { SystemUpdateLiveStatus } from "./response-types";
import { API_BASE, API_V2_BASE, STREAM_STABILITY_DELAY_MS, authorizationChange, notifyAuthorizationChange } from "./client-state";

const systemUpdateWorkflowPhases: ReadonlySet<string> = new Set(SYSTEM_UPDATE_WORKFLOW_PHASES);

export function subscribeToSystemUpdateEvents(
  onStatus: (status: SystemUpdateLiveStatus) => void,
  onState: (state: "live" | "reconnecting") => void,
): () => void {
  const source = new EventSource(`${API_BASE}/system/updates/events`, { withCredentials: true });
  const consume = (message: MessageEvent<string>) => {
    try {
      const status = JSON.parse(message.data) as SystemUpdateLiveStatus;
      if (
        !status
        || typeof status !== "object"
        || typeof status.currentVersion !== "string"
        || (status.latestVersion !== null && typeof status.latestVersion !== "string")
        || typeof status.updateAvailable !== "boolean"
        || !status.capability
        || typeof status.capability !== "object"
        || (status.schema !== undefined && status.schema !== "stugu-system-updates/v2")
        || (status.revision !== undefined && (!Number.isSafeInteger(status.revision) || status.revision < 0))
        || (status.operation !== null && typeof status.operation !== "object")
        || (status.application !== undefined && (status.application === null || typeof status.application !== "object"))
        || (status.host !== undefined && status.host !== null && typeof status.host !== "object")
        || (status.workflow !== undefined && status.workflow !== null && typeof status.workflow !== "object")
      ) return;
      if (status.workflow && (
        typeof status.workflow.id !== "string"
        || !Number.isSafeInteger(status.workflow.revision)
        || typeof status.workflow.phase !== "string"
        || !systemUpdateWorkflowPhases.has(status.workflow.phase)
        || !status.workflow.targets
        || typeof status.workflow.targets !== "object"
      )) return;
      const ready = status.host?.readyToRestart;
      if (ready && (
        typeof ready.operationId !== "string"
        || typeof ready.targetVersion !== "string"
        || !Number.isSafeInteger(ready.targetGeneration)
        || ready.targetGeneration < 0
        || typeof ready.targetDigest !== "string"
      )) return;
      onStatus(status);
    } catch {
      // Keep the last validated update state while the server reconnects.
    }
  };
  source.onopen = () => onState("live");
  source.onerror = () => onState("reconnecting");
  source.onmessage = consume;
  source.addEventListener("system-update", (message) => consume(message as MessageEvent<string>));
  source.addEventListener("authorization", (message) => {
    source.close();
    onState("reconnecting");
    notifyAuthorizationChange(authorizationChange(message as MessageEvent<string>));
  });
  return () => source.close();
}

export const TRACKING_EVENT_TYPES: readonly TrackingEvent["type"][] = [
  "equipment.position.updated",
  "equipment.zone.changed",
  "equipment.movement.started",
  "equipment.movement.stopped",
  "equipment.property.exited",
  "equipment.property.entered",
  "endpoint.battery.low",
  "endpoint.not_seen",
  "gateway.online",
  "gateway.offline",
  "member.location.updated",
  "member.location.stopped",
];

export function subscribeToTrackingEvents(
  propertyId: string,
  onRefresh: (event: TrackingEvent | null) => void,
  onState: (state: "live" | "reconnecting") => void,
): () => void {
  const source = new EventSource(
    `${API_BASE}/properties/${encodeURIComponent(propertyId)}/tracking-stream`,
    { withCredentials: true },
  );
  const consume = (message: MessageEvent<string>) => {
    try {
      const event = JSON.parse(message.data) as TrackingEvent;
      if (
        !event
        || event.propertyId !== propertyId
        || !TRACKING_EVENT_TYPES.includes(event.type)
        || !Number.isSafeInteger(event.sequence)
      ) return;
      onRefresh(event);
    } catch {
      // Preserve the last complete map snapshot when an event is malformed.
    }
  };
  source.onopen = () => onState("live");
  source.onerror = () => onState("reconnecting");
  TRACKING_EVENT_TYPES.forEach((type) => {
    source.addEventListener(type, (message) => consume(message as MessageEvent<string>));
  });
  source.addEventListener("ready", () => onState("live"));
  source.addEventListener("snapshot-required", () => onRefresh(null));
  source.addEventListener("authorization", (message) => {
    source.close();
    onState("reconnecting");
    notifyAuthorizationChange(authorizationChange(message as MessageEvent<string>));
  });
  return () => source.close();
}

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
