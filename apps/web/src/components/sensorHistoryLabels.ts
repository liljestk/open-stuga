import type { Sensor } from "@climate-twin/contracts";

export type SensorHistoryState = "live" | "archived" | "mixed";

export function sensorHistoryState(sensors: readonly Sensor[]): SensorHistoryState {
  const archivedCount = sensors.filter((sensor) => !sensor.enabled).length;
  if (archivedCount === 0) return "live";
  return archivedCount === sensors.length ? "archived" : "mixed";
}

export function sensorHistoryName(sensor: Sensor, archivedLabel: string): string {
  return sensor.enabled ? sensor.name : `${sensor.name} · ${archivedLabel}`;
}

export function withSensorHistoryState(
  label: string,
  state: SensorHistoryState,
  archivedHistoryLabel: string,
  includesArchivedLabel: string,
): string {
  if (state === "live") return label;
  return `${label} · ${state === "archived" ? archivedHistoryLabel : includesArchivedLabel}`;
}
