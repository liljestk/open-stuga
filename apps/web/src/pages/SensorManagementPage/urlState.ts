import type { TimeRange } from "../../domain";
import type { SensorFilter } from "./support";

const SENSOR_URGENCIES: SensorFilter[] = ["live", "waiting", "unplaced", "archived"];
const SENSOR_DETAIL_RANGES: TimeRange[] = ["6h", "24h", "7d"];

export type SensorDetailTarget =
  | { kind: "sensor"; sensorId: string }
  | { kind: "contact"; deviceId: string; connectionId?: string }
  | null;

export interface SensorUrlState {
  urgency: SensorFilter;
  detail: SensorDetailTarget;
  range: TimeRange;
}

function detailFromParam(value: string | null): SensorDetailTarget {
  if (!value) return null;
  const [kind, ...encodedParts] = value.split("/");
  try {
    if (kind === "sensor" && encodedParts.length === 1 && encodedParts[0]) {
      return { kind, sensorId: decodeURIComponent(encodedParts[0]) };
    }
    if (kind === "contact" && encodedParts.length === 1 && encodedParts[0]) {
      return { kind, deviceId: decodeURIComponent(encodedParts[0]) };
    }
    if (kind === "contact" && encodedParts.length === 2 && encodedParts[0] && encodedParts[1]) {
      return {
        kind,
        connectionId: decodeURIComponent(encodedParts[0]),
        deviceId: decodeURIComponent(encodedParts[1]),
      };
    }
  } catch {
    return null;
  }
  return null;
}

function detailParam(target: SensorDetailTarget): string {
  if (!target) return "";
  if (target.kind === "sensor") return `sensor/${encodeURIComponent(target.sensorId)}`;
  const deviceId = encodeURIComponent(target.deviceId);
  return target.connectionId
    ? `contact/${encodeURIComponent(target.connectionId)}/${deviceId}`
    : `contact/${deviceId}`;
}

export function sensorUrlStateFromLocation(
  search = typeof window === "undefined" ? "" : window.location.search,
): SensorUrlState {
  const params = new URLSearchParams(search);
  const requestedUrgency = params.get("urgency");
  const requestedRange = params.get("range");
  return {
    urgency: requestedUrgency && SENSOR_URGENCIES.includes(requestedUrgency as SensorFilter)
      ? requestedUrgency as SensorFilter
      : "all",
    detail: detailFromParam(params.get("detail")),
    range: requestedRange && SENSOR_DETAIL_RANGES.includes(requestedRange as TimeRange)
      ? requestedRange as TimeRange
      : "24h",
  };
}

export function writeSensorUrlStateToLocation(state: SensorUrlState, mode: "push" | "replace"): void {
  if (typeof window === "undefined") return;
  const url = new URL(window.location.href);
  if (state.urgency === "all") url.searchParams.delete("urgency");
  else url.searchParams.set("urgency", state.urgency);
  const detail = detailParam(state.detail);
  if (detail) url.searchParams.set("detail", detail);
  else url.searchParams.delete("detail");
  if (state.range === "24h") url.searchParams.delete("range");
  else url.searchParams.set("range", state.range);
  const next = `${url.pathname}${url.search}${url.hash}`;
  const current = `${window.location.pathname}${window.location.search}${window.location.hash}`;
  if (next !== current) window.history[`${mode}State`](window.history.state, "", next);
}
