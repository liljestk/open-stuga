import {
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
  ChevronLeft,
  ChevronRight,
  CircleDot,
  Edit3,
  FileSpreadsheet,
  Home,
  LoaderCircle,
  MapPin,
  Plus,
  RadioTower,
  RefreshCw,
  RotateCcw,
  Search,
  ThermometerSun,
  TriangleAlert,
  X,
} from "lucide-react";
import type {
  Floor,
  House,
  IntegrationStatus,
  MeasurementSample,
  Sensor,
  TpLinkDiscoveredDevice,
} from "@climate-twin/contracts";
import type { CreateSensorInput, HistoricalImportResult, SensorPatch } from "../api";
import type { ClimateState } from "../domain";
import { useI18n, type TranslationKey } from "../i18n";
import { HistoricalImportWizard } from "../components/HistoricalImportWizard";
import { formatInTimeZone } from "../dateTime";
import { useNow } from "../useNow";

export interface SensorManagementPageProps {
  state: ClimateState;
  house: House;
  houses: House[];
  integration: IntegrationStatus;
  tpLinkDevices: TpLinkDiscoveredDevice[];
  tpLinkDevicesLoading: boolean;
  tpLinkDevicesError: string | null;
  onHouse: (houseId: string) => void;
  onRefreshDevices: () => Promise<void>;
  onCreateSensor: (sensor: CreateSensorInput) => Promise<Sensor>;
  onUpdateSensor: (sensorId: string, patch: SensorPatch) => Promise<Sensor>;
  onImportHistoricalData: (
    samples: MeasurementSample[],
    onProgress: (completed: number, total: number) => void,
  ) => Promise<HistoricalImportResult>;
}

type EditorMode = "closed" | "add" | "edit";
type AddStep = 1 | 2 | 3 | 4;
type SensorFilter = "all" | "live" | "waiting" | "unplaced" | "archived";
type DraftSource = "tp-link" | "manual";

