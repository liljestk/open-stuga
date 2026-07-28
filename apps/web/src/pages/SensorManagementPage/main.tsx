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
import { useSensorManagementPagePart02 } from "./part-02";
import { useSensorManagementPagePart03 } from "./part-03";
import { useSensorManagementPagePart04 } from "./part-04";
import { renderSensorManagementPage } from "./render";

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
  localAuthority = true,
  units = "metric",
  onRequestedDeviceHandled,
  onLoadSeries,
  onHouse,
  onUpdateHouse,
  onRefreshDevices,
  onCreateSensor,
  onUpdateSensor,
  onDeleteSensor,
  onImportHistoricalData,
}: SensorManagementPageProps) {
  const context0 = { state, house, houses, integration, tpLinkDevices, tpLinkDevicesLoading, tpLinkDevicesError, requestedDevice, requestedDeviceId, readOnly, localAuthority, units, onRequestedDeviceHandled, onLoadSeries, onHouse, onUpdateHouse, onRefreshDevices, onCreateSensor, onUpdateSensor, onDeleteSensor, onImportHistoricalData };
  const context1 = useSensorManagementPagePart01(context0);
  const context2 = useSensorManagementPagePart02(context1);
  const context3 = useSensorManagementPagePart03(context2);
  const context4 = useSensorManagementPagePart04(context3);
  return renderSensorManagementPage(context4);
}
