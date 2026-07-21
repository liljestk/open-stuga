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
import { api, type CreateSensorInput, type HistoricalImportResult, type SensorPatch } from "../api";
import type { ClimateState, TimeRange } from "../domain";
import { useI18n, type TranslationKey } from "../i18n";
import { formatInTimeZone } from "../dateTime";
import { measurementLabel } from "../measurements";
import { useNow } from "../useNow";
import { integrationForHouse } from "../integrationScope";
import { assessSensorCoverage, suggestSensorPlacement, type SensorCoverageAssessment, type SensorPlacementSuggestion } from "../experimentalSpatialLayers";
import { configuredSpatialMaxSampleAgeMs } from "../spatialFreshness";
import { useSpatialLayers } from "../useSpatialLayers";
import { qrCodeMatrix } from "../qrCode";
import { TrendChart } from "../components/TrendChart";

const HistoricalImportWizard = lazy(() => import("../components/HistoricalImportWizard")
  .then((module) => ({ default: module.HistoricalImportWizard })));

export interface SensorManagementPageProps {
  state: ClimateState;
  house: House;
  houses: House[];
  integration: IntegrationStatus;
  tpLinkDevices: TpLinkDiscoveredDevice[];
  tpLinkDevicesLoading: boolean;
  tpLinkDevicesError: string | null;
  requestedDevice?: { deviceId: string; connectionId: string | null } | null;
  /** Compatibility for older embedders; ambiguous across multiple connections. */
  requestedDeviceId?: string | null;
  readOnly?: boolean;
  units?: UnitSystem;
  onRequestedDeviceHandled?: () => void;
  onLoadSeries?: (sensorId: string, metric: Metric, range: TimeRange, forecastSupported: boolean) => void;
  onHouse: (houseId: string) => void;
  onRefreshDevices: () => Promise<void>;
  onCreateSensor: (sensor: CreateSensorInput) => Promise<Sensor>;
  onUpdateSensor: (sensorId: string, patch: SensorPatch) => Promise<Sensor>;
  onDeleteSensor: (sensorId: string) => Promise<void>;
  onImportHistoricalData: (
    samples: MeasurementSample[],
    onProgress: (completed: number, total: number) => void,
  ) => Promise<HistoricalImportResult>;
}

type EditorMode = "closed" | "add" | "edit";
type AddStep = 1 | 2 | 3 | 4;
type SensorFilter = "all" | "live" | "waiting" | "unplaced" | "archived";
type SensorStatus = Exclude<SensorFilter, "all">;
type DraftSource = "tp-link" | "manual";

interface SensorDraft {
  source: DraftSource;
  deviceId: string;
  connectionId: string;
  name: string;
  model: string;
  houseId: string;
  floorId: string;
  room: string;
  x: string;
  y: string;
  height: string;
  enabled: boolean;
  measurementEntityIds: Record<string, string>;
}

type DraftErrors = Partial<Record<"source" | "name" | "model" | "house" | "floor" | "room" | "x" | "y" | "height", string>>;
type Feedback = { kind: "success" | "error"; message: string } | null;
type Translate = (key: TranslationKey, values?: Record<string, string | number>) => string;

const UNPLACED_TAG = "unplaced";

function clamp(value: number, minimum: number, maximum: number): number {
  return Math.min(maximum, Math.max(minimum, value));
}

function rounded(value: number): number {
  return Number(value.toFixed(2));
}

function tpLinkDeviceSummary(device: TpLinkDiscoveredDevice, t: Translate, locale: string): string {
  const hasPower = typeof device.power === "number" && Number.isFinite(device.power);
  const hasEnergy = typeof device.energy === "number" && Number.isFinite(device.energy);
  const kind = hasPower || hasEnergy ? t("sensors.energyEndpoint") : t("sensors.climateDevice");
  const number = new Intl.NumberFormat(locale, { maximumFractionDigits: 3 });
  return [
    device.model,
    kind,
    device.deviceId,
    hasPower ? t("sensors.devicePower", { value: number.format(device.power!) }) : null,
    hasEnergy ? t("sensors.deviceEnergy", { value: number.format(device.energy!) }) : null,
  ].filter((value): value is string => Boolean(value)).join(" · ");
}

function roomCenter(floor: Floor, roomName?: string): { x: number; y: number } {
  const normalized = roomName?.trim().toLocaleLowerCase();
  const room = (normalized
    ? floor.rooms.find((candidate) => candidate.name.trim().toLocaleLowerCase() === normalized)
    : floor.rooms[0]) ?? floor.rooms[0];
  if (!room?.points.length) return { x: floor.width / 2, y: floor.height / 2 };
  return {
    x: room.points.reduce((sum, point) => sum + point.x, 0) / room.points.length,
    y: room.points.reduce((sum, point) => sum + point.y, 0) / room.points.length,
  };
}

function stableRoomId(floor: Floor, roomLabel: string): string | null {
  const matches = floor.rooms.filter((room) => room.name === roomLabel);
  return matches.length === 1 ? matches[0]!.id : null;
}

function initialDraft(house: House): SensorDraft {
  const floor = house.floors[0];
  const center = floor ? roomCenter(floor) : { x: 0, y: 0 };
  return {
    source: "tp-link",
    deviceId: "",
    connectionId: "",
    name: "",
    model: "",
    houseId: house.id,
    floorId: floor?.id ?? "",
    room: floor?.rooms[0]?.name ?? "",
    x: String(rounded(center.x)),
    y: String(rounded(center.y)),
    height: "1.4",
    enabled: true,
    measurementEntityIds: {},
  };
}

function sensorMeasurementEntityIds(sensor: Sensor): Record<string, string> {
  return {
    ...(sensor.temperatureEntityId ? { temperature: sensor.temperatureEntityId } : {}),
    ...(sensor.humidityEntityId ? { humidity: sensor.humidityEntityId } : {}),
    ...(sensor.measurementEntityIds ?? {}),
  };
}

function sensorHasMetric(state: ClimateState, sensor: Sensor, metric: Metric): boolean {
  return Boolean(
    state.latestMeasurements[sensor.id]?.[metric]
    || state.measurementHistory[sensor.id]?.[metric]?.length
    || state.measurementForecasts[sensor.id]?.[metric]?.length
    || sensor.measurementEntityIds?.[metric]
    || (metric === "temperature" && sensor.temperatureEntityId)
    || (metric === "humidity" && sensor.humidityEntityId),
  );
}

function mergeMetricSamples(...sampleGroups: MeasurementSample[][]): MeasurementSample[] {
  const byTimestamp = new Map<string, MeasurementSample>();
  for (const sample of sampleGroups.flat()) byTimestamp.set(sample.timestamp, sample);
  return [...byTimestamp.values()].sort((left, right) => Date.parse(left.timestamp) - Date.parse(right.timestamp));
}

function normalizedMeasurementEntityIds(values: Record<string, string>): Record<string, string> {
  return Object.fromEntries(Object.entries(values).flatMap(([metric, entityId]) => {
    const normalized = entityId.trim();
    return normalized ? [[metric, normalized]] : [];
  }));
}

function sameMeasurementEntityIds(first: Record<string, string>, second: Record<string, string>): boolean {
  const firstEntries = Object.entries(first).sort(([left], [right]) => left.localeCompare(right));
  const secondEntries = Object.entries(second).sort(([left], [right]) => left.localeCompare(right));
  return firstEntries.length === secondEntries.length
    && firstEntries.every(([metric, entityId], index) => {
      const candidate = secondEntries[index];
      return candidate?.[0] === metric && candidate[1] === entityId;
    });
}

function isDemoSensor(sensor: Sensor): boolean {
  return sensor.tags.some((tag) => ["seeded", "demo", "mock"].includes(tag.trim().toLocaleLowerCase()));
}

function hasRealBinding(sensor: Pick<Sensor, "tpLinkDeviceId" | "temperatureEntityId" | "humidityEntityId" | "measurementEntityIds">): boolean {
  return Boolean(sensor.tpLinkDeviceId || sensor.temperatureEntityId || sensor.humidityEntityId
    || Object.keys(sensor.measurementEntityIds ?? {}).length > 0);
}

function draftForSensor(sensor: Sensor, houses: House[]): SensorDraft {
  const house = houses.find((candidate) => candidate.id === sensor.houseId);
  const floor = house?.floors.find((candidate) => candidate.id === sensor.floorId);
  return {
    source: sensor.tpLinkDeviceId ? "tp-link" : "manual",
    deviceId: sensor.tpLinkDeviceId ?? "",
    connectionId: sensor.tpLinkConnectionId ?? "",
    name: sensor.name,
    model: sensor.model,
    houseId: sensor.houseId,
    floorId: sensor.floorId,
    room: sensor.room,
    x: String(rounded(sensor.x)),
    y: String(rounded(sensor.y)),
    height: String(rounded(sensor.z - (floor?.elevation ?? 0))),
    enabled: sensor.enabled,
    measurementEntityIds: sensorMeasurementEntityIds(sensor),
  };
}

function draftContext(draft: SensorDraft, houses: House[]): { house: House | undefined; floor: Floor | undefined } {
  const house = houses.find((candidate) => candidate.id === draft.houseId);
  return { house, floor: house?.floors.find((candidate) => candidate.id === draft.floorId) };
}

