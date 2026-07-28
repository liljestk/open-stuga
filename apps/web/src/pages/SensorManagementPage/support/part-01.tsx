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
  HousePatch,
  IntegrationStatus,
  MeasurementSample,
  Metric,
  Sensor,
  SensorLabelDescriptor,
  TpLinkDiscoveredDevice,
  UnitSystem,
} from "@climate-twin/contracts";
import { api, type CreateSensorInput, type HistoricalImportResult, type SensorPatch } from "../../../api";
import type { ClimateState, TimeRange } from "../../../domain";
import { useI18n, type TranslationKey } from "../../../i18n";
import { formatInTimeZone } from "../../../dateTime";
import { measurementLabel } from "../../../measurements";
import { useNow } from "../../../useNow";
import { integrationForHouse } from "../../../integrationScope";
import { assessSensorCoverage, suggestSensorPlacement, type SensorCoverageAssessment, type SensorPlacementSuggestion } from "../../../experimentalSpatialLayers";
import { configuredSpatialMaxSampleAgeMs } from "../../../spatialFreshness";
import { useSpatialLayers } from "../../../useSpatialLayers";
import { qrCodeMatrix } from "../../../qrCode";
import { TrendChart } from "../../../components/TrendChart";
import { isTpLinkContactDevice } from "../../../tpLinkDeviceClassification";

export const HistoricalImportWizard = lazy(() => import("../../../components/HistoricalImportWizard")
  .then((module) => ({ default: module.HistoricalImportWizard })));

export interface SensorManagementPageProps {
  state: ClimateState;
  house: House;
  houses: House[];
  integration: IntegrationStatus;
  tpLinkDevices: TpLinkDiscoveredDevice[];
  tpLinkDevicesLoading: boolean;
  tpLinkDevicesError: string | null;
  requestedDevice?: {
    deviceId: string;
    connectionId: string | null;
    model?: string;
    alias?: string | null;
    deviceType?: "climate" | "contact" | "energy" | "unknown";
  } | null;
  /** Compatibility for older embedders; ambiguous across multiple connections. */
  requestedDeviceId?: string | null;
  readOnly?: boolean;
  /** Integration bindings and historical imports remain with the authoritative Home. */
  localAuthority?: boolean;
  units?: UnitSystem;
  onRequestedDeviceHandled?: () => void;
  onLoadSeries?: (sensorId: string, metric: Metric, range: TimeRange, forecastSupported: boolean) => void;
  onHouse: (houseId: string) => void;
  onUpdateHouse: (houseId: string, patch: HousePatch) => Promise<House>;
  onRefreshDevices: () => Promise<void>;
  onCreateSensor: (sensor: CreateSensorInput) => Promise<Sensor>;
  onUpdateSensor: (sensorId: string, patch: SensorPatch) => Promise<Sensor>;
  onDeleteSensor: (sensorId: string) => Promise<void>;
  onImportHistoricalData: (
    samples: MeasurementSample[],
    onProgress: (completed: number, total: number) => void,
  ) => Promise<HistoricalImportResult>;
}

export type EditorMode = "closed" | "add" | "edit";

export type AddStep = 1 | 2 | 3 | 4;

export type SensorFilter = "all" | "live" | "waiting" | "unplaced" | "archived";

export type SensorStatus = Exclude<SensorFilter, "all">;

export type DraftSource = "tp-link" | "manual";

