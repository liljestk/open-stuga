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
import { isLegacyTpLinkContactSensor, tpLinkOpeningMatchesDevice } from "../../tpLinkDeviceClassification";
import { HistoricalImportWizard, PlacementPicker, SensorLabelCard, UNPLACED_TAG, availableForSensor, clamp, deviceBindingKey, draftContext, draftForSensor, errorMessage, hasHomeAssistantBinding, hasRealBinding, initialDraft, isDemoSensor, isLive, isUnplaced, latestSensorTimestamp, mergeMetricSamples, normalizedMeasurementEntityIds, roomCenter, rounded, sameMeasurementEntityIds, sensorFloor, sensorHasMetric, sensorMeasurementEntityIds, sensorStatus, stableRoomId, tpLinkDeviceSummary, validationErrors } from "./support";
import type { AddStep, DraftErrors, DraftSource, EditorMode, Feedback, SensorDraft, SensorFilter, SensorManagementPageProps, SensorStatus, Translate } from "./support";
import { useSensorManagementPagePart01 } from "./part-01";
import { sensorUrlStateFromLocation, writeSensorUrlStateToLocation, type SensorDetailTarget } from "./urlState";
export function useSensorManagementPagePart02(context: ReturnType<typeof useSensorManagementPagePart01>) {
  const { state, house, houses, integration, tpLinkDevices, tpLinkDevicesLoading, tpLinkDevicesError, requestedDevice, requestedDeviceId, readOnly, localAuthority, units, onRequestedDeviceHandled, onLoadSeries, onHouse, onUpdateHouse, onRefreshDevices, onCreateSensor, onUpdateSensor, onDeleteSensor, onImportHistoricalData, locale, t, now, tpLinkStatus, formId, pageHeadingRef, editorHeadingRef, editorOpenerRef, importButtonRef, detailsHeadingRef, detailsOpenerRef, detailsRequestGeneration, search, setSearch, filter, setFilter, mode, setMode, addStep, setAddStep, editingSensorId, setEditingSensorId, attachSensorId, setAttachSensorId, draft, setDraft, errors, setErrors, editorFeedback, setEditorFeedback, pageFeedback, setPageFeedback, contactSetupDevice, setContactSetupDevice, setLocallyAssignedContactKeys, contactOpenerRef, submitting, setSubmitting, rowBusyId, setRowBusyId, cleanupBusy, setCleanupBusy, refreshing, setRefreshing, refreshError, setRefreshError, importOpen, setImportOpen, detailsSensor, setDetailsSensor, detailsContactKey, setDetailsContactKey, detailSamples, setDetailSamples, detailCursor, setDetailCursor, detailsLoading, setDetailsLoading, detailsError, setDetailsError, detailMetric, setDetailMetric, detailRange, setDetailRange, currentSensors, currentSensorIds, visibleDetailsSensor, demoSensors, hasExistingRealBoundSensor, enabledMeasurementDefinitions, detailDefinitions, detailDefinition, detailHistory, usedDeviceIds, homeTpLinkDevices, contactHistoryDevice, availableContactDevices, addableDevices, attachableSensors, sensorStatuses, statusCounts, normalizedSearch, visibleSensors, draftHouse, draftFloor, editingSensor, selectableDevices, currentBindingMissing, draftDevice, energyOnlyDraft, placementAnalysisEnabled, placementLayerScope, placementLayers, placementCoverage, placementSuggestion } = context;
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
  const beginAddDevice = (device: TpLinkDiscoveredDevice) => {
      if (readOnly || !localAuthority) return;
      editorOpenerRef.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
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
  type SensorHistoryMode = "push" | "replace" | "none";
  const writeSensorLocation = (
    overrides: Partial<ReturnType<typeof sensorUrlStateFromLocation>>,
    mode: Exclude<SensorHistoryMode, "none">,
  ) => {
      const current = sensorUrlStateFromLocation();
      writeSensorUrlStateToLocation({
        ...current,
        urgency: filter,
        range: detailRange,
        ...overrides,
      }, mode);
    };
  const selectSensorFilter = (next: SensorFilter) => {
      setFilter(next);
      writeSensorLocation({ urgency: next }, "replace");
    };
  const selectDetailRange = (next: TimeRange) => {
      setDetailRange(next);
      writeSensorLocation({ range: next }, "replace");
    };
  const loadSensorDetails = async (
    sensor: Sensor,
    cursor: string | null = null,
    historyMode: SensorHistoryMode = cursor ? "none" : "push",
  ) => {
      if (cursor && detailsLoading) return;
      if (!cursor && historyMode !== "none") {
        writeSensorLocation({ detail: { kind: "sensor", sensorId: sensor.id } }, historyMode);
      }
      if (!cursor) detailsOpenerRef.current = document.activeElement instanceof HTMLElement ? document.activeElement : pageHeadingRef.current;
      const generation = ++detailsRequestGeneration.current;
      setDetailsContactKey(null);
      setDetailsSensor(sensor);
      if (!cursor) {
        setDetailSamples([]);
        setDetailCursor(null);
      }
      setDetailsLoading(true);
      setDetailsError(null);
      if (isLegacyTpLinkContactSensor(sensor)) {
        setDetailsLoading(false);
        return;
      }
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
  const closeSensorDetails = (historyMode: SensorHistoryMode = "push") => {
      const opener = detailsOpenerRef.current;
      detailsOpenerRef.current = null;
      detailsRequestGeneration.current += 1;
      setDetailsSensor(null);
      setDetailSamples([]);
      setDetailCursor(null);
      setDetailsError(null);
      setDetailsLoading(false);
      if (historyMode !== "none") writeSensorLocation({ detail: null }, historyMode);
      window.setTimeout(() => (opener?.isConnected ? opener : pageHeadingRef.current)?.focus(), 0);
    };
  const openContactDetails = (device: TpLinkDiscoveredDevice, historyMode: SensorHistoryMode = "push") => {
      detailsOpenerRef.current = document.activeElement instanceof HTMLElement
        ? document.activeElement
        : pageHeadingRef.current;
      detailsRequestGeneration.current += 1;
      setDetailsSensor(null);
      setDetailSamples([]);
      setDetailCursor(null);
      setDetailsError(null);
      setDetailsLoading(false);
      setDetailsContactKey(deviceBindingKey(device.deviceId, device.connectionId));
      if (historyMode !== "none") writeSensorLocation({
        detail: {
          kind: "contact",
          deviceId: device.deviceId,
          ...(device.connectionId ? { connectionId: device.connectionId } : {}),
        },
      }, historyMode);
    };
  const closeContactDetails = (historyMode: SensorHistoryMode = "push") => {
      const opener = detailsOpenerRef.current;
      detailsOpenerRef.current = null;
      setDetailsContactKey(null);
      if (historyMode !== "none") writeSensorLocation({ detail: null }, historyMode);
      window.setTimeout(() => (opener?.isConnected ? opener : pageHeadingRef.current)?.focus(), 0);
    };
  const clearDetailsWithoutFocus = () => {
      detailsOpenerRef.current = null;
      detailsRequestGeneration.current += 1;
      setDetailsSensor(null);
      setDetailsContactKey(null);
      setDetailSamples([]);
      setDetailCursor(null);
      setDetailsError(null);
      setDetailsLoading(false);
    };
  const sensorScopeKey = currentSensors.map((sensor) => sensor.id).sort().join("\u0000");
  const contactScopeKey = context.mappedContactDevices
    .map((device) => deviceBindingKey(device.deviceId, device.connectionId))
    .sort()
    .join("\u0000");
  useEffect(() => {
      const expectedPathname = window.location.pathname;
      const restoreSensorLocation = () => {
        if (window.location.pathname !== expectedPathname) return;
        const next = sensorUrlStateFromLocation();
        setFilter(next.urgency);
        setDetailRange(next.range);
        let canonicalDetail: SensorDetailTarget = next.detail;
        if (!next.detail) {
          clearDetailsWithoutFocus();
        } else if (next.detail.kind === "sensor") {
          const target = next.detail;
          const sensor = currentSensors.find((candidate) => candidate.id === target.sensorId);
          if (!sensor) {
            canonicalDetail = null;
            clearDetailsWithoutFocus();
          } else if (detailsSensor?.id !== sensor.id || detailsContactKey) {
            void loadSensorDetails(sensor, null, "none");
          }
        } else if (!tpLinkDevicesLoading) {
          const target = next.detail;
          const device = context.mappedContactDevices.find((candidate) => (
            candidate.deviceId === target.deviceId
            && (candidate.connectionId ?? "") === (target.connectionId ?? "")
          ));
          if (!device) {
            canonicalDetail = null;
            clearDetailsWithoutFocus();
          } else if (detailsContactKey !== deviceBindingKey(device.deviceId, device.connectionId) || detailsSensor) {
            openContactDetails(device, "none");
          }
        }
        writeSensorUrlStateToLocation({ ...next, detail: canonicalDetail }, "replace");
      };
      restoreSensorLocation();
      window.addEventListener("popstate", restoreSensorLocation);
      return () => window.removeEventListener("popstate", restoreSensorLocation);
    }, [contactScopeKey, detailsContactKey, detailsSensor?.id, house.id, sensorScopeKey, tpLinkDevicesLoading]);
  useEffect(() => {
      if (!visibleDetailsSensor && !contactHistoryDevice) return;
      const timer = window.setTimeout(() => detailsHeadingRef.current?.focus(), 0);
      return () => window.clearTimeout(timer);
    }, [contactHistoryDevice?.connectionId, contactHistoryDevice?.deviceId, visibleDetailsSensor?.id]);
  useEffect(() => {
      if (detailsSensor && !visibleDetailsSensor) closeSensorDetails("replace");
    }, [detailsSensor, visibleDetailsSensor]);
  useEffect(() => {
      if (detailsContactKey && !contactHistoryDevice) closeContactDetails("replace");
    }, [contactHistoryDevice, detailsContactKey]);
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
  const beginContactSetup = (device: TpLinkDiscoveredDevice) => {
      if (readOnly) return;
      if (detailsSensor || detailsContactKey) writeSensorLocation({ detail: null }, "push");
      contactOpenerRef.current = document.activeElement instanceof HTMLButtonElement
        ? document.activeElement
        : null;
      if (detailsSensor) {
        detailsOpenerRef.current = null;
        detailsRequestGeneration.current += 1;
        setDetailsSensor(null);
        setDetailSamples([]);
        setDetailCursor(null);
        setDetailsError(null);
        setDetailsLoading(false);
      }
      setDetailsContactKey(null);
      setPageFeedback(null);
      setContactSetupDevice(device);
    };
  const closeContactSetup = () => {
      const opener = contactOpenerRef.current;
      contactOpenerRef.current = null;
      setContactSetupDevice(null);
      window.setTimeout(() => (opener?.isConnected ? opener : pageHeadingRef.current)?.focus(), 0);
    };
  const assignContactToOpening = async (floorId: string, elementId: string) => {
      const device = contactSetupDevice;
      const targetFloor = house.floors.find((floor) => floor.id === floorId);
      const targetElement = targetFloor?.planElements?.find((element) => element.id === elementId);
      if (!device || !targetFloor || !targetElement
        || (targetElement.kind !== "door" && targetElement.kind !== "window")) {
        throw new Error(t("sensors.contactInvalidOpening"));
      }
      if ((targetElement.kind === "door" && targetElement.variant === "open-passage")
        || (targetElement.kind === "window" && targetElement.variant === "fixed")
        || (targetElement.stateBinding && !tpLinkOpeningMatchesDevice(targetElement.stateBinding, device))) {
        throw new Error(t("sensors.contactOpeningUnavailable"));
      }
      const floors = house.floors.map((floor) => ({
        ...floor,
        planElements: (floor.planElements ?? []).map((element) => {
          const isTarget = floor.id === floorId && element.id === elementId
            && (element.kind === "door" || element.kind === "window");
          if (isTarget) {
            return {
              ...element,
              stateBinding: {
                provider: "tapo" as const,
                externalId: device.deviceId,
                ...(device.connectionId ? { connectionId: device.connectionId } : {}),
              },
            };
          }
          if ("stateBinding" in element && tpLinkOpeningMatchesDevice(element.stateBinding, device)) {
            const { stateBinding: _previousBinding, ...unboundElement } = element;
            return unboundElement;
          }
          return element;
        }),
      }));
      if (device.mappedSensorId) {
        const incorrectlyMappedSensor = state.sensors.find((sensor) => sensor.id === device.mappedSensorId);
        await onUpdateSensor(device.mappedSensorId, {
          tpLinkDeviceId: null,
          tpLinkConnectionId: null,
          ...(!incorrectlyMappedSensor || hasHomeAssistantBinding(incorrectlyMappedSensor)
            ? {}
            : { enabled: false }),
        });
      }
      await onUpdateHouse(house.id, { floors });
      setLocallyAssignedContactKeys((current) => {
        const next = new Set(current);
        next.add(deviceBindingKey(device.deviceId, device.connectionId));
        return next;
      });
      setPageFeedback({
        kind: "success",
        message: t("sensors.contactSaved", {
          name: device.alias?.trim() || device.model,
          opening: targetElement.label?.trim() || t(`planElement.${targetElement.kind}` as TranslationKey),
        }),
      });
      closeContactSetup();
    };
  useEffect(() => {
      const requested = requestedDevice ?? (requestedDeviceId ? { deviceId: requestedDeviceId, connectionId: null } : null);
      if (readOnly || !localAuthority || !requested || mode !== "closed") return;
      const contactDevice = availableContactDevices.find((candidate) => candidate.deviceId === requested.deviceId
        && (requested.connectionId === null || (candidate.connectionId ?? null) === requested.connectionId));
      if (contactDevice) {
        contactOpenerRef.current = null;
        setPageFeedback(null);
        setContactSetupDevice(contactDevice);
        onRequestedDeviceHandled?.();
        return;
      }
      const device = addableDevices.find((candidate) => candidate.deviceId === requested.deviceId
        && (requested.connectionId === null || (candidate.connectionId ?? null) === requested.connectionId));
      const requestedFallback = !device && requested.model && requested.deviceType !== "contact"
        ? {
            deviceId: requested.deviceId,
            connectionId: requested.connectionId,
            model: requested.model,
            alias: requested.alias ?? null,
          }
        : null;
      const placementDevice = device ?? requestedFallback;
      if (!placementDevice) {
        if (!tpLinkDevicesLoading) onRequestedDeviceHandled?.();
        return;
      }
      editorOpenerRef.current = pageHeadingRef.current;
      setDraft({
        ...initialDraft(house),
        source: "tp-link",
        deviceId: placementDevice.deviceId,
        connectionId: placementDevice.connectionId ?? "",
        name: placementDevice.alias?.trim() || `${placementDevice.model} sensor`,
        model: placementDevice.model,
      });
      setMode("add");
      setAddStep(2);
      setEditingSensorId(null);
      setErrors({});
      setEditorFeedback(null);
      onRequestedDeviceHandled?.();
    }, [addableDevices, availableContactDevices, house, localAuthority, mode, onRequestedDeviceHandled, readOnly, requestedDevice, requestedDeviceId, tpLinkDevicesLoading]);
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
  return Object.assign(context, { clearError, beginAdd, beginAddDevice, beginEdit, restoreEditorFocus, cancelEditor, closeImport, selectSensorFilter, selectDetailRange, loadSensorDetails, closeSensorDetails, openContactDetails, closeContactDetails, chooseSource, chooseDevice, attachDeviceToExistingSensor, beginContactSetup, closeContactSetup, assignContactToOpening, changeDraftHouse, changeDraftFloor, focusFirstError, advanceAdd, retreatAdd, buildPlacement });
}
