import {
  fixedPlanElementOpeningState,
  resolvePlanElementOpeningState,
  type AirflowPlanElement,
  type EffectiveOpeningState,
  type OpeningStateObservation,
} from "@climate-twin/contracts";

/** Stable key shared by the 2D map, 3D scene, and the pending-request state. */
export function openingStateKey(floorId: string, elementId: string): string {
  return `${floorId}\u0000${elementId}`;
}

/** Resolve exactly the state that the simulation engines use at the displayed time. */
export function effectiveOpeningState(
  houseId: string | undefined,
  floorId: string,
  element: AirflowPlanElement,
  observations: readonly OpeningStateObservation[],
  at: string | number | Date,
): EffectiveOpeningState {
  return resolvePlanElementOpeningState(
    element,
    observations.filter((observation) => (!houseId || observation.houseId === houseId) && observation.floorId === floorId),
    at,
  );
}

export function openingStateObservationsForHouse(
  houseId: string | undefined,
  observations: readonly OpeningStateObservation[],
): OpeningStateObservation[] {
  return houseId ? observations.filter((observation) => observation.houseId === houseId) : [...observations];
}

/** Fixed windows and open passages are architectural constraints, not runtime controls. */
export function openingStateCanChange(element: AirflowPlanElement): boolean {
  return fixedPlanElementOpeningState(element) === null;
}
