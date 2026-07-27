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
import { useSensorManagementPagePart01 } from "./part-01";
export function useSensorManagementPagePart02(context: ReturnType<typeof useSensorManagementPagePart01>) {
  const { state, house, houses, integration, tpLinkDevices, tpLinkDevicesLoading, tpLinkDevicesError, requestedDevice, requestedDeviceId, readOnly, localAuthority, units, onRequestedDeviceHandled, onLoadSeries, onHouse, onRefreshDevices, onCreateSensor, onUpdateSensor, onDeleteSensor, onImportHistoricalData, locale, t, now, tpLinkStatus, formId, pageHeadingRef, editorHeadingRef, editorOpenerRef, importButtonRef, detailsHeadingRef, detailsOpenerRef, detailsRequestGeneration, search, setSearch, filter, setFilter, mode, setMode, addStep, setAddStep, editingSensorId, setEditingSensorId, attachSensorId, setAttachSensorId, draft, setDraft, errors, setErrors, editorFeedback, setEditorFeedback, pageFeedback, setPageFeedback, submitting, setSubmitting, rowBusyId, setRowBusyId, cleanupBusy, setCleanupBusy, refreshing, setRefreshing, refreshError, setRefreshError, importOpen, setImportOpen, detailsSensor, setDetailsSensor, detailSamples, setDetailSamples, detailCursor, setDetailCursor, detailsLoading, setDetailsLoading, detailsError, setDetailsError, detailMetric, setDetailMetric, detailRange, setDetailRange, currentSensors, currentSensorIds, visibleDetailsSensor, demoSensors, hasExistingRealBoundSensor, enabledMeasurementDefinitions, detailDefinitions, detailDefinition, detailHistory, usedDeviceIds, homeTpLinkDevices, addableDevices, attachableSensors, sensorStatuses, statusCounts, normalizedSearch, visibleSensors, draftHouse, draftFloor, editingSensor, selectableDevices, currentBindingMissing, draftDevice, energyOnlyDraft, placementAnalysisEnabled, placementLayerScope, placementLayers, placementCoverage, placementSuggestion } = context;
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
      if (!localAuthority || addableDevices.length === 0) next.source = "manual";
      setDraft(next);
      setMode("add");
      setAddStep(1);
      setEditingSensorId(null);
      setAttachSensorId("");
      setErrors({});
      setEditorFeedback(null);
    };
  const beginEdit = (sensor: Sensor) => {
      if (readOnly) return;
      editorOpenerRef.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
      setDraft(draftForSensor(sensor, houses));
      setMode("edit");
      setEditingSensorId(sensor.id);
      setAttachSensorId("");
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
      setAttachSensorId("");
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
      const alias = device.alias?.trim().toLocaleLowerCase(locale);
      const likelyExisting = alias
        ? attachableSensors.find((sensor) => sensor.name.trim().toLocaleLowerCase(locale) === alias)
        : undefined;
      setAttachSensorId(likelyExisting?.id ?? attachableSensors[0]?.id ?? "");
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
  const attachDeviceToExistingSensor = () => {
      const sensor = attachableSensors.find((candidate) => candidate.id === attachSensorId);
      const device = draftDevice;
      if (!sensor || !device) return;
      setDraft({
        ...draftForSensor(sensor, houses),
        source: "tp-link",
        deviceId: device.deviceId,
        connectionId: device.connectionId ?? "",
      });
      setMode("edit");
      setEditingSensorId(sensor.id);
      setAttachSensorId("");
      setErrors({});
      setEditorFeedback(null);
    };
  useEffect(() => {
      const requested = requestedDevice ?? (requestedDeviceId ? { deviceId: requestedDeviceId, connectionId: null } : null);
      if (readOnly || !localAuthority || !requested || mode !== "closed") return;
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
    }, [addableDevices, house, localAuthority, mode, onRequestedDeviceHandled, readOnly, requestedDevice, requestedDeviceId, tpLinkDevicesLoading]);
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
  return Object.assign(context, { clearError, beginAdd, beginEdit, restoreEditorFocus, cancelEditor, closeImport, loadSensorDetails, closeSensorDetails, chooseSource, chooseDevice, attachDeviceToExistingSensor, changeDraftHouse, changeDraftFloor, focusFirstError, advanceAdd, retreatAdd, buildPlacement });
}