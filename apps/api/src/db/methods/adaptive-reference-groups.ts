import { isAdaptiveReferenceGroups, type AdaptiveReferenceGroup, type Sensor } from "@climate-twin/contracts";
import { compareCodeUnits } from "../../text-order.js";
import type { DatabaseInternals } from "../core.js";
import { ClimateDataValidationError } from "../support/validation-errors.js";

export function normalizeReferenceGroups(groups: AdaptiveReferenceGroup[]): AdaptiveReferenceGroup[] {
  if (!isAdaptiveReferenceGroups(groups)) {
    throw new ClimateDataValidationError(400, "INVALID_REFERENCE_GROUPS", "Invalid adaptive temperature reference groups");
  }
  return groups.map(({ targetSensorId, kind, referenceSensorIds, placement }) => ({
    targetSensorId,
    kind,
    referenceSensorIds: [...referenceSensorIds].sort(compareCodeUnits),
    placement: placement.trim(),
  })).sort((left, right) => compareCodeUnits(left.targetSensorId, right.targetSensorId));
}

function temperatureSourceKeys(sensor: Sensor): string[] {
  const entities = new Set([sensor.temperatureEntityId, sensor.measurementEntityIds?.temperature]);
  const keys = [...entities].filter(Boolean).map((entity) => `entity:${entity}`);
  if (sensor.tpLinkDeviceId) keys.push(`tapo:${sensor.tpLinkDeviceId}`);
  return keys;
}

export function assertReferenceMembership(
  database: DatabaseInternals,
  houseId: string,
  groups: AdaptiveReferenceGroup[],
): void {
  for (const group of groups) {
    const sources = new Set<string>();
    for (const sensorId of [group.targetSensorId, ...group.referenceSensorIds]) {
      const sensor = database.getSensor(sensorId);
      if (!sensor || !sensor.enabled || sensor.houseId !== houseId) {
        throw new ClimateDataValidationError(400, "INVALID_REFERENCE_SENSOR", "Reference groups require enabled sensors from this Home");
      }
      for (const source of temperatureSourceKeys(sensor)) {
        if (sources.has(source)) {
          throw new ClimateDataValidationError(400, "DUPLICATE_REFERENCE_SOURCE", "Reference group sensors share a temperature source");
        }
        sources.add(source);
      }
    }
  }
}