export interface SensorDraft {
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

export type DraftErrors = Partial<Record<"source" | "name" | "model" | "house" | "floor" | "room" | "x" | "y" | "height", string>>;

export type Feedback = { kind: "success" | "error"; message: string } | null;

export type Translate = (key: TranslationKey, values?: Record<string, string | number>) => string;

export const UNPLACED_TAG = "unplaced";

export function clamp(value: number, minimum: number, maximum: number): number {
  return Math.min(maximum, Math.max(minimum, value));
}

export function rounded(value: number): number {
  return Number(value.toFixed(2));
}

export function tpLinkDeviceSummary(device: TpLinkDiscoveredDevice, t: Translate, locale: string): string {
  const hasPower = typeof device.power === "number" && Number.isFinite(device.power);
  const hasEnergy = typeof device.energy === "number" && Number.isFinite(device.energy);
  const kind = isTpLinkContactDevice(device)
    ? t("sensors.contactDevice")
    : hasPower || hasEnergy ? t("sensors.energyEndpoint") : t("sensors.climateDevice");
  const number = new Intl.NumberFormat(locale, { maximumFractionDigits: 3 });
  return [
    device.model,
    kind,
    device.deviceId,
    hasPower ? t("sensors.devicePower", { value: number.format(device.power!) }) : null,
    hasEnergy ? t("sensors.deviceEnergy", { value: number.format(device.energy!) }) : null,
  ].filter((value): value is string => Boolean(value)).join(" · ");
}

export function roomCenter(floor: Floor, roomName?: string): { x: number; y: number } {
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

export function stableRoomId(floor: Floor, roomLabel: string): string | null {
  const matches = floor.rooms.filter((room) => room.name === roomLabel);
  return matches.length === 1 ? matches[0]!.id : null;
}

export function initialDraft(house: House): SensorDraft {
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

export function sensorMeasurementEntityIds(sensor: Sensor): Record<string, string> {
  return {
    ...(sensor.temperatureEntityId ? { temperature: sensor.temperatureEntityId } : {}),
    ...(sensor.humidityEntityId ? { humidity: sensor.humidityEntityId } : {}),
    ...(sensor.measurementEntityIds ?? {}),
  };
}

export function sensorHasMetric(state: ClimateState, sensor: Sensor, metric: Metric): boolean {
  return Boolean(
    state.latestMeasurements[sensor.id]?.[metric]
    || state.measurementHistory[sensor.id]?.[metric]?.length
    || state.measurementForecasts[sensor.id]?.[metric]?.length
    || sensor.measurementEntityIds?.[metric]
    || (metric === "temperature" && sensor.temperatureEntityId)
    || (metric === "humidity" && sensor.humidityEntityId),
  );
}

export function mergeMetricSamples(...sampleGroups: MeasurementSample[][]): MeasurementSample[] {
  const byTimestamp = new Map<string, MeasurementSample>();
  for (const sample of sampleGroups.flat()) byTimestamp.set(sample.timestamp, sample);
  return [...byTimestamp.values()].sort((left, right) => Date.parse(left.timestamp) - Date.parse(right.timestamp));
}

export function normalizedMeasurementEntityIds(values: Record<string, string>): Record<string, string> {
  return Object.fromEntries(Object.entries(values).flatMap(([metric, entityId]) => {
    const normalized = entityId.trim();
    return normalized ? [[metric, normalized]] : [];
  }));
}

export function sameMeasurementEntityIds(first: Record<string, string>, second: Record<string, string>): boolean {
  const firstEntries = Object.entries(first).sort(([left], [right]) => left.localeCompare(right));
  const secondEntries = Object.entries(second).sort(([left], [right]) => left.localeCompare(right));
  return firstEntries.length === secondEntries.length
    && firstEntries.every(([metric, entityId], index) => {
      const candidate = secondEntries[index];
      return candidate?.[0] === metric && candidate[1] === entityId;
    });
}

export function isDemoSensor(sensor: Sensor): boolean {
  return sensor.tags.some((tag) => ["seeded", "demo", "mock"].includes(tag.trim().toLocaleLowerCase()));
}

export function hasRealBinding(sensor: Pick<Sensor, "tpLinkDeviceId" | "temperatureEntityId" | "humidityEntityId" | "measurementEntityIds">): boolean {
  return Boolean(sensor.tpLinkDeviceId || sensor.temperatureEntityId || sensor.humidityEntityId
    || Object.keys(sensor.measurementEntityIds ?? {}).length > 0);
}

export function hasHomeAssistantBinding(
  sensor: Pick<Sensor, "temperatureEntityId" | "humidityEntityId" | "batteryEntityId" | "measurementEntityIds">,
): boolean {
  return Boolean(sensor.temperatureEntityId || sensor.humidityEntityId || sensor.batteryEntityId
    || Object.keys(sensor.measurementEntityIds ?? {}).length > 0);
}

export function draftForSensor(sensor: Sensor, houses: House[]): SensorDraft {
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

export function draftContext(draft: SensorDraft, houses: House[]): { house: House | undefined; floor: Floor | undefined } {
  const house = houses.find((candidate) => candidate.id === draft.houseId);
  return { house, floor: house?.floors.find((candidate) => candidate.id === draft.floorId) };
}

export function sensorFloor(sensor: Sensor, houses: House[]): Floor | undefined {
  return houses.find((candidate) => candidate.id === sensor.houseId)?.floors.find((candidate) => candidate.id === sensor.floorId);
}

export function isUnplaced(sensor: Sensor, houses: House[]): boolean {
  const floor = sensorFloor(sensor, houses);
  return sensor.tags.includes(UNPLACED_TAG)
    || !floor
    || ![sensor.x, sensor.y, sensor.z].every(Number.isFinite)
    || sensor.x < 0
    || sensor.x > floor.width
    || sensor.y < 0
    || sensor.y > floor.height;
}

export function latestSensorTimestamp(state: ClimateState, sensorId: string): number | null {
  const timestamps = [
    state.readings[sensorId]?.timestamp,
    ...Object.values(state.latestMeasurements[sensorId] ?? {}).map((sample) => sample.timestamp),
  ].flatMap((value) => value && Number.isFinite(Date.parse(value)) ? [Date.parse(value)] : []);
  return timestamps.length ? Math.max(...timestamps) : null;
}

export function isLive(state: ClimateState, sensor: Sensor, houses: House[], now: number): boolean {
  if (!sensor.enabled || isUnplaced(sensor, houses)) return false;
  const timestamp = latestSensorTimestamp(state, sensor.id);
  return timestamp !== null && timestamp <= now + 5 * 60_000 && now - timestamp <= 10 * 60_000;
}

export function sensorStatus(state: ClimateState, sensor: Sensor, houses: House[], now: number): SensorStatus {
  if (!sensor.enabled) return "archived";
  if (isUnplaced(sensor, houses)) return "unplaced";
  return isLive(state, sensor, houses, now) ? "live" : "waiting";
}

export function validationErrors(draft: SensorDraft, houses: House[], t: Translate): DraftErrors {
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
