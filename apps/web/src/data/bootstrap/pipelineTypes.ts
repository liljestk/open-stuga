import type { AlertRule, AlertRulePatch, AreaEquipment, AreaEquipmentInput, AreaEquipmentPatch, ConnectionState, Floor, House, HousePatch, MaintenanceTask, MaintenanceTaskInput, MaintenanceTaskPatch, ManualObservation, ManualObservationInput, ManualObservationPatch, MeasurementSample, MockScenario, Point, Property, PropertyArea, PropertyAreaInput, PropertyAreaPatch, PropertyCreateInput, PropertyNote, PropertyNoteInput, PropertyNotePatch, PropertyPatch, Sensor, SensorPatch, StaticParameter, TelemetryEvent, TpLinkDiscoveredDevice } from "@climate-twin/contracts";
import { api, type CreateHouseInput, type CreateSensorInput, type HouseGeoreferencePatch, type MeasurementHistoryPage } from "../../api";
import type { TimeRange } from "../../domain";
import type {
  HistoricalSeriesWindow,
  StreamConnections,
} from "./support";
import type { useClimateDataStore } from "./useClimateDataStore";

export type ClimateDataStoreContext = ReturnType<typeof useClimateDataStore>;

export interface IntegrationActions {
  refreshTpLinkDevices: (
    houseId?: string,
    options?: { force?: boolean },
  ) => Promise<TpLinkDiscoveredDevice[]>;
  disconnectHomeAssistant: typeof api.disconnectHomeAssistant;
  applyDetachedTpLinkSensors: (sensorIds: string[]) => void;
  disconnectTpLink: typeof api.disconnectTpLink;
  moveHomeAssistant: typeof api.moveHomeAssistant;
  moveTpLink: typeof api.moveTpLink;
}

export interface WorkspaceHydrationActions {
  loadHouseData: (
    houseId: string,
    includeGlobalData?: boolean,
    streamReady?: Promise<void> | null,
    includeAdministrativeData?: boolean,
  ) => Promise<void>;
  loadPortfolioHouseData: (houseId: string) => Promise<void>;
}

export interface SessionLifecycleActions {
  scheduleActiveHouseResync: (delay?: number) => void;
  updateStreamConnection: (
    stream: keyof StreamConnections,
    next: ConnectionState,
  ) => void;
  resetStreamConnections: () => void;
  handleHeartbeat: (data: unknown) => void;
}

export interface LiveTelemetryActions {
  purgeSessionState: (locked: boolean) => void;
  retryBootstrap: () => void;
  revalidateSession: () => void;
  endSession: () => void;
  handleTelemetry: (event: TelemetryEvent) => void;
  flushMeasurements: () => void;
  handleMeasurement: (sample: MeasurementSample) => void;
  selectHouse: (houseId: string) => Promise<void>;
  importHistoricalMeasurements: (
    houseId: string,
    samples: MeasurementSample[],
    onProgress?: (completed: number, total: number) => void,
  ) => ReturnType<typeof api.importHistoricalMeasurements>;
}

export interface SeriesActions {
  loadSeries: (
    sensorId: string,
    metric: string,
    range: TimeRange,
    forecastSupported?: boolean,
    signal?: AbortSignal,
  ) => Promise<void>;
}

export interface SensorActions {
  loadHistoricalSeries: (
    sensorId: string,
    metric: string,
    window: HistoricalSeriesWindow,
    signal?: AbortSignal,
  ) => Promise<MeasurementHistoryPage>;
  createSensor: (input: CreateSensorInput) => Promise<Sensor>;
  updateSensor: (sensorId: string, patch: SensorPatch) => Promise<Sensor>;
  deleteSensor: (sensorId: string) => Promise<void>;
  moveSensor: (sensorId: string, point: Point) => void;
  ensurePropertyWrite: () => void;
  refreshMovedPropertyContext: (includeEquipment: boolean) => Promise<void>;
}

export interface PropertyActions {
  createProperty: (input: PropertyCreateInput) => Promise<Property>;
  updateProperty: (id: string, patch: PropertyPatch) => Promise<Property>;
  deleteProperty: (id: string) => Promise<void>;
  createPropertyArea: (input: PropertyAreaInput) => Promise<PropertyArea>;
  updatePropertyArea: (id: string, patch: PropertyAreaPatch) => Promise<PropertyArea>;
  deletePropertyArea: (id: string) => Promise<void>;
  createAreaEquipment: (input: AreaEquipmentInput) => Promise<AreaEquipment>;
  updateAreaEquipment: (id: string, patch: AreaEquipmentPatch) => Promise<AreaEquipment>;
  deleteAreaEquipment: (id: string) => Promise<void>;
  createPropertyNote: (input: PropertyNoteInput) => Promise<PropertyNote>;
  updatePropertyNote: (id: string, patch: PropertyNotePatch) => Promise<PropertyNote>;
  deletePropertyNote: (id: string) => Promise<void>;
  setHouseGeoreference: (houseId: string, patch: HouseGeoreferencePatch) => Promise<void>;
  updateFloor: (houseId: string, floor: Floor) => void;
  updateHouseDraft: (houseId: string, patch: HousePatch) => void;
  updateHouse: (houseId: string, patch: HousePatch) => Promise<House>;
  createHouse: (input: CreateHouseInput) => Promise<House>;
}

export interface OperationsActions {
  deleteHouse: (houseId: string) => Promise<void>;
  saveLayout: (houseId: string, house: House) => Promise<void>;
  runScenario: (scenario: MockScenario["id"]) => Promise<void>;
  createRule: (rule: Omit<AlertRule, "id">) => Promise<void>;
  updateRule: (id: string, patch: AlertRulePatch) => Promise<AlertRule>;
  acknowledgeAlert: (id: string) => Promise<void>;
  createObservation: (input: ManualObservationInput) => Promise<ManualObservation>;
  reloadObservation: (id: string) => Promise<ManualObservation>;
  updateObservation: (
    id: string,
    patch: ManualObservationPatch,
  ) => Promise<ManualObservation>;
  observationRevisions: typeof api.observationRevisions;
  createMaintenanceTask: (input: MaintenanceTaskInput) => Promise<MaintenanceTask>;
  reloadMaintenanceTask: (id: string) => Promise<MaintenanceTask>;
  updateMaintenanceTask: (
    id: string,
    patch: MaintenanceTaskPatch,
  ) => Promise<MaintenanceTask>;
  maintenanceTaskRevisions: typeof api.maintenanceTaskRevisions;
}

export interface MaintenanceActions {
  deleteMaintenanceTask: (id: string) => Promise<void>;
  createStaticParameter: (
    parameter: Omit<StaticParameter, "id">,
  ) => Promise<StaticParameter>;
}

export type IntegrationContext = ClimateDataStoreContext & IntegrationActions;
export type WorkspaceHydrationContext = IntegrationContext & WorkspaceHydrationActions;
export type SessionLifecycleContext = WorkspaceHydrationContext & SessionLifecycleActions;
export type LiveTelemetryContext = SessionLifecycleContext & LiveTelemetryActions;
export type SeriesContext = LiveTelemetryContext & SeriesActions;
export type SensorContext = SeriesContext & SensorActions;
export type PropertyContext = SensorContext & PropertyActions;
export type OperationsContext = PropertyContext & OperationsActions;
export type ClimateDataPipelineContext = OperationsContext & MaintenanceActions;