function sensorFloor(sensor: Sensor, houses: House[]): Floor | undefined {
  return houses.find((candidate) => candidate.id === sensor.houseId)?.floors.find((candidate) => candidate.id === sensor.floorId);
}

function isUnplaced(sensor: Sensor, houses: House[]): boolean {
  const floor = sensorFloor(sensor, houses);
  return sensor.tags.includes(UNPLACED_TAG)
    || !floor
    || ![sensor.x, sensor.y, sensor.z].every(Number.isFinite)
    || sensor.x < 0
    || sensor.x > floor.width
    || sensor.y < 0
    || sensor.y > floor.height;
}

function latestSensorTimestamp(state: ClimateState, sensorId: string): number | null {
  const timestamps = [
    state.readings[sensorId]?.timestamp,
    ...Object.values(state.latestMeasurements[sensorId] ?? {}).map((sample) => sample.timestamp),
  ].flatMap((value) => value && Number.isFinite(Date.parse(value)) ? [Date.parse(value)] : []);
  return timestamps.length ? Math.max(...timestamps) : null;
}

function isLive(state: ClimateState, sensor: Sensor, houses: House[], now: number): boolean {
  if (!sensor.enabled || isUnplaced(sensor, houses)) return false;
  const timestamp = latestSensorTimestamp(state, sensor.id);
  return timestamp !== null && timestamp <= now + 5 * 60_000 && now - timestamp <= 10 * 60_000;
}

function sensorStatus(state: ClimateState, sensor: Sensor, houses: House[], now: number): SensorStatus {
  if (!sensor.enabled) return "archived";
  if (isUnplaced(sensor, houses)) return "unplaced";
  return isLive(state, sensor, houses, now) ? "live" : "waiting";
}

function validationErrors(draft: SensorDraft, houses: House[], t: Translate): DraftErrors {
  const errors: DraftErrors = {};
  const { house, floor } = draftContext(draft, houses);
  if (draft.source === "tp-link" && !draft.deviceId) errors.source = t("sensors.validationDevice");
  if (!draft.name.trim()) errors.name = t("sensors.validationName");
  if (!draft.model.trim()) errors.model = t("sensors.validationModel");
  if (!house) errors.house = t("sensors.validationHouse");
  if (!floor) errors.floor = t("sensors.validationFloor");
  if (!draft.room.trim()) errors.room = t("sensors.validationRoom");
  const x = Number(draft.x);
  const y = Number(draft.y);
  const height = Number(draft.height);
  if (!Number.isFinite(x) || (floor && (x < 0 || x > floor.width))) {
    errors.x = floor ? t("sensors.validationX", { maximum: floor.width }) : t("sensors.validationCoordinate");
  }
  if (!Number.isFinite(y) || (floor && (y < 0 || y > floor.height))) {
    errors.y = floor ? t("sensors.validationY", { maximum: floor.height }) : t("sensors.validationCoordinate");
  }
  if (!Number.isFinite(height) || height < 0) errors.height = t("sensors.validationHeight");
  return errors;
}

function errorMessage(error: unknown, fallback: string): string {
  return error instanceof Error && error.message.trim() ? error.message : fallback;
}

function deviceBindingKey(deviceId: string, connectionId?: string): string {
  return connectionId ? `${connectionId}\u0000${deviceId}` : deviceId;
}

function availableForSensor(device: TpLinkDiscoveredDevice, sensorId: string | null, usedDeviceIds: Set<string>): boolean {
  if (sensorId && device.mappedSensorId === sensorId) return true;
  return device.mappedSensorId === null && !usedDeviceIds.has(deviceBindingKey(device.deviceId, device.connectionId));
}

