import { lazy, Suspense, useEffect, useMemo, useRef, useState, type FormEvent } from "react";
import { Activity, AlertTriangle, BatteryMedium, Bolt, Box, Check, ChevronDown, Droplets, Edit3, Gauge, History, Home, Map, MapPinPlus, Maximize2, Minimize2, Save, Sparkles, Thermometer, Wind } from "lucide-react";
import { isAirflowPlanElement, type ConfiguredOpeningState, type ConnectionState, type Floor, type House, type ManualObservation, type ManualObservationInput, type ManualObservationPatch, type MeasurementDefinition, type MeasurementSample, type Metric, type MockScenario, type ObservationConfidence, type ObservationRevision, type ObservationSource, type ObservationTimePrecision, type OpeningStateObservation, type Point, type Reading, type Sensor, type StaticParameter, type UnitSystem } from "@climate-twin/contracts";
import { ReplayControls } from "../components/ReplayControls";
import { RoomComfortBoard } from "../components/RoomComfortBoard";
import { MoistureCoach } from "../components/MoistureCoach";
import { HomePulsePanel } from "../components/HomePulsePanel";
import { HomeOperationsPreview } from "../components/HomeOperationsPreview";
import "../components/decisionLayer.css";
import "./OperationsPages.css";
import { formatInTimeZone } from "../dateTime";
import { clamp, round, type ClimateState, type TimeRange, type ViewMode } from "../domain";
import { useI18n, type TranslationKey } from "../i18n";
import { definitionFor, displayUnit, enabledDefinitions, formatMeasurement, formatMeasurementDelta, measurementComparisonColor, measurementDomain, measurementLabel, measurementValue, samplesAt, type LatestMeasurements } from "../measurements";
import { isEnergyDeviceSensor } from "../energyDeviceMap";
import { configuredSpatialMaxSampleAgeMs, configuredSpatialReplayMaxSampleAgeMs, isSpatialSampleFresh } from "../spatialFreshness";
import { createOutdoorBoundaryContext } from "../outdoorContext";
import { useHouseWeather } from "../useHouseWeather";
import type { OutdoorVisualizationState } from "../components/OutdoorConditionsBadge";
import type { CreateHouseInput } from "../components/StructureEditor";
import {
  simulateBuildingAirflow,
  simulateFloorAirflow,
  type BuildingAirflowEstimate,
  type ClimateSampleMatrix,
  type FloorAirflowEstimate,
} from "../airflowSimulation";
import type { DataMode } from "../useClimateData";
import { api, type MeasurementHistoryPage, type SensorPatch } from "../api";
import { useSpatialLayers } from "../useSpatialLayers";
import { SpatialLayerPanel } from "../components/SpatialLayerPanel";
import {
  assessSensorCoverage,
  experimentalLayerSuggestions,
  type ExperimentalVisualizationId,
} from "../experimentalSpatialLayers";
import { readLocalStorage, writeLocalStorage } from "../browserStorage";
import { detectReplayClimateEvents, type ReplayClimateEvent } from "../replayEvents";
import { openingStateCanChange, openingStateKey, openingStateObservationsForHouse } from "../openingState";
import { integrationForHouse } from "../integrationScope";

const BuildingScene = lazy(() => import("../components/BuildingScene").then((module) => ({ default: module.BuildingScene })));
const FloorPlan = lazy(() => import("../components/FloorPlan").then((module) => ({ default: module.FloorPlan })));
const StructureEditor = lazy(() => import("../components/StructureEditor").then((module) => ({ default: module.StructureEditor })));
const ThermalSimulationPanel = lazy(() => import("../components/ThermalSimulationPanel").then((module) => ({ default: module.ThermalSimulationPanel })));
const SpatialLayerLab = lazy(() => import("../components/SpatialLayerLab").then((module) => ({ default: module.SpatialLayerLab })));
const RoomComparisonChart = lazy(() => import("../components/RoomComparisonChart").then((module) => ({ default: module.RoomComparisonChart })));
const HomeActivityTimeline = lazy(() => import("../components/HomeActivityTimeline").then((module) => ({ default: module.HomeActivityTimeline })));

