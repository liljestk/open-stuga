import type { BuildingSceneProps } from "./sceneGeometry";
import { useBuildingScenePart01 } from "./part-01";
import { useBuildingScenePart02 } from "./part-02";
import { useBuildingScenePart03 } from "./part-03";
import { renderBuildingScene } from "./render";

export function BuildingScene({
  house, sensors, samples, climateSamples, observations, definition, colorDomain, units, activeFloorId, selectedSensorId,
  referenceTimeMs, maxSampleAgeMs, outdoor, mapAnimationsEnabled = true, outdoorExtrasVisible = true, editing = false, spatialLayerSnapshots = [], spatialLayerTopology = null,
  experimentalAirflowEnabled = false, experimentalAirflow = null, experimentalSensorCoverage = null, experimentalOutdoorInfluence = null,
  openingStateObservations = [], openingStateLabelsVisible = true, pendingOpeningStateKeys = new Set<string>(), onOpeningStateChange,
  sensorMeasurements = {}, climateSensorMarkersVisible = true, energyDevicesVisible = true,
  connectedDevices = [], connectedDevicesVisible = true, pendingConnectedDeviceIds = new Set<string>(),
  heatPumps = [], heatPumpInfluenceVisible = true, selectedHeatPumpId = null,
  onConnectedDevicePowerChange, onHeatPumpSelect,
  onFloorSelect, onSensorSelect, onFloorChange,
}: BuildingSceneProps) {
  const context0 = { house, sensors, samples, climateSamples, observations, definition, colorDomain, units, activeFloorId, selectedSensorId, referenceTimeMs, maxSampleAgeMs, outdoor, mapAnimationsEnabled, outdoorExtrasVisible, editing, spatialLayerSnapshots, spatialLayerTopology, experimentalAirflowEnabled, experimentalAirflow, experimentalSensorCoverage, experimentalOutdoorInfluence, openingStateObservations, openingStateLabelsVisible, pendingOpeningStateKeys, onOpeningStateChange, sensorMeasurements, climateSensorMarkersVisible, energyDevicesVisible, connectedDevices, connectedDevicesVisible, pendingConnectedDeviceIds, heatPumps, heatPumpInfluenceVisible, selectedHeatPumpId, onConnectedDevicePowerChange, onHeatPumpSelect, onFloorSelect, onSensorSelect, onFloorChange };
  const context1 = useBuildingScenePart01(context0);
  const context2 = useBuildingScenePart02(context1);
  const context3 = useBuildingScenePart03(context2);
  return renderBuildingScene(context3);
}