interface SensorDraft {
  source: DraftSource;
  deviceId: string;
  name: string;
  model: string;
  houseId: string;
  floorId: string;
  room: string;
  x: string;
  y: string;
  height: string;
  enabled: boolean;
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

function initialDraft(house: House): SensorDraft {
  const floor = house.floors[0];
  const center = floor ? roomCenter(floor) : { x: 0, y: 0 };
  return {
    source: "tp-link",
    deviceId: "",
    name: "",
    model: "",
    houseId: house.id,
    floorId: floor?.id ?? "",
    room: floor?.rooms[0]?.name ?? "",
    x: String(rounded(center.x)),
    y: String(rounded(center.y)),
    height: "1.4",
    enabled: true,
  };
}

function draftForSensor(sensor: Sensor, houses: House[]): SensorDraft {
  const house = houses.find((candidate) => candidate.id === sensor.houseId);
  const floor = house?.floors.find((candidate) => candidate.id === sensor.floorId);
  return {
    source: sensor.tpLinkDeviceId ? "tp-link" : "manual",
    deviceId: sensor.tpLinkDeviceId ?? "",
    name: sensor.name,
    model: sensor.model,
    houseId: sensor.houseId,
    floorId: sensor.floorId,
    room: sensor.room,
    x: String(rounded(sensor.x)),
    y: String(rounded(sensor.y)),
    height: String(rounded(sensor.z - (floor?.elevation ?? 0))),
    enabled: sensor.enabled,
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

function availableForSensor(device: TpLinkDiscoveredDevice, sensorId: string | null, usedDeviceIds: Set<string>): boolean {
  if (sensorId && device.mappedSensorId === sensorId) return true;
  return device.mappedSensorId === null && !usedDeviceIds.has(device.deviceId);
}

export function SensorManagementPage({
  state,
  house,
  houses,
  integration,
  tpLinkDevices,
  tpLinkDevicesLoading,
  tpLinkDevicesError,
  onHouse,
  onRefreshDevices,
  onCreateSensor,
  onUpdateSensor,
  onImportHistoricalData,
}: SensorManagementPageProps) {
  const { locale, t } = useI18n();
  const now = useNow();
  const formId = useId().replace(/:/g, "");
  const editorHeadingRef = useRef<HTMLHeadingElement>(null);
  const editorOpenerRef = useRef<HTMLElement | null>(null);
  const importButtonRef = useRef<HTMLButtonElement>(null);
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
  const [refreshing, setRefreshing] = useState(false);
  const [refreshError, setRefreshError] = useState<string | null>(null);
  const [importOpen, setImportOpen] = useState(false);

  const currentSensors = useMemo(
    () => state.sensors.filter((sensor) => sensor.houseId === house.id),
    [state.sensors, house.id],
  );
  const usedDeviceIds = useMemo(
    () => new Set(state.sensors.flatMap((sensor) => sensor.tpLinkDeviceId ? [sensor.tpLinkDeviceId] : [])),
    [state.sensors],
  );
  const addableDevices = useMemo(
    () => tpLinkDevices.filter((device) => availableForSensor(device, null, usedDeviceIds)),
    [tpLinkDevices, usedDeviceIds],
  );
  const normalizedSearch = search.trim().toLocaleLowerCase(locale);
  const visibleSensors = useMemo(() => currentSensors.filter((sensor) => {
    const matchesSearch = !normalizedSearch || [sensor.name, sensor.room, sensor.model, sensor.id, sensor.tpLinkDeviceId ?? ""]
      .some((value) => value.toLocaleLowerCase(locale).includes(normalizedSearch));
    if (!matchesSearch) return false;
    const unplaced = isUnplaced(sensor, houses);
    const live = isLive(state, sensor, houses, now);
    if (filter === "live") return live;
    if (filter === "waiting") return sensor.enabled && !unplaced && !live;
    if (filter === "unplaced") return unplaced;
    if (filter === "archived") return !sensor.enabled;
    return true;
  }), [currentSensors, filter, houses, locale, normalizedSearch, now, state]);
  const { house: draftHouse, floor: draftFloor } = draftContext(draft, houses);
  const editingSensor = editingSensorId ? state.sensors.find((sensor) => sensor.id === editingSensorId) ?? null : null;
  const selectableDevices = tpLinkDevices.filter((device) => availableForSensor(device, editingSensorId, usedDeviceIds));
  const currentBindingMissing = Boolean(draft.deviceId && !selectableDevices.some((device) => device.deviceId === draft.deviceId));

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

  const chooseSource = (source: DraftSource) => {
    setDraft((current) => ({
      ...current,
      source,
      deviceId: source === "manual" ? "" : current.deviceId,
    }));
    clearError("source");
    setEditorFeedback(null);
  };

  const chooseDevice = (device: TpLinkDiscoveredDevice) => {
    setDraft((current) => ({
      ...current,
      source: "tp-link",
      deviceId: device.deviceId,
      name: current.name.trim() || device.alias?.trim() || `${device.model} sensor`,
      model: device.model,
    }));
    clearError("source");
    setEditorFeedback(null);
  };

  const changeDraftHouse = (houseId: string) => {
    const nextHouse = houses.find((candidate) => candidate.id === houseId);
    const nextFloor = nextHouse?.floors[0];
    const center = nextFloor ? roomCenter(nextFloor) : { x: 0, y: 0 };
    setDraft((current) => ({
      ...current,
      houseId,
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
    if (submitting) return;
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
      const input: CreateSensorInput = {
        houseId: draft.houseId,
        floorId: draft.floorId,
        name: draft.name.trim(),
        room: draft.room.trim(),
        model: draft.model.trim(),
        x: placement.x,
        y: placement.y,
        z: placement.z,
        tags: [],
        enabled: true,
        ...(draft.source === "tp-link" && draft.deviceId ? { tpLinkDeviceId: draft.deviceId } : {}),
      };
      const saved = await onCreateSensor(input);
      setPageFeedback({ kind: "success", message: t("sensors.added", { name: saved.name }) });
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
    if (submitting || !editingSensor) return;
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
      const patch = {
        houseId: draft.houseId,
        floorId: draft.floorId,
        name: draft.name.trim(),
        room: draft.room.trim(),
        model: draft.model.trim(),
        x: placement.x,
        y: placement.y,
        z: placement.z,
        enabled: draft.enabled,
        tags: editingSensor.tags.filter((tag) => tag !== UNPLACED_TAG),
        tpLinkDeviceId: draft.deviceId || null,
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
    if (rowBusyId) return;
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

  const refreshDevices = async () => {
    if (refreshing || tpLinkDevicesLoading) return;
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
        value={draft.deviceId}
        onChange={(event) => {
          const deviceId = event.target.value;
          setDraft((current) => ({ ...current, deviceId, source: deviceId ? "tp-link" : "manual" }));
          clearError("source");
        }}
      >
        <option value="">{t("sensors.noBinding")}</option>
        {currentBindingMissing && <option value={draft.deviceId}>{draft.deviceId}</option>}
        {selectableDevices.map((device) => (
          <option key={device.deviceId} value={device.deviceId}>
            {device.alias || device.model} · {device.deviceId}
          </option>
        ))}
      </select>
      <small>{t("sensors.bindingHelp")}</small>
    </label>
  );

  const renderLocationFields = () => draftFloor ? (
    <div className="sensor-location-editor">
      <PlacementPicker
        floor={draftFloor}
        x={Number.isFinite(Number(draft.x)) ? Number(draft.x) : 0}
        y={Number.isFinite(Number(draft.y)) ? Number(draft.y) : 0}
        label={t("sensors.placementMap", { floor: draftFloor.name })}
        description={t("sensors.placementHelp")}
        onChange={(point) => {
          setDraft((current) => ({ ...current, x: String(rounded(point.x)), y: String(rounded(point.y)) }));
          clearError("x");
          clearError("y");
        }}
      />
      <div className="sensor-coordinate-fields">
        <label className="field">
          <span>{t("sensors.xPosition")}</span>
          <input id={`${formId}-x`} type="number" min="0" max={draftFloor.width} step="0.1" required value={draft.x} onChange={(event) => { setDraft((current) => ({ ...current, x: event.target.value })); clearError("x"); }} {...fieldA11y("x")} />
          {renderFieldError("x")}
        </label>
        <label className="field">
          <span>{t("sensors.yPosition")}</span>
          <input id={`${formId}-y`} type="number" min="0" max={draftFloor.height} step="0.1" required value={draft.y} onChange={(event) => { setDraft((current) => ({ ...current, y: event.target.value })); clearError("y"); }} {...fieldA11y("y")} />
          {renderFieldError("y")}
        </label>
        <label className="field">
          <span>{t("sensors.mountingHeight")}</span>
          <span className="input-suffix"><input id={`${formId}-height`} type="number" min="0" step="0.1" required value={draft.height} onChange={(event) => { setDraft((current) => ({ ...current, height: event.target.value })); clearError("height"); }} {...fieldA11y("height")} /><span aria-hidden="true">m</span></span>
          {renderFieldError("height")}
        </label>
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
                  <button key={device.deviceId} type="button" className={draft.deviceId === device.deviceId ? "selected" : ""} aria-pressed={draft.deviceId === device.deviceId} onClick={() => chooseDevice(device)}>
                    <span className="device-radio"><span /></span>
                    <span><strong>{device.alias || t("sensors.unnamedDevice")}</strong><small>{device.model} · {device.deviceId}</small></span>
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
        {addStep === 2 && <div className="sensor-editor-section">{renderDetailsFields()}</div>}
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
        <section aria-labelledby={`${formId}-location-title`}><h3 id={`${formId}-location-title`}>{t("sensors.locationSection")}</h3>{renderLocationFields()}</section>
        <section aria-labelledby={`${formId}-connection-title`}><h3 id={`${formId}-connection-title`}>{t("sensors.connectionSection")}</h3>{renderBindingField()}<label className="sensor-toggle"><input type="checkbox" checked={draft.enabled} onChange={(event) => setDraft((current) => ({ ...current, enabled: event.target.checked }))} /><span><strong>{t("sensors.enabled")}</strong><small>{t("sensors.enabledHelp")}</small></span></label></section>
        {editorFeedback && <p className={`sensor-form-feedback ${editorFeedback.kind}`} role={editorFeedback.kind === "error" ? "alert" : "status"}>{editorFeedback.kind === "error" ? <TriangleAlert size={16} aria-hidden="true" /> : <Check size={16} aria-hidden="true" />}{editorFeedback.message}</p>}
        <div className="sensor-editor-actions"><button type="button" className="secondary-button" onClick={cancelEditor}>{t("common.cancel")}</button><span /><button type="submit" className="primary-button" disabled={submitting}>{submitting ? <LoaderCircle className="spin" size={16} aria-hidden="true" /> : <Check size={16} aria-hidden="true" />}{submitting ? t("common.saving") : t("sensors.saveChanges")}</button></div>
      </form>
    </section>
  );

  return (
    <>
      <header className="page-heading sensor-page-heading">
        <div><span className="eyebrow"><RadioTower size={14} aria-hidden="true" />{t("sensors.eyebrow")}</span><h1>{t("sensors.title")}</h1><p>{t("sensors.description")}</p></div>
        <div className="sensor-heading-actions">
          <button ref={importButtonRef} type="button" className="secondary-button" disabled={currentSensors.length === 0 || mode !== "closed"} title={currentSensors.length === 0 ? t("historyImport.noSensors") : undefined} onClick={() => setImportOpen(true)}><FileSpreadsheet size={16} aria-hidden="true" />{t("historyImport.open")}</button>
          <button type="button" className="primary-button" onClick={beginAdd} disabled={mode !== "closed"}><Plus size={16} aria-hidden="true" />{t("sensors.add")}</button>
        </div>
      </header>

      <HistoricalImportWizard
        open={importOpen}
        house={house}
        sensors={currentSensors}
        definitions={state.measurementDefinitions.filter((definition) => definition.enabled)}
        onClose={closeImport}
        onImport={onImportHistoricalData}
      />

      {pageFeedback && <p className={`sensor-page-feedback ${pageFeedback.kind}`} role={pageFeedback.kind === "error" ? "alert" : "status"}>{pageFeedback.kind === "error" ? <TriangleAlert size={16} aria-hidden="true" /> : <Check size={16} aria-hidden="true" />}{pageFeedback.message}<button type="button" className="icon-button small" onClick={() => setPageFeedback(null)} aria-label={t("common.close")}><X size={14} /></button></p>}

      <section className="sensor-overview" aria-label={t("sensors.overview") }>
        <div><span className="sensor-overview-icon"><ThermometerSun size={18} aria-hidden="true" /></span><span><small>{t("sensors.total")}</small><strong>{currentSensors.length}</strong></span></div>
        <div><span className="sensor-overview-icon live"><CircleDot size={18} aria-hidden="true" /></span><span><small>{t("sensors.live")}</small><strong>{currentSensors.filter((sensor) => isLive(state, sensor, houses, now)).length}</strong></span></div>
        <div><span className="sensor-overview-icon unplaced"><MapPin size={18} aria-hidden="true" /></span><span><small>{t("sensors.unplaced")}</small><strong>{currentSensors.filter((sensor) => isUnplaced(sensor, houses)).length}</strong></span></div>
        <div><span className="sensor-overview-icon archived"><Archive size={18} aria-hidden="true" /></span><span><small>{t("sensors.archived")}</small><strong>{currentSensors.filter((sensor) => !sensor.enabled).length}</strong></span></div>
      </section>

      {mode === "add" && renderAddEditor()}
      {mode === "edit" && renderEditEditor()}

      <div className="sensor-workspace">
        <section className="panel sensor-list-panel" aria-labelledby="sensor-list-title">
          <div className="sensor-list-header">
            <div><span className="eyebrow">{t("sensors.inventory")}</span><h2 id="sensor-list-title">{t("sensors.houseSensors", { house: house.name })}</h2></div>
            <label className="sensor-house-picker"><span>{t("common.house")}</span><select value={house.id} onChange={(event) => onHouse(event.target.value)}>{houses.map((candidate) => <option key={candidate.id} value={candidate.id}>{candidate.name}</option>)}</select></label>
          </div>
          <div className="sensor-list-controls">
            <label className="sensor-search"><span className="sr-only">{t("sensors.search")}</span><Search size={16} aria-hidden="true" /><input type="search" value={search} onChange={(event) => setSearch(event.target.value)} placeholder={t("sensors.searchPlaceholder")} /></label>
            <label className="sensor-filter"><span className="sr-only">{t("sensors.filter")}</span><select value={filter} onChange={(event) => setFilter(event.target.value as SensorFilter)}><option value="all">{t("sensors.filterAll")}</option><option value="live">{t("sensors.filterLive")}</option><option value="waiting">{t("sensors.filterWaiting")}</option><option value="unplaced">{t("sensors.filterUnplaced")}</option><option value="archived">{t("sensors.filterArchived")}</option></select></label>
          </div>
          {visibleSensors.length > 0 ? (
            <ul className="sensor-inventory-list">
              {visibleSensors.map((sensor) => {
                const floor = sensorFloor(sensor, houses);
                const unplaced = isUnplaced(sensor, houses);
                const live = isLive(state, sensor, houses, now);
                const lastTimestamp = latestSensorTimestamp(state, sensor.id);
                const sensorTimeZone = houses.find((candidate) => candidate.id === sensor.houseId)?.timezone;
                return (
                  <li key={sensor.id} className={!sensor.enabled ? "archived" : ""}>
                    <span className="sensor-list-glyph" aria-hidden="true"><span /><span /></span>
                    <div className="sensor-list-copy">
                      <span className="sensor-list-name"><strong>{sensor.name}</strong>{!sensor.enabled ? <span className="sensor-status-badge archived">{t("sensors.archived")}</span> : live ? <span className="sensor-status-badge live">{t("sensors.live")}</span> : <span className="sensor-status-badge waiting">{t("sensors.waiting")}</span>}{unplaced && <span className="sensor-status-badge unplaced">{t("sensors.unplaced")}</span>}</span>
                      <span className="sensor-list-location"><Home size={13} aria-hidden="true" />{sensor.room} · {floor?.name ?? t("sensors.unknownFloor")}</span>
                      <small>{sensor.model}{sensor.tpLinkDeviceId ? ` · ${t("sensors.boundTo", { id: sensor.tpLinkDeviceId })}` : ` · ${t("sensors.manual")}`}{lastTimestamp ? ` · ${t("sensors.lastSeen", { time: formatInTimeZone(lastTimestamp, locale, sensorTimeZone, { dateStyle: "short", timeStyle: "short" }) })}` : ""}</small>
                    </div>
                    <div className="sensor-list-actions">
                      <button type="button" className="secondary-button" disabled={mode !== "closed"} onClick={() => beginEdit(sensor)}><Edit3 size={14} aria-hidden="true" />{t("sensors.editAction", { name: sensor.name })}</button>
                      <button type="button" className="secondary-button archive-action" disabled={mode !== "closed" || rowBusyId === sensor.id} onClick={() => void setArchived(sensor, sensor.enabled)}>{rowBusyId === sensor.id ? <LoaderCircle className="spin" size={14} aria-hidden="true" /> : sensor.enabled ? <Archive size={14} aria-hidden="true" /> : <RotateCcw size={14} aria-hidden="true" />}{sensor.enabled ? t("sensors.archiveAction", { name: sensor.name }) : t("sensors.restoreAction", { name: sensor.name })}</button>
                    </div>
                  </li>
                );
              })}
            </ul>
          ) : <div className="sensor-list-empty"><Search size={22} aria-hidden="true" /><strong>{t("sensors.noMatches")}</strong><p>{t("sensors.noMatchesHelp")}</p></div>}
        </section>

        <aside className="sensor-side-column">
          <section className="panel sensor-discovery-card" aria-labelledby="sensor-discovery-title">
            <div className="panel-header"><div><span className="eyebrow">TP-Link H100/H200</span><h2 id="sensor-discovery-title">{t("sensors.discovery")}</h2></div><span className={`sensor-bridge-mark ${integration.tpLink.connected ? "connected" : ""}`}><RadioTower size={19} aria-hidden="true" /></span></div>
            <div className="sensor-bridge-status"><span className={`status-pulse ${integration.tpLink.connected ? "live" : ""}`} aria-hidden="true" /><span><strong>{integration.tpLink.connected ? t("common.connected") : t("common.notConnected")}</strong><small>{t("sensors.discoveryCount", { available: addableDevices.length, total: tpLinkDevices.length })}</small></span></div>
            {(tpLinkDevicesError || refreshError) && <p className="sensor-discovery-error" role="alert"><TriangleAlert size={15} aria-hidden="true" />{refreshError || tpLinkDevicesError}</p>}
            {(tpLinkDevicesLoading || refreshing) && <p className="sensor-discovery-loading" role="status"><LoaderCircle className="spin" size={15} aria-hidden="true" />{t("sensors.refreshing")}</p>}
            <button type="button" className="secondary-button full-width" disabled={tpLinkDevicesLoading || refreshing} onClick={() => void refreshDevices()}><RefreshCw className={tpLinkDevicesLoading || refreshing ? "spin" : ""} size={15} aria-hidden="true" />{t("sensors.refreshDevices")}</button>
          </section>
          {mode === "closed" && (
            <section className="panel sensor-help-card">
              <span className="sensor-help-icon"><MapPin size={20} aria-hidden="true" /></span><div><h2>{t("sensors.easySetup")}</h2><p>{t("sensors.easySetupHelp")}</p><button type="button" className="secondary-button" onClick={beginAdd}><Plus size={15} aria-hidden="true" />{t("sensors.startSetup")}</button></div>
            </section>
          )}
        </aside>
      </div>
    </>
  );
}

function PlacementPicker({
  floor,
  x,
  y,
  label,
  description,
  onChange,
}: {
  floor: Floor;
  x: number;
  y: number;
  label: string;
  description: string;
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
    onChange({
      x: clamp((event.clientX - bounds.left) / bounds.width * floor.width, 0, floor.width),
      y: clamp((event.clientY - bounds.top) / bounds.height * floor.height, 0, floor.height),
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
        <g className="sensor-placement-pin" transform={`translate(${clamp(x, 0, floor.width)} ${clamp(y, 0, floor.height)})`} aria-hidden="true"><circle r={pinRadius * 1.8} /><circle r={pinRadius} /><path d={`M0 ${pinRadius * 2.7} L${-pinRadius * .7} ${pinRadius * 1.25} L${pinRadius * .7} ${pinRadius * 1.25}Z`} /></g>
      </svg>
      <p id={descriptionId}><MapPin size={14} aria-hidden="true" />{description}</p>
    </div>
  );
}
