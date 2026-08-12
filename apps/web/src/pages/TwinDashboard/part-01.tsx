import { lazy, Suspense, useCallback, useEffect, useMemo, useRef, useState, type FormEvent, type SetStateAction } from "react";
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
import { createClientUuid } from "../../clientUuid";
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
import type { HeatPumpState } from "@climate-twin/contracts";
import { useHeatPumpsQuery } from "../../data/heatPumpsQuery";
import { heatPumpSensorId } from "../../heatPumpPresentation";
import { heatPumpInfluencePreferenceKey, initialHeatPumpInfluenceVisibility } from "./support";
import { BuildingScene, FloorPlan, HomeActivityTimeline, MeasurementGlyph, RoomComparisonChart, SensorInspector, SpatialLayerLab, StructureEditor, ThermalSimulationPanel, climateSensorLayerPreferenceKey, connectedDeviceLayerPreferenceKey, energyDeviceLayerPreferenceKey, experimentalVisualizationPreferenceKey, houseLocalDateTimeCandidates, initialClimateSensorLayerVisibility, initialConnectedDeviceLayerVisibility, initialEnergyDeviceLayerVisibility, initialExperimentalVisualizations, initialMapAnimationsEnabled, initialOpeningStateLabelsVisibility, initialOutdoorExtrasVisibility, initialOutdoorInfluenceMetric, localDateTimeValue, localDateValue, mapAnimationsPreferenceKey, mergeOpeningStateObservations, observationConfidences, observationKinds, observationSources, observationTimeFields, observationTimePrecisions, openingStateLabelsPreferenceKey, outdoorExtrasPreferenceKey, outdoorInfluenceMetricPreferenceKey, zonedDateTimeParts } from "./support";
import type { TwinDashboardProps } from "./support";
import type { TwinDashboardHomeView } from "./queryState";
export function useTwinDashboardPart01(context: {
  props: TwinDashboardProps;
  range: TimeRange;
  setRange: (range: TimeRange) => void;
  meaningfulQueryState: boolean;
  homeView: TwinDashboardHomeView;
  setHomeView: (homeView: TwinDashboardHomeView, mode?: "push" | "replace") => void;
}) {
  const { props } = context;
  const { state, house, floor, houseId, floorId, metric, units, viewMode, selectedSensorId, scenario, connection = "live", dataMode = "unknown" } = props;
  const { locale, t } = useI18n();
  const scopedIntegration = useMemo(() => integrationForHouse(state.integration, houseId, Boolean(house.location)), [house.location, houseId, state.integration]);
  const sensorSourceHealthy = scopedIntegration.homeAssistant.connected || scopedIntegration.tpLink.connected;
  const readOnly = props.readOnly ?? false;
  const editing = context.homeView === "edit" && !readOnly;
  const fullPage = context.homeView === "full";
  const liveMapOpen = context.homeView === "auto"
    ? context.meaningfulQueryState
    : context.homeView !== "summary";
  const nextBoolean = (next: SetStateAction<boolean>, current: boolean) => (
    typeof next === "function" ? next(current) : next
  );
  const setEditing = (next: SetStateAction<boolean>) => {
    const enabled = nextBoolean(next, editing);
    if (enabled === editing) return;
    context.setHomeView(enabled ? "edit" : "live");
  };
  const setFullPage = (next: SetStateAction<boolean>) => {
    const enabled = nextBoolean(next, fullPage);
    if (enabled === fullPage) return;
    context.setHomeView(enabled ? "full" : "live");
  };
  const setLiveMapOpen = (next: SetStateAction<boolean>) => {
    const enabled = nextBoolean(next, liveMapOpen);
    if (enabled === liveMapOpen) return;
    context.setHomeView(enabled ? "live" : "summary");
  };
  const [historyOpen, setHistoryOpen] = useState(false);
  const [analysisOpen, setAnalysisOpen] = useState(false);
  useEffect(() => {
    if (context.homeView === "edit" && readOnly) context.setHomeView("live", "replace");
  }, [context.homeView, readOnly]);
  const fullPagePanelRef = useRef<HTMLElement>(null);
  const fullPageTriggerRef = useRef<HTMLButtonElement>(null);
  const liveMapTriggerRef = useRef<HTMLButtonElement>(null);
  const pageHeadingRef = useRef<HTMLHeadingElement>(null);
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
  const [heatPumpInfluenceVisible, setHeatPumpInfluenceVisible] = useState(initialHeatPumpInfluenceVisibility);
  const [openingStateLabelsVisible, setOpeningStateLabelsVisible] = useState(initialOpeningStateLabelsVisibility);
  const [mapAnimationsEnabled, setMapAnimationsEnabled] = useState(initialMapAnimationsEnabled);
  const [outdoorExtrasVisible, setOutdoorExtrasVisible] = useState(initialOutdoorExtrasVisibility);
  const connectedDevicesQuery = useConnectedDevicesQuery(houseId, Boolean(scopedIntegration.tuya?.configured));
  const connectedDevices = connectedDevicesQuery.data ?? [];
  const heatPumpsQuery = useHeatPumpsQuery(houseId, Boolean(scopedIntegration.gree?.configured));
  const heatPumps = heatPumpsQuery.data ?? [];
  const [selectedHeatPumpId, setSelectedHeatPumpId] = useState<string | null>(null);
  const selectedHeatPump = heatPumps.find((candidate) => (
      candidate.connectionId === selectedHeatPumpId
      || heatPumpSensorId(candidate.connectionId) === selectedSensorId
    )) ?? null;
  const [pendingHeatPumpIds, setPendingHeatPumpIds] = useState<ReadonlySet<string>>(new Set());
  const [heatPumpError, setHeatPumpError] = useState<string | null>(null);
  const [heatPumpAnnouncement, setHeatPumpAnnouncement] = useState("");
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
  const replayWindowControllerRef = useRef<AbortController | null>(null);
  const replayOutdoorBatchRef = useRef("");
  const previousReplayActiveRef = useRef(replayActive);
  const effectSeriesLoadsRef = useRef({
      keys: new Set<string>(),
      controllers: new globalThis.Map<string, AbortController>(),
    });
  useEffect(() => () => {
      effectSeriesLoadsRef.current.controllers.forEach((controller) => controller.abort());
      effectSeriesLoadsRef.current.controllers.clear();
      effectSeriesLoadsRef.current.keys.clear();
  }, [houseId, props.onLoadSeries, range]);
  useEffect(() => {
    setReplayLoadState("idle");
    return () => {
      replayWindowControllerRef.current?.abort();
      replayWindowControllerRef.current = null;
    };
  }, [houseId, props.onLoadReplaySeries]);
  const loadSeriesOnce = useCallback((sensorId: string, candidate: MeasurementDefinition) => {
      const key = `${houseId}:${range}:${sensorId}:${candidate.id}`;
      if (effectSeriesLoadsRef.current.keys.has(key)) return;
      const seriesKey = `${sensorId}\u0000${candidate.id}`;
      effectSeriesLoadsRef.current.controllers.get(seriesKey)?.abort();
      const controller = new AbortController();
      effectSeriesLoadsRef.current.keys.add(key);
      effectSeriesLoadsRef.current.controllers.set(seriesKey, controller);
      try {
        props.onLoadSeries(sensorId, candidate.id, range, candidate.forecastSupported, controller.signal);
      } catch (error) {
        controller.abort();
        if (effectSeriesLoadsRef.current.controllers.get(seriesKey) === controller) {
          effectSeriesLoadsRef.current.controllers.delete(seriesKey);
        }
        effectSeriesLoadsRef.current.keys.delete(key);
        throw error;
      }
    }, [houseId, props.onLoadSeries, range]);
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
          operationId: createClientUuid(),
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
  const heatPumpName = (state: HeatPumpState) => (
      state.name ?? ([state.brand, state.model].filter(Boolean).join(" ") || "Gree/Wilfa")
    );
  const cacheHeatPump = (next: HeatPumpState) => {
      queryClient.setQueryData<HeatPumpState[]>(
        queryKeys.heatPumps(houseId),
        (current = []) => [next, ...current.filter((state) => state.connectionId !== next.connectionId)],
      );
    };
  const setHeatPumpPending = (connectionId: string, value: boolean) => {
      setPendingHeatPumpIds((current) => {
        const next = new Set(current);
        if (value) next.add(connectionId);
        else next.delete(connectionId);
        return next;
      });
    };
  const saveHeatPumpPlacement = async (
      state: HeatPumpState,
      targetFloor: Floor,
      point: Point,
    ) => {
      if (readOnly || !canManageConnectedDevices || !localAuthority || replayActive
        || pendingHeatPumpIds.has(state.connectionId)) return;
      setHeatPumpPending(state.connectionId, true);
      setHeatPumpError(null);
      try {
        const result = await api.placeHeatPump(state.connectionId, {
          floorId: targetFloor.id,
          roomId: null,
          x: clamp(point.x, 0, targetFloor.width),
          y: clamp(point.y, 0, targetFloor.height),
          z: state.z ?? targetFloor.elevation + Math.max(1.8, (targetFloor.ceilingHeight ?? 2.4) - .35),
        });
        if (result.state) cacheHeatPump(result.state);
        setHeatPumpAnnouncement(t("twin.heatPumpMoved", { device: heatPumpName(state) }));
      } catch {
        setHeatPumpError(t("twin.heatPumpMoveFailed", { device: heatPumpName(state) }));
      } finally {
        setHeatPumpPending(state.connectionId, false);
      }
    };
  const placeHeatPumpOnFloor = (connectionId: string) => {
      const state = heatPumps.find((candidate) => candidate.connectionId === connectionId);
      if (!state) return;
      void saveHeatPumpPlacement(state, floor, {
        x: floor.width / 2,
        y: Math.min(.25, floor.height / 2),
      });
    };
  const moveHeatPump = (connectionId: string, point: Point) => {
      const state = heatPumps.find((candidate) => candidate.connectionId === connectionId);
      if (!state?.floorId) return;
      const targetFloor = house.floors.find((candidate) => candidate.id === state.floorId);
      if (targetFloor) void saveHeatPumpPlacement(state, targetFloor, point);
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
      writeLocalStorage(heatPumpInfluencePreferenceKey, String(heatPumpInfluenceVisible));
    }, [heatPumpInfluenceVisible]);
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
  useEffect(() => {
      setPendingHeatPumpIds(new Set());
      setHeatPumpError(null);
      setHeatPumpAnnouncement("");
      setSelectedHeatPumpId(null);
    }, [houseId]);
  const heatPumpContext = Object.assign(context, { heatPumps, selectedHeatPump, selectedHeatPumpId, setSelectedHeatPumpId, heatPumpInfluenceVisible, setHeatPumpInfluenceVisible, pendingHeatPumpIds, heatPumpError, heatPumpAnnouncement, placeHeatPumpOnFloor, moveHeatPump });
  return Object.assign(heatPumpContext, { state, house, floor, houseId, floorId, metric, units, viewMode, selectedSensorId, scenario, connection, dataMode, locale, t, scopedIntegration, sensorSourceHealthy, editing, setEditing, fullPage, setFullPage, liveMapOpen, setLiveMapOpen, historyOpen, setHistoryOpen, analysisOpen, setAnalysisOpen, fullPagePanelRef, fullPageTriggerRef, liveMapTriggerRef, pageHeadingRef, readOnly, canManageConnectedDevices, localAuthority, range, setRange, replayActive, setReplayActive, replayPlaying, setReplayPlaying, replayStartPending, setReplayStartPending, replayPrepared, setReplayPrepared, replaySpeed, setReplaySpeed, replayWindowFrom, setReplayWindowFrom, replayWindowTo, setReplayWindowTo, replayResolutionSeconds, setReplayResolutionSeconds, replayRequestedBounds, setReplayRequestedBounds, replayLoadState, setReplayLoadState, replayLoadError, setReplayLoadError, replayLoadPartial, setReplayLoadPartial, replaySampleCount, setReplaySampleCount, replayOutdoorSamples, setReplayOutdoorSamples, replayOutdoorLoading, setReplayOutdoorLoading, replayOutdoorPartial, setReplayOutdoorPartial, liveSpatialClockMs, setLiveSpatialClockMs, experimentalVisualizations, setExperimentalVisualizations, outdoorInfluenceMetric, setOutdoorInfluenceMetric, climateSensorsVisible, setClimateSensorsVisible, energyDevicesVisible, setEnergyDevicesVisible, connectedDevicesVisible, setConnectedDevicesVisible, openingStateLabelsVisible, setOpeningStateLabelsVisible, connectedDevices, pendingConnectedDeviceIds, connectedDeviceError, connectedDeviceAnnouncement, changeConnectedDevicePower, moveConnectedDevice, mapAnimationsEnabled, setMapAnimationsEnabled, outdoorExtrasVisible, setOutdoorExtrasVisible, observationPlacement, setObservationPlacement, observationKind, setObservationKind, observationSeverity, setObservationSeverity, observationNote, setObservationNote, observationTimePrecision, setObservationTimePrecision, observationDateTime, setObservationDateTime, observationDate, setObservationDate, observationValidFrom, setObservationValidFrom, observationValidTo, setObservationValidTo, observationSource, setObservationSource, observationSourceDetail, setObservationSourceDetail, observationConfidence, setObservationConfidence, observationDraft, setObservationDraft, observationValidationError, setObservationValidationError, observationStatus, setObservationStatus, observationError, setObservationError, parameterLabel, setParameterLabel, parameterValue, setParameterValue, parameterUnit, setParameterUnit, parameterPending, setParameterPending, parameterFeedback, setParameterFeedback, replayBatchRef, replayPreparationBatchRef, airflowReplayBatchRef, inspectorReplayBatchRef, replayWindowRequestRef, replayWindowControllerRef, replayOutdoorBatchRef, previousReplayActiveRef, effectSeriesLoadsRef, loadSeriesOnce });
}