export function SensorManagementPage({
  state,
  house,
  houses,
  integration,
  tpLinkDevices,
  tpLinkDevicesLoading,
  tpLinkDevicesError,
  requestedDevice = null,
  requestedDeviceId = null,
  readOnly = false,
  units = "metric",
  onRequestedDeviceHandled,
  onLoadSeries,
  onHouse,
  onRefreshDevices,
  onCreateSensor,
  onUpdateSensor,
  onDeleteSensor,
  onImportHistoricalData,
}: SensorManagementPageProps) {
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

  useEffect(() => {
    if (mode === "closed") return;
    const timer = window.setTimeout(() => editorHeadingRef.current?.focus(), 0);
    return () => window.clearTimeout(timer);
  }, [mode, addStep]);

  const clearError = (key: keyof DraftErrors) => setErrors((current) => {
    if (!current[key]) return current;
    const next = { ...current };
    delete next[key];
    return next;
  });

  const beginAdd = () => {
    if (readOnly) return;
    editorOpenerRef.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const next = initialDraft(house);
    if (addableDevices.length === 0) next.source = "manual";
    setDraft(next);
    setMode("add");
    setAddStep(1);
    setEditingSensorId(null);
    setErrors({});
    setEditorFeedback(null);
  };

  const beginEdit = (sensor: Sensor) => {
    if (readOnly) return;
    editorOpenerRef.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    setDraft(draftForSensor(sensor, houses));
    setMode("edit");
    setEditingSensorId(sensor.id);
    setErrors({});
    setEditorFeedback(null);
  };

  const restoreEditorFocus = () => {
    window.setTimeout(() => {
      if (editorOpenerRef.current?.isConnected) editorOpenerRef.current.focus();
      editorOpenerRef.current = null;
    }, 0);
  };

  const cancelEditor = () => {
    setMode("closed");
    setEditingSensorId(null);
    setErrors({});
    setEditorFeedback(null);
    setSubmitting(false);
    restoreEditorFocus();
  };

  const closeImport = () => {
    setImportOpen(false);
    window.setTimeout(() => importButtonRef.current?.focus(), 0);
  };

  const loadSensorDetails = async (sensor: Sensor, cursor: string | null = null) => {
    if (cursor && detailsLoading) return;
    if (!cursor) detailsOpenerRef.current = document.activeElement instanceof HTMLElement ? document.activeElement : pageHeadingRef.current;
    const generation = ++detailsRequestGeneration.current;
    setDetailsSensor(sensor);
    if (!cursor) {
      setDetailSamples([]);
      setDetailCursor(null);
    }
    setDetailsLoading(true);
    setDetailsError(null);
    try {
      const page = await api.sensorMeasurementPage(sensor.id, cursor);
      if (detailsRequestGeneration.current !== generation) return;
      setDetailSamples((current) => cursor ? [...current, ...page.samples] : page.samples);
      setDetailCursor(page.nextCursor);
    } catch (error) {
      if (detailsRequestGeneration.current !== generation) return;
      setDetailsError(errorMessage(error, t("sensors.detailsError")));
    } finally {
      if (detailsRequestGeneration.current === generation) setDetailsLoading(false);
    }
  };

  const closeSensorDetails = () => {
    const opener = detailsOpenerRef.current;
    detailsOpenerRef.current = null;
    detailsRequestGeneration.current += 1;
    setDetailsSensor(null);
    setDetailSamples([]);
    setDetailCursor(null);
    setDetailsError(null);
    setDetailsLoading(false);
    window.setTimeout(() => (opener?.isConnected ? opener : pageHeadingRef.current)?.focus(), 0);
  };

  useEffect(() => {
    if (!visibleDetailsSensor) return;
    const timer = window.setTimeout(() => detailsHeadingRef.current?.focus(), 0);
    return () => window.clearTimeout(timer);
  }, [visibleDetailsSensor?.id]);

  useEffect(() => {
    if (detailsSensor && !visibleDetailsSensor) closeSensorDetails();
  }, [detailsSensor, visibleDetailsSensor]);

  useEffect(() => {
    if (detailDefinition && detailDefinition.id !== detailMetric) setDetailMetric(detailDefinition.id);
  }, [detailDefinition, detailMetric]);

  useEffect(() => {
    if (!visibleDetailsSensor || !detailDefinition || !onLoadSeries) return;
    onLoadSeries(visibleDetailsSensor.id, detailDefinition.id, detailRange, detailDefinition.forecastSupported);
  }, [detailDefinition?.id, detailDefinition?.forecastSupported, detailRange, onLoadSeries, visibleDetailsSensor?.id]);

  const chooseSource = (source: DraftSource) => {
    setDraft((current) => ({
      ...current,
      source,
      deviceId: source === "manual" ? "" : current.deviceId,
      connectionId: source === "manual" ? "" : current.connectionId,
    }));
    clearError("source");
    setEditorFeedback(null);
  };

  const chooseDevice = (device: TpLinkDiscoveredDevice) => {
    setDraft((current) => ({
      ...current,
      source: "tp-link",
      deviceId: device.deviceId,
      connectionId: device.connectionId ?? "",
      name: current.name.trim() || device.alias?.trim() || `${device.model} sensor`,
      model: device.model,
    }));
    clearError("source");
    setEditorFeedback(null);
  };

  useEffect(() => {
    const requested = requestedDevice ?? (requestedDeviceId ? { deviceId: requestedDeviceId, connectionId: null } : null);
    if (readOnly || !requested || mode !== "closed") return;
    const device = addableDevices.find((candidate) => candidate.deviceId === requested.deviceId
      && (requested.connectionId === null || (candidate.connectionId ?? null) === requested.connectionId));
    if (!device) {
      if (!tpLinkDevicesLoading) onRequestedDeviceHandled?.();
      return;
    }
    editorOpenerRef.current = pageHeadingRef.current;
    setDraft({
      ...initialDraft(house),
      source: "tp-link",
      deviceId: device.deviceId,
      connectionId: device.connectionId ?? "",
      name: device.alias?.trim() || `${device.model} sensor`,
      model: device.model,
    });
    setMode("add");
    setAddStep(2);
    setEditingSensorId(null);
    setErrors({});
    setEditorFeedback(null);
    onRequestedDeviceHandled?.();
  }, [addableDevices, house, mode, onRequestedDeviceHandled, readOnly, requestedDevice, requestedDeviceId, tpLinkDevicesLoading]);

  const changeDraftHouse = (houseId: string) => {
    const nextHouse = houses.find((candidate) => candidate.id === houseId);
    const nextFloor = nextHouse?.floors[0];
    const center = nextFloor ? roomCenter(nextFloor) : { x: 0, y: 0 };
    setDraft((current) => ({
      ...current,
      houseId,
      deviceId: houseId === current.houseId ? current.deviceId : "",
      connectionId: houseId === current.houseId ? current.connectionId : "",
      floorId: nextFloor?.id ?? "",
      room: nextFloor?.rooms[0]?.name ?? current.room,
      x: String(rounded(center.x)),
      y: String(rounded(center.y)),
    }));
    setErrors((current) => Object.fromEntries(Object.entries(current).filter(([key]) => !["house", "floor", "x", "y"].includes(key))) as DraftErrors);
  };

  const changeDraftFloor = (floorId: string) => {
    const nextFloor = draftHouse?.floors.find((candidate) => candidate.id === floorId);
    const center = nextFloor ? roomCenter(nextFloor) : null;
    setDraft((current) => ({
      ...current,
      floorId,
      room: nextFloor?.rooms[0]?.name ?? current.room,
      x: center ? String(rounded(center.x)) : current.x,
      y: center ? String(rounded(center.y)) : current.y,
    }));
    setErrors((current) => Object.fromEntries(Object.entries(current).filter(([key]) => !["floor", "x", "y"].includes(key))) as DraftErrors);
  };

  const focusFirstError = (nextErrors: DraftErrors) => {
    const first = Object.keys(nextErrors)[0];
    if (!first) return;
    window.setTimeout(() => document.getElementById(`${formId}-${first}`)?.focus(), 0);
  };

  const advanceAdd = () => {
    const allErrors = validationErrors(draft, houses, t);
    const relevant: DraftErrors = addStep === 1
      ? { ...(allErrors.source ? { source: allErrors.source } : {}) }
      : addStep === 2
        ? Object.fromEntries(Object.entries(allErrors).filter(([key]) => ["name", "model", "house", "floor", "room"].includes(key))) as DraftErrors
        : Object.fromEntries(Object.entries(allErrors).filter(([key]) => ["x", "y", "height"].includes(key))) as DraftErrors;
    if (Object.keys(relevant).length > 0) {
      setErrors((current) => ({ ...current, ...relevant }));
      setEditorFeedback({ kind: "error", message: t("sensors.fixFields") });
      focusFirstError(relevant);
      return;
    }
    setEditorFeedback(null);
    setAddStep((current) => Math.min(4, current + 1) as AddStep);
  };

  const retreatAdd = () => {
    setEditorFeedback(null);
    setAddStep((current) => Math.max(1, current - 1) as AddStep);
  };

  const buildPlacement = () => {
    const { floor } = draftContext(draft, houses);
    if (!floor) throw new Error(t("sensors.validationFloor"));
    return {
      x: rounded(Number(draft.x)),
      y: rounded(Number(draft.y)),
      z: rounded(floor.elevation + Number(draft.height)),
      floor,
    };
  };

  const submitAdd = async (event: FormEvent) => {
    event.preventDefault();
    if (readOnly || submitting) return;
    if (addStep < 4) {
      advanceAdd();
      return;
    }
    const nextErrors = validationErrors(draft, houses, t);
    if (Object.keys(nextErrors).length > 0) {
      setErrors(nextErrors);
      setEditorFeedback({ kind: "error", message: t("sensors.fixFields") });
      const firstStep: AddStep = nextErrors.source ? 1
        : [nextErrors.name, nextErrors.model, nextErrors.house, nextErrors.floor, nextErrors.room].some(Boolean) ? 2 : 3;
      setAddStep(firstStep);
      focusFirstError(nextErrors);
      return;
    }
    setSubmitting(true);
    setEditorFeedback(null);
    try {
      const placement = buildPlacement();
      const measurementEntityIds = normalizedMeasurementEntityIds(draft.measurementEntityIds);
      const input: CreateSensorInput = {
        houseId: draft.houseId,
        floorId: draft.floorId,
        name: draft.name.trim(),
        roomId: stableRoomId(placement.floor, draft.room.trim()),
        room: draft.room.trim(),
        model: draft.model.trim(),
        x: placement.x,
        y: placement.y,
        z: placement.z,
        tags: [],
        enabled: true,
        ...(draft.source === "tp-link" && draft.deviceId ? {
          tpLinkDeviceId: draft.deviceId,
          ...(draft.connectionId ? { tpLinkConnectionId: draft.connectionId } : {}),
        } : {}),
        ...(Object.keys(measurementEntityIds).length > 0 ? { measurementEntityIds } : {}),
      };
      const saved = await onCreateSensor(input);
      const offerDemoCleanup = integration.mock.mode === "real"
        && demoSensors.length > 0
        && !hasExistingRealBoundSensor
        && hasRealBinding(saved);
      if (offerDemoCleanup && window.confirm(t("sensors.cleanupConfirm", { count: demoSensors.length }))) {
        const results = await Promise.allSettled(demoSensors.map((sensor) => onDeleteSensor(sensor.id)));
        const selectedResultIndex = demoSensors.findIndex((sensor) => sensor.id === detailsSensor?.id);
        if (selectedResultIndex >= 0 && results[selectedResultIndex]?.status === "fulfilled") closeSensorDetails();
        const failed = results.filter((result) => result.status === "rejected").length;
        setPageFeedback(failed > 0
          ? { kind: "error", message: t("sensors.cleanupPartial", { name: saved.name, count: failed }) }
          : { kind: "success", message: t("sensors.cleanupDone", { name: saved.name, count: demoSensors.length }) });
      } else {
        setPageFeedback({ kind: "success", message: t("sensors.added", { name: saved.name }) });
      }
      setMode("closed");
      restoreEditorFocus();
      if (saved.houseId !== house.id) onHouse(saved.houseId);
    } catch (error) {
      setEditorFeedback({ kind: "error", message: errorMessage(error, t("sensors.addError")) });
    } finally {
      setSubmitting(false);
    }
  };

  const submitEdit = async (event: FormEvent) => {
    event.preventDefault();
    if (readOnly || submitting || !editingSensor) return;
    const nextErrors = validationErrors(draft, houses, t);
    if (Object.keys(nextErrors).length > 0) {
      setErrors(nextErrors);
      setEditorFeedback({ kind: "error", message: t("sensors.fixFields") });
      focusFirstError(nextErrors);
      return;
    }
    setSubmitting(true);
    setEditorFeedback(null);
    try {
      const placement = buildPlacement();
      const measurementEntityIds = normalizedMeasurementEntityIds(draft.measurementEntityIds);
      const existingMeasurementEntityIds = normalizedMeasurementEntityIds(sensorMeasurementEntityIds(editingSensor));
      const measurementBindingsChanged = !sameMeasurementEntityIds(measurementEntityIds, existingMeasurementEntityIds);
      const patch = {
        houseId: draft.houseId,
        floorId: draft.floorId,
        name: draft.name.trim(),
        roomId: stableRoomId(placement.floor, draft.room.trim()),
        room: draft.room.trim(),
        model: draft.model.trim(),
        x: placement.x,
        y: placement.y,
        z: placement.z,
        enabled: draft.enabled,
        tags: editingSensor.tags.filter((tag) => tag !== UNPLACED_TAG),
        tpLinkDeviceId: draft.deviceId || null,
        ...((editingSensor.tpLinkConnectionId !== undefined || draft.connectionId)
          ? { tpLinkConnectionId: draft.deviceId && draft.connectionId ? draft.connectionId : null }
          : {}),
        ...(measurementBindingsChanged ? {
          measurementEntityIds,
        } : {}),
      } as SensorPatch;
      const saved = await onUpdateSensor(editingSensor.id, patch);
      setPageFeedback({ kind: "success", message: t("sensors.updated", { name: saved.name }) });
      setMode("closed");
      setEditingSensorId(null);
      restoreEditorFocus();
      if (saved.houseId !== house.id) onHouse(saved.houseId);
    } catch (error) {
      setEditorFeedback({ kind: "error", message: errorMessage(error, t("sensors.updateError")) });
    } finally {
      setSubmitting(false);
    }
  };

  const setArchived = async (sensor: Sensor, archived: boolean) => {
    if (readOnly || rowBusyId) return;
    setRowBusyId(sensor.id);
    setPageFeedback(null);
    try {
      const saved = await onUpdateSensor(sensor.id, { enabled: !archived });
      setPageFeedback({
        kind: "success",
        message: archived ? t("sensors.archivedFeedback", { name: saved.name }) : t("sensors.restoredFeedback", { name: saved.name }),
      });
      if (editingSensorId === sensor.id) setDraft((current) => ({ ...current, enabled: saved.enabled }));
    } catch (error) {
      setPageFeedback({ kind: "error", message: errorMessage(error, archived ? t("sensors.archiveError") : t("sensors.restoreError")) });
    } finally {
      setRowBusyId(null);
    }
  };

  const removeSensor = async (sensor: Sensor) => {
    if (readOnly || rowBusyId || cleanupBusy || !window.confirm(t("sensors.deleteConfirm", { name: sensor.name }))) return;
    setRowBusyId(sensor.id);
    setPageFeedback(null);
    try {
      await onDeleteSensor(sensor.id);
      if (detailsSensor?.id === sensor.id) closeSensorDetails();
      setPageFeedback({ kind: "success", message: t("sensors.deletedFeedback", { name: sensor.name }) });
      if (editingSensorId === sensor.id) cancelEditor();
    } catch (error) {
      setPageFeedback({ kind: "error", message: errorMessage(error, t("sensors.deleteError")) });
    } finally {
      setRowBusyId(null);
    }
  };

  const removeDemoSensors = async () => {
    if (readOnly || cleanupBusy || demoSensors.length === 0
      || !window.confirm(t("sensors.cleanupConfirm", { count: demoSensors.length }))) return;
    setCleanupBusy(true);
    setPageFeedback(null);
    try {
      const results = await Promise.allSettled(demoSensors.map((sensor) => onDeleteSensor(sensor.id)));
      const selectedResultIndex = demoSensors.findIndex((sensor) => sensor.id === detailsSensor?.id);
      if (selectedResultIndex >= 0 && results[selectedResultIndex]?.status === "fulfilled") closeSensorDetails();
      const failed = results.filter((result) => result.status === "rejected").length;
      setPageFeedback(failed > 0
        ? { kind: "error", message: t("sensors.demoCleanupPartial", { count: failed }) }
        : { kind: "success", message: t("sensors.demoCleanupDone", { count: demoSensors.length }) });
    } finally {
      setCleanupBusy(false);
    }
  };

  const refreshDevices = async () => {
    if (readOnly || refreshing || tpLinkDevicesLoading) return;
    setRefreshing(true);
    setRefreshError(null);
    try {
      await onRefreshDevices();
    } catch (error) {
      setRefreshError(errorMessage(error, t("sensors.discoveryError")));
    } finally {
      setRefreshing(false);
    }
  };

  const renderFieldError = (key: keyof DraftErrors) => errors[key]
    ? <span className="sensor-field-error" id={`${formId}-${key}-error`}>{errors[key]}</span>
    : null;

  const fieldA11y = (key: keyof DraftErrors) => ({
    "aria-invalid": errors[key] ? true as const : undefined,
    "aria-describedby": errors[key] ? `${formId}-${key}-error` : undefined,
  });

  const renderDetailsFields = () => (
    <div className="sensor-form-grid">
      <label className="field sensor-field-wide">
        <span>{t("sensors.name")}</span>
        <input
          id={`${formId}-name`}
          required
          autoComplete="off"
          value={draft.name}
          onChange={(event) => { setDraft((current) => ({ ...current, name: event.target.value })); clearError("name"); }}
          placeholder={t("sensors.namePlaceholder")}
          {...fieldA11y("name")}
        />
        {renderFieldError("name")}
      </label>
      <label className="field">
        <span>{t("sensors.model")}</span>
        <input
          id={`${formId}-model`}
          required
          value={draft.model}
          onChange={(event) => { setDraft((current) => ({ ...current, model: event.target.value })); clearError("model"); }}
          placeholder={t("sensors.modelPlaceholder")}
          {...fieldA11y("model")}
        />
        {renderFieldError("model")}
      </label>
      <label className="field">
        <span>{t("common.house")}</span>
        <select id={`${formId}-house`} value={draft.houseId} onChange={(event) => changeDraftHouse(event.target.value)} {...fieldA11y("house")}>
          {houses.map((candidate) => <option key={candidate.id} value={candidate.id}>{candidate.name}</option>)}
        </select>
        {renderFieldError("house")}
      </label>
      <label className="field">
        <span>{t("common.floor")}</span>
        <select id={`${formId}-floor`} value={draft.floorId} onChange={(event) => changeDraftFloor(event.target.value)} {...fieldA11y("floor")}>
          {(draftHouse?.floors ?? []).map((candidate) => <option key={candidate.id} value={candidate.id}>{candidate.name}</option>)}
        </select>
        {renderFieldError("floor")}
      </label>
      <label className="field">
        <span>{t("sensors.room")}</span>
        <input
          id={`${formId}-room`}
          required
          list={`${formId}-rooms`}
          value={draft.room}
          onChange={(event) => {
            const room = event.target.value;
            const center = draftFloor ? roomCenter(draftFloor, room) : null;
            const exactRoom = draftFloor?.rooms.some((candidate) => candidate.name.trim().toLocaleLowerCase() === room.trim().toLocaleLowerCase());
            setDraft((current) => ({
              ...current,
              room,
              ...(center && exactRoom ? { x: String(rounded(center.x)), y: String(rounded(center.y)) } : {}),
            }));
            clearError("room");
          }}
          placeholder={t("sensors.roomPlaceholder")}
          {...fieldA11y("room")}
        />
        <datalist id={`${formId}-rooms`}>{(draftFloor?.rooms ?? []).map((room) => <option key={room.id} value={room.name} />)}</datalist>
        {renderFieldError("room")}
      </label>
    </div>
  );

  const renderBindingField = () => (
    <label className="field sensor-binding-field">
      <span>{t("sensors.tpLinkBinding")}</span>
      <select
        value={draft.deviceId ? deviceBindingKey(draft.deviceId, draft.connectionId) : ""}
        onChange={(event) => {
          const deviceId = event.target.value;
          const device = selectableDevices.find((candidate) => deviceBindingKey(candidate.deviceId, candidate.connectionId) === deviceId);
          setDraft((current) => ({
            ...current,
            deviceId: device?.deviceId ?? "",
            connectionId: device?.connectionId ?? "",
            source: device ? "tp-link" : "manual",
          }));
          clearError("source");
        }}
      >
        <option value="">{t("sensors.noBinding")}</option>
        {currentBindingMissing && <option value={deviceBindingKey(draft.deviceId, draft.connectionId)}>{draft.deviceId}</option>}
        {selectableDevices.map((device) => (
          <option key={deviceBindingKey(device.deviceId, device.connectionId)} value={deviceBindingKey(device.deviceId, device.connectionId)}>
            {device.alias || device.model} · {tpLinkDeviceSummary(device, t, locale)}
          </option>
        ))}
      </select>
      <small>{t("sensors.bindingHelp")}</small>
    </label>
  );

  const renderHomeAssistantBindings = () => (
    <fieldset className="sensor-ha-bindings">
      <legend>{t("sensors.haBindings")}</legend>
      <p>{t("sensors.haBindingsHelp")}</p>
      <div className="sensor-ha-binding-grid">
        {enabledMeasurementDefinitions.map((definition) => {
          const label = measurementLabel(definition, locale);
          return (
            <label className="field" key={definition.id}>
              <span>{t("sensors.haEntityLabel", { measurement: label })}</span>
              <input
                aria-label={t("sensors.haEntityLabel", { measurement: label })}
                autoCapitalize="none"
                autoComplete="off"
                spellCheck={false}
                value={draft.measurementEntityIds[definition.id] ?? ""}
                onChange={(event) => setDraft((current) => ({
                  ...current,
                  measurementEntityIds: { ...current.measurementEntityIds, [definition.id]: event.target.value },
                }))}
                placeholder={t("sensors.haEntityPlaceholder", { metric: definition.id })}
              />
              <small>{definition.id} · {definition.unit}</small>
            </label>
          );
        })}
      </div>
    </fieldset>
  );

  const renderLocationFields = () => draftFloor ? (
    <div className="sensor-location-editor">
      <PlacementPicker
        floor={draftFloor}
        x={Number.isFinite(Number(draft.x)) ? Number(draft.x) : 0}
        y={Number.isFinite(Number(draft.y)) ? Number(draft.y) : 0}
        label={t("sensors.placementMap", { floor: draftFloor.name })}
        description={t("sensors.placementHelp")}
        coverage={placementCoverage}
        suggestion={placementSuggestion}
        onChange={(point) => {
          setDraft((current) => ({ ...current, x: String(rounded(point.x)), y: String(rounded(point.y)) }));
          clearError("x");
          clearError("y");
        }}
      />
      <div className="sensor-location-side">
        {placementSuggestion && placementCoverage && (() => {
          const recommendation = placementSuggestion.recommendation;
          const target = recommendation.roomName ?? recommendation.floorName;
          const suggestedHeight = rounded(Math.max(0, recommendation.z - draftFloor.elevation));
          const usingSuggestion = Math.abs(Number(draft.x) - recommendation.x) < .01
            && Math.abs(Number(draft.y) - recommendation.y) < .01
            && Math.abs(Number(draft.height) - suggestedHeight) < .01;
          return <section className="sensor-placement-suggestion" aria-labelledby={`${formId}-placement-suggestion-title`}>
            <header>
              <span className="sensor-suggestion-icon" aria-hidden="true"><Sparkles size={17} /></span>
              <span><small>{t("spatial.experimental")}</small><strong id={`${formId}-placement-suggestion-title`}>{t("sensors.placementSuggestionTitle")}</strong></span>
            </header>
            <p>{t("spatial.suggestion.add-temperature-anchor", { room: target })}</p>
            <div className="sensor-suggestion-evidence">
              <span>{t("sensors.placementSuggestionPointSupport", { support: Math.round(placementSuggestion.coverageAtPoint * 100) })}</span>
              <span>{t("spatial.coverage.support", { support: Math.round(placementCoverage.coverageScore * 100) })}</span>
              <span>{t("spatial.coverage.evidence", {
                fresh: placementCoverage.freshTemperatureSensors,
                total: placementCoverage.enabledSensors,
                paired: placementCoverage.pairedHumiditySensors,
              })}</span>
              {placementSuggestion.engineLayerCount > 0 && <span>{t("sensors.placementSuggestionEngineBasis", {
                count: placementSuggestion.engineLayerCount,
                support: Math.round((placementSuggestion.engineSupport ?? 0) * 100),
              })}</span>}
            </div>
            <small className="sensor-suggestion-disclaimer">{t("spatial.suggestions.description")}</small>
            <button
              type="button"
              className="secondary-button"
              disabled={usingSuggestion}
              onClick={() => {
                setDraft((current) => ({
                  ...current,
                  x: String(rounded(recommendation.x)),
                  y: String(rounded(recommendation.y)),
                  height: String(suggestedHeight),
                }));
                clearError("x");
                clearError("y");
                clearError("height");
              }}
            >{usingSuggestion ? <Check size={15} aria-hidden="true" /> : <MapPin size={15} aria-hidden="true" />}{t(usingSuggestion ? "sensors.placementSuggestionSelected" : "sensors.placementSuggestionUse")}</button>
          </section>;
        })()}
        <div className="sensor-coordinate-panel">
        <div className="sensor-coordinate-heading">
          <span className="sensor-coordinate-icon" aria-hidden="true"><MapPin size={17} /></span>
          <span>
            <strong>{t("sensors.position")}</strong>
            <small>{t("sensors.positionValue", { x: draft.x || "\u2014", y: draft.y || "\u2014", height: draft.height || "\u2014" })}</small>
          </span>
        </div>
        <div className="sensor-coordinate-fields">
          <label className="field">
            <span>{t("sensors.xPosition")}</span>
            <input id={`${formId}-x`} type="number" min="0" max={draftFloor.width} step="0.1" required value={draft.x} onChange={(event) => { setDraft((current) => ({ ...current, x: event.target.value })); clearError("x"); }} {...fieldA11y("x")} />
            <small className="sensor-coordinate-range" aria-hidden="true">0–{draftFloor.width}</small>
            {renderFieldError("x")}
          </label>
          <label className="field">
            <span>{t("sensors.yPosition")}</span>
            <input id={`${formId}-y`} type="number" min="0" max={draftFloor.height} step="0.1" required value={draft.y} onChange={(event) => { setDraft((current) => ({ ...current, y: event.target.value })); clearError("y"); }} {...fieldA11y("y")} />
            <small className="sensor-coordinate-range" aria-hidden="true">0–{draftFloor.height}</small>
            {renderFieldError("y")}
          </label>
          <label className="field sensor-height-field">
            <span>{t("sensors.mountingHeight")}</span>
            <span className="input-suffix"><input id={`${formId}-height`} type="number" min="0" step="0.1" required value={draft.height} onChange={(event) => { setDraft((current) => ({ ...current, height: event.target.value })); clearError("height"); }} {...fieldA11y("height")} /><span aria-hidden="true">m</span></span>
            {renderFieldError("height")}
          </label>
        </div>
      </div>
      </div>
    </div>
  ) : <p className="sensor-empty-callout" role="alert"><TriangleAlert size={17} aria-hidden="true" />{t("sensors.noFloor")}</p>;

  const renderAddEditor = () => (
    <section className="panel sensor-editor-card" aria-labelledby={`${formId}-editor-title`}>
      <header className="sensor-editor-header">
        <div>
          <span className="eyebrow">{t("sensors.guidedSetup")}</span>
          <h2 ref={editorHeadingRef} id={`${formId}-editor-title`} tabIndex={-1}>{t(`sensors.step${addStep}` as TranslationKey)}</h2>
        </div>
        <button type="button" className="icon-button" onClick={cancelEditor} aria-label={t("sensors.cancelAdd")}><X size={18} /></button>
      </header>
      <ol className="sensor-stepper" aria-label={t("sensors.setupProgress") }>
        {[1, 2, 3, 4].map((step) => <li key={step} className={step < addStep ? "complete" : step === addStep ? "active" : ""} aria-current={step === addStep ? "step" : undefined}><span>{step < addStep ? <Check size={13} aria-hidden="true" /> : step}</span><small>{t(`sensors.step${step}Short` as TranslationKey)}</small></li>)}
      </ol>
      <form onSubmit={submitAdd} noValidate>
        {addStep === 1 && (
          <fieldset className="sensor-source-fieldset">
            <legend className="sr-only">{t("sensors.chooseSource")}</legend>
            <label className={`sensor-source-choice ${draft.source === "tp-link" ? "selected" : ""}`}>
              <input type="radio" name={`${formId}-source`} checked={draft.source === "tp-link"} disabled={addableDevices.length === 0} onChange={() => chooseSource("tp-link")} />
              <span className="sensor-source-icon"><RadioTower size={20} aria-hidden="true" /></span>
              <span><strong>{t("sensors.discoveredSource")}</strong><small>{t("sensors.discoveredSourceHelp", { count: addableDevices.length })}</small></span>
            </label>
            {draft.source === "tp-link" && (
              <div className="discovered-device-list" aria-label={t("sensors.availableDevices")}>
                {addableDevices.map((device) => (
                  <button key={deviceBindingKey(device.deviceId, device.connectionId)} type="button" className={draft.deviceId === device.deviceId && draft.connectionId === (device.connectionId ?? "") ? "selected" : ""} aria-pressed={draft.deviceId === device.deviceId && draft.connectionId === (device.connectionId ?? "")} onClick={() => chooseDevice(device)}>
                    <span className="device-radio"><span /></span>
                    <span><strong>{device.alias || t("sensors.unnamedDevice")}</strong><small>{tpLinkDeviceSummary(device, t, locale)}</small></span>
                    <span className={`device-health ${device.status?.toLowerCase() === "online" ? "online" : ""}`}>{device.status || t("sensors.unknownStatus")}</span>
                  </button>
                ))}
              </div>
            )}
            <label className={`sensor-source-choice ${draft.source === "manual" ? "selected" : ""}`}>
              <input id={`${formId}-source`} type="radio" name={`${formId}-source`} checked={draft.source === "manual"} aria-describedby={errors.source ? `${formId}-source-error` : undefined} onChange={() => chooseSource("manual")} />
              <span className="sensor-source-icon manual"><Plus size={20} aria-hidden="true" /></span>
              <span><strong>{t("sensors.manualSource")}</strong><small>{t("sensors.manualSourceHelp")}</small></span>
            </label>
            {errors.source && <p className="sensor-field-error source-error" id={`${formId}-source-error`} role="alert">{errors.source}</p>}
          </fieldset>
        )}
        {addStep === 2 && <div className="sensor-editor-section">{renderDetailsFields()}{renderHomeAssistantBindings()}</div>}
        {addStep === 3 && <div className="sensor-editor-section"><p className="sensor-section-copy">{t("sensors.locationDescription")}</p>{renderLocationFields()}</div>}
        {addStep === 4 && (
          <div className="sensor-review">
            <div className="sensor-review-hero"><span className="device-glyph" aria-hidden="true"><span /><span /></span><span><small>{draft.source === "tp-link" ? t("sensors.discoveredSource") : t("sensors.manualSource")}</small><strong>{draft.name.trim()}</strong><span>{draft.model.trim()}</span></span></div>
            <dl>
              <div><dt>{t("common.house")}</dt><dd>{draftHouse?.name ?? "—"}</dd></div>
              <div><dt>{t("common.floor")}</dt><dd>{draftFloor?.name ?? "—"}</dd></div>
              <div><dt>{t("sensors.room")}</dt><dd>{draft.room.trim()}</dd></div>
              <div><dt>{t("sensors.position")}</dt><dd>{t("sensors.positionValue", { x: draft.x, y: draft.y, height: draft.height })}</dd></div>
              <div><dt>{t("sensors.tpLinkBinding")}</dt><dd>{draft.deviceId || t("sensors.noBinding")}</dd></div>
              <div><dt>{t("sensors.haBindings")}</dt><dd>{Object.keys(normalizedMeasurementEntityIds(draft.measurementEntityIds)).length > 0 ? t("sensors.haBindingCount", { count: Object.keys(normalizedMeasurementEntityIds(draft.measurementEntityIds)).length }) : t("sensors.haNoBindings")}</dd></div>
            </dl>
            <p className="sensor-review-note"><Check size={16} aria-hidden="true" />{t("sensors.reviewNote")}</p>
          </div>
        )}
        {editorFeedback && <p className={`sensor-form-feedback ${editorFeedback.kind}`} role={editorFeedback.kind === "error" ? "alert" : "status"}>{editorFeedback.kind === "error" ? <TriangleAlert size={16} aria-hidden="true" /> : <Check size={16} aria-hidden="true" />}{editorFeedback.message}</p>}
        <div className="sensor-editor-actions">
          <button type="button" className="secondary-button" onClick={cancelEditor}>{t("common.cancel")}</button>
          <span />
          {addStep > 1 && <button type="button" className="secondary-button" onClick={retreatAdd}><ChevronLeft size={15} aria-hidden="true" />{t("sensors.back")}</button>}
          {addStep < 4
            ? <button type="button" className="primary-button" onClick={advanceAdd}>{t("sensors.continue")}<ChevronRight size={15} aria-hidden="true" /></button>
            : <button type="submit" className="primary-button" disabled={submitting}>{submitting ? <LoaderCircle className="spin" size={16} aria-hidden="true" /> : <Plus size={16} aria-hidden="true" />}{submitting ? t("sensors.adding") : t("sensors.add")}</button>}
        </div>
      </form>
    </section>
  );

  const renderEditEditor = () => editingSensor && (
    <section className="panel sensor-editor-card" aria-labelledby={`${formId}-editor-title`}>
      <header className="sensor-editor-header">
        <div><span className="eyebrow">{t("sensors.editEyebrow")}</span><h2 ref={editorHeadingRef} id={`${formId}-editor-title`} tabIndex={-1}>{t("sensors.editTitle", { name: editingSensor.name })}</h2><p>{t("sensors.stableId", { id: editingSensor.id })}</p></div>
        <button type="button" className="icon-button" onClick={cancelEditor} aria-label={t("sensors.cancelEdit")}><X size={18} /></button>
      </header>
      <form onSubmit={submitEdit} className="sensor-edit-form" noValidate>
        <section aria-labelledby={`${formId}-details-title`}><h3 id={`${formId}-details-title`}>{t("sensors.detailsSection")}</h3>{renderDetailsFields()}</section>
        <details className="sensor-edit-advanced">
          <summary><span><strong>{t("sensors.advancedEdit")}</strong><small>{t("sensors.locationSection")} · {t("sensors.connectionSection")}</small></span><ChevronDown size={16} aria-hidden="true" /></summary>
          <section aria-labelledby={`${formId}-location-title`}><h3 id={`${formId}-location-title`}>{t("sensors.locationSection")}</h3>{renderLocationFields()}</section>
          <section aria-labelledby={`${formId}-connection-title`}><h3 id={`${formId}-connection-title`}>{t("sensors.connectionSection")}</h3>{renderBindingField()}{renderHomeAssistantBindings()}<label className="sensor-toggle"><input type="checkbox" checked={draft.enabled} onChange={(event) => setDraft((current) => ({ ...current, enabled: event.target.checked }))} /><span><strong>{t("sensors.enabled")}</strong><small>{t("sensors.enabledHelp")}</small></span></label></section>
        </details>
        {editorFeedback && <p className={`sensor-form-feedback ${editorFeedback.kind}`} role={editorFeedback.kind === "error" ? "alert" : "status"}>{editorFeedback.kind === "error" ? <TriangleAlert size={16} aria-hidden="true" /> : <Check size={16} aria-hidden="true" />}{editorFeedback.message}</p>}
        <div className="sensor-editor-actions"><button type="button" className="secondary-button" onClick={cancelEditor}>{t("common.cancel")}</button><span /><button type="submit" className="primary-button" disabled={submitting}>{submitting ? <LoaderCircle className="spin" size={16} aria-hidden="true" /> : <Check size={16} aria-hidden="true" />}{submitting ? t("common.saving") : t("sensors.saveChanges")}</button></div>
      </form>
    </section>
  );

  return (
    <>
      <header className="page-heading sensor-page-heading">
        <div><span className="eyebrow"><RadioTower size={14} aria-hidden="true" />{t("sensors.eyebrow")}</span><h1 ref={pageHeadingRef} tabIndex={-1}>{t("sensors.title")}</h1><p>{t("sensors.description")}</p></div>
        {!readOnly && (currentSensors.length > 0 || demoSensors.length > 0) && <div className="sensor-heading-actions">
          {demoSensors.length > 0 && <button type="button" className="secondary-button delete-action" onClick={() => void removeDemoSensors()} disabled={mode !== "closed" || cleanupBusy}>{cleanupBusy ? <LoaderCircle className="spin" size={16} aria-hidden="true" /> : <Trash2 size={16} aria-hidden="true" />}{cleanupBusy ? t("sensors.removingDemoSensors") : t("sensors.removeDemoSensors", { count: demoSensors.length })}</button>}
          {currentSensors.length > 0 && <button type="button" className="primary-button" onClick={beginAdd} disabled={mode !== "closed" || cleanupBusy}><Plus size={16} aria-hidden="true" />{t("sensors.add")}</button>}
        </div>}
      </header>

      {!readOnly && importOpen && <Suspense fallback={<output className="history-import-loading"><LoaderCircle className="spin" size={18} aria-hidden="true" />{t("common.loading")}</output>}>
        <HistoricalImportWizard
          open
          house={house}
          sensors={currentSensors}
          definitions={state.measurementDefinitions.filter((definition) => definition.enabled)}
          onClose={closeImport}
          onImport={onImportHistoricalData}
        />
      </Suspense>}

      {pageFeedback && <p className={`sensor-page-feedback ${pageFeedback.kind}`} role={pageFeedback.kind === "error" ? "alert" : "status"}>{pageFeedback.kind === "error" ? <TriangleAlert size={16} aria-hidden="true" /> : <Check size={16} aria-hidden="true" />}{pageFeedback.message}<button type="button" className="icon-button small" onClick={() => setPageFeedback(null)} aria-label={t("common.close")}><X size={14} /></button></p>}

      {!readOnly && tpLinkStatus.configured && <section
        className={`sensor-discovery-watch ${tpLinkStatus.connected ? "active" : "waiting"}`}
        role="region"
        aria-label={t("sensors.discoveryStatus")}
      >
        <span className="sensor-discovery-watch-icon" aria-hidden="true">
          {tpLinkDevicesLoading || refreshing
            ? <LoaderCircle className="spin" size={19} />
            : tpLinkStatus.connected
              ? <RadioTower size={19} />
              : <RefreshCw className="spin" size={19} />}
        </span>
        <span>
          <strong>{t(tpLinkStatus.connected ? "sensors.discoveryWatchingTitle" : "sensors.discoveryPausedTitle")}</strong>
          <small>{tpLinkStatus.connected
            ? tpLinkStatus.lastPollAt
              ? t("sensors.discoveryLastChecked", { time: formatInTimeZone(tpLinkStatus.lastPollAt, locale, house.timezone, { hour: "2-digit", minute: "2-digit", second: "2-digit" }) })
              : t("sensors.discoveryStarting")
            : t("sensors.discoveryPaused")}</small>
        </span>
        <button type="button" className="secondary-button" disabled={tpLinkDevicesLoading || refreshing} onClick={() => void refreshDevices()}>
          <RefreshCw className={tpLinkDevicesLoading || refreshing ? "spin" : ""} size={15} aria-hidden="true" />{t("sensors.refreshDeviceList")}
        </button>
      </section>}

      <section className="sensor-overview" aria-label={t("sensors.overview") }>
        <button type="button" className={filter === "waiting" ? "active" : ""} aria-pressed={filter === "waiting"} onClick={() => setFilter("waiting")}><span className="sensor-overview-icon waiting"><TriangleAlert size={18} aria-hidden="true" /></span><span><small>{t("sensors.waiting")}</small><strong>{statusCounts.waiting}</strong></span></button>
        <button type="button" className={filter === "unplaced" ? "active" : ""} aria-pressed={filter === "unplaced"} onClick={() => setFilter("unplaced")}><span className="sensor-overview-icon unplaced"><MapPin size={18} aria-hidden="true" /></span><span><small>{t("sensors.unplaced")}</small><strong>{statusCounts.unplaced}</strong></span></button>
        <button type="button" className={filter === "live" ? "active" : ""} aria-pressed={filter === "live"} onClick={() => setFilter("live")}><span className="sensor-overview-icon live"><CircleDot size={18} aria-hidden="true" /></span><span><small>{t("sensors.live")}</small><strong>{statusCounts.live}</strong></span></button>
        <button type="button" className={filter === "archived" ? "active" : ""} aria-pressed={filter === "archived"} onClick={() => setFilter("archived")}><span className="sensor-overview-icon archived"><Archive size={18} aria-hidden="true" /></span><span><small>{t("sensors.archived")}</small><strong>{statusCounts.archived}</strong></span></button>
      </section>

      {!readOnly && mode === "add" && renderAddEditor()}
      {!readOnly && mode === "edit" && renderEditEditor()}

      {visibleDetailsSensor && <section id="sensor-details-panel" className="panel sensor-details-panel" aria-labelledby="sensor-details-title">
        <header>
          <div><span className="eyebrow">{t("sensors.dataAndLogs")}</span><h2 ref={detailsHeadingRef} id="sensor-details-title" tabIndex={-1}>{visibleDetailsSensor.name}</h2><small>{visibleDetailsSensor.id}</small></div>
          <button type="button" className="icon-button" onClick={closeSensorDetails} aria-label={t("common.close")}><X size={17} /></button>
        </header>
        <div className="sensor-details-summary">
          <span><Database size={15} aria-hidden="true" />{t("sensors.loadedRecords", { count: detailSamples.length })}</span>
          <small>{t("sensors.newestFirst")}</small>
        </div>
        {detailDefinition && <div className="sensor-detail-visualization">
          <div className="sensor-detail-visualization-toolbar">
            <span><strong>{t("sensors.visualization")}</strong><small>{t("sensors.visualizationDescription")}</small></span>
            <label className="field"><span>{t("sensors.analyticsMetric")}</span><select value={detailDefinition.id} onChange={(event) => setDetailMetric(event.target.value)}>{detailDefinitions.map((definition) => <option key={definition.id} value={definition.id}>{measurementLabel(definition, locale)}</option>)}</select></label>
          </div>
          <TrendChart
            sensor={visibleDetailsSensor}
            history={detailHistory}
            forecast={state.measurementForecasts[visibleDetailsSensor.id]?.[detailDefinition.id] ?? []}
            definition={detailDefinition}
            units={units}
            range={detailRange}
            onRange={setDetailRange}
            timeZone={house.timezone}
            heading={measurementLabel(detailDefinition, locale)}
          />
        </div>}
        <SensorLabelCard sensor={visibleDetailsSensor} />
        {detailsError && <p className="sensor-details-error" role="alert"><TriangleAlert size={15} aria-hidden="true" />{detailsError}</p>}
        {detailSamples.length > 0 ? <div className="sensor-log-scroll" role="region" aria-labelledby="sensor-details-title" tabIndex={0}><table>
          <thead><tr><th>{t("sensors.logTime")}</th><th>{t("sensors.logMetric")}</th><th>{t("sensors.logValue")}</th><th>{t("sensors.logSource")}</th><th>{t("sensors.logQuality")}</th></tr></thead>
          <tbody>{detailSamples.map((sample, index) => <tr key={`${sample.timestamp}-${sample.metric}-${sample.source}-${index}`}>
            <td>{formatInTimeZone(Date.parse(sample.timestamp), locale, house.timezone, { dateStyle: "short", timeStyle: "medium" })}</td>
            <td>{state.measurementDefinitions.find((definition) => definition.id === sample.metric)
              ? measurementLabel(state.measurementDefinitions.find((definition) => definition.id === sample.metric)!, locale)
              : sample.metric}</td>
            <td>{sample.value} {sample.canonicalUnit}</td><td>{sample.source}</td><td>{sample.quality}</td>
          </tr>)}</tbody>
        </table></div> : !detailsLoading && !detailsError ? <p className="sensor-details-empty">{t("sensors.noData")}</p> : null}
        <footer>
          {detailsLoading && <span role="status"><LoaderCircle className="spin" size={15} aria-hidden="true" />{t("sensors.loadingData")}</span>}
          {!detailsLoading && detailCursor && <button type="button" className="secondary-button" onClick={() => void loadSensorDetails(visibleDetailsSensor, detailCursor)}>{t("sensors.loadMore")}</button>}
          {!readOnly && <div className="sensor-details-actions">
            <button type="button" className="secondary-button" disabled={mode !== "closed" || cleanupBusy} onClick={() => { beginEdit(visibleDetailsSensor); closeSensorDetails(); }}><Edit3 size={14} aria-hidden="true" />{t("sensors.editAction", { name: visibleDetailsSensor.name })}</button>
            <button type="button" className="secondary-button archive-action" disabled={mode !== "closed" || cleanupBusy || rowBusyId === visibleDetailsSensor.id} onClick={() => void setArchived(visibleDetailsSensor, visibleDetailsSensor.enabled)}>{rowBusyId === visibleDetailsSensor.id ? <LoaderCircle className="spin" size={14} aria-hidden="true" /> : visibleDetailsSensor.enabled ? <Archive size={14} aria-hidden="true" /> : <RotateCcw size={14} aria-hidden="true" />}{visibleDetailsSensor.enabled ? t("sensors.archiveAction", { name: visibleDetailsSensor.name }) : t("sensors.restoreAction", { name: visibleDetailsSensor.name })}</button>
            <button type="button" className="secondary-button delete-action" disabled={mode !== "closed" || cleanupBusy || rowBusyId === visibleDetailsSensor.id} onClick={() => void removeSensor(visibleDetailsSensor)}><Trash2 size={14} aria-hidden="true" />{t("sensors.deleteAction", { name: visibleDetailsSensor.name })}</button>
          </div>}
        </footer>
      </section>}

      <div className="sensor-workspace">
        {currentSensors.length === 0 ? <section className="panel sensor-help-card" aria-labelledby="sensor-zero-title">
          <span className="sensor-help-icon"><ThermometerSun size={20} aria-hidden="true" /></span>
          <div><span className="eyebrow">{t("sensors.inventory")}</span><h2 id="sensor-zero-title">{t("sensors.easySetup")}</h2><p>{t("sensors.easySetupHelp")}</p>{!readOnly && mode === "closed" && <button type="button" className="primary-button" onClick={beginAdd}><Plus size={15} aria-hidden="true" />{t("sensors.startSetup")}</button>}</div>
        </section> : <section className="panel sensor-list-panel" aria-labelledby="sensor-list-title">
          <div className="sensor-list-header">
            <div><span className="eyebrow">{t("sensors.inventory")}</span><h2 id="sensor-list-title">{t("sensors.houseSensors", { house: house.name })}</h2></div>
          </div>
          <div className="sensor-list-controls">
            <label className="field sensor-search-field"><span>{t("sensors.search")}</span><span className="sensor-search"><Search size={16} aria-hidden="true" /><input type="search" value={search} onChange={(event) => setSearch(event.target.value)} placeholder={t("sensors.searchPlaceholder")} /></span></label>
            <label className="field sensor-filter"><span>{t("sensors.filter")}</span><select value={filter} onChange={(event) => setFilter(event.target.value as SensorFilter)}><option value="all">{t("sensors.filterAll")}</option><option value="live">{t("sensors.filterLive")}</option><option value="waiting">{t("sensors.filterWaiting")}</option><option value="unplaced">{t("sensors.filterUnplaced")}</option><option value="archived">{t("sensors.filterArchived")}</option></select></label>
          </div>
          {visibleSensors.length > 0 ? (
            <ul className="sensor-inventory-list">
              {visibleSensors.map((sensor) => {
                const floor = sensorFloor(sensor, houses);
                const status = sensorStatuses.get(sensor.id) ?? "waiting";
                const lastTimestamp = latestSensorTimestamp(state, sensor.id);
                const sensorTimeZone = houses.find((candidate) => candidate.id === sensor.houseId)?.timezone;
                return (
                  <li key={sensor.id} className={!sensor.enabled ? "archived" : ""}>
                    <span className="sensor-list-glyph" aria-hidden="true"><span /><span /></span>
                    <div className="sensor-list-copy">
                      <span className="sensor-list-name"><strong>{sensor.name}</strong>{isDemoSensor(sensor) && <span className="sensor-demo-badge">{t("sensors.demoBadge")}</span>}<span className={`sensor-status-badge ${status}`}>{t(`sensors.${status}`)}</span></span>
                      <span className="sensor-list-location"><Home size={13} aria-hidden="true" />{sensor.room} · {floor?.name ?? t("sensors.unknownFloor")}</span>
                      <small>{sensor.model}{sensor.tpLinkDeviceId ? ` · ${t("sensors.boundTo", { id: sensor.tpLinkDeviceId })}` : ` · ${t("sensors.manual")}`}{lastTimestamp ? ` · ${t("sensors.lastSeen", { time: formatInTimeZone(lastTimestamp, locale, sensorTimeZone, { dateStyle: "short", timeStyle: "short" }) })}` : ""}</small>
                    </div>
                    <div className="sensor-list-actions">
                      <button type="button" className="secondary-button" disabled={cleanupBusy} aria-expanded={visibleDetailsSensor?.id === sensor.id} aria-controls="sensor-details-panel" onClick={() => void loadSensorDetails(sensor)}><Database size={14} aria-hidden="true" />{t("sensors.detailsAction", { name: sensor.name })}</button>
                    </div>
                  </li>
                );
              })}
            </ul>
          ) : <div className="sensor-list-empty"><Search size={22} aria-hidden="true" /><strong>{t("sensors.noMatches")}</strong><p>{t("sensors.noMatchesHelp")}</p></div>}
        </section>}

        {!readOnly && <aside className="sensor-side-column">
          {currentSensors.length > 0 && <details className="panel sensor-import-card">
            <summary><span><FileSpreadsheet size={16} aria-hidden="true" /><strong>{t("historyImport.open")}</strong></span><ChevronDown size={16} aria-hidden="true" /></summary>
            <button ref={importButtonRef} type="button" className="secondary-button full-width" disabled={mode !== "closed"} onClick={() => setImportOpen(true)}><FileSpreadsheet size={16} aria-hidden="true" />{t("historyImport.open")}</button>
          </details>}
          <details className="panel sensor-discovery-card" aria-labelledby="sensor-discovery-title">
            <summary><span><RadioTower size={17} aria-hidden="true" /><strong id="sensor-discovery-title">{t("sensors.discovery")}</strong><small>{t("sensors.discoveryCount", { available: addableDevices.length, total: homeTpLinkDevices.length })}</small></span><ChevronDown size={16} aria-hidden="true" /></summary>
            <div>
              <div className="sensor-bridge-status"><span className={`status-pulse ${tpLinkStatus.connected ? "live" : "reconnecting"}`} aria-hidden="true" /><span><strong>{tpLinkStatus.connected ? t("common.connected") : t("status.reconnecting")}</strong><small>{t("sensors.tpLinkBridgeScope")}</small></span></div>
              {(tpLinkDevicesError || refreshError) && <p className="sensor-discovery-error" role="alert"><TriangleAlert size={15} aria-hidden="true" />{refreshError || tpLinkDevicesError}</p>}
              {(tpLinkDevicesLoading || refreshing) && <p className="sensor-discovery-loading" role="status"><LoaderCircle className="spin" size={15} aria-hidden="true" />{t("sensors.refreshing")}</p>}
              <button type="button" className="secondary-button full-width" disabled={tpLinkDevicesLoading || refreshing} onClick={() => void refreshDevices()}><RefreshCw className={tpLinkDevicesLoading || refreshing ? "spin" : ""} size={15} aria-hidden="true" />{t("sensors.refreshDevices")}</button>
            </div>
          </details>
        </aside>}
      </div>
    </>
  );
}