interface TwinDashboardProps {
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

const observationKinds: ManualObservation["kind"][] = ["leak", "condensation", "mould", "ventilation", "maintenance", "note"];
const observationTimePrecisions: ObservationTimePrecision[] = ["exact", "approximate", "date-only", "date-range", "unknown"];
const observationSources: ObservationSource[] = ["owner", "caretaker", "contractor", "sensor", "imported-document", "automated-analysis", "unknown"];
const observationConfidences: ObservationConfidence[] = ["confirmed", "probable", "uncertain", "awaiting-inspection"];
const experimentalVisualizationPreferenceKey = "stuga-experimental-home-visualizations";
const energyDeviceLayerPreferenceKey = "stuga-home-map-energy-devices-visible";

function initialExperimentalVisualizations(): ExperimentalVisualizationId[] {
  const stored = readLocalStorage(experimentalVisualizationPreferenceKey);
  if (!stored) return [];
  try {
    const parsed = JSON.parse(stored);
    return Array.isArray(parsed)
      ? parsed.filter((value): value is ExperimentalVisualizationId => value === "air-movement" || value === "sensor-coverage")
      : [];
  } catch {
    return [];
  }
}

function initialEnergyDeviceLayerVisibility(): boolean {
  return readLocalStorage(energyDeviceLayerPreferenceKey) !== "false";
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

function zonedDateTimeParts(date: Date, timeZone: string): number[] {
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

function localDateTimeValue(date = new Date(), timeZone?: string): string {
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

function localDateValue(date = new Date(), timeZone?: string): string {
  return localDateTimeValue(date, timeZone).slice(0, 10);
}

function houseLocalDateTimeCandidates(value: string, timeZone: string): string[] | null {
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

export function TwinDashboard(props: TwinDashboardProps) {
  const { state, house, floor, houseId, floorId, metric, units, viewMode, selectedSensorId, scenario, connection = "live", dataMode = "unknown" } = props;
  const { locale, t } = useI18n();
  const scopedIntegration = useMemo(() => integrationForHouse(state.integration, houseId, Boolean(house.location)), [house.location, houseId, state.integration]);
  const sensorSourceHealthy = scopedIntegration.homeAssistant.connected || scopedIntegration.tpLink.connected;
  const [editing, setEditing] = useState(false);
  const [fullPage, setFullPage] = useState(false);
  const [liveMapOpen, setLiveMapOpen] = useState(false);
  const [historyOpen, setHistoryOpen] = useState(false);
  const [analysisOpen, setAnalysisOpen] = useState(false);
  const fullPagePanelRef = useRef<HTMLElement>(null);
  const fullPageTriggerRef = useRef<HTMLButtonElement>(null);
  const readOnly = props.readOnly ?? false;
  const [range, setRange] = useState<TimeRange>("24h");
  const [replayActive, setReplayActive] = useState(false);
  const [replayPlaying, setReplayPlaying] = useState(false);
  const [replayStartPending, setReplayStartPending] = useState(false);
  const [replayPrepared, setReplayPrepared] = useState(true);
  const [replaySpeed, setReplaySpeed] = useState(4);
  const [replayWindowFrom, setReplayWindowFrom] = useState(() => localDateTimeValue(new Date(Date.now() - 24 * 3_600_000), house.timezone));
  const [replayWindowTo, setReplayWindowTo] = useState(() => localDateTimeValue(new Date(), house.timezone));
  const [replayResolutionSeconds, setReplayResolutionSeconds] = useState<number | null>(null);
  const [replayRequestedBounds, setReplayRequestedBounds] = useState<{ minimum: number; maximum: number } | null>(null);
  const [replayLoadState, setReplayLoadState] = useState<"idle" | "loading" | "ready" | "error">("idle");
  const [replayLoadError, setReplayLoadError] = useState<string | null>(null);
  const [replayLoadPartial, setReplayLoadPartial] = useState(false);
  const [replaySampleCount, setReplaySampleCount] = useState<number | null>(null);
  const [liveSpatialClockMs, setLiveSpatialClockMs] = useState(() => Date.now());
  const [experimentalVisualizations, setExperimentalVisualizations] = useState<ExperimentalVisualizationId[]>(initialExperimentalVisualizations);
  const [energyDevicesVisible, setEnergyDevicesVisible] = useState(initialEnergyDeviceLayerVisibility);
  const [observationPlacement, setObservationPlacement] = useState(false);
  const [observationKind, setObservationKind] = useState<ManualObservation["kind"]>("leak");
  const [observationSeverity, setObservationSeverity] = useState<ManualObservation["severity"]>("warning");
  const [observationNote, setObservationNote] = useState("");
  const [observationTimePrecision, setObservationTimePrecision] = useState<ObservationTimePrecision>("exact");
  const [observationDateTime, setObservationDateTime] = useState(() => localDateTimeValue(new Date(), house.timezone));
  const [observationDate, setObservationDate] = useState(() => localDateValue(new Date(), house.timezone));
  const [observationValidFrom, setObservationValidFrom] = useState(() => localDateValue(new Date(), house.timezone));
  const [observationValidTo, setObservationValidTo] = useState(() => localDateValue(new Date(), house.timezone));
  const [observationSource, setObservationSource] = useState<ObservationSource>("unknown");
  const [observationSourceDetail, setObservationSourceDetail] = useState("");
  const [observationConfidence, setObservationConfidence] = useState<ObservationConfidence>("uncertain");
  const [observationDraft, setObservationDraft] = useState<Omit<ManualObservationInput, "x" | "y"> | null>(null);
  const [observationValidationError, setObservationValidationError] = useState(false);
  const [observationStatus, setObservationStatus] = useState(false);
  const [observationError, setObservationError] = useState(false);
  const [parameterLabel, setParameterLabel] = useState("");
  const [parameterValue, setParameterValue] = useState("");
  const [parameterUnit, setParameterUnit] = useState("");
  const [parameterPending, setParameterPending] = useState(false);
  const [parameterFeedback, setParameterFeedback] = useState<"saved" | "error" | null>(null);
  const replayBatchRef = useRef("");
  const replayPreparationBatchRef = useRef("");
  const airflowReplayBatchRef = useRef("");
  const inspectorReplayBatchRef = useRef("");
  const replayWindowRequestRef = useRef(0);
  const previousReplayActiveRef = useRef(replayActive);
  const effectSeriesLoadsRef = useRef({ loader: props.onLoadSeries, keys: new Set<string>() });
  if (effectSeriesLoadsRef.current.loader !== props.onLoadSeries) {
    effectSeriesLoadsRef.current = { loader: props.onLoadSeries, keys: new Set<string>() };
  }

  const loadSeriesOnce = (sensorId: string, candidate: MeasurementDefinition) => {
    const key = `${houseId}:${range}:${sensorId}:${candidate.id}`;
    if (effectSeriesLoadsRef.current.keys.has(key)) return;
    effectSeriesLoadsRef.current.keys.add(key);
    props.onLoadSeries(sensorId, candidate.id, range, candidate.forecastSupported);
  };

  useEffect(() => {
    if (!fullPage) return;
    const previousOverflow = document.body.style.overflow;
    const panel = fullPagePanelRef.current;
    if (!panel) return;
    const isolated: Array<{ element: HTMLElement; alreadyInert: boolean }> = [];
    const isolate = (element: Element | null) => {
      if (!(element instanceof HTMLElement) || element === panel || isolated.some((item) => item.element === element)) return;
      const alreadyInert = element.hasAttribute("inert");
      isolated.push({ element, alreadyInert });
      element.setAttribute("inert", "");
    };
    isolate(document.getElementById("primary-sidebar"));
    document.querySelectorAll(".app-main-column > :not(#main-content)").forEach(isolate);
    const main = panel.closest("main");
    if (main) {
      let branch: Element = panel;
      while (branch.parentElement && branch.parentElement !== main) {
        [...branch.parentElement.children].filter((candidate) => candidate !== branch).forEach(isolate);
        branch = branch.parentElement;
      }
      [...main.children].filter((candidate) => candidate !== branch).forEach(isolate);
    }
    const handleDialogKeys = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        setFullPage(false);
        return;
      }
      if (event.key !== "Tab") return;
      const focusable = [...panel.querySelectorAll<HTMLElement>("button:not([disabled]), select:not([disabled]), input:not([disabled]), textarea:not([disabled]), a[href], [tabindex]:not([tabindex='-1'])")]
        .filter((element) => element.getClientRects().length > 0);
      const first = focusable[0];
      const last = focusable.at(-1);
      if (!first || !last) return;
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    };
    document.body.style.overflow = "hidden";
    window.addEventListener("keydown", handleDialogKeys);
    window.requestAnimationFrame(() => {
      if (!panel.contains(document.activeElement)) panel.querySelector<HTMLElement>("button:not([disabled]), select:not([disabled]), [tabindex]:not([tabindex='-1'])")?.focus();
    });
    return () => {
      document.body.style.overflow = previousOverflow;
      window.removeEventListener("keydown", handleDialogKeys);
      isolated.forEach(({ element, alreadyInert }) => { if (!alreadyInert) element.removeAttribute("inert"); });
      window.requestAnimationFrame(() => fullPageTriggerRef.current?.focus());
    };
  }, [fullPage]);

  useEffect(() => {
    writeLocalStorage(experimentalVisualizationPreferenceKey, JSON.stringify(experimentalVisualizations));
  }, [experimentalVisualizations]);

  useEffect(() => {
    writeLocalStorage(energyDeviceLayerPreferenceKey, String(energyDevicesVisible));
  }, [energyDevicesVisible]);

  useEffect(() => {
    const now = new Date();
    setObservationDateTime(localDateTimeValue(now, house.timezone));
    setObservationDate(localDateValue(now, house.timezone));
    setObservationValidFrom(localDateValue(now, house.timezone));
    setObservationValidTo(localDateValue(now, house.timezone));
    setObservationPlacement(false);
    setObservationDraft(null);
    setObservationValidationError(false);
    setObservationStatus(false);
    setObservationError(false);
  }, [houseId, floorId, house.timezone]);

  useEffect(() => {
    const now = new Date();
    replayWindowRequestRef.current += 1;
    setReplayActive(false);
    setReplayPlaying(false);
    setReplayPrepared(true);
    setReplayWindowFrom(localDateTimeValue(new Date(now.getTime() - 24 * 3_600_000), house.timezone));
    setReplayWindowTo(localDateTimeValue(now, house.timezone));
    setReplayRequestedBounds(null);
    setReplayLoadState("idle");
    setReplayLoadError(null);
    setReplayLoadPartial(false);
    setReplaySampleCount(null);
  }, [houseId, house.timezone]);

  useEffect(() => {
    if (!readOnly) return;
    setEditing(false);
    setObservationPlacement(false);
    setObservationDraft(null);
  }, [readOnly]);

  const houseWeather = useHouseWeather(house, !replayActive);
  const outdoorContext = useMemo(
    () => createOutdoorBoundaryContext(house, houseWeather.weather),
    [house, houseWeather.weather],
  );
  const outdoor = useMemo<OutdoorVisualizationState>(() => ({
    context: replayActive ? null : outdoorContext,
    loading: !replayActive && houseWeather.loading,
    unavailable: !replayActive && !houseWeather.loading && !outdoorContext
      && Boolean(houseWeather.error || houseWeather.weather),
    refreshFailed: !replayActive && Boolean(outdoorContext && houseWeather.error),
    hasLocation: Boolean(house.location),
    replayActive,
    timeZone: house.timezone,
    ...(house.orientationDegrees === undefined ? {} : { orientationDegrees: house.orientationDegrees }),
    ...(houseWeather.weather?.attribution ? { attribution: houseWeather.weather.attribution } : {}),
    ...(houseWeather.weather?.observationStation ? {
      station: {
        name: houseWeather.weather.observationStation.name,
        distanceKm: houseWeather.weather.observationStation.distanceKm,
      },
    } : {}),
  }), [house.location, house.orientationDegrees, house.timezone, houseWeather.error, houseWeather.loading, houseWeather.weather, outdoorContext, replayActive]);

  useEffect(() => {
    if (replayActive) return;
    const update = () => setLiveSpatialClockMs(Date.now());
    update();
    const timer = window.setInterval(update, 30_000);
    return () => window.clearInterval(timer);
  }, [replayActive]);

  const houseSensors = useMemo(
    () => state.sensors.filter((sensor) => sensor.houseId === houseId && sensor.enabled),
    [state.sensors, houseId],
  );
  const energyDeviceCount = useMemo(() => houseSensors.filter((sensor) => (
    isEnergyDeviceSensor(sensor, state.latestMeasurements[sensor.id] ?? {})
  )).length, [houseSensors, state.latestMeasurements]);
  const floorSensors = useMemo(
    () => houseSensors.filter((sensor) => sensor.floorId === floorId),
    [houseSensors, floorId],
  );
  const selectedSensor = houseSensors.find((sensor) => sensor.id === selectedSensorId) ?? floorSensors[0] ?? houseSensors[0] ?? null;
  const selectedFloor = house.floors.find((item) => item.id === selectedSensor?.floorId) ?? floor;
  const viewSensors = viewMode === "isometric" ? houseSensors : floorSensors;
  // Home-level status stays house-scoped so changing the visual view cannot
  // silently change the meaning of the headline values.
  const summarySensors = houseSensors;
  const definitions = enabledDefinitions(state.measurementDefinitions);
  const houseDefinitions = definitions.filter((definition) => houseSensors.some((sensor) =>
    state.latestMeasurements[sensor.id]?.[definition.id]
    || (state.measurementHistory[sensor.id]?.[definition.id]?.length ?? 0) > 0
    || Boolean(sensor.measurementEntityIds?.[definition.id]),
  ));
  const availableDefinitions = houseDefinitions.length ? houseDefinitions : definitions;
  const airflowDefinitions = definitions.filter((item) => item.id === "temperature" || item.id === "humidity" || item.id === "co2");
  const airflowMetricKey = airflowDefinitions.map((item) => item.id).join(",");
  const definition = definitionFor(definitions, metric);
  const metricOptions = availableDefinitions.some((item) => item.id === definition.id)
    ? availableDefinitions
    : [definition, ...availableDefinitions];
  const metricLabel = measurementLabel(definition, locale);
  const liveSamples = useMemo(() => Object.fromEntries(houseSensors.flatMap((sensor) => {
    const sample = state.latestMeasurements[sensor.id]?.[definition.id];
    return sample ? [[sensor.id, sample]] : [];
  })), [houseSensors, state.latestMeasurements, definition.id]);
  const houseSensorIdList = useMemo(() => houseSensors.map((sensor) => sensor.id), [houseSensors]);
  const houseSensorIds = houseSensorIdList.join(",");
  const replayMetricIds = useMemo(
    () => [...new Set([...availableDefinitions.map((candidate) => candidate.id), definition.id, "temperature", "humidity"])],
    [availableDefinitions, definition.id],
  );
  const loadedReplayBounds = useMemo(() => {
    let minimum = Number.POSITIVE_INFINITY;
    let maximum = Number.NEGATIVE_INFINITY;
    let count = 0;
    for (const sensor of houseSensors) {
      for (const replayMetric of replayMetricIds) {
        for (const sample of state.measurementHistory[sensor.id]?.[replayMetric] ?? []) {
          const timestamp = Date.parse(sample.timestamp);
          if (!Number.isFinite(timestamp)) continue;
          minimum = Math.min(minimum, timestamp);
          maximum = Math.max(maximum, timestamp);
          count += 1;
        }
      }
    }
    return count > 0 ? { minimum, maximum, count } : null;
  }, [houseSensors, replayMetricIds, state.measurementHistory]);
  const fallbackReplayBounds = useMemo(() => {
    const maximum = Date.now();
    return { minimum: maximum - 24 * 3600000, maximum };
  }, [houseId]);
  const replayMin = replayRequestedBounds?.minimum ?? loadedReplayBounds?.minimum ?? fallbackReplayBounds.minimum;
  const replayMax = replayRequestedBounds?.maximum ?? loadedReplayBounds?.maximum ?? fallbackReplayBounds.maximum;
  const replayHistoryReady = useMemo(() => houseSensors.some((sensor) => replayMetricIds.some((replayMetric) => (
    state.measurementHistory[sensor.id]?.[replayMetric] ?? []
  ).some((sample) => {
    const timestamp = Date.parse(sample.timestamp);
    return Number.isFinite(timestamp) && timestamp >= replayMin && timestamp <= replayMax;
  }))), [houseSensors, replayMetricIds, replayMax, replayMin, state.measurementHistory]);
  const replayEvents = useMemo(() => detectReplayClimateEvents(
    state.measurementHistory,
    houseSensorIdList,
    { maxEvents: 24, from: replayMin, to: replayMax },
  ), [state.measurementHistory, houseSensorIdList, replayMin, replayMax]);
  const [replayTimestamp, setReplayTimestamp] = useState(replayMax);
  const spatialReferenceTimeMs = replayActive ? replayTimestamp : liveSpatialClockMs;
  const spatialLayerScope = useMemo(() => ({ kind: "house" as const, id: houseId }), [houseId]);
  const spatialLayers = useSpatialLayers({
    scope: spatialLayerScope,
    enabled: !editing,
    historyAt: replayActive ? replayTimestamp : null,
  });
  const liveSpatialMaxSampleAgeMs = configuredSpatialMaxSampleAgeMs();
  const spatialMaxSampleAgeMs = replayActive
    ? configuredSpatialReplayMaxSampleAgeMs()
    : liveSpatialMaxSampleAgeMs;
  const spatialFreshness = useMemo(() => ({
    referenceTimeMs: spatialReferenceTimeMs,
    maxSampleAgeMs: spatialMaxSampleAgeMs,
  }), [spatialReferenceTimeMs, spatialMaxSampleAgeMs]);

  useEffect(() => {
    setReplayTimestamp((current) => replayActive ? clamp(current, replayMin, replayMax) : replayMax);
  }, [replayActive, replayMin, replayMax]);
  useEffect(() => {
    const wasActive = previousReplayActiveRef.current;
    previousReplayActiveRef.current = replayActive;
    if (wasActive && !replayActive) effectSeriesLoadsRef.current.keys.clear();
  }, [replayActive]);
  useEffect(() => {
    if (!replayActive) {
      if (replayStartPending) setReplayStartPending(false);
      return;
    }
    if (!replayStartPending || !replayHistoryReady) return;
    setReplayTimestamp(replayMin);
    setReplayPlaying(true);
    setReplayStartPending(false);
  }, [replayActive, replayStartPending, replayHistoryReady, replayMin]);
  useEffect(() => {
    if (!replayPlaying) return;
    let previousTick = Date.now();
    const timer = window.setInterval(() => {
      const currentTick = Date.now();
      const elapsedRealMs = Math.max(0, currentTick - previousTick);
      previousTick = currentTick;
      setReplayTimestamp((current) => {
        const next = current + elapsedRealMs * replaySpeed * 60;
        if (next >= replayMax) { setReplayPlaying(false); return replayMax; }
        return next;
      });
    }, 250);
    return () => window.clearInterval(timer);
  }, [replayPlaying, replaySpeed, replayMax]);

  const changeReplayPlaying = (playing: boolean) => {
    if (!playing) {
      setReplayStartPending(false);
      setReplayPlaying(false);
      return;
    }
    if (!replayHistoryReady) {
      setReplayStartPending(true);
      setReplayPlaying(false);
      return;
    }
    setReplayStartPending(false);
    setReplayPlaying(true);
  };

  const selectReplayEvent = (event: ReplayClimateEvent) => {
    props.onMetric(event.metric);
    const sensor = houseSensors.find((candidate) => candidate.id === event.sensorId);
    if (!sensor) return;
    if (sensor.floorId !== floorId) props.onFloor(sensor.floorId);
    props.onSensorSelect(sensor.id);
  };

  const loadReplayWindow = async () => {
    if (!props.onLoadReplaySeries) {
      setReplayLoadState("error");
      setReplayLoadError(t("replay.windowUnavailable"));
      return;
    }
    const fromCandidates = houseLocalDateTimeCandidates(replayWindowFrom, house.timezone);
    const toCandidates = houseLocalDateTimeCandidates(replayWindowTo, house.timezone);
    const from = fromCandidates?.[0] ?? null;
    const to = toCandidates?.at(-1) ?? null;
    if (!from || !to || Date.parse(from) >= Date.parse(to)) {
      setReplayLoadState("error");
      setReplayLoadError(t("replay.invalidWindow"));
      return;
    }

    const requestId = replayWindowRequestRef.current + 1;
    replayWindowRequestRef.current = requestId;
    setReplayLoadState("loading");
    setReplayLoadError(null);
    setReplayLoadPartial(false);
    setReplaySampleCount(null);
    setReplayPlaying(false);
    setReplayStartPending(false);
    setReplayPrepared(true);
    try {
      const pages = await Promise.all(houseSensors.flatMap((sensor) => replayMetricIds.map((replayMetric) => (
        props.onLoadReplaySeries!(sensor.id, replayMetric, {
          from,
          to,
          bucketSeconds: replayResolutionSeconds,
        })
      ))));
      if (replayWindowRequestRef.current !== requestId) return;
      const minimum = Date.parse(from);
      const maximum = Date.parse(to);
      const sampleCount = pages.reduce((total, page) => total + page.samples.length, 0);
      setReplayRequestedBounds({ minimum, maximum });
      setReplayTimestamp(minimum);
      setReplayLoadPartial(pages.some((page) => page.truncated));
      setReplaySampleCount(sampleCount);
      setReplayLoadState("ready");
      setReplayActive(sampleCount > 0);
    } catch (error) {
      if (replayWindowRequestRef.current !== requestId) return;
      setReplayLoadState("error");
      setReplayLoadError(error instanceof Error && error.message.trim() ? error.message : t("replay.loadFailed"));
    }
  };

  useEffect(() => {
    if (replayActive && replayRequestedBounds) return;
    if (selectedSensor) loadSeriesOnce(selectedSensor.id, definition);
  }, [replayActive, replayRequestedBounds, selectedSensor?.id, definition.id, range, definition.forecastSupported]);

  useEffect(() => {
    if (!replayActive || replayRequestedBounds) {
      replayBatchRef.current = "";
      return;
    }
    const batchKey = `${houseId}:${definition.id}:${range}:${houseSensorIds}`;
    if (replayBatchRef.current === batchKey) return;
    replayBatchRef.current = batchKey;
    houseSensors.forEach((sensor) => {
      if (sensor.id !== selectedSensor?.id) loadSeriesOnce(sensor.id, definition);
    });
  }, [replayActive, replayRequestedBounds, houseId, definition.id, definition.forecastSupported, range, houseSensorIds, selectedSensor?.id]);

  useEffect(() => {
    if (!replayPrepared || replayRequestedBounds) {
      replayPreparationBatchRef.current = "";
      return;
    }
    const batchKey = `${houseId}:${range}:${houseSensorIds}:${airflowMetricKey}`;
    if (replayPreparationBatchRef.current === batchKey) return;
    replayPreparationBatchRef.current = batchKey;
    airflowDefinitions
      .filter((candidate) => candidate.id === "temperature" || candidate.id === "humidity")
      .forEach((replayDefinition) => houseSensors.forEach((sensor) => {
        loadSeriesOnce(sensor.id, replayDefinition);
      }));
  }, [replayPrepared, replayRequestedBounds, houseId, range, houseSensorIds, airflowMetricKey]);

  useEffect(() => {
    if (!replayActive || replayRequestedBounds) {
      airflowReplayBatchRef.current = "";
      return;
    }
    const batchKey = `${houseId}:${range}:${houseSensorIds}:${airflowMetricKey}:${definition.id}:${replayPrepared}`;
    if (airflowReplayBatchRef.current === batchKey) return;
    airflowReplayBatchRef.current = batchKey;
    airflowDefinitions.forEach((airflowDefinition) => {
      if (airflowDefinition.id === definition.id) return;
      if (replayPrepared && (airflowDefinition.id === "temperature" || airflowDefinition.id === "humidity")) return;
      houseSensors.forEach((sensor) => {
        loadSeriesOnce(sensor.id, airflowDefinition);
      });
    });
  }, [replayActive, replayPrepared, replayRequestedBounds, houseId, range, houseSensorIds, airflowMetricKey, definition.id]);

  useEffect(() => {
    if (!replayActive || replayRequestedBounds || !selectedSensor) {
      inspectorReplayBatchRef.current = "";
      return;
    }
    const supported = definitions.filter((candidate) => candidate.id !== definition.id
      && !airflowDefinitions.some((airflow) => airflow.id === candidate.id)
      && (selectedSensor.measurementEntityIds?.[candidate.id]
        || state.latestMeasurements[selectedSensor.id]?.[candidate.id]
        || state.measurementHistory[selectedSensor.id]?.[candidate.id]?.length));
    const batchKey = `${selectedSensor.id}:${range}:${supported.map((candidate) => candidate.id).join(",")}`;
    if (inspectorReplayBatchRef.current === batchKey) return;
    inspectorReplayBatchRef.current = batchKey;
    supported.forEach((candidate) => {
      loadSeriesOnce(selectedSensor.id, candidate);
    });
  }, [replayActive, replayRequestedBounds, selectedSensor?.id, range, definition.id, airflowMetricKey, state.latestMeasurements, state.measurementHistory]);

  const displayedSamples = useMemo(() => replayActive
    ? samplesAt(state.measurementHistory, houseSensors.map((sensor) => sensor.id), definition.id, replayTimestamp)
    : liveSamples,
  [replayActive, replayTimestamp, houseSensors, state.measurementHistory, liveSamples, definition.id]);

  const mapSensorMeasurements = useMemo<LatestMeasurements>(() => {
    if (!replayActive) return state.latestMeasurements;
    const replayEnergySamples = ["power", "energy"].map((energyMetric) => (
      samplesAt(state.measurementHistory, houseSensors.map((sensor) => sensor.id), energyMetric, replayTimestamp)
    ));
    return Object.fromEntries(houseSensors.map((sensor) => [sensor.id, Object.fromEntries(
      replayEnergySamples.flatMap((samplesBySensor) => {
        const sample = samplesBySensor[sensor.id];
        return sample ? [[sample.metric, sample]] : [];
      }),
    )]));
  }, [replayActive, replayTimestamp, houseSensors, state.latestMeasurements, state.measurementHistory]);

  const airflowSamples = useMemo<ClimateSampleMatrix>(() => {
    if (!replayActive) {
      return Object.fromEntries(houseSensors.map((sensor) => [sensor.id, state.latestMeasurements[sensor.id] ?? {}]));
    }
    const replayByMetric = Object.fromEntries(airflowDefinitions.map((airflowDefinition) => [
      airflowDefinition.id,
      samplesAt(state.measurementHistory, houseSensors.map((sensor) => sensor.id), airflowDefinition.id, replayTimestamp),
    ]));
    return Object.fromEntries(houseSensors.map((sensor) => [sensor.id, Object.fromEntries(
      airflowDefinitions.flatMap((airflowDefinition) => {
        const sample = replayByMetric[airflowDefinition.id]?.[sensor.id];
        return sample ? [[airflowDefinition.id, sample]] : [];
      }),
    )]));
  }, [replayActive, replayTimestamp, houseSensors, state.latestMeasurements, state.measurementHistory, airflowMetricKey]);

  const sensorCoverage = useMemo(() => assessSensorCoverage({
    house,
    sensors: houseSensors,
    samples: airflowSamples,
    freshness: spatialFreshness,
  }), [house, houseSensors, airflowSamples, spatialFreshness]);
  const airMovementSelected = spatialLayers.available && experimentalVisualizations.includes("air-movement");
  const coverageSelected = spatialLayers.available && experimentalVisualizations.includes("sensor-coverage");
  const openingStateAt = replayActive ? new Date(replayTimestamp).toISOString() : undefined;
  const [openingStateObservations, setOpeningStateObservations] = useState<OpeningStateObservation[]>([]);
  const [pendingOpeningStateKeys, setPendingOpeningStateKeys] = useState<ReadonlySet<string>>(() => new Set());
  const [openingStateError, setOpeningStateError] = useState<string | null>(null);
  const [openingStateAnnouncement, setOpeningStateAnnouncement] = useState("");
  const openingStateRequestsRef = useRef(new Set<string>());
  const openingStateContextRef = useRef({ houseId });
  if (openingStateContextRef.current.houseId !== houseId) openingStateContextRef.current = { houseId };
  const houseOpeningStateObservations = useMemo(
    () => openingStateObservationsForHouse(houseId, openingStateObservations),
    [houseId, openingStateObservations],
  );
  const controllableOpenings = useMemo(() => house.floors.flatMap((candidateFloor) => (
    (candidateFloor.planElements ?? []).flatMap((element, index) => (
      isAirflowPlanElement(element) && openingStateCanChange(element)
        ? [{ floor: candidateFloor, element, index }]
        : []
    ))
  )), [house.floors]);
  const hasOpeningElements = useMemo(() => house.floors.some((candidateFloor) => (
    (candidateFloor.planElements ?? []).some(isAirflowPlanElement)
  )), [house.floors]);

  useEffect(() => {
    setOpeningStateObservations([]);
    setPendingOpeningStateKeys(new Set());
    setOpeningStateError(null);
    setOpeningStateAnnouncement("");
    openingStateRequestsRef.current.clear();
  }, [houseId]);

  useEffect(() => {
    if (!hasOpeningElements) return;
    const controller = new AbortController();
    let loading = false;
    const load = async () => {
      if (loading) return;
      loading = true;
      try {
        const result = await api.openingStates(houseId, openingStateAt, controller.signal);
        if (!controller.signal.aborted) {
          setOpeningStateObservations((current) => mergeOpeningStateObservations(current, result.observations));
        }
      } catch {
        // Keep the last-good states; configured/manual fallbacks remain authoritative.
      } finally {
        loading = false;
      }
    };
    void load();
    const timer = openingStateAt === undefined ? window.setInterval(() => { void load(); }, 30_000) : null;
    return () => {
      controller.abort();
      if (timer !== null) window.clearInterval(timer);
    };
  }, [hasOpeningElements, houseId, openingStateAt]);

  const changeOpeningState = async (targetFloorId: string, elementId: string, nextState: ConfiguredOpeningState) => {
    if (readOnly || replayActive) return;
    const requestContext = openingStateContextRef.current;
    const requestKey = openingStateKey(targetFloorId, elementId);
    if (openingStateRequestsRef.current.has(requestKey)) return;
    const targetFloor = house.floors.find((candidate) => candidate.id === targetFloorId);
    const elementIndex = targetFloor?.planElements?.findIndex((candidate) => candidate.id === elementId) ?? -1;
    const element = elementIndex >= 0 ? targetFloor?.planElements?.[elementIndex] : undefined;
    if (!element || !isAirflowPlanElement(element) || !openingStateCanChange(element)) return;
    const openingName = element.label ?? `${t(`planElement.${element.kind}` as TranslationKey)} ${elementIndex + 1}`;
    openingStateRequestsRef.current.add(requestKey);
    setPendingOpeningStateKeys((current) => new Set([...current, requestKey]));
    setOpeningStateError(null);
    try {
      const observation = await api.recordOpeningState(requestContext.houseId, {
        floorId: targetFloorId,
        elementId,
        state: nextState,
        source: "manual",
      });
      if (openingStateContextRef.current !== requestContext) return;
      setLiveSpatialClockMs((current) => Math.max(current, Date.parse(observation.observedAt), Date.now()));
      setOpeningStateObservations((current) => mergeOpeningStateObservations(current, [observation]));
      setOpeningStateAnnouncement(t("opening.updated", {
        opening: openingName,
        state: t(`opening.state.${nextState}` as TranslationKey),
      }));
    } catch {
      if (openingStateContextRef.current === requestContext) {
        setOpeningStateError(t("opening.updateError", { opening: openingName }));
      }
    } finally {
      if (openingStateContextRef.current !== requestContext) return;
      openingStateRequestsRef.current.delete(requestKey);
      setPendingOpeningStateKeys((current) => {
        const next = new Set(current);
        next.delete(requestKey);
        return next;
      });
    }
  };
  const experimentalFloorAirflow = useMemo<FloorAirflowEstimate | null>(() => (
    spatialLayers.available && viewMode === "plan" ? simulateFloorAirflow({
      floor,
      sensors: floorSensors,
      samples: airflowSamples,
      freshness: spatialFreshness,
      outdoor: replayActive ? null : outdoorContext,
      openingStateObservations: houseOpeningStateObservations,
    }, 9) : null
  ), [spatialLayers.available, viewMode, floor, floorSensors, airflowSamples, spatialFreshness, replayActive, outdoorContext, houseOpeningStateObservations]);
  const experimentalBuildingAirflow = useMemo<BuildingAirflowEstimate | null>(() => (
    spatialLayers.available && viewMode === "isometric" ? simulateBuildingAirflow({
      house,
      sensors: houseSensors,
      samples: airflowSamples,
      freshness: spatialFreshness,
      outdoor: replayActive ? null : outdoorContext,
      openingStateObservations: houseOpeningStateObservations,
    }, 14) : null
  ), [spatialLayers.available, viewMode, house, houseSensors, airflowSamples, spatialFreshness, replayActive, outdoorContext, houseOpeningStateObservations]);
  const experimentalAirflowEvidence = experimentalFloorAirflow?.evidence ?? experimentalBuildingAirflow?.evidence ?? null;
  const experimentalSuggestions = useMemo(() => experimentalLayerSuggestions({
    house,
    coverage: sensorCoverage,
    airflow: experimentalAirflowEvidence,
    ...(viewMode === "plan" ? { floorId } : {}),
  }), [house, sensorCoverage, experimentalAirflowEvidence, viewMode, floorId]);
  const toggleExperimentalVisualization = (layerId: ExperimentalVisualizationId, selected: boolean) => {
    setExperimentalVisualizations((current) => {
      return selected
        ? current.includes(layerId) ? current : [...current, layerId]
        : current.filter((candidate) => candidate !== layerId);
    });
  };

  const values = summarySensors.flatMap((sensor) => {
    const sample = displayedSamples[sensor.id];
    const value = measurementValue(sample, definition.id);
    return isSpatialSampleFresh(sample, spatialFreshness) && value != null ? [value] : [];
  });
  const hasUsableReadings = houseSensors.some((sensor) => Object.values(state.latestMeasurements[sensor.id] ?? {})
    .some((sample) => Number.isFinite(sample.value) && isSpatialSampleFresh(sample, {
      referenceTimeMs: liveSpatialClockMs,
      maxSampleAgeMs: liveSpatialMaxSampleAgeMs,
    })));
  const houseValues = houseSensors.flatMap((sensor) => {
    const sample = displayedSamples[sensor.id];
    const value = measurementValue(sample, definition.id);
    return isSpatialSampleFresh(sample, spatialFreshness) && value != null ? [value] : [];
  });
  const activeOutdoorValue = definition.id === "temperature"
    ? outdoor.context?.conditions.temperatureC
    : definition.id === "humidity"
      ? outdoor.context?.conditions.relativeHumidityPercent
      : undefined;
  const activeOutdoorComparison = measurementComparisonColor(definition, houseValues, activeOutdoorValue);
  const houseColorDomain = activeOutdoorComparison?.domain ?? measurementDomain(definition, houseValues);
  const outdoorConditionColors: NonNullable<OutdoorVisualizationState["conditionColors"]> = {};
  for (const conditionMetric of ["temperature", "humidity"] as const) {
    const conditionDefinition = definitionFor(definitions, conditionMetric);
    const outsideValue = conditionMetric === "temperature"
      ? outdoor.context?.conditions.temperatureC
      : outdoor.context?.conditions.relativeHumidityPercent;
    const indoorValues = conditionMetric === definition.id
      ? houseValues
      : houseSensors.flatMap((sensor) => {
        const sample = state.latestMeasurements[sensor.id]?.[conditionMetric];
        const value = measurementValue(sample, conditionMetric);
        return isSpatialSampleFresh(sample, {
          referenceTimeMs: liveSpatialClockMs,
          maxSampleAgeMs: liveSpatialMaxSampleAgeMs,
        }) && value != null ? [value] : [];
      });
    const comparison = conditionMetric === definition.id
      ? activeOutdoorComparison
      : measurementComparisonColor(conditionDefinition, indoorValues, outsideValue);
    if (comparison) outdoorConditionColors[conditionMetric] = comparison.color;
  }
  const visualOutdoor: OutdoorVisualizationState = { ...outdoor, conditionColors: outdoorConditionColors };
  const average = values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : null;
  const spread = values.length ? Math.max(...values) - Math.min(...values) : null;
  const openAlerts = state.alerts.filter((alert) => !alert.resolvedAt && summarySensors.some((sensor) => sensor.id === alert.sensorId));
  const floorObservations = state.observations.filter((observation) => observation.houseId === houseId && observation.floorId === floorId);
  const houseObservations = state.observations.filter((observation) => observation.houseId === houseId);
  const houseParameters = state.staticParameters.filter((parameter) => parameter.houseId === houseId);
  const inspectorSamples = useMemo<Record<string, MeasurementSample>>(() => {
    if (!selectedSensor) return {};
    const samples: Record<string, MeasurementSample> = replayActive
      ? Object.fromEntries(definitions.flatMap((candidate) => {
          const replaySample = samplesAt(
            state.measurementHistory,
            [selectedSensor.id],
            candidate.id,
            replayTimestamp,
          )[selectedSensor.id];
          return replaySample ? [[candidate.id, replaySample]] : [];
        }))
      : { ...(state.latestMeasurements[selectedSensor.id] ?? {}) };
    return Object.fromEntries(Object.keys(samples).map((measurementId) => {
      const sample = samples[measurementId]!;
      return [measurementId, isSpatialSampleFresh(sample, spatialFreshness)
        ? sample
        : { ...sample, quality: "stale" as const }];
    }));
  }, [selectedSensor?.id, state.latestMeasurements, state.measurementHistory, replayActive, replayTimestamp, definitions, spatialFreshness]);

  const changeRange = (next: TimeRange) => {
    setRange(next);
  };

  const submitObservation = (event: FormEvent) => {
    event.preventDefault();
    if (readOnly) return;
    const time = observationTimeFields(observationTimePrecision, observationDateTime, observationDate, observationValidFrom, observationValidTo, house.timezone);
    if (!time) {
      setObservationValidationError(true);
      return;
    }
    setObservationDraft({
      houseId,
      floorId,
      sensorId: null,
      kind: observationKind,
      severity: observationSeverity,
      note: observationNote.trim() || t(`observations.${observationKind === "note" ? "noteKind" : observationKind}` as TranslationKey),
      source: observationSource,
      sourceDetail: observationSourceDetail.trim() || null,
      confidence: observationConfidence,
      ...time,
    });
    props.onViewMode("plan");
    setLiveMapOpen(true);
    setObservationPlacement(true);
    setObservationStatus(false);
    setObservationError(false);
    setObservationValidationError(false);
  };

  const placeObservation = async (point: Point) => {
    if (readOnly || !observationDraft) return;
    try {
      await props.onCreateObservation({
        ...observationDraft,
        x: round(point.x),
        y: round(point.y),
      });
      setObservationStatus(true);
      setObservationNote("");
      setObservationDateTime(localDateTimeValue(new Date(), house.timezone));
      setObservationDate(localDateValue(new Date(), house.timezone));
      setObservationValidFrom(localDateValue(new Date(), house.timezone));
      setObservationValidTo(localDateValue(new Date(), house.timezone));
    } catch {
      setObservationError(true);
    } finally {
      setObservationPlacement(false);
      setObservationDraft(null);
    }
  };

  const cancelObservationPlacement = () => {
    setObservationPlacement(false);
    setObservationDraft(null);
  };

  const submitParameter = async (event: FormEvent) => {
    event.preventDefault();
    const label = parameterLabel.trim();
    const value = parameterValue.trim();
    if (readOnly || !label || !value || parameterPending) return;
    setParameterPending(true);
    setParameterFeedback(null);
    try {
      await props.onCreateStaticParameter({
        houseId,
        scopeType: "house",
        scopeId: houseId,
        key: label.toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_|_$/g, "") || crypto.randomUUID(),
        label,
        value,
        unit: parameterUnit.trim() || null,
      });
      setParameterLabel("");
      setParameterValue("");
      setParameterUnit("");
      setParameterFeedback("saved");
    } catch {
      setParameterFeedback("error");
    } finally {
      setParameterPending(false);
    }
  };

  const startEditing = () => {
    if (readOnly) return;
    setFullPage(false);
    setEditing(true);
    cancelObservationPlacement();
  };

  const saveEdits = async () => {
    if (readOnly) return false;
    try {
      await props.onSaveLayout(house);
      return true;
    } catch {
      return false;
    }
  };

  const finishEditing = async () => {
    if (await saveEdits()) setEditing(false);
  };

  const openDecisionSensor = (targetFloorId: string, sensorId: string) => {
    props.onFloor(targetFloorId);
    props.onSensorSelect(sensorId);
    props.onViewMode("plan");
    setLiveMapOpen(true);
  };
  const liveMapVisible = liveMapOpen || editing || replayActive || fullPage;

  return (
    <>
      <header className="page-heading twin-heading">
        <div className="twin-heading-copy"><span className={`eyebrow twin-status ${dataMode === "demo" ? "demo" : connection}`}>{dataMode === "demo" ? t("demo.bannerTitle") : t(`status.${connection}`)}</span><h1>{t("twin.title")}</h1><p>{t("twin.description")}</p></div>
        <div className="context-controls">
          {props.onOpenActivity && <button type="button" className="secondary-button" onClick={props.onOpenActivity}><Activity size={15} aria-hidden="true" />{t("nav.activity")}</button>}
          {props.onOpenOutdoor && <button type="button" className="secondary-button" onClick={props.onOpenOutdoor}><Wind size={15} aria-hidden="true" />{t("nav.outdoor")}</button>}
          {props.onOpenEnergy && <button type="button" className="secondary-button" onClick={props.onOpenEnergy}><Bolt size={15} aria-hidden="true" />{t("nav.energyUse")}</button>}
          {props.onOpenAnalytics && <button type="button" className="secondary-button" onClick={props.onOpenAnalytics}><Gauge size={15} aria-hidden="true" />{t("nav.analytics")}</button>}
        </div>
      </header>

      {!editing && !replayActive && <>
        <div className="decision-layer">
          <HomePulsePanel
            key={house.id}
            house={house}
            sensors={houseSensors}
            latestMeasurements={state.latestMeasurements}
            measurementHistory={state.measurementHistory}
            alerts={state.alerts}
            alertRules={state.alertRules}
            weather={houseWeather.weather}
            referenceTime={liveSpatialClockMs}
            onOpenTarget={openDecisionSensor}
            {...(!readOnly && (sensorSourceHealthy ? props.onOpenSensors : props.onOpenConnections) ? {
              onOpenSetup: sensorSourceHealthy ? () => props.onOpenSensors?.(houseId) : () => props.onOpenConnections?.(houseId),
              setupDestination: sensorSourceHealthy ? "sensors" as const : "connections" as const,
            } : {})}
          />
          {hasUsableReadings && <MoistureCoach
            sensors={houseSensors}
            latestMeasurements={state.latestMeasurements}
            conditions={houseWeather.weather?.current}
            {...(houseWeather.weather ? { weatherStale: houseWeather.weather.stale } : {})}
            units={units}
            now={liveSpatialClockMs}
            onOpenSensor={(sensorId) => {
              const sensor = houseSensors.find((candidate) => candidate.id === sensorId);
              if (sensor) openDecisionSensor(sensor.floorId, sensor.id);
            }}
          />}
        </div>
        {hasUsableReadings && <section className="home-status-zone" aria-labelledby="home-status-heading">
          <div className="decision-section-heading home-zone-heading">
            <div><span className="eyebrow">{t("home.statusEyebrow")}</span><h2 id="home-status-heading">{t("home.statusTitle")}</h2></div>
            <p>{t("home.statusDescription")}</p>
          </div>
          <section className="summary-strip" aria-label={t("twin.title")}>
            <div className="summary-item"><span className={`summary-icon measurement ${definition.colorScale}`}><MeasurementGlyph definition={definition} size={18} /></span><span><small>{t("twin.averageMeasurement", { metric: metricLabel })}</small><strong>{average == null ? t("common.noData") : formatMeasurement(average, definition, units)}</strong></span></div>
            <div className="summary-item"><span className="summary-icon flow"><Activity size={18} aria-hidden="true" /></span><span><small>{t("twin.reportingSensors")}</small><strong>{t("twin.reportingCount", { count: values.length, total: summarySensors.length })}</strong></span></div>
            <div className="summary-item"><span className="summary-icon flow"><Wind size={18} aria-hidden="true" /></span><span><small>{t("twin.spread")}</small><strong>{spread == null ? t("common.noData") : formatMeasurementDelta(spread, definition, units)}</strong></span></div>
            <div className={`summary-item ${openAlerts.length ? "attention" : ""}`} data-summary-scope="threshold-alerts"><span className="summary-icon alert"><AlertTriangle size={18} aria-hidden="true" /></span><span><small>{t("alerts.open")}</small><strong>{openAlerts.length === 0 ? t("twin.noActiveAlerts") : openAlerts.length === 1 ? t("twin.oneAlert") : t("twin.manyAlerts", { count: openAlerts.length })}</strong></span></div>
          </section>
        </section>}
      </>}

      {!liveMapVisible && <section className="panel home-live-launcher" aria-labelledby="home-live-launcher-title"><div><span className="eyebrow">{t("home.liveEyebrow")}</span><h2 id="home-live-launcher-title">{t("home.liveTitle")}</h2><p>{t("home.liveDescription")}</p></div><button type="button" className="secondary-button" aria-expanded="false" onClick={() => setLiveMapOpen(true)}><Map size={15} aria-hidden="true" />{t("home.openLiveView")}</button></section>}
      {liveMapVisible && <>
      {!editing && <div className="decision-section-heading home-live-heading"><div><span className="eyebrow">{replayActive ? t("replay.title") : t("home.liveEyebrow")}</span><h2>{replayActive
        ? t("replay.active", { time: formatInTimeZone(replayTimestamp, locale, house.timezone, { dateStyle: "medium", timeStyle: "short" }) })
        : t("home.liveTitle")}</h2></div><p>{replayActive ? t("replay.description") : t("home.liveDescription")}</p></div>}
      <section ref={fullPagePanelRef} className={`panel twin-panel ${fullPage ? "is-full-page" : ""}`} role={fullPage ? "dialog" : undefined} aria-modal={fullPage ? true : undefined} aria-label={fullPage ? t("home.liveTitle") : undefined}>
        <div className="twin-toolbar">
          <div className="toolbar-title">
            {editing
              ? <><span className="eyebrow">{house.name}</span><strong>{t("twin.editingFloor", { floor: floor.name })}</strong></>
              : house.floors.length > 1
                ? <><label className="toolbar-floor-picker"><span>{t("common.floor")}</span><select value={floorId} onChange={(event) => props.onFloor(event.target.value)}>{house.floors.map((item) => <option key={item.id} value={item.id}>{item.name}</option>)}</select></label><strong>{viewSensors.length} {t("twin.sensors")}</strong></>
                : <><span className="eyebrow">{floor.name}</span><strong>{viewSensors.length} {t("twin.sensors")}</strong></>}
          </div>
          <div className="toolbar-groups">
            {!editing && <label className="metric-picker"><span>{t("common.metric")}</span><select value={definition.id} onChange={(event) => props.onMetric(event.target.value)}>{metricOptions.map((item) => <option key={item.id} value={item.id}>{measurementLabel(item, locale)} · {displayUnit(item, units)}</option>)}</select></label>}
            <div className="segmented" role="group" aria-label={t("common.view")}><button type="button" aria-pressed={viewMode === "plan"} onClick={() => props.onViewMode("plan")}><Map size={15} aria-hidden="true" />{t("twin.mode2d")}</button><button type="button" aria-pressed={viewMode === "isometric"} onClick={() => { cancelObservationPlacement(); props.onViewMode("isometric"); }}><Box size={15} aria-hidden="true" />{t("twin.modeIso")}</button></div>
            {!editing && energyDeviceCount > 0 && <div className="segmented compact map-device-layers" role="group" aria-label={t("twin.mapLayers")}><button type="button" aria-pressed={energyDevicesVisible} onClick={() => setEnergyDevicesVisible((current) => !current)}><Bolt size={15} aria-hidden="true" />{t("twin.energyDeviceLayer")}</button></div>}
            {!editing && <button ref={fullPageTriggerRef} type="button" className="secondary-button twin-full-page-button" aria-pressed={fullPage} onClick={() => setFullPage((current) => !current)}>{fullPage ? <Minimize2 size={15} aria-hidden="true" /> : <Maximize2 size={15} aria-hidden="true" />}{fullPage ? t("twin.exitFullPage") : t("twin.fullPage")}</button>}
            {!editing && !replayActive && !fullPage && <button type="button" className="secondary-button" onClick={() => setLiveMapOpen(false)}><Minimize2 size={15} aria-hidden="true" />{t("home.hideLiveView")}</button>}
            {!readOnly && !editing && <button type="button" className="secondary-button" onClick={startEditing}><Edit3 size={15} aria-hidden="true" />{t("common.edit")}</button>}
            {editing && <><button type="button" className="primary-button" onClick={() => void finishEditing()} disabled={props.saveState === "saving"}><Save size={15} aria-hidden="true" />{props.saveState === "saving" ? t("common.saving") : t("common.saveAndFinish")}</button><button type="button" className="secondary-button" onClick={() => setEditing(false)} disabled={props.saveState === "saving"}>{t("common.cancel")}</button></>}
          </div>
        </div>
        {props.saveState === "error" && <p className="inline-error" role="alert">{t("twin.layoutSaveError")}</p>}
        {!editing && !replayActive && !readOnly && controllableOpenings.length > 0 && <div className="opening-runtime-bar">
          <span className="opening-runtime-states" aria-hidden="true"><i className="closed" /><i className="open" /></span>
          <span>{t("opening.controlHint")}</span>
        </div>}
        {openingStateError && !replayActive && <p className="inline-error opening-state-error" role="alert">{openingStateError}</p>}
        <p className="sr-only" role="status" aria-live="polite">{openingStateAnnouncement}</p>
        {!editing && <SpatialLayerPanel
          layers={spatialLayers}
          timeZone={house.timezone}
          historyAt={replayActive ? replayTimestamp : null}
          compact
          visualization={{
            selected: experimentalVisualizations,
            mode: viewMode,
            coverage: sensorCoverage,
            airflow: experimentalAirflowEvidence,
            suggestions: experimentalSuggestions,
            onToggle: toggleExperimentalVisualization,
          }}
          onHistorySelect={(timestamp) => {
            setReplayActive(true);
            setReplayTimestamp(clamp(timestamp, replayMin, replayMax));
          }}
        />}
        <Suspense fallback={<output className="page-loading">{t("common.loading")}</output>}><div className={`twin-grid ${editing ? "is-editing" : ""}`}>
          {editing && (
            <StructureEditor
              houses={state.houses} house={house} floor={floor} sensors={state.sensors}
              onHouseSelect={props.onHouse} onFloorSelect={props.onFloor}
              {...(props.onHouseChange ? { onHouseChange: props.onHouseChange } : {})}
              onHouseSave={props.onSaveLayout}
              {...(props.onHouseCreate ? { onHouseCreate: props.onHouseCreate } : {})}
              {...(props.onHouseDelete ? { onHouseDelete: props.onHouseDelete } : {})}
            />
          )}
          {viewMode === "plan" ? (
            <FloorPlan
              floor={floor} house={house} sensors={floorSensors} samples={displayedSamples} climateSamples={airflowSamples} observations={floorObservations} definition={definition} colorDomain={houseColorDomain} units={units}
              sensorMeasurements={mapSensorMeasurements} energyDevicesVisible={energyDevicesVisible}
              viewMode="plan" selectedSensorId={selectedSensor?.id ?? null} editing={editing} observationPlacement={observationPlacement}
              referenceTimeMs={spatialReferenceTimeMs} maxSampleAgeMs={spatialMaxSampleAgeMs}
              outdoor={visualOutdoor}
              spatialLayerSnapshots={spatialLayers.snapshots}
              spatialLayerTopology={spatialLayers.topology}
              experimentalAirflowEnabled={airMovementSelected}
              experimentalAirflow={airMovementSelected ? experimentalFloorAirflow : null}
              experimentalSensorCoverage={coverageSelected ? sensorCoverage : null}
              openingStateObservations={houseOpeningStateObservations}
              pendingOpeningStateKeys={pendingOpeningStateKeys}
              {...(!readOnly && !replayActive ? { onOpeningStateChange: (targetFloorId: string, elementId: string, nextState: ConfiguredOpeningState) => { void changeOpeningState(targetFloorId, elementId, nextState); } } : {})}
              onSensorSelect={props.onSensorSelect} onSensorMove={props.onSensorMove} onFloorChange={props.onFloorChange} onObservationPoint={placeObservation}
              onCancelObservationPlacement={cancelObservationPlacement}
            />
          ) : (
            <BuildingScene
              house={house} sensors={houseSensors} samples={displayedSamples} climateSamples={airflowSamples} observations={houseObservations} definition={definition} colorDomain={houseColorDomain} units={units}
              sensorMeasurements={mapSensorMeasurements} energyDevicesVisible={energyDevicesVisible}
              activeFloorId={floorId} selectedSensorId={selectedSensor?.id ?? null} onFloorSelect={props.onFloor}
              referenceTimeMs={spatialReferenceTimeMs} maxSampleAgeMs={spatialMaxSampleAgeMs}
              outdoor={visualOutdoor}
              editing={editing}
              spatialLayerSnapshots={spatialLayers.snapshots}
              spatialLayerTopology={spatialLayers.topology}
              experimentalAirflowEnabled={airMovementSelected}
              experimentalAirflow={airMovementSelected ? experimentalBuildingAirflow : null}
              experimentalSensorCoverage={coverageSelected ? sensorCoverage : null}
              openingStateObservations={houseOpeningStateObservations}
              pendingOpeningStateKeys={pendingOpeningStateKeys}
              {...(!readOnly && !replayActive ? { onOpeningStateChange: (targetFloorId: string, elementId: string, nextState: ConfiguredOpeningState) => { void changeOpeningState(targetFloorId, elementId, nextState); } } : {})}
              onFloorChange={props.onFloorChange}
              onSensorSelect={(sensorId) => props.onSensorSelect(sensorId)}
            />
          )}
          <SensorInspector
            sensor={selectedSensor} reading={!replayActive && selectedSensor ? state.readings[selectedSensor.id] : undefined} samples={inspectorSamples}
            definitions={definitions} selectedDefinition={definition} units={units}
            house={house} floor={selectedFloor} editing={editing} onSensorUpdate={props.onSensorUpdate} onFloorSelect={props.onFloor}
          />
        </div></Suspense>
      </section>
      </>}

      {!editing && <>
      {!replayActive && hasUsableReadings && <RoomComfortBoard
        sensors={houseSensors}
        latestMeasurements={state.latestMeasurements}
        measurementHistory={state.measurementHistory}
        definitions={definitions}
        alerts={state.alerts}
        units={units}
        now={liveSpatialClockMs}
        onOpenRoom={openDecisionSensor}
      />}

      {!replayActive && <div className="home-secondary-grid">
        <HomeOperationsPreview
          sensors={houseSensors}
          alerts={state.alerts.filter((alert) => houseSensors.some((sensor) => sensor.id === alert.sensorId))}
          observations={houseObservations}
          maintenanceTasks={state.maintenanceTasks.filter((task) => task.houseId === houseId)}
          warnings={houseWeather.weather?.warnings ?? []}
          integration={state.integration}
          timeZone={house.timezone}
          {...(props.onOpenActivity ? { onOpenActivity: props.onOpenActivity } : {})}
          {...(props.onOpenMaintenance ? { onOpenMaintenance: props.onOpenMaintenance } : {})}
        />
      </div>}

      <section className="panel history-events-workspace" aria-labelledby="history-events-heading">
        <div className="panel-header history-events-heading">
          <div><span className="eyebrow"><History size={14} aria-hidden="true" />{t("historyEvents.eyebrow")}</span><h2 id="history-events-heading">{t("historyEvents.title")}</h2><p className="panel-intro">{t("historyEvents.description")}</p></div>
          <div className="history-events-actions"><span className="count-badge">{t("historyEvents.detectedCount", { count: replayEvents.length })}</span>{!replayActive && <button type="button" className="secondary-button" aria-expanded={historyOpen} onClick={() => setHistoryOpen((current) => !current)}><History size={15} aria-hidden="true" />{t(historyOpen ? "historyEvents.close" : "historyEvents.open")}</button>}</div>
        </div>
        {(historyOpen || replayActive) && <ReplayControls
          active={replayActive}
          playing={replayPlaying}
          timestamp={replayTimestamp}
          min={replayMin}
          max={replayMax}
          speed={replaySpeed}
          timeZone={house.timezone}
          events={replayEvents}
          sensors={houseSensors}
          definitions={definitions}
          units={units}
          onActive={(active) => { setReplayActive(active); if (active) { setHistoryOpen(true); setLiveMapOpen(true); } }}
          onPlaying={changeReplayPlaying}
          onTimestamp={setReplayTimestamp}
          onSpeed={setReplaySpeed}
          onEventSelect={selectReplayEvent}
          {...(props.onLoadReplaySeries ? {
            windowFrom: replayWindowFrom,
            windowTo: replayWindowTo,
            resolutionSeconds: replayResolutionSeconds,
            loading: replayLoadState === "loading",
            partial: replayLoadPartial,
            loadError: replayLoadError,
            onWindowFrom: setReplayWindowFrom,
            onWindowTo: setReplayWindowTo,
            onResolution: setReplayResolutionSeconds,
            onLoadWindow: () => { void loadReplayWindow(); },
          } : {})}
          {...(replaySampleCount === null ? {} : { sampleCount: replaySampleCount })}
        />}
      </section>

      <details className="home-tools-disclosure" open={analysisOpen}>
        <summary onClick={(event) => { event.preventDefault(); setAnalysisOpen((current) => !current); }}>
          <span className="home-tools-icon" aria-hidden="true"><History size={20} /></span>
          <span><span className="eyebrow">{t("home.toolsSummary")}</span><strong>{t("home.toolsTitle")}</strong><small>{t("home.toolsDescription")}</small></span>
          <ChevronDown className="disclosure-chevron" size={19} aria-hidden="true" />
        </summary>
        {analysisOpen && <Suspense fallback={<output className="page-loading">{t("common.loading")}</output>}><div className="home-tools-content">
          <ThermalSimulationPanel
            houseId={houseId}
            sensor={selectedSensor}
            range={range}
            units={units}
            timeZone={house.timezone}
            currentOutdoorTemperatureC={houseWeather.weather?.current?.temperatureC}
            {...(replayActive ? { cursorTimestamp: replayTimestamp } : {})}
          />
          {!readOnly && <SpatialLayerLab houseId={houseId} sensors={houseSensors} layers={spatialLayers} />}

          <div className="lower-grid">
        <RoomComparisonChart
          sensors={houseSensors}
          selectedSensorId={selectedSensor?.id ?? null}
          history={state.measurementHistory}
          definition={definition}
          units={units}
          range={range}
          weather={houseWeather.weather}
          alerts={state.alerts.filter((alert) => houseSensors.some((sensor) => sensor.id === alert.sensorId))}
          observations={houseObservations}
          warnings={houseWeather.weather?.warnings ?? []}
          timeZone={house.timezone}
          onRange={changeRange}
          onLoadSeries={(sensorId) => props.onLoadSeries(sensorId, definition.id, range, definition.forecastSupported)}
        />
        <div className="side-stack">
          <HomeActivityTimeline
            sensors={houseSensors}
            alerts={state.alerts.filter((alert) => houseSensors.some((sensor) => sensor.id === alert.sensorId))}
            observations={houseObservations}
            maintenanceTasks={state.maintenanceTasks.filter((task) => task.houseId === houseId)}
            warnings={houseWeather.weather?.warnings ?? []}
            integration={state.integration}
            timeZone={house.timezone}
            {...(!readOnly && props.onUpdateObservation ? { onUpdateObservation: props.onUpdateObservation } : {})}
            {...(!readOnly && props.onReloadObservation ? { onReloadObservation: props.onReloadObservation } : {})}
            {...(props.onLoadObservationRevisions ? { onLoadObservationRevisions: props.onLoadObservationRevisions } : {})}
            onOpenSensor={openDecisionSensor}
            onOpenFloor={(targetFloorId) => { props.onFloor(targetFloorId); props.onViewMode("plan"); }}
          />
          {!readOnly && dataMode === "demo" && <section className="panel compact-panel">
            <div className="panel-header"><div><h2>{t("mock.title")}</h2><p className="panel-intro">{t("mock.description")}</p></div></div>
            <label className="field"><span>{t("mock.scenario")}</span><select value={scenario} onChange={(event) => props.onRunScenario(event.target.value as MockScenario["id"])}>{state.scenarios.map((item) => <option key={item.id} value={item.id}>{t(`mock.${item.id}` as TranslationKey)}</option>)}</select></label>
            <p className="field-help">{t(`mock.${scenario}Description` as TranslationKey)}</p>
            <button type="button" className="secondary-button full-width" onClick={() => props.onRunScenario(scenario)}><Sparkles size={15} aria-hidden="true" />{t("mock.start")}</button>
          </section>}
          {!readOnly && <section className="panel compact-panel observation-panel">
            <div className="panel-header"><div><span className="eyebrow">{floor.name}</span><h2>{t("observations.title")}</h2></div><span className="count-badge">{floorObservations.length}</span></div>
            <form onSubmit={submitObservation} className="observation-form">
              <fieldset className="observation-fields" disabled={observationPlacement}>
                <legend className="sr-only">{t("observations.details")}</legend>
                <div className="field-row"><label className="field"><span>{t("observations.kind")}</span><select value={observationKind} onChange={(event) => setObservationKind(event.target.value as ManualObservation["kind"])}>{observationKinds.map((kind) => <option key={kind} value={kind}>{t(`observations.${kind === "note" ? "noteKind" : kind}` as TranslationKey)}</option>)}</select></label><label className="field"><span>{t("alerts.severity")}</span><select value={observationSeverity} onChange={(event) => setObservationSeverity(event.target.value as ManualObservation["severity"])}><option value="info">{t("alerts.info")}</option><option value="warning">{t("alerts.warning")}</option><option value="critical">{t("alerts.critical")}</option></select></label></div>
                <label className="field"><span>{t("observations.timePrecision")}</span><select value={observationTimePrecision} onChange={(event) => { setObservationTimePrecision(event.target.value as ObservationTimePrecision); setObservationValidationError(false); }}>{observationTimePrecisions.map((precision) => <option key={precision} value={precision}>{t(`observations.precision.${precision}` as TranslationKey)}</option>)}</select></label>
                {(observationTimePrecision === "exact" || observationTimePrecision === "approximate") && <label className="field"><span>{t("observations.observedAt")}</span><input type="datetime-local" required value={observationDateTime} onChange={(event) => setObservationDateTime(event.target.value)} /><small>{t("observations.localTimeHelp")}</small></label>}
                {observationTimePrecision === "date-only" && <label className="field"><span>{t("observations.observedDate")}</span><input type="date" required value={observationDate} onChange={(event) => setObservationDate(event.target.value)} /></label>}
                {observationTimePrecision === "date-range" && <div className="field-row"><label className="field"><span>{t("observations.validFrom")}</span><input type="date" required max={observationValidTo} value={observationValidFrom} onChange={(event) => setObservationValidFrom(event.target.value)} /></label><label className="field"><span>{t("observations.validTo")}</span><input type="date" required min={observationValidFrom} value={observationValidTo} onChange={(event) => setObservationValidTo(event.target.value)} /></label></div>}
                {observationTimePrecision === "unknown" && <p className="field-help observation-time-help">{t("observations.unknownTimeHelp")}</p>}
                <div className="field-row"><label className="field"><span>{t("observations.source")}</span><select value={observationSource} onChange={(event) => setObservationSource(event.target.value as ObservationSource)}>{observationSources.map((source) => <option key={source} value={source}>{t(`observations.source.${source}` as TranslationKey)}</option>)}</select></label><label className="field"><span>{t("observations.confidence")}</span><select value={observationConfidence} onChange={(event) => setObservationConfidence(event.target.value as ObservationConfidence)}>{observationConfidences.map((confidence) => <option key={confidence} value={confidence}>{t(`observations.confidence.${confidence}` as TranslationKey)}</option>)}</select></label></div>
                <label className="field"><span>{t("observations.sourceDetail")}</span><input value={observationSourceDetail} onChange={(event) => setObservationSourceDetail(event.target.value)} placeholder={t("observations.sourceDetailPlaceholder")} /></label>
                <label className="field"><span>{t("observations.note")}</span><input value={observationNote} onChange={(event) => setObservationNote(event.target.value)} placeholder={t("observations.notePlaceholder")} /></label>
              </fieldset>
              <button type="submit" className={observationPlacement ? "primary-button full-width" : "secondary-button full-width"}><MapPinPlus size={15} aria-hidden="true" />{observationPlacement ? t("observations.locationHint") : t("observations.add")}</button>
              {observationValidationError && <p className="inline-error" role="alert">{t("observations.invalidTime")}</p>}
              {observationStatus && <p className="success-message" role="status"><Check size={15} aria-hidden="true" />{t("observations.logged")}</p>}
              {observationError && <p className="inline-error" role="alert">{t("observations.saveFailed")}</p>}
            </form>
          </section>}
          <section className="panel compact-panel context-panel">
            <div className="panel-header"><div><h2>{t("context.title")}</h2><p className="panel-intro">{t("context.description")}</p></div><span className="count-badge">{houseParameters.length}</span></div>
            {houseParameters.length > 0 && <dl className="parameter-list">{houseParameters.slice(0, 5).map((parameter) => <div key={parameter.id}><dt>{parameter.label}</dt><dd>{String(parameter.value)}{parameter.unit ? ` ${parameter.unit}` : ""}</dd></div>)}</dl>}
            {!readOnly && <form onSubmit={submitParameter} className="context-form">
              <label className="field"><span>{t("context.label")}</span><input required value={parameterLabel} onChange={(event) => setParameterLabel(event.target.value)} placeholder={t("context.labelPlaceholder")} /></label>
              <div className="field-row"><label className="field"><span>{t("context.value")}</span><input required value={parameterValue} onChange={(event) => setParameterValue(event.target.value)} placeholder={t("context.valuePlaceholder")} /></label><label className="field"><span>{t("context.unit")}</span><input value={parameterUnit} onChange={(event) => setParameterUnit(event.target.value)} placeholder={t("common.optional")} /></label></div>
              <button type="submit" className="secondary-button full-width" disabled={parameterPending}>{parameterPending ? t("common.saving") : t("context.add")}</button>
              {parameterFeedback === "saved" && <p className="success-message" role="status"><Check size={15} aria-hidden="true" />{t("context.saved")}</p>}
              {parameterFeedback === "error" && <p className="inline-error" role="alert">{t("context.saveFailed")}</p>}
            </form>}
          </section>
        </div>
          </div>
        </div></Suspense>}
      </details>
      </>}
    </>
  );
}

function MeasurementGlyph({ definition, size }: { definition: MeasurementDefinition; size: number }) {
  const Icon = definition.colorScale === "thermal"
    ? Thermometer
    : definition.colorScale === "humidity"
      ? Droplets
      : definition.colorScale === "air-quality"
        ? Wind
        : Gauge;
  return <Icon size={size} aria-hidden="true" />;
}

function SensorInspector({
  sensor, reading, samples, definitions, selectedDefinition, units, house, floor, editing, onSensorUpdate, onFloorSelect,
}: {
  sensor: Sensor | null;
  reading: Reading | undefined;
  samples: Record<string, MeasurementSample>;
  definitions: MeasurementDefinition[];
  selectedDefinition: MeasurementDefinition;
  units: UnitSystem;
  house: House;
  floor: Floor;
  editing: boolean;
  onSensorUpdate: (id: string, patch: SensorPatch) => Promise<Sensor>;
  onFloorSelect: (floorId: string) => void;
}) {
  const { locale, t } = useI18n();
  const [targetFloorId, setTargetFloorId] = useState(sensor?.floorId ?? floor.id);
  const [mountingHeight, setMountingHeight] = useState(sensor ? String(round(sensor.z - floor.elevation)) : "1.4");
  const [placementPending, setPlacementPending] = useState(false);
  const [placementError, setPlacementError] = useState(false);
  useEffect(() => {
    if (!sensor) return;
    const sensorFloor = house.floors.find((item) => item.id === sensor.floorId) ?? floor;
    setTargetFloorId(sensorFloor.id);
    setMountingHeight(String(round(sensor.z - sensorFloor.elevation)));
    setPlacementError(false);
  }, [sensor?.id, sensor?.floorId, sensor?.z, house.floors, floor]);
  if (!sensor) return <aside className={`sensor-inspector ${editing ? "editing" : ""}`}><div className="empty-state">{editing ? t("twin.selectSensorToMove") : t("twin.selectSensor")}</div></aside>;
  const registeredForSensor = definitions.filter((definition) => samples[definition.id] || sensor.measurementEntityIds?.[definition.id]);
  const availableDefinitions = registeredForSensor.length ? registeredForSensor : definitions;
  const visibleDefinitions = availableDefinitions.some((definition) => definition.id === selectedDefinition.id)
    ? availableDefinitions
    : [selectedDefinition, ...availableDefinitions];
  const selectedSample = samples[selectedDefinition.id];
  const applyPlacement = async (event: FormEvent) => {
    event.preventDefault();
    const targetFloor = house.floors.find((item) => item.id === targetFloorId);
    const height = Number(mountingHeight);
    if (!targetFloor || !Number.isFinite(height)) return;
    setPlacementPending(true);
    setPlacementError(false);
    try {
      await onSensorUpdate(sensor.id, {
        floorId: targetFloor.id,
        x: clamp(sensor.x, 0, targetFloor.width),
        y: clamp(sensor.y, 0, targetFloor.height),
        z: targetFloor.elevation + Math.max(0, height),
      });
      onFloorSelect(targetFloor.id);
    } catch {
      setPlacementError(true);
    } finally {
      setPlacementPending(false);
    }
  };
  const batteryValue = measurementValue(samples.battery, "battery") ?? reading?.battery ?? null;
  return (
    <aside className={`sensor-inspector ${editing ? "editing" : ""}`} aria-labelledby="selected-sensor-title">
      <div className="sensor-heading"><span className="device-glyph" aria-hidden="true"><span /><span /></span><div><span className="eyebrow">{sensor.model}</span><h2 id="selected-sensor-title">{sensor.name}</h2><p><Home size={13} aria-hidden="true" />{sensor.room}</p></div></div>
      {!editing && <><div className="sensor-current" role="list" aria-label={t("twin.measurements")}>
        {visibleDefinitions.map((definition) => {
          const sample = samples[definition.id];
          const value = measurementValue(sample, definition.id);
          return (
            <div key={definition.id} role="listitem" className={definition.id === selectedDefinition.id ? "selected" : undefined}>
              <span><MeasurementGlyph definition={definition} size={16} />{measurementLabel(definition, locale)}</span>
              <strong>{value == null ? "—" : formatMeasurement(value, definition, units)}</strong>
              <small>
                <span className={`quality-dot ${sample?.quality ?? "stale"}`} aria-hidden="true" />
                {sample ? t(`measurement.quality.${sample.quality}` as TranslationKey) : t("common.noData")}
                {sample && <time dateTime={sample.timestamp}>{formatInTimeZone(sample.timestamp, locale, house.timezone, { hour: "2-digit", minute: "2-digit", second: "2-digit" })}</time>}
              </small>
            </div>
          );
        })}
      </div>
      <dl className="sensor-meta">
        <div><dt>{t("twin.sensorFloor")}</dt><dd>{floor.name}</dd></div>
        <div><dt>{t("twin.mountingHeight")}</dt><dd>{round(sensor.z - floor.elevation)} m</dd></div>
        <div><dt><BatteryMedium size={15} aria-hidden="true" />{t("twin.battery")}</dt><dd>{batteryValue == null ? "—" : `${batteryValue}%`}</dd></div>
        <div><dt>{t("twin.quality")}</dt><dd><span className={`quality-dot ${selectedSample?.quality ?? "stale"}`} aria-hidden="true" />{selectedSample ? t(`measurement.quality.${selectedSample.quality}` as TranslationKey) : "—"}</dd></div>
        <div><dt>{t("twin.source")}</dt><dd>{selectedSample ? t(`measurement.source.${selectedSample.source}` as TranslationKey) : "—"}</dd></div>
        <div><dt>{t("twin.lastReading")}</dt><dd>{selectedSample ? <time dateTime={selectedSample.timestamp}>{formatInTimeZone(selectedSample.timestamp, locale, house.timezone, { hour: "2-digit", minute: "2-digit", second: "2-digit" })}</time> : "—"}</dd></div>
      </dl></>}
      {editing && <>
        <p className="sensor-edit-help">{t("twin.sensorEditHint")}</p>
        <form className="sensor-placement-form" onSubmit={applyPlacement}>
          <strong>{t("twin.sensorPlacement")}</strong>
          <label className="field"><span>{t("twin.sensorFloor")}</span><select value={targetFloorId} onChange={(event) => setTargetFloorId(event.target.value)}>{house.floors.map((item) => <option key={item.id} value={item.id}>{item.name}</option>)}</select></label>
          <label className="field"><span>{t("twin.mountingHeight")}</span><span className="input-suffix"><input type="number" min="0" step="0.1" required value={mountingHeight} onChange={(event) => setMountingHeight(event.target.value)} /><span aria-hidden="true">m</span></span></label>
          <button type="submit" className="secondary-button full-width" disabled={placementPending}>{placementPending ? t("common.saving") : t("twin.applyPlacement")}</button>
          {placementError && <p className="inline-error" role="alert">{t("twin.sensorPlacementError")}</p>}
        </form>
        <p className="keyboard-help">{t("twin.keyboardMove")}</p>
      </>}
    </aside>
  );
}
