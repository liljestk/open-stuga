import type { TelemetryEvent } from "@climate-twin/contracts";

type TelemetryEventType = TelemetryEvent["type"];
type Payload = Record<string, unknown>;

const isText = (value: unknown): value is string => typeof value === "string";
const isFiniteNumber = (value: unknown): value is number => typeof value === "number" && Number.isFinite(value);
const isPayload = (value: unknown): value is Payload => Boolean(value) && typeof value === "object" && !Array.isArray(value);

/** The fields each consumer of an event type reads; a payload without them is dropped. */
const PAYLOAD_CHECKS: Readonly<Record<TelemetryEventType, (data: Payload) => boolean>> = {
  reading: (data) => isText(data.sensorId) && isText(data.timestamp)
    && isFiniteNumber(data.temperature) && isFiniteNumber(data.humidity),
  measurement: (data) => isText(data.sensorId) && isText(data.metric) && isText(data.timestamp) && isFiniteNumber(data.value),
  alert: (data) => isText(data.id) && isText(data.ruleId) && isText(data.sensorId),
  integration: (data) => isPayload(data.homeAssistant) && isPayload(data.tpLink),
  weather: (data) => data.type === "weather.snapshot" && isText(data.houseId) && isPayload(data.weather),
  opening: (data) => isText(data.id) && isText(data.houseId) && isText(data.elementId),
  "heat-pump": (data) => isText(data.connectionId) && isText(data.houseId),
  "connected-device": (data) => isText(data.id) && isText(data.houseId),
  mutation: (data) => isText(data.method) && isText(data.resource) && isText(data.occurredAt),
  heartbeat: (data) => isText(data.timestamp),
};

/** A named server-sent event as a TelemetryEvent, or null when its payload is not that type's shape. */
export function decodeTelemetryEvent(type: TelemetryEventType, raw: unknown): TelemetryEvent | null {
  if (!isPayload(raw) || !PAYLOAD_CHECKS[type](raw)) return null;
  // PAYLOAD_CHECKS[type] established the fields that event type's consumers read.
  return { type, data: raw } as TelemetryEvent;
}
