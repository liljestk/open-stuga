import type { ClimateDataPipelineContext } from "./pipelineTypes";
export function createClimateDataPublicModel(context: ClimateDataPipelineContext) {
  const { state, loading, bootstrapStatus, bootstrapError, dataMode, connection, pollingFallback, resourceErrors, seriesStates, scenario, saveState, tpLinkDevices, tpLinkDevicesLoading, tpLinkDevicesError, applyIntegrationStatus, refreshTpLinkDevices, disconnectHomeAssistant, disconnectTpLink, moveHomeAssistant, moveTpLink, retryBootstrap, endSession, selectHouse, importHistoricalMeasurements, loadSeries, loadHistoricalSeries, createSensor, updateSensor, deleteSensor, moveSensor, createProperty, updateProperty, deleteProperty, createPropertyArea, updatePropertyArea, deletePropertyArea, createAreaEquipment, updateAreaEquipment, deleteAreaEquipment, createPropertyNote, updatePropertyNote, deletePropertyNote, setHouseGeoreference, updateFloor, updateHouseDraft, updateHouse, createHouse, deleteHouse, saveLayout, runScenario, createRule, updateRule, acknowledgeAlert, createObservation, reloadObservation, updateObservation, observationRevisions, createMaintenanceTask, reloadMaintenanceTask, updateMaintenanceTask, maintenanceTaskRevisions, deleteMaintenanceTask, createStaticParameter } = context;
  return {
      state, loading, bootstrapStatus, bootstrapError, retryBootstrap, endSession, dataMode, connection, pollingFallback,
      resourceErrors, seriesStates, scenario, saveState,
      tpLinkDevices, tpLinkDevicesLoading, tpLinkDevicesError, refreshTpLinkDevices,
      disconnectHomeAssistant, disconnectTpLink, moveHomeAssistant, moveTpLink,
      applyIntegrationStatus,
      selectHouse, loadSeries, loadHistoricalSeries, importHistoricalMeasurements,
      createProperty, updateProperty, deleteProperty, createPropertyArea, updatePropertyArea, deletePropertyArea,
      createAreaEquipment, updateAreaEquipment, deleteAreaEquipment, createPropertyNote, updatePropertyNote, deletePropertyNote,
      createHouse, deleteHouse, createSensor, updateSensor, deleteSensor, moveSensor, updateFloor, updateHouse, updateHouseDraft, setHouseGeoreference,
      saveLayout, runScenario, createRule, updateRule, acknowledgeAlert, createObservation, reloadObservation, updateObservation, observationRevisions,
      createMaintenanceTask, reloadMaintenanceTask, updateMaintenanceTask, maintenanceTaskRevisions, deleteMaintenanceTask, createStaticParameter,
    };
}
