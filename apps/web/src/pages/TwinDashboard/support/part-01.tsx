import type { SensorPatch } from "@climate-twin/contracts";
import { lazy } from "react";
import { Droplets, Gauge, Thermometer, Wind } from "lucide-react";
import { type ConnectionState, type Floor, type House, type ManualObservation, type ManualObservationInput, type ManualObservationPatch, type MeasurementDefinition, type Metric, type MockScenario, type ObservationConfidence, type ObservationRevision, type ObservationSource, type ObservationTimePrecision, type OpeningStateObservation, type Point, type Sensor, type StaticParameter, type UnitSystem } from "@climate-twin/contracts";
import "../../../components/decisionLayer.css";
import "../../OperationsPages.css";
import { type ClimateState, type TimeRange, type ViewMode } from "../../../domain";
import type { CreateHouseInput } from "../../../components/StructureEditor";
import type { ClientDataMode } from "../../../useClimateData";
import { type MeasurementHistoryPage } from "../../../api";
import {
  type ExperimentalVisualizationId,
} from "../../../experimentalSpatialLayers";
import type { OutdoorInfluenceMetric } from "../../../outdoorInfluence";
import { readLocalStorage } from "../../../browserStorage";
import { zonedDateTimeParts } from "../../../observationTime";

export const BuildingScene = lazy(() => import("../../../components/BuildingScene").then((module) => ({ default: module.BuildingScene })));

export const FloorPlan = lazy(() => import("../../../components/FloorPlan").then((module) => ({ default: module.FloorPlan })));

export const StructureEditor = lazy(() => import("../../../components/StructureEditor").then((module) => ({ default: module.StructureEditor })));

export const ThermalSimulationPanel = lazy(() => import("../../../components/ThermalSimulationPanel").then((module) => ({ default: module.ThermalSimulationPanel })));

export const SpatialLayerLab = lazy(() => import("../../../components/SpatialLayerLab").then((module) => ({ default: module.SpatialLayerLab })));

export const RoomComparisonChart = lazy(() => import("../../../components/RoomComparisonChart").then((module) => ({ default: module.RoomComparisonChart })));

export const HomeActivityTimeline = lazy(() => import("../../../components/HomeActivityTimeline").then((module) => ({ default: module.HomeActivityTimeline })));

export interface TwinDashboardProps {
  state: ClimateState;
  house: House;
  floor: Floor;
  houseId: string;
  floorId: string;
  metric: Metric;
  units: UnitSystem;
  viewMode: ViewMode;
  selectedSensorId: string | null;
  saveState: "idle" | "saving" | "saved" | "error";
  scenario: MockScenario["id"];
  dataMode?: ClientDataMode;
  connection?: ConnectionState;
  readOnly?: boolean;
  /** Connected-device control and placement require an Owner or Admin account. */
  canManageConnectedDevices?: boolean;
  /** Owner-only integrations, imports, runtime controls, and local analysis configuration stay local. */
  localAuthority?: boolean;
  onHouse: (id: string) => void;
  onFloor: (id: string) => void;
  onMetric: (metric: Metric) => void;
  onViewMode: (view: ViewMode) => void;
  onSensorSelect: (id: string | null) => void;
  onSensorMove: (id: string, point: Point) => void;
  onSensorUpdate: (id: string, patch: SensorPatch) => Promise<Sensor>;
  onFloorChange: (floor: Floor) => void;
  onSaveLayout: (house: House) => void | Promise<void>;
  onHouseChange?: (house: House) => void;
  onHouseCreate?: (input: CreateHouseInput) => Promise<House>;
  onHouseDelete?: (houseId: string) => Promise<void>;
  onOpenSensors?: (houseId: string) => void;
  onOpenConnections?: (houseId: string) => void;
  onLoadSeries: (sensorId: string, metric: Metric, range: TimeRange, forecastSupported: boolean, signal?: AbortSignal) => void;
  onLoadReplaySeries?: (
    sensorId: string,
    metric: Metric,
    window: { from: string; to: string; bucketSeconds: number | null },
    signal?: AbortSignal,
  ) => Promise<MeasurementHistoryPage>;
  onRunScenario: (scenario: MockScenario["id"]) => void;
  onCreateObservation: (observation: ManualObservationInput) => Promise<ManualObservation>;
  onUpdateObservation?: (id: string, patch: ManualObservationPatch) => Promise<ManualObservation>;
  onReloadObservation?: (id: string) => Promise<ManualObservation>;
  onLoadObservationRevisions?: (observationId: string) => Promise<ObservationRevision[]>;
  onCreateStaticParameter: (parameter: Omit<StaticParameter, "id">) => Promise<StaticParameter>;
  onOpenActivity?: () => void;
  onOpenMaintenance?: () => void;
  onOpenEnergy?: () => void;
  onOpenOutdoor?: () => void;
  onOpenAnalytics?: () => void;
  onAcknowledgeAlert?: (alertId: string) => Promise<void>;
}

