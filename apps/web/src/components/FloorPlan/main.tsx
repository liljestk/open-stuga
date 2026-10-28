import type { FloorPlanProps } from "./support";
import { useFloorPlanPart01 } from "./part-01";
import { useFloorPlanPart02 } from "./part-02";
import { useFloorPlanPart03 } from "./part-03";
import { useFloorPlanPart04 } from "./part-04";
import { useFloorPlanPart05 } from "./part-05";
import { renderFloorPlan } from "./render";

export function FloorPlan({
  floor, house, sensors, samples, climateSamples, observations, definition, colorDomain, units, viewMode, selectedSensorId, editing,
  observationPlacement, onSensorSelect, onSensorMove, onFloorChange, onObservationPoint, onCancelObservationPlacement,
  referenceTimeMs, maxSampleAgeMs,
  outdoor, mapAnimationsEnabled = true, outdoorExtrasVisible = true, spatialLayerSnapshots = [], spatialLayerTopology = null,
  experimentalAirflowEnabled = false, experimentalAirflow = null, experimentalSensorCoverage = null, experimentalOutdoorInfluence = null,
  openingStateObservations = [], pendingOpeningStateKeys = new Set<string>(), onOpeningStateChange,
  sensorMeasurements = {}, climateSensorMarkersVisible = true, energyDevicesVisible = true,
  connectedDevices = [], connectedDevicesVisible = true, pendingConnectedDeviceIds = new Set<string>(),
  heatPumps = [], heatPumpInfluenceVisible = true, pendingHeatPumpIds = new Set<string>(), selectedHeatPumpId = null,
  onConnectedDevicePowerChange, onConnectedDeviceMove, onHeatPumpSelect, onHeatPumpMove, allowBackgroundImageEditing = true,
}: FloorPlanProps) {
  const context0 = { floor, house, sensors, samples, climateSamples, observations, definition, colorDomain, units, viewMode, selectedSensorId, editing, observationPlacement, onSensorSelect, onSensorMove, onFloorChange, onObservationPoint, onCancelObservationPlacement, referenceTimeMs, maxSampleAgeMs, outdoor, mapAnimationsEnabled, outdoorExtrasVisible, spatialLayerSnapshots, spatialLayerTopology, experimentalAirflowEnabled, experimentalAirflow, experimentalSensorCoverage, experimentalOutdoorInfluence, openingStateObservations, pendingOpeningStateKeys, onOpeningStateChange, sensorMeasurements, climateSensorMarkersVisible, energyDevicesVisible, connectedDevices, connectedDevicesVisible, pendingConnectedDeviceIds, heatPumps, heatPumpInfluenceVisible, pendingHeatPumpIds, selectedHeatPumpId, onConnectedDevicePowerChange, onConnectedDeviceMove, onHeatPumpSelect, onHeatPumpMove, allowBackgroundImageEditing };
  const context1 = useFloorPlanPart01(context0);
  const context2 = useFloorPlanPart02(context1);
  const context3 = useFloorPlanPart03(context2);
  const context4 = useFloorPlanPart04(context3);
  const context5 = useFloorPlanPart05(context4);
  return renderFloorPlan(context5);
}
