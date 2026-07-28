import { lazy, Suspense, useEffect, useMemo, useRef, useState, type FormEvent } from "react";
import { Activity, AlertTriangle, BatteryMedium, Bolt, Box, Check, ChevronDown, Droplets, Edit3, Gauge, History, Home, Map, MapPinPlus, Maximize2, Minimize2, Save, Sparkles, Thermometer, Wind } from "lucide-react";
import { isAirflowPlanElement, type ConfiguredOpeningState, type ConnectionState, type Floor, type House, type ManualObservation, type ManualObservationInput, type ManualObservationPatch, type MeasurementDefinition, type MeasurementSample, type Metric, type MockScenario, type ObservationConfidence, type ObservationRevision, type ObservationSource, type ObservationTimePrecision, type OpeningStateObservation, type Point, type Reading, type Sensor, type StaticParameter, type UnitSystem } from "@climate-twin/contracts";
import { ReplayControls } from "../../../components/ReplayControls";
import { RoomComfortBoard } from "../../../components/RoomComfortBoard";
import { MoistureCoach } from "../../../components/MoistureCoach";
import { HomePulsePanel } from "../../../components/HomePulsePanel";
import { HomeOperationsPreview } from "../../../components/HomeOperationsPreview";
import "../../../components/decisionLayer.css";
import "../../OperationsPages.css";
import { formatInTimeZone } from "../../../dateTime";
import { clamp, round, type ClimateState, type TimeRange, type ViewMode } from "../../../domain";
import { useI18n, type TranslationKey } from "../../../i18n";
import { definitionFor, displayUnit, enabledDefinitions, formatMeasurement, formatMeasurementDelta, measurementComparisonColor, measurementDomain, measurementLabel, measurementValue, samplesAt, type LatestMeasurements } from "../../../measurements";
import { isEnergyDeviceSensor } from "../../../energyDeviceMap";
import { configuredSpatialMaxSampleAgeMs, configuredSpatialReplayMaxSampleAgeMs, isSpatialSampleFresh } from "../../../spatialFreshness";
import { createOutdoorBoundaryContext } from "../../../outdoorContext";
import { useHouseWeather } from "../../../useHouseWeather";
import type { OutdoorVisualizationState } from "../../../components/OutdoorConditionsBadge";
import type { CreateHouseInput } from "../../../components/StructureEditor";
import {
  simulateBuildingAirflow,
  simulateFloorAirflow,
  type BuildingAirflowEstimate,
  type ClimateSampleMatrix,
  type FloorAirflowEstimate,
} from "../../../airflowSimulation";
import type { DataMode } from "../../../useClimateData";
import { api, type MeasurementHistoryPage, type SensorPatch } from "../../../api";
import { useSpatialLayers } from "../../../useSpatialLayers";
import { SpatialLayerPanel } from "../../../components/SpatialLayerPanel";
import {
  assessSensorCoverage,
  experimentalLayerSuggestions,
  type ExperimentalVisualizationId,
} from "../../../experimentalSpatialLayers";
import type { OutdoorInfluenceMetric } from "../../../outdoorInfluence";
import { readLocalStorage, writeLocalStorage } from "../../../browserStorage";
import { detectReplayClimateEvents, type ReplayClimateEvent } from "../../../replayEvents";
import { openingStateCanChange, openingStateKey, openingStateObservationsForHouse } from "../../../openingState";
import { integrationForHouse } from "../../../integrationScope";

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
  dataMode?: DataMode;
  connection?: ConnectionState;
  readOnly?: boolean;
  /** Owner-only integrations, imports, runtime controls, and local analysis configuration stay local. */
  localAuthority?: boolean;
  onHouse: (id: string) => void;
  onFloor: (id: string) => void;
  onMetric: (metric: Metric) => void;
  onViewMode: (view: ViewMode) => void;
  onSensorSelect: (id: string) => void;
  onSensorMove: (id: string, point: Point) => void;
  onSensorUpdate: (id: string, patch: SensorPatch) => Promise<Sensor>;
  onFloorChange: (floor: Floor) => void;
  onSaveLayout: (house: House) => void | Promise<void>;
  onHouseChange?: (house: House) => void;
  onHouseCreate?: (input: CreateHouseInput) => Promise<House>;
  onHouseDelete?: (houseId: string) => Promise<void>;
  onOpenSensors?: (houseId: string) => void;
  onOpenConnections?: (houseId: string) => void;
  onLoadSeries: (sensorId: string, metric: Metric, range: TimeRange, forecastSupported: boolean) => void;
  onLoadReplaySeries?: (
    sensorId: string,
    metric: Metric,
    window: { from: string; to: string; bucketSeconds: number | null },
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
}