function SensorLabelCard({ sensor }: Readonly<{ sensor: Sensor }>) {
  const { t } = useI18n();
  const [label, setLabel] = useState<SensorLabelDescriptor | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  useEffect(() => {
    let active = true;
    setLabel(null); setError(null); setCopied(false);
    void api.sensorLabel(sensor.id).then((value) => { if (active) setLabel(value); })
      .catch((reason: unknown) => { if (active) setError(reason instanceof Error ? reason.message : t("sensors.labelUnavailable")); });
    return () => { active = false; };
  }, [sensor.id, t]);
  const matrix = useMemo(() => label ? qrCodeMatrix(label.setupUri) : null, [label]);
  const copy = async () => {
    if (!label || !navigator.clipboard?.writeText) return;
    await navigator.clipboard.writeText(label.setupUri);
    setCopied(true);
  };
  if (error) return <p className="sensor-details-error" role="alert"><TriangleAlert size={15} />{error}</p>;
  if (!label || !matrix) return null;
  return <section className="sensor-label-card" aria-labelledby="sensor-label-title">
    <svg className="sensor-label-qr" viewBox={`-4 -4 ${matrix.length + 8} ${matrix.length + 8}`} role="img" aria-label={t("sensors.labelQrAria", { sensor: label.sensorName })} shapeRendering="crispEdges"><rect x="-4" y="-4" width={matrix.length + 8} height={matrix.length + 8} fill="white" />{matrix.flatMap((row, y) => row.map((dark, x) => dark ? <rect key={`${x}:${y}`} x={x} y={y} width="1" height="1" fill="black" /> : null))}</svg>
    <div><span className="eyebrow"><QrCode size={14} aria-hidden="true" />{t("sensors.localSensorLabel")}</span><h3 id="sensor-label-title">{label.sensorName}</h3><p>{label.houseName}{label.roomName ? ` · ${label.roomName}` : ""}</p><code>{label.setupUri}</code><small>{t("sensors.labelHelp")}</small></div>
    <div className="sensor-label-actions"><button type="button" className="secondary-button" onClick={() => void copy()}><Copy size={14} aria-hidden="true" />{copied ? t("sensors.labelCopied") : t("sensors.copyLabelUri")}</button><button type="button" className="primary-button" onClick={() => window.print()}><Printer size={14} aria-hidden="true" />{t("sensors.printLabel")}</button></div>
  </section>;
}

