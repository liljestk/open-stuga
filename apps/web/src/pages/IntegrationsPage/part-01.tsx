import { lazy, Suspense, useEffect, useMemo, useRef, useState, type FormEvent, type KeyboardEvent } from "react";
import {
  Building2,
  Check,
  ChevronRight,
  CircleDot,
  CloudSun,
  Compass,
  ExternalLink,
  Home,
  LocateFixed,
  Link2,
  LoaderCircle,
  LockKeyhole,
  MapPin,
  Maximize2,
  Move,
  RadioTower,
  RefreshCw,
  Router,
  Ruler,
  ShieldCheck,
  ThermometerSun,
  Trash2,
  TriangleAlert,
} from "lucide-react";
import { floorMetersPerPlanUnit } from "@climate-twin/contracts";
import type {
  ConnectionState,
  House,
  HouseLocation,
  HouseMapPlacement,
  IntegrationStatus,
  TpLinkDiscoveredDevice,
  UnitSystem,
} from "@climate-twin/contracts";
import {
  api,
  type HouseGeoreferencePatch,
  type HousePatch,
  type IntegrationDiscoveryResult,
  type TpLinkHistoryExportJob,
  type TpLinkHistoryExportJobsResponse,
  type TpLinkHistoryExportJobStatus,
} from "../../api";
import type { HouseLocationMapItem, MapLocation } from "../../components/HouseLocationMap";
import { LocationDiscoveryPanel, type DiscoveredHomeDefaults } from "../../components/LocationDiscoveryPanel";
import { useI18n } from "../../i18n";
import { integrationForHouse } from "../../integrationScope";
import { AutomationSetupPanel } from "../AutomationSetupPanel";
import { SetupOperationsPanel } from "../SetupOperationsPanel";
import { ACTIVE_TP_LINK_EXPORT_STATUSES, HouseLocationMap, RETRYABLE_TP_LINK_EXPORT_STATUSES, TP_LINK_CHILD_DISCOVERY_ATTEMPTS, TP_LINK_CHILD_DISCOVERY_INTERVAL_MS, TP_LINK_EXPORT_PROVIDER_KEYS, TP_LINK_EXPORT_STATUS_KEYS, connectionError, dateTime, decimal, defaultFootprintWidthMeters, floorPlanSize, footprintFloorFor, mapLocation, placementForm, setupSectionFromPath, setupSectionOrder, validTimeZone, waitForChildDiscoveryAttempt, writeSetupSection } from "./support";
import type { DiscoveryOutcome, Feedback, HouseFloor, IntegrationsPageProps, SetupSection, TpLinkChildDiscovery } from "./support";
export function useIntegrationsPagePart01(context: { aggregateIntegration: IntegrationsPageProps["integration"]; initialHouse: IntegrationsPageProps["house"]; houses: IntegrationsPageProps["houses"]; connectionHouses: Exclude<IntegrationsPageProps["connectionHouses"], undefined>; streamConnection: IntegrationsPageProps["streamConnection"]; tpLinkDevicesLoading: Exclude<IntegrationsPageProps["tpLinkDevicesLoading"], undefined>; tpLinkDevicesError: Exclude<IntegrationsPageProps["tpLinkDevicesError"], undefined>; onHouse: IntegrationsPageProps["onHouse"]; onHouseUpdate: IntegrationsPageProps["onHouseUpdate"]; onGeoreferenceChange: IntegrationsPageProps["onGeoreferenceChange"]; onIntegrationChange: IntegrationsPageProps["onIntegrationChange"]; onRefreshTpLinkDevices: IntegrationsPageProps["onRefreshTpLinkDevices"]; onDisconnectHomeAssistant: IntegrationsPageProps["onDisconnectHomeAssistant"]; onDisconnectTpLink: IntegrationsPageProps["onDisconnectTpLink"]; onMoveHomeAssistant: IntegrationsPageProps["onMoveHomeAssistant"]; onMoveTpLink: IntegrationsPageProps["onMoveTpLink"]; onOpenSensors: IntegrationsPageProps["onOpenSensors"]; onOpenLayout: IntegrationsPageProps["onOpenLayout"] }) {
  const { aggregateIntegration, initialHouse, houses, connectionHouses, streamConnection, tpLinkDevicesLoading, tpLinkDevicesError, onHouse, onHouseUpdate, onGeoreferenceChange, onIntegrationChange, onRefreshTpLinkDevices, onDisconnectHomeAssistant, onDisconnectTpLink, onMoveHomeAssistant, onMoveTpLink, onOpenSensors, onOpenLayout } = context;
  const { locale, t } = useI18n();
  const [setupHouseId, setSetupHouseId] = useState(initialHouse.id);
  const house = connectionHouses.find((candidate) => candidate.id === setupHouseId) ?? initialHouse;
  const integration = useMemo(
      () => integrationForHouse(aggregateIntegration, house.id, Boolean(house.location)),
      [aggregateIntegration, house.id, house.location],
    );
  const [activeSection, setActiveSection] = useState<SetupSection>(() => setupSectionFromPath());
  const [mapLoaded, setMapLoaded] = useState(false);
  const [testing, setTesting] = useState(false);
  const [result, setResult] = useState<"success" | "failure" | null>(null);
  const homeAssistantTestGeneration = useRef(0);
  const discoveryGeneration = useRef(0);
  const automaticallyScannedHouseId = useRef<string | null>(null);
  const inventoryRefreshGeneration = useRef(0);
  const historyExportRequestGeneration = useRef(0);
  const [testingDirect, setTestingDirect] = useState(false);
  const [directResult, setDirectResult] = useState<"success" | "failure" | null>(null);
  const tpLinkTestGeneration = useRef(0);
  const [validatedTpLinkDraft, setValidatedTpLinkDraft] = useState<string | null>(null);
  const [discovering, setDiscovering] = useState(false);
  const [discovery, setDiscovery] = useState<IntegrationDiscoveryResult | null>(null);
  const [discoveryOutcome, setDiscoveryOutcome] = useState<DiscoveryOutcome>("idle");
  const [tpLinkSettingsOpen, setTpLinkSettingsOpen] = useState(false);
  const [tpLinkHost, setTpLinkHost] = useState("");
  const tpLinkHostDraft = useRef("");
  const [tpLinkUsername, setTpLinkUsername] = useState("");
  const [tpLinkPassword, setTpLinkPassword] = useState("");
  const [showTpLinkPassword, setShowTpLinkPassword] = useState(false);
  const [savingTpLink, setSavingTpLink] = useState(false);
  const [tpLinkFeedback, setTpLinkFeedback] = useState<Feedback>(null);
  const [refreshingTpLinkInventory, setRefreshingTpLinkInventory] = useState(false);
  const [tpLinkInventoryRefreshFailed, setTpLinkInventoryRefreshFailed] = useState(false);
  const [tpLinkExportEnabled, setTpLinkExportEnabled] = useState<boolean | null>(null);
  const [tpLinkExportJobs, setTpLinkExportJobs] = useState<TpLinkHistoryExportJob[]>([]);
  const [tpLinkExportAutomation, setTpLinkExportAutomation] = useState<TpLinkHistoryExportJobsResponse["automation"] | null>(null);
  const [tpLinkExportJobsLoading, setTpLinkExportJobsLoading] = useState(false);
  const [tpLinkExportJobsError, setTpLinkExportJobsError] = useState<string | null>(null);
  const [busyTpLinkExportJobId, setBusyTpLinkExportJobId] = useState<string | null>(null);
  const [tpLinkCanaryTargets, setTpLinkCanaryTargets] = useState<Array<{ sensorId: string; label: string }>>([]);
  const [tpLinkCanarySensorId, setTpLinkCanarySensorId] = useState("");
  const [tpLinkCanaryMetric, setTpLinkCanaryMetric] = useState<"temperature" | "humidity">("temperature");
  const [tpLinkCanaryRunning, setTpLinkCanaryRunning] = useState(false);
  const [tpLinkChildDiscovery, setTpLinkChildDiscovery] = useState<TpLinkChildDiscovery>({ phase: "idle" });
  const tpLinkChildDiscoveryAbort = useRef<AbortController | null>(null);
  const tpLinkChildDiscoveryKey = useRef<string | null>(null);
  const tpLinkChildDiscoveryRunning = useRef(false);
  const [haUrl, setHaUrl] = useState("");
  const [haToken, setHaToken] = useState("");
  const [showHaToken, setShowHaToken] = useState(false);
  const [savingHomeAssistant, setSavingHomeAssistant] = useState(false);
  const [homeAssistantFeedback, setHomeAssistantFeedback] = useState<Feedback>(null);
  const [busyAssignment, setBusyAssignment] = useState<string | null>(null);
  const [assignmentHouseDrafts, setAssignmentHouseDrafts] = useState<Record<string, string>>({});
  const [assignmentFeedback, setAssignmentFeedback] = useState<Feedback>(null);
  const [validatedHomeAssistantDraft, setValidatedHomeAssistantDraft] = useState<string | null>(null);
  const [latitude, setLatitude] = useState("");
  const [longitude, setLongitude] = useState("");
  const [locationLabel, setLocationLabel] = useState("");
  const [timezone, setTimezone] = useState(house.timezone);
  const [locationValidationAttempted, setLocationValidationAttempted] = useState(false);
  const [placementLatitude, setPlacementLatitude] = useState("");
  const [placementLongitude, setPlacementLongitude] = useState("");
  const [footprintFloorId, setFootprintFloorId] = useState("");
  const [footprintWidthMeters, setFootprintWidthMeters] = useState("12");
  const [placementEditing, setPlacementEditing] = useState(false);
  const [mapViewport, setMapViewport] = useState<"all" | "selected">("all");
  const [orientation, setOrientation] = useState("");
  const [savingLocation, setSavingLocation] = useState(false);
  const [locationFeedback, setLocationFeedback] = useState<Feedback>(null);
  const [savingPlacement, setSavingPlacement] = useState(false);
  const [placementFeedback, setPlacementFeedback] = useState<Feedback>(null);
  const activeSetupHouseId = useRef(house.id);
  const locationRequestGeneration = useRef(0);
  const placementRequestGeneration = useRef(0);
  activeSetupHouseId.current = house.id;
  const localDateTime = (value: string | null | undefined, options?: Intl.DateTimeFormatOptions) => dateTime(value, locale, house.timezone, options);
  const managedHouseIds = new Set(connectionHouses.map((candidate) => candidate.id));
  const homeAssistantAssignments = (aggregateIntegration.homeAssistant.connections ?? [])
      .filter((connection) => managedHouseIds.has(connection.houseId));
  const tpLinkAssignments = (aggregateIntegration.tpLink.connections ?? [])
      .filter((connection) => managedHouseIds.has(connection.houseId));
  const beginLocationRequest = () => ({
      houseId: house.id,
      generation: ++locationRequestGeneration.current,
    });
  const isCurrentLocationRequest = (request: { houseId: string; generation: number }) => (
      activeSetupHouseId.current === request.houseId
      && locationRequestGeneration.current === request.generation
    );
  const beginPlacementRequest = () => ({
      houseId: house.id,
      generation: ++placementRequestGeneration.current,
    });
  const isCurrentPlacementRequest = (request: { houseId: string; generation: number }) => (
      activeSetupHouseId.current === request.houseId
      && placementRequestGeneration.current === request.generation
    );
  const stopTpLinkChildDiscovery = (resetSettlingState = false) => {
      const shouldReset = resetSettlingState && tpLinkChildDiscovery.phase === "settling";
      tpLinkChildDiscoveryAbort.current?.abort();
      tpLinkChildDiscoveryAbort.current = null;
      tpLinkChildDiscoveryKey.current = null;
      tpLinkChildDiscoveryRunning.current = false;
      if (shouldReset) setTpLinkChildDiscovery({ phase: "idle" });
    };
  useEffect(() => {
      setSetupHouseId(initialHouse.id);
    }, [initialHouse.id]);
  useEffect(() => {
      if (!connectionHouses.some((candidate) => candidate.id === setupHouseId)) setSetupHouseId(initialHouse.id);
    }, [connectionHouses, initialHouse.id, setupHouseId]);
  return Object.assign(context, { locale, t, setupHouseId, setSetupHouseId, house, integration, activeSection, setActiveSection, mapLoaded, setMapLoaded, testing, setTesting, result, setResult, homeAssistantTestGeneration, discoveryGeneration, automaticallyScannedHouseId, inventoryRefreshGeneration, historyExportRequestGeneration, testingDirect, setTestingDirect, directResult, setDirectResult, tpLinkTestGeneration, validatedTpLinkDraft, setValidatedTpLinkDraft, discovering, setDiscovering, discovery, setDiscovery, discoveryOutcome, setDiscoveryOutcome, tpLinkSettingsOpen, setTpLinkSettingsOpen, tpLinkHost, setTpLinkHost, tpLinkHostDraft, tpLinkUsername, setTpLinkUsername, tpLinkPassword, setTpLinkPassword, showTpLinkPassword, setShowTpLinkPassword, savingTpLink, setSavingTpLink, tpLinkFeedback, setTpLinkFeedback, refreshingTpLinkInventory, setRefreshingTpLinkInventory, tpLinkInventoryRefreshFailed, setTpLinkInventoryRefreshFailed, tpLinkExportEnabled, setTpLinkExportEnabled, tpLinkExportJobs, setTpLinkExportJobs, tpLinkExportAutomation, setTpLinkExportAutomation, tpLinkExportJobsLoading, setTpLinkExportJobsLoading, tpLinkExportJobsError, setTpLinkExportJobsError, busyTpLinkExportJobId, setBusyTpLinkExportJobId, tpLinkCanaryTargets, setTpLinkCanaryTargets, tpLinkCanarySensorId, setTpLinkCanarySensorId, tpLinkCanaryMetric, setTpLinkCanaryMetric, tpLinkCanaryRunning, setTpLinkCanaryRunning, tpLinkChildDiscovery, setTpLinkChildDiscovery, tpLinkChildDiscoveryAbort, tpLinkChildDiscoveryKey, tpLinkChildDiscoveryRunning, haUrl, setHaUrl, haToken, setHaToken, showHaToken, setShowHaToken, savingHomeAssistant, setSavingHomeAssistant, homeAssistantFeedback, setHomeAssistantFeedback, busyAssignment, setBusyAssignment, assignmentHouseDrafts, setAssignmentHouseDrafts, assignmentFeedback, setAssignmentFeedback, validatedHomeAssistantDraft, setValidatedHomeAssistantDraft, latitude, setLatitude, longitude, setLongitude, locationLabel, setLocationLabel, timezone, setTimezone, locationValidationAttempted, setLocationValidationAttempted, placementLatitude, setPlacementLatitude, placementLongitude, setPlacementLongitude, footprintFloorId, setFootprintFloorId, footprintWidthMeters, setFootprintWidthMeters, placementEditing, setPlacementEditing, mapViewport, setMapViewport, orientation, setOrientation, savingLocation, setSavingLocation, locationFeedback, setLocationFeedback, savingPlacement, setSavingPlacement, placementFeedback, setPlacementFeedback, activeSetupHouseId, locationRequestGeneration, placementRequestGeneration, localDateTime, managedHouseIds, homeAssistantAssignments, tpLinkAssignments, beginLocationRequest, isCurrentLocationRequest, beginPlacementRequest, isCurrentPlacementRequest, stopTpLinkChildDiscovery });
}