import type { TelemetryEvent } from "@climate-twin/contracts";

/** The per-principal checks a live event stream applies to each event. */
export interface StreamAccess {
  readonly restricted: boolean;
  sensor(sensorId: string): boolean;
  house(houseId: string): boolean;
}

/**
 * Returns what one principal may see of a live event, or null when it must not
 * be sent. The switch is exhaustive over TelemetryEvent, so a new event type
 * does not compile until it is scoped here.
 */
export function visibleStreamEvent(event: TelemetryEvent, access: StreamAccess): TelemetryEvent | null {
  switch (event.type) {
    case "reading":
    case "measurement":
    case "alert":
      return access.sensor(event.data.sensorId) ? event : null;
    case "weather":
    case "opening":
    case "heat-pump":
    case "connected-device":
      return access.house(event.data.houseId) ? event : null;
    case "integration":
      return access.restricted ? null : event;
    case "mutation":
      // Clients only use mutations as a refresh signal. Raw request paths name
      // members, grants and ungranted homes, which Guests must see as not found.
      return access.restricted
        ? { type: "mutation", data: { method: event.data.method, resource: "", occurredAt: event.data.occurredAt } }
        : event;
    case "heartbeat":
      return event;
    default: {
      const unscoped: never = event;
      return unscoped;
    }
  }
}