export const observationKinds: ManualObservation["kind"][] = ["leak", "condensation", "mould", "ventilation", "maintenance", "note"];

export const observationTimePrecisions: ObservationTimePrecision[] = ["exact", "approximate", "date-only", "date-range", "unknown"];

export const observationSources: ObservationSource[] = ["owner", "caretaker", "contractor", "sensor", "imported-document", "automated-analysis", "unknown"];

export const observationConfidences: ObservationConfidence[] = ["confirmed", "probable", "uncertain", "awaiting-inspection"];

export const experimentalVisualizationPreferenceKey = "stugu-experimental-home-visualizations";

export const outdoorInfluenceMetricPreferenceKey = "stugu-outdoor-influence-metric";

export const energyDeviceLayerPreferenceKey = "stugu-home-map-energy-devices-visible";

export const climateSensorLayerPreferenceKey = "stugu-home-map-climate-sensors-visible";

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

export function initialClimateSensorLayerVisibility(): boolean {
  return readLocalStorage(climateSensorLayerPreferenceKey) !== "false";
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

export function zonedDateTimeParts(date: Date, timeZone: string): number[] {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hourCycle: "h23",
  }).formatToParts(date);
  const value = (type: Intl.DateTimeFormatPartTypes) => Number(parts.find((part) => part.type === type)?.value);
  return [value("year"), value("month"), value("day"), value("hour"), value("minute"), value("second")];
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

export function houseLocalDateTimeCandidates(value: string, timeZone: string): string[] | null {
  const match = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2}))?$/.exec(value);
  if (!match) return null;
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const hour = Number(match[4]);
  const minute = Number(match[5]);
  const second = match[6] === undefined ? 0 : Number(match[6]);
  const nominal = Date.UTC(year, month - 1, day, hour, minute, second);
  const nominalDate = new Date(nominal);
  if (nominalDate.getUTCFullYear() !== year || nominalDate.getUTCMonth() !== month - 1 || nominalDate.getUTCDate() !== day
    || nominalDate.getUTCHours() !== hour || nominalDate.getUTCMinutes() !== minute || nominalDate.getUTCSeconds() !== second) return null;
  try {
    const offsets = new Set<number>();
    for (let deltaHours = -36; deltaHours <= 36; deltaHours += 6) {
      const probe = nominal + deltaHours * 3_600_000;
      const displayed = zonedDateTimeParts(new Date(probe), timeZone);
      offsets.add(Date.UTC(displayed[0]!, displayed[1]! - 1, displayed[2]!, displayed[3]!, displayed[4]!, displayed[5]!) - probe);
    }
    const target = [year, month, day, hour, minute, second];
    return [...new Set([...offsets].map((offset) => nominal - offset))]
      .filter((candidate) => zonedDateTimeParts(new Date(candidate), timeZone).slice(0, 6)
        .every((part, index) => part === target[index]))
      .sort((left, right) => left - right)
      .map((candidate) => new Date(candidate).toISOString());
  } catch {
    return null;
  }
}

export function observationTimeFields(
  precision: ObservationTimePrecision,
  dateTime: string,
  date: string,
  validFrom: string,
  validTo: string,
  timeZone: string,
): Pick<ManualObservationInput, "timePrecision"> & Partial<Pick<ManualObservationInput, "occurredAt" | "validFrom" | "validTo">> | null {
  if (precision === "unknown") return { timePrecision: precision };
  if (precision === "date-only") return /^\d{4}-\d{2}-\d{2}$/.test(date) ? { timePrecision: precision, occurredAt: date } : null;
  if (precision === "date-range") {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(validFrom) || !/^\d{4}-\d{2}-\d{2}$/.test(validTo) || validFrom > validTo) return null;
    return { timePrecision: precision, validFrom, validTo };
  }
  const candidates = houseLocalDateTimeCandidates(dateTime, timeZone);
  const instant = candidates?.length === 1 || (precision === "approximate" && candidates && candidates.length > 1)
    ? candidates[0]
    : null;
  return instant ? { timePrecision: precision, occurredAt: instant } : null;
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
