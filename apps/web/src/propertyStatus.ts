import type { AreaEquipment, PropertyArea } from "@climate-twin/contracts";
import type { ClimateState } from "./domain";
import { deriveHouseMonitoring } from "./houseMonitoring";
import { integrationForHouse } from "./integrationScope";

export type PropertyTrafficLightId = "house" | "equipment" | "well" | "infrastructure";
export type PropertyTrafficLightLevel = "ok" | "caution" | "critical";
export type PropertyTrafficLightReason = "healthy" | "not-monitored" | "sensor-gap" | "connection-down" | "asset-failure";

export interface PropertyTrafficLight {
  id: PropertyTrafficLightId;
  level: PropertyTrafficLightLevel;
  reason: PropertyTrafficLightReason;
}

type PropertyStatusState = Pick<ClimateState,
  | "houses"
  | "sensors"
  | "latestMeasurements"
  | "measurementHistory"
  | "alerts"
  | "alertRules"
  | "integration"
  | "propertyAreas"
  | "areaEquipment"
>;

const INFRASTRUCTURE_AREA_KINDS = new Set<PropertyArea["kind"]>(["garage", "dock", "road", "shoreline", "building"]);

function equipmentFailure(items: readonly AreaEquipment[]): boolean {
  return items.some((item) => item.status === "out-of-service");
}

/**
 * Produces conservative traffic lights only for asset categories that exist
 * on the Property. Green means the mapped scope has positive current evidence;
 * missing monitoring remains amber and known failures are red.
 */
export function derivePropertyTrafficLights(
  state: PropertyStatusState,
  propertyId: string,
  referenceTime: string | number,
): PropertyTrafficLight[] {
  const houses = state.houses.filter((house) => house.propertyId === propertyId);
  const areas = state.propertyAreas.filter((area) => area.propertyId === propertyId);
  const equipment = state.areaEquipment.filter((item) => item.propertyId === propertyId && item.status !== "retired");
  const monitoring = houses.map((house) => deriveHouseMonitoring({
    house,
    sensors: state.sensors,
    latestMeasurements: state.latestMeasurements,
    measurementHistory: state.measurementHistory,
    alerts: state.alerts,
    alertRules: state.alertRules,
    integration: integrationForHouse(state.integration, house.id, Boolean(house.location)),
    referenceTime,
  }));

  const houseConnectionDown = monitoring.some((result) => result.blockers.some((blocker) => blocker.kind === "source-disconnected"));
  const houseFailure = monitoring.some((result) => result.status === "action-required");
  const houseGap = houses.length === 0 || monitoring.some((result) => result.status !== "monitoring-ok");
  const house: PropertyTrafficLight = houseConnectionDown
    ? { id: "house", level: "critical", reason: "connection-down" }
    : houseFailure
      ? { id: "house", level: "critical", reason: "asset-failure" }
      : houseGap
        ? { id: "house", level: "caution", reason: houses.length ? "sensor-gap" : "not-monitored" }
        : { id: "house", level: "ok", reason: "healthy" };

  const equipmentBroken = equipmentFailure(equipment);
  const equipmentLight: PropertyTrafficLight = equipmentBroken
      ? { id: "equipment", level: "critical", reason: "asset-failure" }
      : { id: "equipment", level: "caution", reason: "not-monitored" };

  const wells = areas.filter((area) => area.kind === "well");
  const wellIds = new Set(wells.map((area) => area.id));
  const wellEquipment = equipment.filter((item) => wellIds.has(item.areaId));
  const well: PropertyTrafficLight = equipmentFailure(wellEquipment)
      ? { id: "well", level: "critical", reason: "asset-failure" }
      : { id: "well", level: "caution", reason: "not-monitored" };

  const infrastructureAreas = areas.filter((area) => INFRASTRUCTURE_AREA_KINDS.has(area.kind));
  const infrastructureAreaIds = new Set(infrastructureAreas.map((area) => area.id));
  const infrastructureEquipment = equipment.filter((item) => infrastructureAreaIds.has(item.areaId));
  const infrastructure: PropertyTrafficLight = equipmentFailure(infrastructureEquipment)
      ? { id: "infrastructure", level: "critical", reason: "asset-failure" }
      : { id: "infrastructure", level: "caution", reason: "not-monitored" };

  return [
    ...(houses.length ? [house] : []),
    ...(equipment.length ? [equipmentLight] : []),
    ...(wells.length ? [well] : []),
    ...(infrastructureAreas.length ? [infrastructure] : []),
  ];
}
