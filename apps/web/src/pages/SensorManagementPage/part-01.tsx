import {
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
} from "react";
import type {
  MeasurementSample,
  Metric,
  Sensor,
  TpLinkDiscoveredDevice,
} from "@climate-twin/contracts";
import type { TimeRange } from "../../domain";
import { useI18n } from "../../i18n";
import { useNow } from "../../useNow";
import { integrationForHouse } from "../../integrationScope";
import { assessSensorCoverage, suggestSensorPlacement, type SensorCoverageAssessment, type SensorPlacementSuggestion } from "../../spatial/experimentalLayers";
import { configuredSpatialMaxSampleAgeMs } from "../../spatial/freshness";
import { useSpatialLayers } from "../../spatial/useSpatialLayers";
import {
  houseHasTpLinkOpeningBinding,
  isLegacyTpLinkContactSensor,
  isTpLinkContactDevice,
  tpLinkContactDeviceForSensor,
  tpLinkOpeningForDevice,
} from "../../tpLinkDeviceClassification";
import { availableForSensor, deviceBindingKey, draftContext, hasHomeAssistantBinding, hasRealBinding, initialDraft, isDemoSensor, isUnplaced, mergeMetricSamples, sensorHasMetric, sensorStatus } from "./support";
import type { AddStep, DraftErrors, EditorMode, Feedback, SensorDraft, SensorFilter, SensorManagementPageProps, SensorStatus } from "./support";
import { sensorUrlStateFromLocation } from "./urlState";
export function useSensorManagementPagePart01(context: { state: SensorManagementPageProps["state"]; house: SensorManagementPageProps["house"]; houses: SensorManagementPageProps["houses"]; integration: SensorManagementPageProps["integration"]; tpLinkDevices: SensorManagementPageProps["tpLinkDevices"]; tpLinkDevicesLoading: SensorManagementPageProps["tpLinkDevicesLoading"]; tpLinkDevicesError: SensorManagementPageProps["tpLinkDevicesError"]; requestedDevice: Exclude<SensorManagementPageProps["requestedDevice"], undefined>; requestedDeviceId: Exclude<SensorManagementPageProps["requestedDeviceId"], undefined>; readOnly: Exclude<SensorManagementPageProps["readOnly"], undefined>; localAuthority: Exclude<SensorManagementPageProps["localAuthority"], undefined>; canManageIntegrations: Exclude<SensorManagementPageProps["canManageIntegrations"], undefined>; units: Exclude<SensorManagementPageProps["units"], undefined>; onRequestedDeviceHandled: SensorManagementPageProps["onRequestedDeviceHandled"]; onLoadSeries: SensorManagementPageProps["onLoadSeries"]; onHouse: SensorManagementPageProps["onHouse"]; onUpdateHouse: SensorManagementPageProps["onUpdateHouse"]; onRefreshDevices: SensorManagementPageProps["onRefreshDevices"]; onCreateSensor: SensorManagementPageProps["onCreateSensor"]; onUpdateSensor: SensorManagementPageProps["onUpdateSensor"]; onDeleteSensor: SensorManagementPageProps["onDeleteSensor"]; onImportHistoricalData: SensorManagementPageProps["onImportHistoricalData"] }) {
  const { state, house, houses, integration, tpLinkDevices } = context;
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
  const [initialSensorUrlState] = useState(sensorUrlStateFromLocation);
  const [search, setSearch] = useState("");
  const [filter, setFilter] = useState<SensorFilter>(initialSensorUrlState.urgency);
  const [modelFilter, setModelFilter] = useState("");
  const [mode, setMode] = useState<EditorMode>("closed");
  const [addStep, setAddStep] = useState<AddStep>(1);
  const [editingSensorId, setEditingSensorId] = useState<string | null>(null);
  const [attachSensorId, setAttachSensorId] = useState("");
  const [draft, setDraft] = useState<SensorDraft>(() => initialDraft(house));
  const [errors, setErrors] = useState<DraftErrors>({});
  const [editorFeedback, setEditorFeedback] = useState<Feedback>(null);
  const [pageFeedback, setPageFeedback] = useState<Feedback>(null);
  const [contactSetupDevice, setContactSetupDevice] = useState<TpLinkDiscoveredDevice | null>(null);
  const [locallyAssignedContactKeys, setLocallyAssignedContactKeys] = useState<Set<string>>(() => new Set());
  const contactOpenerRef = useRef<HTMLButtonElement>(null);
  const [submitting, setSubmitting] = useState(false);
  const [rowBusyId, setRowBusyId] = useState<string | null>(null);
  const [cleanupBusy, setCleanupBusy] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  const [refreshError, setRefreshError] = useState<string | null>(null);
  const [importOpen, setImportOpen] = useState(false);
  const [detailsSensor, setDetailsSensor] = useState<Sensor | null>(null);
  const [detailsContactKey, setDetailsContactKey] = useState<string | null>(null);
  const [detailSamples, setDetailSamples] = useState<MeasurementSample[]>([]);
  const [detailCursor, setDetailCursor] = useState<string | null>(null);
  const [detailsLoading, setDetailsLoading] = useState(false);
  const [detailsError, setDetailsError] = useState<string | null>(null);
  const [detailMetric, setDetailMetric] = useState<Metric>("temperature");
  const [detailRange, setDetailRange] = useState<TimeRange>(initialSensorUrlState.range);
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
  const visibleDetailsIsContactSensor = Boolean(
      visibleDetailsSensor && isLegacyTpLinkContactSensor(visibleDetailsSensor),
    );
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
      if (visibleDetailsIsContactSensor) return [];
      if (!visibleDetailsSensor) return enabledMeasurementDefinitions;
      const available = enabledMeasurementDefinitions.filter((definition) => (
        sensorHasMetric(state, visibleDetailsSensor, definition.id)
        || detailSamples.some((sample) => sample.metric === definition.id)
      ));
      return available.length > 0 ? available : enabledMeasurementDefinitions;
    }, [detailSamples, enabledMeasurementDefinitions, state, visibleDetailsIsContactSensor, visibleDetailsSensor]);
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
  const contactDevices = useMemo(
      () => homeTpLinkDevices.filter(isTpLinkContactDevice),
      [homeTpLinkDevices],
    );
  const mappedContactDevices = useMemo(
      () => contactDevices.filter((device) => houseHasTpLinkOpeningBinding(house, device)),
      [contactDevices, house],
    );
  const contactHistoryDevice = useMemo(
      () => detailsContactKey
        ? mappedContactDevices.find((device) => deviceBindingKey(device.deviceId, device.connectionId) === detailsContactKey) ?? null
        : null,
      [detailsContactKey, mappedContactDevices],
    );
  const contactHistoryOpening = useMemo(
      () => contactHistoryDevice ? tpLinkOpeningForDevice(house, contactHistoryDevice) : null,
      [contactHistoryDevice, house],
    );
  const contactStatuses = useMemo(
      () => new Map(mappedContactDevices.map((device) => [
        deviceBindingKey(device.deviceId, device.connectionId),
        device.status?.trim().toLocaleLowerCase() === "online" ? "live" as const : "waiting" as const,
      ])),
      [mappedContactDevices],
    );
  const visibleDetailsContactDevice = useMemo(
      () => visibleDetailsSensor && visibleDetailsIsContactSensor
        ? tpLinkContactDeviceForSensor(visibleDetailsSensor, contactDevices)
        : null,
      [contactDevices, visibleDetailsIsContactSensor, visibleDetailsSensor],
    );
  const visibleDetailsContactOpening = useMemo(
      () => visibleDetailsContactDevice ? tpLinkOpeningForDevice(house, visibleDetailsContactDevice) : null,
      [house, visibleDetailsContactDevice],
    );
  const availableContactDevices = useMemo(
      () => contactDevices.filter((device) => !locallyAssignedContactKeys.has(deviceBindingKey(device.deviceId, device.connectionId))
        && !houseHasTpLinkOpeningBinding(house, device)),
      [contactDevices, house, locallyAssignedContactKeys],
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
      for (const status of contactStatuses.values()) counts[status] += 1;
      return counts;
    }, [contactStatuses, sensorStatuses]);
  const sensorModels = useMemo(() => Array.from(new Set(
      [
        ...currentSensors.map((sensor) => sensor.model.trim()),
        ...mappedContactDevices.map((device) => device.model.trim()),
      ].filter(Boolean),
    )).sort((left, right) => left.localeCompare(right, locale, { sensitivity: "base" })),
    [currentSensors, locale, mappedContactDevices]);
  const normalizedSearch = search.trim().toLocaleLowerCase(locale);
  const visibleSensors = useMemo(() => currentSensors.filter((sensor) => {
      const matchesSearch = !normalizedSearch || [sensor.name, sensor.room, sensor.model, sensor.id, sensor.tpLinkDeviceId ?? ""]
        .some((value) => value.toLocaleLowerCase(locale).includes(normalizedSearch));
      if (!matchesSearch) return false;
      if (modelFilter && sensor.model.trim() !== modelFilter) return false;
      if (filter !== "all") return sensorStatuses.get(sensor.id) === filter;
      return true;
    }), [currentSensors, filter, locale, modelFilter, normalizedSearch, sensorStatuses]);
  const visibleContactDevices = useMemo(() => mappedContactDevices.filter((device) => {
      const opening = tpLinkOpeningForDevice(house, device);
      const matchesSearch = !normalizedSearch || [
        device.alias ?? "",
        device.model,
        device.deviceId,
        opening?.element.label ?? "",
        opening?.floor.name ?? "",
      ].some((value) => value.toLocaleLowerCase(locale).includes(normalizedSearch));
      if (!matchesSearch) return false;
      if (modelFilter && device.model.trim() !== modelFilter) return false;
      if (filter !== "all") {
        return contactStatuses.get(deviceBindingKey(device.deviceId, device.connectionId)) === filter;
      }
      return true;
    }), [contactStatuses, filter, house, locale, mappedContactDevices, modelFilter, normalizedSearch]);
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
      if (modelFilter && !sensorModels.includes(modelFilter)) setModelFilter("");
    }, [modelFilter, sensorModels]);
  return Object.assign(context, { locale, t, now, tpLinkStatus, formId, pageHeadingRef, editorHeadingRef, editorOpenerRef, importButtonRef, detailsHeadingRef, detailsOpenerRef, detailsRequestGeneration, search, setSearch, filter, setFilter, modelFilter, setModelFilter, mode, setMode, addStep, setAddStep, editingSensorId, setEditingSensorId, attachSensorId, setAttachSensorId, draft, setDraft, errors, setErrors, editorFeedback, setEditorFeedback, pageFeedback, setPageFeedback, contactSetupDevice, setContactSetupDevice, locallyAssignedContactKeys, setLocallyAssignedContactKeys, contactOpenerRef, submitting, setSubmitting, rowBusyId, setRowBusyId, cleanupBusy, setCleanupBusy, refreshing, setRefreshing, refreshError, setRefreshError, importOpen, setImportOpen, detailsSensor, setDetailsSensor, detailsContactKey, setDetailsContactKey, detailSamples, setDetailSamples, detailCursor, setDetailCursor, detailsLoading, setDetailsLoading, detailsError, setDetailsError, detailMetric, setDetailMetric, detailRange, setDetailRange, currentSensors, currentSensorIds, visibleDetailsSensor, visibleDetailsIsContactSensor, visibleDetailsContactDevice, visibleDetailsContactOpening, demoSensors, hasExistingRealBoundSensor, enabledMeasurementDefinitions, detailDefinitions, detailDefinition, detailHistory, usedDeviceIds, homeTpLinkDevices, contactDevices, mappedContactDevices, contactHistoryDevice, contactHistoryOpening, contactStatuses, availableContactDevices, addableDevices, attachableSensors, sensorStatuses, statusCounts, sensorModels, normalizedSearch, visibleSensors, visibleContactDevices, draftHouse, draftFloor, editingSensor, selectableDevices, currentBindingMissing, draftDevice, energyOnlyDraft, placementAnalysisEnabled, placementLayerScope, placementLayers, placementCoverage, placementSuggestion });
}
