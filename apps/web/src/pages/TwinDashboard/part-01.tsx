import { lazy, Suspense, useEffect, useMemo, useRef, useState, type FormEvent } from "react";
import { Activity, AlertTriangle, BatteryMedium, Bolt, Box, Check, ChevronDown, Droplets, Edit3, Gauge, History, Home, Map, MapPinPlus, Maximize2, Minimize2, Save, Sparkles, Thermometer, Wind } from "lucide-react";
import { isAirflowPlanElement, type ConfiguredOpeningState, type ConnectedDeviceState, type ConnectionState, type Floor, type House, type ManualObservation, type ManualObservationInput, type ManualObservationPatch, type MeasurementDefinition, type MeasurementSample, type Metric, type MockScenario, type ObservationConfidence, type ObservationRevision, type ObservationSource, type ObservationTimePrecision, type OpeningStateObservation, type OutdoorTemperatureSample, type Point, type Reading, type Sensor, type StaticParameter, type UnitSystem } from "@climate-twin/contracts";
import { ReplayControls } from "../../components/ReplayControls";
import { RoomComfortBoard } from "../../components/RoomComfortBoard";
import { MoistureCoach } from "../../components/MoistureCoach";
import { HomePulsePanel } from "../../components/HomePulsePanel";
import { HomeOperationsPreview } from "../../components/HomeOperationsPreview";
import "../../components/decisionLayer.css";
import "../OperationsPages.css";
import { formatInTimeZone } from "../../dateTime";
import { clamp, round, type ClimateState, type TimeRange, type ViewMode } from "../../domain";
import { useI18n, type TranslationKey } from "../../i18n";
import { definitionFor, displayUnit, enabledDefinitions, formatMeasurement, formatMeasurementDelta, measurementComparisonColor, measurementDomain, measurementLabel, measurementValue, samplesAt, type LatestMeasurements } from "../../measurements";
import { isEnergyDeviceSensor } from "../../energyDeviceMap";
import { configuredSpatialMaxSampleAgeMs, configuredSpatialReplayMaxSampleAgeMs, isSpatialSampleFresh } from "../../spatialFreshness";
import { createOutdoorBoundaryContext } from "../../outdoorContext";
import { useHouseWeather } from "../../useHouseWeather";
import type { OutdoorVisualizationState } from "../../components/OutdoorConditionsBadge";
import type { CreateHouseInput } from "../../components/StructureEditor";
import {
  simulateBuildingAirflow,
  simulateFloorAirflow,
  type BuildingAirflowEstimate,
  type ClimateSampleMatrix,
  type FloorAirflowEstimate,
} from "../../airflowSimulation";
import type { DataMode } from "../../useClimateData";
import { api, type MeasurementHistoryPage, type SensorPatch } from "../../api";
import { useSpatialLayers } from "../../useSpatialLayers";
import { SpatialLayerPanel } from "../../components/SpatialLayerPanel";
import {
  assessSensorCoverage,
  experimentalLayerSuggestions,
  type ExperimentalVisualizationId,
} from "../../experimentalSpatialLayers";
import { readLocalStorage, writeLocalStorage } from "../../browserStorage";
import { detectReplayClimateEvents, type ReplayClimateEvent } from "../../replayEvents";
import { openingStateCanChange, openingStateKey, openingStateObservationsForHouse } from "../../openingState";
import { integrationForHouse } from "../../integrationScope";
import { useConnectedDevicesQuery } from "../../data/connectedDevicesQuery";
import { queryClient } from "../../data/queryClient";
import { queryKeys } from "../../data/queryKeys";
import { BuildingScene, FloorPlan, HomeActivityTimeline, MeasurementGlyph, RoomComparisonChart, SensorInspector, SpatialLayerLab, StructureEditor, ThermalSimulationPanel, climateSensorLayerPreferenceKey, connectedDeviceLayerPreferenceKey, energyDeviceLayerPreferenceKey, experimentalVisualizationPreferenceKey, houseLocalDateTimeCandidates, initialClimateSensorLayerVisibility, initialConnectedDeviceLayerVisibility, initialEnergyDeviceLayerVisibility, initialExperimentalVisualizations, initialMapAnimationsEnabled, initialOpeningStateLabelsVisibility, initialOutdoorExtrasVisibility, initialOutdoorInfluenceMetric, localDateTimeValue, localDateValue, mapAnimationsPreferenceKey, mergeOpeningStateObservations, observationConfidences, observationKinds, observationSources, observationTimeFields, observationTimePrecisions, openingStateLabelsPreferenceKey, outdoorExtrasPreferenceKey, outdoorInfluenceMetricPreferenceKey, zonedDateTimeParts } from "./support";
import type { TwinDashboardProps } from "./support";
export function useTwinDashboardPart01(context: {
  props: TwinDashboardProps;
  range: TimeRange;
  setRange: (range: TimeRange) => void;
  meaningfulQueryState: boolean;
}) {
  const { props } = context;
  const { state, house, floor, houseId, floorId, metric, units, viewMode, selectedSensorId, scenario, connection = "live", dataMode = "unknown" } = props;
  const { locale, t } = useI18n();
  const scopedIntegration = useMemo(() => integrationForHouse(state.integration, houseId, Boolean(house.location)), [house.location, houseId, state.integration]);
  const sensorSourceHealthy = scopedIntegration.homeAssistant.connected || scopedIntegration.tpLink.connected;
  const [editing, setEditing] = useState(false);
  const [fullPage, setFullPage] = useState(false);
  const [liveMapOpen, setLiveMapOpen] = useState(context.meaningfulQueryState);
  const [historyOpen, setHistoryOpen] = useState(false);
  const [analysisOpen, setAnalysisOpen] = useState(false);
  useEffect(() => {
    if (context.meaningfulQueryState) setLiveMapOpen(true);
  }, [context.meaningfulQueryState]);
  const fullPagePanelRef = useRef<HTMLElement>(null);
  const fullPageTriggerRef = useRef<HTMLButtonElement>(null);
  const liveMapTriggerRef = useRef<HTMLButtonElement>(null);
  const pageHeadingRef = useRef<HTMLHeadingElement>(null);
  const readOnly = props.readOnly ?? false;
  const canManageConnectedDevices = props.canManageConnectedDevices ?? false;
  const localAuthority = props.localAuthority ?? true;
  const { range, setRange } = context;
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
  const [replayOutdoorSamples, setReplayOutdoorSamples] = useState<OutdoorTemperatureSample[]>([]);
  const [replayOutdoorLoading, setReplayOutdoorLoading] = useState(false);
  const [replayOutdoorPartial, setReplayOutdoorPartial] = useState(false);
  const [liveSpatialClockMs, setLiveSpatialClockMs] = useState(() => Date.now());
  const [experimentalVisualizations, setExperimentalVisualizations] = useState<ExperimentalVisualizationId[]>(initialExperimentalVisualizations);
  const [outdoorInfluenceMetric, setOutdoorInfluenceMetric] = useState(() => initialOutdoorInfluenceMetric(metric));
  const [climateSensorsVisible, setClimateSensorsVisible] = useState(initialClimateSensorLayerVisibility);
  const [energyDevicesVisible, setEnergyDevicesVisible] = useState(initialEnergyDeviceLayerVisibility);
  const [connectedDevicesVisible, setConnectedDevicesVisible] = useState(initialConnectedDeviceLayerVisibility);
  const [openingStateLabelsVisible, setOpeningStateLabelsVisible] = useState(initialOpeningStateLabelsVisibility);
  const [mapAnimationsEnabled, setMapAnimationsEnabled] = useState(initialMapAnimationsEnabled);
  const [outdoorExtrasVisible, setOutdoorExtrasVisible] = useState(initialOutdoorExtrasVisibility);
  const connectedDevicesQuery = useConnectedDevicesQuery(houseId, Boolean(scopedIntegration.tuya?.configured));
  const connectedDevices = connectedDevicesQuery.data ?? [];
  const [pendingConnectedDeviceIds, setPendingConnectedDeviceIds] = useState<ReadonlySet<string>>(new Set());
  const [connectedDeviceError, setConnectedDeviceError] = useState<string | null>(null);
  const [connectedDeviceAnnouncement, setConnectedDeviceAnnouncement] = useState("");
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
  const replayOutdoorBatchRef = useRef("");
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
  const cacheConnectedDevice = (next: ConnectedDeviceState) => {
      queryClient.setQueryData<ConnectedDeviceState[]>(
        queryKeys.connectedDevices(houseId),
        (current = []) => [next, ...current.filter((device) => device.connectionId !== next.connectionId)],
      );
    };
  const setConnectedDevicePending = (connectionId: string, value: boolean) => {
      setPendingConnectedDeviceIds((current) => {
        const next = new Set(current);
        if (value) next.add(connectionId);
        else next.delete(connectionId);
        return next;
      });
    };
  const changeConnectedDevicePower = async (connectionId: string, power: boolean) => {
      const device = connectedDevices.find((candidate) => candidate.connectionId === connectionId);
      if (!device || readOnly || !canManageConnectedDevices || !localAuthority
        || replayActive || pendingConnectedDeviceIds.has(connectionId)) return;
      setConnectedDevicePending(connectionId, true);
      setConnectedDeviceError(null);
      try {
        const result = await api.commandConnectedDevice(connectionId, {
          operationId: crypto.randomUUID(),
          power,
        });
        cacheConnectedDevice(result.state);
        setConnectedDeviceAnnouncement(t("twin.connectedDeviceChanged", {
          device: result.state.name,
          state: t(result.state.power ? "connectedDevice.state.on" : "connectedDevice.state.off"),
        }));
      } catch {
        setConnectedDeviceError(t("twin.connectedDeviceCommandFailed", { device: device.name }));
      } finally {
        setConnectedDevicePending(connectionId, false);
      }
    };
  const moveConnectedDevice = async (connectionId: string, point: Point) => {
      const device = connectedDevices.find((candidate) => candidate.connectionId === connectionId);
      if (!device || !device.floorId || readOnly || !canManageConnectedDevices
        || !localAuthority || replayActive || pendingConnectedDeviceIds.has(connectionId)) return;
      const targetFloor = house.floors.find((candidate) => candidate.id === device.floorId);
      if (!targetFloor) return;
      setConnectedDevicePending(connectionId, true);
      setConnectedDeviceError(null);
      try {
        const result = await api.placeConnectedDevice(connectionId, {
          floorId: targetFloor.id,
          roomId: null,
          x: clamp(point.x, 0, targetFloor.width),
          y: clamp(point.y, 0, targetFloor.height),
          z: device.z ?? targetFloor.elevation + 1.2,
        });
        if (result.state) cacheConnectedDevice(result.state);
        setConnectedDeviceAnnouncement(t("twin.connectedDeviceMoved", { device: device.name }));
      } catch {
        setConnectedDeviceError(t("twin.connectedDeviceMoveFailed", { device: device.name }));
      } finally {
        setConnectedDevicePending(connectionId, false);
      }
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
        const focusable = [...panel.querySelectorAll<HTMLElement>("summary, button:not([disabled]), select:not([disabled]), input:not([disabled]), textarea:not([disabled]), a[href], [tabindex]:not([tabindex='-1'])")]
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
        window.requestAnimationFrame(() => {
          const trigger = fullPageTriggerRef.current;
          const disclosure = trigger?.closest<HTMLDetailsElement>("details");
          if (disclosure && !disclosure.open) disclosure.querySelector<HTMLElement>("summary")?.focus();
          else trigger?.focus();
        });
      };
    }, [fullPage]);
  useEffect(() => {
      writeLocalStorage(experimentalVisualizationPreferenceKey, JSON.stringify(experimentalVisualizations));
    }, [experimentalVisualizations]);
  useEffect(() => {
      writeLocalStorage(outdoorInfluenceMetricPreferenceKey, outdoorInfluenceMetric);
    }, [outdoorInfluenceMetric]);
  useEffect(() => {
      writeLocalStorage(climateSensorLayerPreferenceKey, String(climateSensorsVisible));
    }, [climateSensorsVisible]);
  useEffect(() => {
      writeLocalStorage(energyDeviceLayerPreferenceKey, String(energyDevicesVisible));
    }, [energyDevicesVisible]);
  useEffect(() => {
      writeLocalStorage(connectedDeviceLayerPreferenceKey, String(connectedDevicesVisible));
    }, [connectedDevicesVisible]);
  useEffect(() => {
      writeLocalStorage(openingStateLabelsPreferenceKey, String(openingStateLabelsVisible));
    }, [openingStateLabelsVisible]);
  useEffect(() => {
      writeLocalStorage(mapAnimationsPreferenceKey, String(mapAnimationsEnabled));
    }, [mapAnimationsEnabled]);
  useEffect(() => {
      writeLocalStorage(outdoorExtrasPreferenceKey, String(outdoorExtrasVisible));
    }, [outdoorExtrasVisible]);
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
      setPendingConnectedDeviceIds(new Set());
      setConnectedDeviceError(null);
      setConnectedDeviceAnnouncement("");
    }, [houseId]);
  return Object.assign(context, { state, house, floor, houseId, floorId, metric, units, viewMode, selectedSensorId, scenario, connection, dataMode, locale, t, scopedIntegration, sensorSourceHealthy, editing, setEditing, fullPage, setFullPage, liveMapOpen, setLiveMapOpen, historyOpen, setHistoryOpen, analysisOpen, setAnalysisOpen, fullPagePanelRef, fullPageTriggerRef, liveMapTriggerRef, pageHeadingRef, readOnly, canManageConnectedDevices, localAuthority, range, setRange, replayActive, setReplayActive, replayPlaying, setReplayPlaying, replayStartPending, setReplayStartPending, replayPrepared, setReplayPrepared, replaySpeed, setReplaySpeed, replayWindowFrom, setReplayWindowFrom, replayWindowTo, setReplayWindowTo, replayResolutionSeconds, setReplayResolutionSeconds, replayRequestedBounds, setReplayRequestedBounds, replayLoadState, setReplayLoadState, replayLoadError, setReplayLoadError, replayLoadPartial, setReplayLoadPartial, replaySampleCount, setReplaySampleCount, replayOutdoorSamples, setReplayOutdoorSamples, replayOutdoorLoading, setReplayOutdoorLoading, replayOutdoorPartial, setReplayOutdoorPartial, liveSpatialClockMs, setLiveSpatialClockMs, experimentalVisualizations, setExperimentalVisualizations, outdoorInfluenceMetric, setOutdoorInfluenceMetric, climateSensorsVisible, setClimateSensorsVisible, energyDevicesVisible, setEnergyDevicesVisible, connectedDevicesVisible, setConnectedDevicesVisible, openingStateLabelsVisible, setOpeningStateLabelsVisible, connectedDevices, pendingConnectedDeviceIds, connectedDeviceError, connectedDeviceAnnouncement, changeConnectedDevicePower, moveConnectedDevice, mapAnimationsEnabled, setMapAnimationsEnabled, outdoorExtrasVisible, setOutdoorExtrasVisible, observationPlacement, setObservationPlacement, observationKind, setObservationKind, observationSeverity, setObservationSeverity, observationNote, setObservationNote, observationTimePrecision, setObservationTimePrecision, observationDateTime, setObservationDateTime, observationDate, setObservationDate, observationValidFrom, setObservationValidFrom, observationValidTo, setObservationValidTo, observationSource, setObservationSource, observationSourceDetail, setObservationSourceDetail, observationConfidence, setObservationConfidence, observationDraft, setObservationDraft, observationValidationError, setObservationValidationError, observationStatus, setObservationStatus, observationError, setObservationError, parameterLabel, setParameterLabel, parameterValue, setParameterValue, parameterUnit, setParameterUnit, parameterPending, setParameterPending, parameterFeedback, setParameterFeedback, replayBatchRef, replayPreparationBatchRef, airflowReplayBatchRef, inspectorReplayBatchRef, replayWindowRequestRef, replayOutdoorBatchRef, previousReplayActiveRef, effectSeriesLoadsRef, loadSeriesOnce });
}
