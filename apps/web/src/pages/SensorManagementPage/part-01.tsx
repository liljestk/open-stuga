import {
  lazy,
  Suspense,
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
  type FormEvent,
  type KeyboardEvent,
  type PointerEvent as ReactPointerEvent,
} from "react";
import {
  Archive,
  Check,
  ChevronDown,
  ChevronLeft,
  ChevronRight,
  CircleDot,
  Copy,
  Database,
  Edit3,
  FileSpreadsheet,
  Home,
  LoaderCircle,
  MapPin,
  Plus,
  Printer,
  QrCode,
  RadioTower,
  RefreshCw,
  RotateCcw,
  Search,
  Sparkles,
  ThermometerSun,
  Trash2,
  TriangleAlert,
  X,
} from "lucide-react";
import type {
  Floor,
  House,
  IntegrationStatus,
  MeasurementSample,
  Metric,
  Sensor,
  SensorLabelDescriptor,
  TpLinkDiscoveredDevice,
  UnitSystem,
} from "@climate-twin/contracts";
import { api, type CreateSensorInput, type HistoricalImportResult, type SensorPatch } from "../../api";
import type { ClimateState, TimeRange } from "../../domain";
import { useI18n, type TranslationKey } from "../../i18n";
import { formatInTimeZone } from "../../dateTime";
import { measurementLabel } from "../../measurements";
import { useNow } from "../../useNow";
import { integrationForHouse } from "../../integrationScope";
import { assessSensorCoverage, suggestSensorPlacement, type SensorCoverageAssessment, type SensorPlacementSuggestion } from "../../experimentalSpatialLayers";
import { configuredSpatialMaxSampleAgeMs } from "../../spatialFreshness";
import { useSpatialLayers } from "../../useSpatialLayers";
import { qrCodeMatrix } from "../../qrCode";
import { TrendChart } from "../../components/TrendChart";
import { HistoricalImportWizard, PlacementPicker, SensorLabelCard, UNPLACED_TAG, availableForSensor, clamp, deviceBindingKey, draftContext, draftForSensor, errorMessage, hasHomeAssistantBinding, hasRealBinding, initialDraft, isDemoSensor, isLive, isUnplaced, latestSensorTimestamp, mergeMetricSamples, normalizedMeasurementEntityIds, roomCenter, rounded, sameMeasurementEntityIds, sensorFloor, sensorHasMetric, sensorMeasurementEntityIds, sensorStatus, stableRoomId, tpLinkDeviceSummary, validationErrors } from "./support";
import type { AddStep, DraftErrors, DraftSource, EditorMode, Feedback, SensorDraft, SensorFilter, SensorManagementPageProps, SensorStatus, Translate } from "./support";
export function useSensorManagementPagePart01(context: { state: SensorManagementPageProps["state"]; house: SensorManagementPageProps["house"]; houses: SensorManagementPageProps["houses"]; integration: SensorManagementPageProps["integration"]; tpLinkDevices: SensorManagementPageProps["tpLinkDevices"]; tpLinkDevicesLoading: SensorManagementPageProps["tpLinkDevicesLoading"]; tpLinkDevicesError: SensorManagementPageProps["tpLinkDevicesError"]; requestedDevice: Exclude<SensorManagementPageProps["requestedDevice"], undefined>; requestedDeviceId: Exclude<SensorManagementPageProps["requestedDeviceId"], undefined>; readOnly: Exclude<SensorManagementPageProps["readOnly"], undefined>; localAuthority: Exclude<SensorManagementPageProps["localAuthority"], undefined>; units: Exclude<SensorManagementPageProps["units"], undefined>; onRequestedDeviceHandled: SensorManagementPageProps["onRequestedDeviceHandled"]; onLoadSeries: SensorManagementPageProps["onLoadSeries"]; onHouse: SensorManagementPageProps["onHouse"]; onRefreshDevices: SensorManagementPageProps["onRefreshDevices"]; onCreateSensor: SensorManagementPageProps["onCreateSensor"]; onUpdateSensor: SensorManagementPageProps["onUpdateSensor"]; onDeleteSensor: SensorManagementPageProps["onDeleteSensor"]; onImportHistoricalData: SensorManagementPageProps["onImportHistoricalData"] }) {
  const { state, house, houses, integration, tpLinkDevices, tpLinkDevicesLoading, tpLinkDevicesError, requestedDevice, requestedDeviceId, readOnly, localAuthority, units, onRequestedDeviceHandled, onLoadSeries, onHouse, onRefreshDevices, onCreateSensor, onUpdateSensor, onDeleteSensor, onImportHistoricalData } = context;
  const { locale, t } = useI18n();
  const now = useNow();
  const tpLinkStatus = useMemo(
      () => integrationForHouse(integration, house.id).tpLink,
      [house.id, integration],
    );
  const formId = useId().replace(/:/g, "");
  const pageHeadingRef = useRef<HTMLHeadingElement>(null);
  const editorHeadingRef = useRef<HTMLHeadingElement>(null);
  const editorOpenerRef = useRef<HTMLElement | null>(null);
  const importButtonRef = useRef<HTMLButtonElement>(null);
  const detailsHeadingRef = useRef<HTMLHeadingElement>(null);
  const detailsOpenerRef = useRef<HTMLElement | null>(null);
  const detailsRequestGeneration = useRef(0);
  const [search, setSearch] = useState("");
  const [filter, setFilter] = useState<SensorFilter>("all");
  const [mode, setMode] = useState<EditorMode>("closed");
  const [addStep, setAddStep] = useState<AddStep>(1);
  const [editingSensorId, setEditingSensorId] = useState<string | null>(null);
  const [attachSensorId, setAttachSensorId] = useState("");
  const [draft, setDraft] = useState<SensorDraft>(() => initialDraft(house));
  const [errors, setErrors] = useState<DraftErrors>({});
  const [editorFeedback, setEditorFeedback] = useState<Feedback>(null);
  const [pageFeedback, setPageFeedback] = useState<Feedback>(null);
  const [submitting, setSubmitting] = useState(false);
  const [rowBusyId, setRowBusyId] = useState<string | null>(null);
  const [cleanupBusy, setCleanupBusy] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  const [refreshError, setRefreshError] = useState<string | null>(null);
  const [importOpen, setImportOpen] = useState(false);
  const [detailsSensor, setDetailsSensor] = useState<Sensor | null>(null);
  const [detailSamples, setDetailSamples] = useState<MeasurementSample[]>([]);
  const [detailCursor, setDetailCursor] = useState<string | null>(null);
  const [detailsLoading, setDetailsLoading] = useState(false);
  const [detailsError, setDetailsError] = useState<string | null>(null);
  const [detailMetric, setDetailMetric] = useState<Metric>("temperature");
  const [detailRange, setDetailRange] = useState<TimeRange>("24h");
  const currentSensors = useMemo(
      () => state.sensors.filter((sensor) => sensor.houseId === house.id),
      [state.sensors, house.id],
    );
  const currentSensorIds = useMemo(
      () => new Set(currentSensors.map((sensor) => sensor.id)),
      [currentSensors],
    );
  const visibleDetailsSensor = detailsSensor && currentSensorIds.has(detailsSensor.id)
      ? currentSensors.find((sensor) => sensor.id === detailsSensor.id) ?? null
      : null;
  const demoSensors = useMemo(() => currentSensors.filter(isDemoSensor), [currentSensors]);
  const hasExistingRealBoundSensor = useMemo(
      () => currentSensors.some((sensor) => !isDemoSensor(sensor) && hasRealBinding(sensor)),
      [currentSensors],
    );
  const enabledMeasurementDefinitions = useMemo(
      () => state.measurementDefinitions.filter((definition) => definition.enabled),
      [state.measurementDefinitions],
    );
  const detailDefinitions = useMemo(() => {
      if (!visibleDetailsSensor) return enabledMeasurementDefinitions;
      const available = enabledMeasurementDefinitions.filter((definition) => (
        sensorHasMetric(state, visibleDetailsSensor, definition.id)
        || detailSamples.some((sample) => sample.metric === definition.id)
      ));
      return available.length > 0 ? available : enabledMeasurementDefinitions;
    }, [detailSamples, enabledMeasurementDefinitions, state, visibleDetailsSensor]);
  const detailDefinition = detailDefinitions.find((definition) => definition.id === detailMetric) ?? detailDefinitions[0];
  const detailHistory = useMemo(() => visibleDetailsSensor && detailDefinition
      ? mergeMetricSamples(
        state.measurementHistory[visibleDetailsSensor.id]?.[detailDefinition.id] ?? [],
        detailSamples.filter((sample) => sample.metric === detailDefinition.id),
        [state.latestMeasurements[visibleDetailsSensor.id]?.[detailDefinition.id]].filter(Boolean) as MeasurementSample[],
      )
      : [], [detailDefinition, detailSamples, state.latestMeasurements, state.measurementHistory, visibleDetailsSensor]);
  const usedDeviceIds = useMemo(
      () => new Set(state.sensors.flatMap((sensor) => sensor.tpLinkDeviceId
        ? [deviceBindingKey(sensor.tpLinkDeviceId, sensor.tpLinkConnectionId)] : [])),
      [state.sensors],
    );
  const homeTpLinkDevices = useMemo(
      () => tpLinkDevices.filter((device) => device.houseId === house.id),
      [house.id, tpLinkDevices],
    );
  const addableDevices = useMemo(
      () => homeTpLinkDevices.filter((device) => availableForSensor(device, null, usedDeviceIds)),
      [homeTpLinkDevices, usedDeviceIds],
    );
  const attachableSensors = useMemo(
      () => currentSensors.filter((sensor) => sensor.enabled && !sensor.tpLinkDeviceId && hasHomeAssistantBinding(sensor)),
      [currentSensors],
    );
  const sensorStatuses = useMemo(
      () => new Map(currentSensors.map((sensor) => [sensor.id, sensorStatus(state, sensor, houses, now)])),
      [currentSensors, houses, now, state],
    );
  const statusCounts = useMemo(() => {
      const counts: Record<SensorStatus, number> = { waiting: 0, unplaced: 0, live: 0, archived: 0 };
      for (const status of sensorStatuses.values()) counts[status] += 1;
      return counts;
    }, [sensorStatuses]);
  const normalizedSearch = search.trim().toLocaleLowerCase(locale);
  const visibleSensors = useMemo(() => currentSensors.filter((sensor) => {
      const matchesSearch = !normalizedSearch || [sensor.name, sensor.room, sensor.model, sensor.id, sensor.tpLinkDeviceId ?? ""]
        .some((value) => value.toLocaleLowerCase(locale).includes(normalizedSearch));
      if (!matchesSearch) return false;
      if (filter !== "all") return sensorStatuses.get(sensor.id) === filter;
      return true;
    }), [currentSensors, filter, locale, normalizedSearch, sensorStatuses]);
  const { house: draftHouse, floor: draftFloor } = draftContext(draft, houses);
  const editingSensor = editingSensorId ? state.sensors.find((sensor) => sensor.id === editingSensorId) ?? null : null;
  const selectableDevices = tpLinkDevices.filter((device) => device.houseId === draft.houseId
      && availableForSensor(device, editingSensorId, usedDeviceIds));
  const currentBindingMissing = Boolean(draft.deviceId && !selectableDevices.some((device) => device.deviceId === draft.deviceId
      && (device.connectionId ?? "") === draft.connectionId));
  const draftDevice = draft.deviceId ? tpLinkDevices.find((device) => device.deviceId === draft.deviceId
      && (device.connectionId ?? "") === draft.connectionId) : undefined;
  const energyOnlyDraft = Boolean(draftDevice
      && (typeof draftDevice.power === "number" || typeof draftDevice.energy === "number")
      && typeof draftDevice.temperature !== "number"
      && typeof draftDevice.humidity !== "number");
  const placementAnalysisEnabled = !energyOnlyDraft && (mode === "edit" || (mode === "add" && addStep === 3));
  const placementLayerScope = useMemo(() => placementAnalysisEnabled && draftHouse
      ? { kind: "house" as const, id: draftHouse.id }
      : null, [draftHouse?.id, placementAnalysisEnabled]);
  const placementLayers = useSpatialLayers({
      scope: placementLayerScope,
      enabled: placementAnalysisEnabled,
    });
  const placementCoverage = useMemo<SensorCoverageAssessment | null>(() => {
      if (!placementAnalysisEnabled || !draftHouse) return null;
      const sensors = state.sensors.filter((sensor) => sensor.houseId === draftHouse.id
        && sensor.id !== editingSensorId
        && !isUnplaced(sensor, houses));
      return assessSensorCoverage({
        house: draftHouse,
        sensors,
        samples: state.latestMeasurements,
        freshness: { referenceTimeMs: now, maxSampleAgeMs: configuredSpatialMaxSampleAgeMs() },
      });
    }, [draftHouse, editingSensorId, houses, now, placementAnalysisEnabled, state.latestMeasurements, state.sensors]);
  const placementSuggestion = useMemo<SensorPlacementSuggestion | null>(() => {
      if (!draftFloor || !placementCoverage) return null;
      const currentSnapshots = placementLayers.snapshots.filter((snapshot) => !placementLayers.staleLayerIds.includes(snapshot.layerId));
      return suggestSensorPlacement({
        floor: draftFloor,
        roomName: draft.room,
        coverage: placementCoverage,
        spatialSnapshots: currentSnapshots,
      });
    }, [draft.room, draftFloor, placementCoverage, placementLayers.snapshots, placementLayers.staleLayerIds]);
  useEffect(() => {
      if (mode !== "closed") return;
      setDraft(initialDraft(house));
    }, [house.id, mode]);
  return Object.assign(context, { locale, t, now, tpLinkStatus, formId, pageHeadingRef, editorHeadingRef, editorOpenerRef, importButtonRef, detailsHeadingRef, detailsOpenerRef, detailsRequestGeneration, search, setSearch, filter, setFilter, mode, setMode, addStep, setAddStep, editingSensorId, setEditingSensorId, attachSensorId, setAttachSensorId, draft, setDraft, errors, setErrors, editorFeedback, setEditorFeedback, pageFeedback, setPageFeedback, submitting, setSubmitting, rowBusyId, setRowBusyId, cleanupBusy, setCleanupBusy, refreshing, setRefreshing, refreshError, setRefreshError, importOpen, setImportOpen, detailsSensor, setDetailsSensor, detailSamples, setDetailSamples, detailCursor, setDetailCursor, detailsLoading, setDetailsLoading, detailsError, setDetailsError, detailMetric, setDetailMetric, detailRange, setDetailRange, currentSensors, currentSensorIds, visibleDetailsSensor, demoSensors, hasExistingRealBoundSensor, enabledMeasurementDefinitions, detailDefinitions, detailDefinition, detailHistory, usedDeviceIds, homeTpLinkDevices, addableDevices, attachableSensors, sensorStatuses, statusCounts, normalizedSearch, visibleSensors, draftHouse, draftFloor, editingSensor, selectableDevices, currentBindingMissing, draftDevice, energyOnlyDraft, placementAnalysisEnabled, placementLayerScope, placementLayers, placementCoverage, placementSuggestion });
}