function PlacementPicker({
  floor,
  x,
  y,
  label,
  description,
  coverage,
  suggestion,
  onChange,
}: {
  floor: Floor;
  x: number;
  y: number;
  label: string;
  description: string;
  coverage?: SensorCoverageAssessment | null;
  suggestion?: SensorPlacementSuggestion | null;
  onChange: (point: { x: number; y: number }) => void;
}) {
  const descriptionId = useId();
  const svgRef = useRef<SVGSVGElement>(null);
  const safeWidth = Math.max(1, floor.width);
  const safeHeight = Math.max(1, floor.height);
  const pinRadius = Math.max(.18, Math.min(safeWidth, safeHeight) * .035);
  const moveToPointer = (event: ReactPointerEvent<SVGSVGElement>) => {
    const svg = svgRef.current;
    if (!svg) return;
    const bounds = svg.getBoundingClientRect();
    if (bounds.width <= 0 || bounds.height <= 0) return;
    const scale = Math.min(bounds.width / safeWidth, bounds.height / safeHeight);
    const renderedWidth = safeWidth * scale;
    const renderedHeight = safeHeight * scale;
    const offsetX = (bounds.width - renderedWidth) / 2;
    const offsetY = (bounds.height - renderedHeight) / 2;
    onChange({
      x: clamp((event.clientX - bounds.left - offsetX) / scale, 0, floor.width),
      y: clamp((event.clientY - bounds.top - offsetY) / scale, 0, floor.height),
    });
  };
  const moveWithKeyboard = (event: KeyboardEvent<SVGSVGElement>) => {
    if (!["ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown"].includes(event.key)) return;
    event.preventDefault();
    const multiplier = event.shiftKey ? 5 : 1;
    const xStep = Math.max(.1, floor.width / 100) * multiplier;
    const yStep = Math.max(.1, floor.height / 100) * multiplier;
    onChange({
      x: clamp(x + (event.key === "ArrowRight" ? xStep : event.key === "ArrowLeft" ? -xStep : 0), 0, floor.width),
      y: clamp(y + (event.key === "ArrowDown" ? yStep : event.key === "ArrowUp" ? -yStep : 0), 0, floor.height),
    });
  };
  return (
    <div className="sensor-placement-picker">
      <svg
        ref={svgRef}
        viewBox={`0 0 ${safeWidth} ${safeHeight}`}
        role="group"
        aria-label={label}
        aria-describedby={descriptionId}
        tabIndex={0}
        onPointerDown={moveToPointer}
        onKeyDown={moveWithKeyboard}
      >
        <title>{label}</title>
        <desc>{description}</desc>
        <rect className="sensor-placement-base" x="0" y="0" width={safeWidth} height={safeHeight} rx={Math.min(safeWidth, safeHeight) * .025} />
        <g className="sensor-placement-rooms" aria-hidden="true">{floor.rooms.map((room) => room.points.length > 2 && <polygon key={room.id} points={room.points.map((point) => `${point.x},${point.y}`).join(" ")} />)}</g>
        <g className="sensor-placement-walls" aria-hidden="true">{floor.walls.map((wall) => <line key={wall.id} x1={wall.from.x} y1={wall.from.y} x2={wall.to.x} y2={wall.to.y} />)}</g>
        {coverage && <g className="sensor-placement-coverage" aria-hidden="true">{coverage.regions.filter((region) => region.floorId === floor.id).map((region) => <ellipse
          key={region.id}
          cx={region.x}
          cy={region.y}
          rx={region.radiusX}
          ry={region.radiusY}
          style={{ opacity: .055 + region.support * .075 }}
        />)}</g>}
        {suggestion && <g className="sensor-placement-target" transform={`translate(${suggestion.recommendation.x} ${suggestion.recommendation.y})`} aria-hidden="true">
          <circle r={pinRadius * 2.25} />
          <path d={`M${-pinRadius * .8} 0H${pinRadius * .8}M0 ${-pinRadius * .8}V${pinRadius * .8}`} />
        </g>}
        <g className="sensor-placement-pin" transform={`translate(${clamp(x, 0, floor.width)} ${clamp(y, 0, floor.height)})`} aria-hidden="true"><circle r={pinRadius * 1.8} /><circle r={pinRadius} /><path d={`M0 ${pinRadius * 2.7} L${-pinRadius * .7} ${pinRadius * 1.25} L${pinRadius * .7} ${pinRadius * 1.25}Z`} /></g>
      </svg>
      <p id={descriptionId}><MapPin size={14} aria-hidden="true" />{description}</p>
    </div>
  );
}