export const observationKinds: ManualObservation["kind"][] = ["leak", "condensation", "mould", "ventilation", "maintenance", "note"];

export const observationTimePrecisions: ObservationTimePrecision[] = ["exact", "approximate", "date-only", "date-range", "unknown"];

export const observationSources: ObservationSource[] = ["owner", "caretaker", "contractor", "sensor", "imported-document", "automated-analysis", "unknown"];

export const observationConfidences: ObservationConfidence[] = ["confirmed", "probable", "uncertain", "awaiting-inspection"];

export const experimentalVisualizationPreferenceKey = "stugu-experimental-home-visualizations";

export const outdoorInfluenceMetricPreferenceKey = "stugu-outdoor-influence-metric";

export const energyDeviceLayerPreferenceKey = "stugu-home-map-energy-devices-visible";

export const connectedDeviceLayerPreferenceKey = "stugu-home-map-connected-devices-visible";

export const heatPumpInfluencePreferenceKey = "stugu-home-map-heat-pump-influence-visible";

export const climateSensorLayerPreferenceKey = "stugu-home-map-climate-sensors-visible";

export const openingStateLabelsPreferenceKey = "stugu-home-map-opening-state-labels-visible";

export const mapAnimationsPreferenceKey = "stugu-home-map-animations-enabled";

export const outdoorExtrasPreferenceKey = "stugu-home-map-outdoor-extras-visible";

export function initialExperimentalVisualizations(): ExperimentalVisualizationId[] {
  const stored = readLocalStorage(experimentalVisualizationPreferenceKey);
  if (!stored) return [];
  try {
    const parsed = JSON.parse(stored);
    return Array.isArray(parsed)
      ? parsed.filter((value): value is ExperimentalVisualizationId => (
          value === "air-movement" || value === "sensor-coverage" || value === "outdoor-influence"
        ))
      : [];
  } catch {
    return [];
  }
}

export function initialOutdoorInfluenceMetric(activeMetric: string): OutdoorInfluenceMetric {
  const stored = readLocalStorage(outdoorInfluenceMetricPreferenceKey);
  if (stored === "temperature" || stored === "moisture") return stored;
  return activeMetric === "humidity" ? "moisture" : "temperature";
}

export function initialEnergyDeviceLayerVisibility(): boolean {
  return readLocalStorage(energyDeviceLayerPreferenceKey) !== "false";
}

export function initialConnectedDeviceLayerVisibility(): boolean {
  return readLocalStorage(connectedDeviceLayerPreferenceKey) !== "false";
}

export function initialHeatPumpInfluenceVisibility(): boolean {
  return readLocalStorage(heatPumpInfluencePreferenceKey) !== "false";
}

export function initialClimateSensorLayerVisibility(): boolean {
  return readLocalStorage(climateSensorLayerPreferenceKey) !== "false";
}

export function initialOpeningStateLabelsVisibility(): boolean {
  return readLocalStorage(openingStateLabelsPreferenceKey) !== "false";
}

export function initialMapAnimationsEnabled(): boolean {
  return readLocalStorage(mapAnimationsPreferenceKey) !== "false";
}

export function initialOutdoorExtrasVisibility(): boolean {
  return readLocalStorage(outdoorExtrasPreferenceKey) !== "false";
}

export function mergeOpeningStateObservations(
  current: readonly OpeningStateObservation[],
  incoming: readonly OpeningStateObservation[],
): OpeningStateObservation[] {
  const merged = new globalThis.Map(current.map((observation) => [observation.id, observation]));
  for (const observation of incoming) merged.set(observation.id, observation);
  return [...merged.values()].sort((left, right) => (
    Date.parse(right.observedAt) - Date.parse(left.observedAt) || right.id.localeCompare(left.id)
  ));
}

export function localDateTimeValue(date = new Date(), timeZone?: string): string {
  if (timeZone) {
    try {
      const [year, month, day, hour, minute] = zonedDateTimeParts(date, timeZone);
      return `${year}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}T${String(hour).padStart(2, "0")}:${String(minute).padStart(2, "0")}`;
    } catch {
      // Fall back to the browser timezone when a stored timezone is no longer supported.
    }
  }
  return new Date(date.getTime() - date.getTimezoneOffset() * 60_000).toISOString().slice(0, 16);
}

export function localDateValue(date = new Date(), timeZone?: string): string {
  return localDateTimeValue(date, timeZone).slice(0, 10);
}

export function MeasurementGlyph({ definition, size }: { definition: MeasurementDefinition; size: number }) {
  const Icon = definition.colorScale === "thermal"
    ? Thermometer
    : definition.colorScale === "humidity"
      ? Droplets
      : definition.colorScale === "air-quality"
        ? Wind
        : Gauge;
  return <Icon size={size} aria-hidden="true" />;
}
