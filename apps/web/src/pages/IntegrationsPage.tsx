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
import type {
  ConnectionState,
  House,
  HouseLocation,
  HouseMapPlacement,
  IntegrationStatus,
  TpLinkDiscoveredDevice,
  UnitSystem,
} from "@climate-twin/contracts";
import { api, type HouseGeoreferencePatch, type HousePatch, type IntegrationDiscoveryResult } from "../api";
import type { HouseLocationMapItem, MapLocation } from "../components/HouseLocationMap";
import { LocationDiscoveryPanel, type DiscoveredHomeDefaults } from "../components/LocationDiscoveryPanel";
import { useI18n } from "../i18n";
import { integrationForHouse } from "../integrationScope";
import { AutomationSetupPanel } from "./AutomationSetupPanel";
import { SetupOperationsPanel } from "./SetupOperationsPanel";

const HouseLocationMap = lazy(() => import("../components/HouseLocationMap").then((module) => ({ default: module.HouseLocationMap })));

interface IntegrationsPageProps {
  integration: IntegrationStatus;
  house: House;
  houses: House[];
  /** All workspace Homes available to the connection manager, including other Properties. */
  connectionHouses?: House[];
  units: UnitSystem;
  streamConnection: ConnectionState;
  tpLinkDevicesLoading?: boolean;
  tpLinkDevicesError?: string | null;
  onHouse: (houseId: string) => void;
  onHouseUpdate: (houseId: string, patch: HousePatch) => Promise<unknown>;
  onGeoreferenceChange: (houseId: string, patch: HouseGeoreferencePatch) => Promise<void>;
  onIntegrationChange: (integration: IntegrationStatus) => void;
  onRefreshTpLinkDevices?: (houseId?: string) => Promise<TpLinkDiscoveredDevice[]>;
  onDisconnectHomeAssistant?: (houseId: string) => ReturnType<typeof api.disconnectHomeAssistant>;
  onDisconnectTpLink?: (connectionId: string) => ReturnType<typeof api.disconnectTpLink>;
  onMoveHomeAssistant?: (fromHouseId: string, houseId: string) => ReturnType<typeof api.moveHomeAssistant>;
  onMoveTpLink?: (connectionId: string, houseId: string) => ReturnType<typeof api.moveTpLink>;
  onOpenSensors?: () => void;
  onOpenLayout?: () => void;
}

type Feedback = { kind: "success" | "error"; message: string } | null;
type SetupSection = "overview" | "homes" | "layout" | "connections" | "weather" | "automations" | "operations";
type DiscoveryOutcome = "idle" | "found" | "empty" | "error";
type TpLinkChildDiscovery =
  | { phase: "idle" }
  | { phase: "settling"; attempt: number; hubModel: "H100" | "H200" | null }
  | { phase: "found"; count: number; hubModel: "H100" | "H200" | null }
  | { phase: "empty" | "error"; hubModel: "H100" | "H200" | null };

const setupSectionOrder: SetupSection[] = ["overview", "layout", "connections", "weather", "operations", "automations"];
const TP_LINK_CHILD_DISCOVERY_ATTEMPTS = 7;
const TP_LINK_CHILD_DISCOVERY_INTERVAL_MS = 5_000;

function connectionError(error: unknown, fallback: string): string {
  return error instanceof Error && error.message.trim() ? error.message : fallback;
}

function waitForChildDiscoveryAttempt(signal: AbortSignal): Promise<boolean> {
  if (signal.aborted) return Promise.resolve(false);
  return new Promise((resolve) => {
    const finish = (completed: boolean) => {
      signal.removeEventListener("abort", cancel);
      resolve(completed);
    };
    const timer = window.setTimeout(() => finish(true), TP_LINK_CHILD_DISCOVERY_INTERVAL_MS);
    const cancel = () => {
      window.clearTimeout(timer);
      finish(false);
    };
    signal.addEventListener("abort", cancel, { once: true });
  });
}

function setupSectionFromPath(pathname = typeof window === "undefined" ? "" : window.location.pathname): SetupSection {
  const candidate = pathname.match(/\/setup\/([^/]+)\/?$/)?.[1];
  return setupSectionOrder.includes(candidate as SetupSection) ? candidate as SetupSection : "overview";
}

function writeSetupSection(section: SetupSection, replace = false): void {
  if (typeof window === "undefined") return;
  const setupPath = /^(.*\/setup)(?:\/(?:overview|homes|layout|connections|weather|automations|operations))?\/?$/.exec(window.location.pathname);
  if (!setupPath) return;
  const next = `${setupPath[1]}/${section}${window.location.search}${window.location.hash}`;
  if (`${window.location.pathname}${window.location.search}${window.location.hash}` === next) return;
  window.history[replace ? "replaceState" : "pushState"](null, "", next);
}

function dateTime(value: string | null | undefined, locale: string, timeZone: string, options?: Intl.DateTimeFormatOptions): string | null {
  if (!value) return null;
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) return null;
  try {
    return new Intl.DateTimeFormat(locale, { ...(options ?? { dateStyle: "short", timeStyle: "short" }), timeZone }).format(date);
  } catch {
    return new Intl.DateTimeFormat(locale, options ?? { dateStyle: "short", timeStyle: "short" }).format(date);
  }
}

function decimal(value: number, locale: string, maximumFractionDigits = 1): string {
  return new Intl.NumberFormat(locale, { maximumFractionDigits }).format(value);
}

function validTimeZone(value: string): boolean {
  if (!value.trim()) return false;
  try {
    new Intl.DateTimeFormat("en", { timeZone: value.trim() }).format();
    return true;
  } catch {
    return false;
  }
}

type HouseFloor = House["floors"][number];

function footprintFloorFor(candidate: House): HouseFloor | undefined {
  const explicitlySelected = candidate.mapPlacement?.footprintFloorId
    ? candidate.floors.find((floor) => floor.id === candidate.mapPlacement?.footprintFloorId)
    : undefined;
  if (explicitlySelected) return explicitlySelected;
  const usable = candidate.floors.filter((floor) => floor.type !== "outdoor");
  return usable.find((floor) => floor.type === "ground")
    ?? [...usable].filter((floor) => floor.elevation >= 0).sort((first, second) => first.elevation - second.elevation)[0]
    ?? [...usable].sort((first, second) => first.elevation - second.elevation)[0];
}

function floorPlanSize(floor: HouseFloor | undefined): { width: number; depth: number } {
  if (!floor) return { width: 1, depth: 1 };
  const points = floor.walls.flatMap((wall) => [wall.from, wall.to])
    .filter((point) => Number.isFinite(point.x) && Number.isFinite(point.y));
  const minX = Math.min(0, ...points.map((point) => point.x));
  const minY = Math.min(0, ...points.map((point) => point.y));
  const maxX = Math.max(Number.isFinite(floor.width) ? floor.width : 1, ...points.map((point) => point.x));
  const maxY = Math.max(Number.isFinite(floor.height) ? floor.height : 1, ...points.map((point) => point.y));
  return { width: Math.max(0.001, maxX - minX), depth: Math.max(0.001, maxY - minY) };
}

function defaultFootprintWidthMeters(floor: HouseFloor | undefined): number {
  const planWidth = floorPlanSize(floor).width;
  return planWidth >= 2 && planWidth <= 80 ? Number(planWidth.toFixed(2)) : 12;
}

function mapLocation(latitude: string, longitude: string): MapLocation | null {
  if (!latitude.trim() || !longitude.trim()) return null;
  const parsedLatitude = Number(latitude);
  const parsedLongitude = Number(longitude);
  return Number.isFinite(parsedLatitude) && parsedLatitude >= -90 && parsedLatitude <= 90
    && Number.isFinite(parsedLongitude) && parsedLongitude >= -180 && parsedLongitude <= 180
    ? { latitude: parsedLatitude, longitude: parsedLongitude }
    : null;
}

function placementForm(candidate: House): {
  latitude: string;
  longitude: string;
  footprintFloorId: string;
  footprintWidthMeters: string;
} {
  const floor = footprintFloorFor(candidate);
  const source = candidate.mapPlacement ?? candidate.location;
  const planWidth = floorPlanSize(floor).width;
  const physicalWidth = candidate.mapPlacement
    ? candidate.mapPlacement.metersPerPlanUnit * planWidth
    : defaultFootprintWidthMeters(floor);
  return {
    latitude: source ? String(source.latitude) : "",
    longitude: source ? String(source.longitude) : "",
    footprintFloorId: floor?.id ?? "",
    footprintWidthMeters: Number(physicalWidth.toFixed(2)).toString(),
  };
}

export function IntegrationsPage({ integration: aggregateIntegration, house: initialHouse, houses, connectionHouses = houses, streamConnection, tpLinkDevicesLoading = false, tpLinkDevicesError = null, onHouse, onHouseUpdate, onGeoreferenceChange, onIntegrationChange, onRefreshTpLinkDevices, onDisconnectHomeAssistant, onDisconnectTpLink, onMoveHomeAssistant, onMoveTpLink, onOpenSensors, onOpenLayout }: IntegrationsPageProps) {
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
  const inventoryRefreshGeneration = useRef(0);
  const [testingDirect, setTestingDirect] = useState(false);
  const [directResult, setDirectResult] = useState<"success" | "failure" | null>(null);
  const tpLinkTestGeneration = useRef(0);
  const [validatedTpLinkDraft, setValidatedTpLinkDraft] = useState<string | null>(null);
  const [discovering, setDiscovering] = useState(false);
  const [discovery, setDiscovery] = useState<IntegrationDiscoveryResult | null>(null);
  const [discoveryOutcome, setDiscoveryOutcome] = useState<DiscoveryOutcome>("idle");
  const [tpLinkSettingsOpen, setTpLinkSettingsOpen] = useState(false);
  const [tpLinkHost, setTpLinkHost] = useState("");
  const [tpLinkUsername, setTpLinkUsername] = useState("");
  const [tpLinkPassword, setTpLinkPassword] = useState("");
  const [showTpLinkPassword, setShowTpLinkPassword] = useState(false);
  const [savingTpLink, setSavingTpLink] = useState(false);
  const [tpLinkFeedback, setTpLinkFeedback] = useState<Feedback>(null);
  const [refreshingTpLinkInventory, setRefreshingTpLinkInventory] = useState(false);
  const [tpLinkInventoryRefreshFailed, setTpLinkInventoryRefreshFailed] = useState(false);
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

  useEffect(() => {
    const restoreSection = () => setActiveSection(setupSectionFromPath());
    window.addEventListener("popstate", restoreSection);
    writeSetupSection(setupSectionFromPath(), true);
    return () => window.removeEventListener("popstate", restoreSection);
  }, []);

  useEffect(() => () => {
    tpLinkChildDiscoveryAbort.current?.abort();
    tpLinkChildDiscoveryAbort.current = null;
    tpLinkChildDiscoveryKey.current = null;
    tpLinkChildDiscoveryRunning.current = false;
  }, []);

  useEffect(() => {
    if (tpLinkChildDiscovery.phase !== "settling" || integration.tpLink.discoveredDevices <= 0) return;
    stopTpLinkChildDiscovery();
    setTpLinkChildDiscovery({
      phase: "found",
      count: integration.tpLink.discoveredDevices,
      hubModel: integration.tpLink.hubModel ?? tpLinkChildDiscovery.hubModel,
    });
  }, [integration.tpLink.discoveredDevices, integration.tpLink.hubModel, tpLinkChildDiscovery]);

  useEffect(() => {
    setLatitude(house.location ? String(house.location.latitude) : "");
    setLongitude(house.location ? String(house.location.longitude) : "");
    setLocationLabel(house.location?.label ?? "");
    setTimezone(house.timezone);
  }, [house.id, house.location?.label, house.location?.latitude, house.location?.longitude, house.timezone]);

  useEffect(() => {
    const form = placementForm(house);
    setPlacementLatitude(form.latitude);
    setPlacementLongitude(form.longitude);
    setFootprintFloorId(form.footprintFloorId);
    setFootprintWidthMeters(form.footprintWidthMeters);
    setPlacementEditing(!house.mapPlacement);
    setPlacementFeedback(null);
    setMapViewport(houses.some((candidate) => candidate.id !== house.id && (candidate.mapPlacement || candidate.location)) ? "all" : "selected");
  }, [house, houses]);

  useEffect(() => {
    setOrientation(house.orientationDegrees === undefined ? "" : String(house.orientationDegrees));
  }, [house.id, house.orientationDegrees]);

  useEffect(() => {
    locationRequestGeneration.current += 1;
    placementRequestGeneration.current += 1;
    tpLinkTestGeneration.current += 1;
    homeAssistantTestGeneration.current += 1;
    discoveryGeneration.current += 1;
    inventoryRefreshGeneration.current += 1;
    stopTpLinkChildDiscovery(true);
    setDiscovering(false);
    setDiscovery(null);
    setDiscoveryOutcome("idle");
    setRefreshingTpLinkInventory(false);
    setTpLinkInventoryRefreshFailed(false);
    setSavingLocation(false);
    setSavingPlacement(false);
    setSavingTpLink(false);
    setSavingHomeAssistant(false);
    setLocationFeedback(null);
    setPlacementFeedback(null);
    setLocationValidationAttempted(false);
    setTpLinkHost("");
    setTpLinkUsername("");
    setTpLinkPassword("");
    setShowTpLinkPassword(false);
    setValidatedTpLinkDraft(null);
    setDirectResult(null);
    setTpLinkFeedback(null);
    setHaUrl("");
    setHaToken("");
    setShowHaToken(false);
    setValidatedHomeAssistantDraft(null);
    setResult(null);
    setHomeAssistantFeedback(null);
  }, [house.id]);

  const tpLinkDraftKey = `${tpLinkHost.trim()}\u0000${tpLinkUsername.trim()}\u0000${tpLinkPassword}`;
  const homeAssistantDraftKey = `${haUrl.trim()}\u0000${haToken}`;
  useEffect(() => {
    tpLinkTestGeneration.current += 1;
    setTestingDirect(false);
    setValidatedTpLinkDraft(null);
    setDirectResult(null);
  }, [tpLinkHost, tpLinkUsername, tpLinkPassword]);
  useEffect(() => {
    homeAssistantTestGeneration.current += 1;
    setTesting(false);
    setValidatedHomeAssistantDraft(null);
    setResult(null);
  }, [haUrl, haToken]);

  const changeTpLinkDraft = (field: "host" | "username" | "password", value: string) => {
    // Invalidate synchronously in the input event. A passive effect alone can
    // lose a race to a connection test promise that settles in the same turn.
    tpLinkTestGeneration.current += 1;
    setTestingDirect(false);
    setValidatedTpLinkDraft(null);
    setDirectResult(null);
    if (field === "host") setTpLinkHost(value);
    else if (field === "username") setTpLinkUsername(value);
    else setTpLinkPassword(value);
  };

  const changeHomeAssistantDraft = (field: "url" | "token", value: string) => {
    homeAssistantTestGeneration.current += 1;
    setTesting(false);
    setValidatedHomeAssistantDraft(null);
    setResult(null);
    if (field === "url") setHaUrl(value);
    else setHaToken(value);
  };

  const draftLocation = useMemo<HouseLocation | null>(() => {
    if (!latitude.trim() || !longitude.trim()) return null;
    const parsedLatitude = Number(latitude);
    const parsedLongitude = Number(longitude);
    if (!Number.isFinite(parsedLatitude) || !Number.isFinite(parsedLongitude)
      || parsedLatitude < -90 || parsedLatitude > 90 || parsedLongitude < -180 || parsedLongitude > 180) return null;
    const label = locationLabel.trim();
    return { latitude: parsedLatitude, longitude: parsedLongitude, ...(label ? { label } : {}) };
  }, [latitude, locationLabel, longitude]);
  const coordinateValidationVisible = !draftLocation
    && (locationValidationAttempted || Boolean(latitude.trim() || longitude.trim()));
  const timezoneValidationVisible = !validTimeZone(timezone)
    && (locationValidationAttempted || Boolean(timezone.trim()));

  const selectedFootprintFloor = useMemo(
    () => house.floors.find((floor) => floor.id === footprintFloorId) ?? footprintFloorFor(house),
    [footprintFloorId, house],
  );
  const selectedPlanSize = useMemo(() => floorPlanSize(selectedFootprintFloor), [selectedFootprintFloor]);
  const draftMapLocation = useMemo(
    () => mapLocation(placementLatitude, placementLongitude),
    [placementLatitude, placementLongitude],
  );
  const draftPlacement = useMemo<HouseMapPlacement | null>(() => {
    if (!draftMapLocation) return null;
    const physicalWidth = Number(footprintWidthMeters);
    if (!Number.isFinite(physicalWidth) || physicalWidth < 1 || physicalWidth > 500) return null;
    const metersPerPlanUnit = physicalWidth / selectedPlanSize.width;
    if (!Number.isFinite(metersPerPlanUnit) || metersPerPlanUnit <= 0) return null;
    return {
      ...draftMapLocation,
      metersPerPlanUnit,
      ...(selectedFootprintFloor ? { footprintFloorId: selectedFootprintFloor.id } : {}),
    };
  }, [draftMapLocation, footprintWidthMeters, selectedFootprintFloor, selectedPlanSize.width]);

  const draftOrientation = useMemo<number | null>(() => {
    if (!orientation.trim()) return null;
    const parsed = Number(orientation);
    return Number.isInteger(parsed) && parsed >= 0 && parsed <= 359 ? parsed : null;
  }, [orientation]);
  const footprintDepthMeters = useMemo(() => {
    const physicalWidth = Number(footprintWidthMeters);
    return Number.isFinite(physicalWidth) && selectedPlanSize.width > 0
      ? physicalWidth * selectedPlanSize.depth / selectedPlanSize.width
      : null;
  }, [footprintWidthMeters, selectedPlanSize]);
  const mapItems = useMemo<HouseLocationMapItem[]>(() => houses.map((candidate) => {
    const selected = candidate.id === house.id;
    const placement = selected ? draftPlacement : candidate.mapPlacement;
    const fallback = selected ? draftMapLocation : candidate.mapPlacement ?? candidate.location ?? null;
    const floor = selected
      ? selectedFootprintFloor
      : candidate.floors.find((item) => item.id === candidate.mapPlacement?.footprintFloorId) ?? footprintFloorFor(candidate);
    const candidateOrientation = selected ? draftOrientation : candidate.orientationDegrees;
    return {
      id: candidate.id,
      label: t("weather.markerLabel", { house: candidate.name }),
      location: fallback ? { latitude: fallback.latitude, longitude: fallback.longitude } : null,
      ...(candidateOrientation !== null && candidateOrientation !== undefined ? { orientationDegrees: candidateOrientation } : {}),
      ...(placement ? { metersPerPlanUnit: placement.metersPerPlanUnit } : {}),
      ...(floor ? { floor } : {}),
    };
  }), [draftMapLocation, draftOrientation, draftPlacement, house.id, houses, selectedFootprintFloor, t]);
  const orientationDirection = draftOrientation === null
    ? null
    : [t("orientation.north"), t("orientation.east"), t("orientation.south"), t("orientation.west")][Math.round(draftOrientation / 90) % 4];
  const orientationExplanation = draftOrientation === null
    ? t("orientation.unknownExplanation")
    : t("orientation.knownExplanation", { degrees: draftOrientation, direction: orientationDirection ?? "" });

  const selectSetupHouse = (houseId: string) => {
    if (houseId !== house.id) {
      locationRequestGeneration.current += 1;
      placementRequestGeneration.current += 1;
      discoveryGeneration.current += 1;
      inventoryRefreshGeneration.current += 1;
      stopTpLinkChildDiscovery(true);
      setSavingLocation(false);
      setSavingPlacement(false);
      setDiscovering(false);
      setRefreshingTpLinkInventory(false);
    }
    setSetupHouseId(houseId);
    onHouse(houseId);
  };

  const disconnectHomeAssistantAssignment = async (houseId: string) => {
    const assignedHouse = connectionHouses.find((candidate) => candidate.id === houseId);
    if (!window.confirm(t("setup.disconnectHomeAssistantConfirm", { home: assignedHouse?.name ?? houseId }))) return;
    const assignmentKey = `ha:${houseId}`;
    setBusyAssignment(assignmentKey);
    setAssignmentFeedback(null);
    try {
      const result = await (onDisconnectHomeAssistant
        ? onDisconnectHomeAssistant(houseId)
        : api.disconnectHomeAssistant(houseId));
      onIntegrationChange(result.integration);
      setAssignmentFeedback({ kind: "success", message: t("setup.connectionDisconnected") });
    } catch (error) {
      setAssignmentFeedback({ kind: "error", message: connectionError(error, t("setup.connectionDisconnectFailed")) });
    } finally {
      setBusyAssignment((current) => current === assignmentKey ? null : current);
    }
  };

  const disconnectTpLinkAssignment = async (connectionId: string, houseId: string) => {
    const assignedHouse = connectionHouses.find((candidate) => candidate.id === houseId);
    if (!window.confirm(t("setup.disconnectTpLinkConfirm", { home: assignedHouse?.name ?? houseId }))) return;
    const assignmentKey = `tp:${connectionId}`;
    setBusyAssignment(assignmentKey);
    setAssignmentFeedback(null);
    try {
      const result = await (onDisconnectTpLink
        ? onDisconnectTpLink(connectionId)
        : api.disconnectTpLink(connectionId));
      onIntegrationChange(result.integration);
      setAssignmentFeedback({
        kind: "success",
        message: result.detachedSensorIds.length > 0
          ? t("setup.tpLinkDisconnectedWithSensors", { count: result.detachedSensorIds.length })
          : t("setup.connectionDisconnected"),
      });
    } catch (error) {
      setAssignmentFeedback({ kind: "error", message: connectionError(error, t("setup.connectionDisconnectFailed")) });
    } finally {
      setBusyAssignment((current) => current === assignmentKey ? null : current);
    }
  };

  const moveHomeAssistantAssignment = async (fromHouseId: string, targetHouseId: string) => {
    if (fromHouseId === targetHouseId) return;
    const fromHome = connectionHouses.find((candidate) => candidate.id === fromHouseId)?.name ?? fromHouseId;
    const targetHome = connectionHouses.find((candidate) => candidate.id === targetHouseId)?.name ?? targetHouseId;
    if (!window.confirm(t("setup.moveHomeAssistantConfirm", { from: fromHome, to: targetHome }))) return;
    const assignmentKey = `ha:${fromHouseId}`;
    setBusyAssignment(assignmentKey);
    setAssignmentFeedback(null);
    try {
      const result = await (onMoveHomeAssistant
        ? onMoveHomeAssistant(fromHouseId, targetHouseId)
        : api.moveHomeAssistant(fromHouseId, targetHouseId));
      onIntegrationChange(result.integration);
      setAssignmentHouseDrafts((current) => {
        const next = { ...current };
        delete next[assignmentKey];
        return next;
      });
      setAssignmentFeedback({ kind: "success", message: t("setup.connectionMoved", { home: targetHome }) });
    } catch (error) {
      setAssignmentFeedback({ kind: "error", message: connectionError(error, t("setup.connectionMoveFailed")) });
    } finally {
      setBusyAssignment((current) => current === assignmentKey ? null : current);
    }
  };

  const moveTpLinkAssignment = async (connectionId: string, fromHouseId: string, targetHouseId: string) => {
    if (fromHouseId === targetHouseId) return;
    const fromHome = connectionHouses.find((candidate) => candidate.id === fromHouseId)?.name ?? fromHouseId;
    const targetHome = connectionHouses.find((candidate) => candidate.id === targetHouseId)?.name ?? targetHouseId;
    if (!window.confirm(t("setup.moveTpLinkConfirm", { from: fromHome, to: targetHome }))) return;
    const assignmentKey = `tp:${connectionId}`;
    setBusyAssignment(assignmentKey);
    setAssignmentFeedback(null);
    try {
      const result = await (onMoveTpLink
        ? onMoveTpLink(connectionId, targetHouseId)
        : api.moveTpLink(connectionId, targetHouseId));
      onIntegrationChange(result.integration);
      setAssignmentHouseDrafts((current) => {
        const next = { ...current };
        delete next[assignmentKey];
        return next;
      });
      setAssignmentFeedback({
        kind: "success",
        message: result.detachedSensorIds.length > 0
          ? t("setup.tpLinkMovedWithSensors", { home: targetHome, count: result.detachedSensorIds.length })
          : t("setup.connectionMoved", { home: targetHome }),
      });
    } catch (error) {
      setAssignmentFeedback({ kind: "error", message: connectionError(error, t("setup.connectionMoveFailed")) });
    } finally {
      setBusyAssignment((current) => current === assignmentKey ? null : current);
    }
  };

  const testConnection = async () => {
    const generation = ++homeAssistantTestGeneration.current;
    const testedDraftKey = homeAssistantDraftKey;
    setTesting(true);
    setResult(null);
    try {
      const response = await api.testHomeAssistantDraft({ url: haUrl.trim(), token: haToken });
      if (homeAssistantTestGeneration.current !== generation) return;
      const successful = response.ok;
      setValidatedHomeAssistantDraft(successful ? testedDraftKey : null);
      setResult(successful ? "success" : "failure");
    } catch {
      if (homeAssistantTestGeneration.current !== generation) return;
      setValidatedHomeAssistantDraft(null);
      setResult("failure");
    } finally {
      if (homeAssistantTestGeneration.current === generation) setTesting(false);
    }
  };

  const testDirectConnection = async () => {
    const generation = ++tpLinkTestGeneration.current;
    const testedDraftKey = tpLinkDraftKey;
    setTestingDirect(true);
    setDirectResult(null);
    try {
      const hasCompleteDraft = Boolean(tpLinkHost.trim() && tpLinkUsername.trim() && tpLinkPassword);
      const hasAnyDraft = Boolean(tpLinkHost.trim() || tpLinkUsername.trim() || tpLinkPassword);
      if (!hasAnyDraft && integration.tpLink.configured) {
        const response = await api.testTpLink(house.id);
        if (tpLinkTestGeneration.current !== generation) return;
        setDirectResult(response.ok ? "success" : "failure");
        return;
      }
      if (!hasCompleteDraft) {
        if (tpLinkTestGeneration.current !== generation) return;
        setValidatedTpLinkDraft(null);
        setDirectResult("failure");
        return;
      }
      const response = await api.testTpLinkDraft({
        host: tpLinkHost.trim(), username: tpLinkUsername.trim(), password: tpLinkPassword,
      });
      if (tpLinkTestGeneration.current !== generation) return;
      const successful = response.ok;
      setValidatedTpLinkDraft(successful ? testedDraftKey : null);
      setDirectResult(successful ? "success" : "failure");
    } catch {
      if (tpLinkTestGeneration.current !== generation) return;
      setValidatedTpLinkDraft(null);
      setDirectResult("failure");
    } finally {
      if (tpLinkTestGeneration.current === generation) setTestingDirect(false);
    }
  };

  const refreshTpLinkInventory = async () => {
    const targetHouseId = house.id;
    const generation = ++inventoryRefreshGeneration.current;
    setRefreshingTpLinkInventory(true);
    setTpLinkInventoryRefreshFailed(false);
    try {
      await (onRefreshTpLinkDevices ? onRefreshTpLinkDevices(targetHouseId) : api.tpLinkDevices(targetHouseId));
    } catch {
      if (activeSetupHouseId.current === targetHouseId && inventoryRefreshGeneration.current === generation) {
        setTpLinkInventoryRefreshFailed(true);
      }
    } finally {
      if (activeSetupHouseId.current === targetHouseId && inventoryRefreshGeneration.current === generation) {
        setRefreshingTpLinkInventory(false);
      }
    }
  };

  const scanIntegrations = async () => {
    const targetHouseId = house.id;
    const generation = ++discoveryGeneration.current;
    setDiscovering(true);
    setDiscovery(null);
    setDiscoveryOutcome("idle");
    try {
      const result = await api.discoverIntegrations(targetHouseId);
      if (activeSetupHouseId.current !== targetHouseId || discoveryGeneration.current !== generation) return;
      setDiscovery(result);
      const count = result.tpLink.length + result.homeAssistant.length;
      setDiscoveryOutcome(count > 0 ? "found" : result.warnings.length > 0 ? "error" : "empty");
      if (result.tpLink.length === 0 && !integration.tpLink.configured && !integration.homeAssistant.configured) setTpLinkSettingsOpen(true);
    } catch {
      if (activeSetupHouseId.current !== targetHouseId || discoveryGeneration.current !== generation) return;
      setDiscovery(null);
      setDiscoveryOutcome("error");
      if (!integration.tpLink.configured && !integration.homeAssistant.configured) setTpLinkSettingsOpen(true);
    } finally {
      if (activeSetupHouseId.current === targetHouseId && discoveryGeneration.current === generation) {
        setDiscovering(false);
      }
    }
  };

  const settleTpLinkChildren = async (hubModel: "H100" | "H200" | null) => {
    stopTpLinkChildDiscovery();
    const targetHouseId = house.id;
    const controller = new AbortController();
    tpLinkChildDiscoveryAbort.current = controller;
    tpLinkChildDiscoveryKey.current = hubModel ?? "unknown";
    tpLinkChildDiscoveryRunning.current = true;
    let receivedResponse = false;
    let receivedDeviceInventory = false;
    let latestStatus: IntegrationStatus["tpLink"] | null = null;
    const isCurrentHouse = () => !controller.signal.aborted
      && activeSetupHouseId.current === targetHouseId
      && tpLinkChildDiscoveryAbort.current === controller;

    try {
      for (let attempt = 1; attempt <= TP_LINK_CHILD_DISCOVERY_ATTEMPTS; attempt += 1) {
        if (attempt > 1 && !await waitForChildDiscoveryAttempt(controller.signal)) return;
        if (!isCurrentHouse()) return;
        setTpLinkChildDiscovery({ phase: "settling", attempt, hubModel });
        const [devicesResult, statusResult] = await Promise.allSettled([
          onRefreshTpLinkDevices ? onRefreshTpLinkDevices(targetHouseId) : api.tpLinkDevices(targetHouseId),
          api.integrations(targetHouseId),
        ]);
        if (!isCurrentHouse()) return;

        const devices = devicesResult.status === "fulfilled" ? devicesResult.value : [];
        if (devicesResult.status === "fulfilled") {
          receivedResponse = true;
          receivedDeviceInventory = true;
        }
        if (statusResult.status === "fulfilled") {
          receivedResponse = true;
          latestStatus = statusResult.value.tpLink;
        }
        const discoveredDevices = Math.max(devices.length, latestStatus?.discoveredDevices ?? 0);
        if (discoveredDevices > 0) {
          setTpLinkChildDiscovery({ phase: "found", count: discoveredDevices, hubModel: latestStatus?.hubModel ?? hubModel });
          return;
        }
      }

      if (!isCurrentHouse()) return;
      setTpLinkChildDiscovery({
        phase: !receivedResponse || !receivedDeviceInventory || Boolean(latestStatus?.error) ? "error" : "empty",
        hubModel: latestStatus?.hubModel ?? hubModel,
      });
    } finally {
      if (tpLinkChildDiscoveryAbort.current === controller) {
        tpLinkChildDiscoveryAbort.current = null;
        tpLinkChildDiscoveryKey.current = null;
        tpLinkChildDiscoveryRunning.current = false;
      }
    }
  };

  useEffect(() => {
    const hubModel = integration.tpLink.hubModel;
    const eligible = activeSection === "connections"
      && integration.tpLink.configured
      && integration.tpLink.connected
      && integration.tpLink.discoveredDevices === 0
      && Boolean(hubModel);
    const configuredHubDiscoveryRunning = activeSection === "connections"
      && integration.tpLink.configured
      && integration.tpLink.discoveredDevices === 0
      && tpLinkChildDiscoveryRunning.current;
    if (!eligible && !configuredHubDiscoveryRunning) {
      stopTpLinkChildDiscovery(integration.tpLink.discoveredDevices === 0);
    }
  }, [
    activeSection,
    integration.tpLink.configured,
    integration.tpLink.connected,
    integration.tpLink.discoveredDevices,
    integration.tpLink.hubModel,
  ]);

  useEffect(() => {
    const hubModel = integration.tpLink.hubModel;
    const eligible = activeSection === "connections"
      && integration.tpLink.configured
      && integration.tpLink.connected
      && integration.tpLink.discoveredDevices === 0
      && Boolean(hubModel);
    if (!eligible || !hubModel) return;
    const expectedKey = hubModel;
    if (tpLinkChildDiscoveryRunning.current) {
      if (tpLinkChildDiscoveryKey.current !== expectedKey) void settleTpLinkChildren(hubModel);
      return;
    }
    const displayedHubModel = tpLinkChildDiscovery.phase === "idle" ? null : tpLinkChildDiscovery.hubModel;
    if (tpLinkChildDiscovery.phase === "idle" || displayedHubModel !== hubModel) void settleTpLinkChildren(hubModel);
  }, [
    activeSection,
    integration.tpLink.configured,
    integration.tpLink.connected,
    integration.tpLink.discoveredDevices,
    integration.tpLink.hubModel,
    tpLinkChildDiscovery.phase,
  ]);

  const saveTpLink = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (validatedTpLinkDraft !== tpLinkDraftKey) {
      setTpLinkFeedback({ kind: "error", message: t("setup.validationRequired") });
      return;
    }
    if (!window.confirm(t("setup.activationConfirm"))) return;
    setSavingTpLink(true);
    setTpLinkFeedback(null);
    const requestHouseId = house.id;
    try {
      const configured = await api.configureTpLink({ houseId: requestHouseId, host: tpLinkHost, username: tpLinkUsername, password: tpLinkPassword });
      if (activeSetupHouseId.current !== requestHouseId) return;
      onIntegrationChange(configured.integration);
      setTpLinkPassword("");
      setValidatedTpLinkDraft(null);
      setShowTpLinkPassword(false);
      setTpLinkFeedback({ kind: "success", message: t("setup.credentialsSaved") });
      const selectedHub = discovery?.tpLink.find((candidate) => candidate.host === tpLinkHost);
      void settleTpLinkChildren(configured.integration.tpLink.hubModel ?? selectedHub?.model ?? null);
    } catch {
      if (activeSetupHouseId.current === requestHouseId) setTpLinkFeedback({ kind: "error", message: t("setup.credentialsError") });
    } finally {
      if (activeSetupHouseId.current === requestHouseId) setSavingTpLink(false);
    }
  };

  const saveHomeAssistant = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (validatedHomeAssistantDraft !== homeAssistantDraftKey) {
      setHomeAssistantFeedback({ kind: "error", message: t("setup.validationRequired") });
      return;
    }
    if (!window.confirm(t("setup.activationConfirm"))) return;
    setSavingHomeAssistant(true);
    setHomeAssistantFeedback(null);
    const requestHouseId = house.id;
    try {
      const configured = await api.configureHomeAssistant({ houseId: requestHouseId, url: haUrl, token: haToken });
      if (activeSetupHouseId.current !== requestHouseId) return;
      onIntegrationChange(configured.integration);
      setHaToken("");
      setValidatedHomeAssistantDraft(null);
      setShowHaToken(false);
      setHomeAssistantFeedback({ kind: "success", message: t("setup.credentialsSaved") });
    } catch {
      if (activeSetupHouseId.current === requestHouseId) setHomeAssistantFeedback({ kind: "error", message: t("setup.credentialsError") });
    } finally {
      if (activeSetupHouseId.current === requestHouseId) setSavingHomeAssistant(false);
    }
  };

  const saveLocation = async () => {
    setLocationValidationAttempted(true);
    if (!draftLocation || !validTimeZone(timezone)) {
      setLocationFeedback(null);
      return;
    }
    const request = beginLocationRequest();
    const nextLocation = draftLocation;
    const nextTimezone = timezone.trim();
    setSavingLocation(true);
    setLocationFeedback(null);
    try {
      await onHouseUpdate(request.houseId, {
        location: {
          ...nextLocation,
          source: "manual",
          confidence: "high",
          discoveredAt: new Date().toISOString(),
          userOverridden: true,
        },
        timezone: nextTimezone,
      });
      if (!isCurrentLocationRequest(request)) return;
      setLocationValidationAttempted(false);
      setLocationFeedback({ kind: "success", message: t("weather.locationSaved") });
    } catch {
      if (!isCurrentLocationRequest(request)) return;
      setLocationFeedback({ kind: "error", message: t("weather.locationSaveError") });
    } finally {
      if (isCurrentLocationRequest(request)) setSavingLocation(false);
    }
  };

  const removeLocation = async () => {
    const request = beginLocationRequest();
    setSavingLocation(true);
    setLocationFeedback(null);
    try {
      await onGeoreferenceChange(request.houseId, { location: null });
      if (!isCurrentLocationRequest(request)) return;
      setLatitude("");
      setLongitude("");
      setLocationLabel("");
      setLocationFeedback({ kind: "success", message: t("weather.locationRemoved") });
    } catch {
      if (!isCurrentLocationRequest(request)) return;
      setLocationFeedback({ kind: "error", message: t("weather.locationSaveError") });
    } finally {
      if (isCurrentLocationRequest(request)) setSavingLocation(false);
    }
  };

  const resetPlacementDraft = () => {
    const form = placementForm(house);
    setPlacementLatitude(form.latitude);
    setPlacementLongitude(form.longitude);
    setFootprintFloorId(form.footprintFloorId);
    setFootprintWidthMeters(form.footprintWidthMeters);
    setOrientation(house.orientationDegrees === undefined ? "" : String(house.orientationDegrees));
    setPlacementEditing(false);
    setPlacementFeedback(null);
  };

  const savePlacement = async () => {
    if (!draftPlacement) {
      setPlacementFeedback({ kind: "error", message: t("placement.invalid") });
      return;
    }
    if (orientation.trim() && draftOrientation === null) {
      setPlacementFeedback({ kind: "error", message: t("orientation.invalid") });
      return;
    }
    const patch: HouseGeoreferencePatch = {
      mapPlacement: draftPlacement,
      ...(orientation.trim()
        ? { orientationDegrees: draftOrientation as number }
        : house.orientationDegrees !== undefined ? { orientationDegrees: null } : {}),
    };
    const request = beginPlacementRequest();
    setSavingPlacement(true);
    setPlacementFeedback(null);
    try {
      await onGeoreferenceChange(request.houseId, patch);
      if (!isCurrentPlacementRequest(request)) return;
      setPlacementEditing(false);
      setPlacementFeedback({ kind: "success", message: t("placement.saved") });
    } catch {
      if (!isCurrentPlacementRequest(request)) return;
      setPlacementFeedback({ kind: "error", message: t("placement.saveError") });
    } finally {
      if (isCurrentPlacementRequest(request)) setSavingPlacement(false);
    }
  };

  const removePlacement = async () => {
    const request = beginPlacementRequest();
    const selectedHouse = house;
    setSavingPlacement(true);
    setPlacementFeedback(null);
    try {
      await onGeoreferenceChange(request.houseId, { mapPlacement: null });
      if (!isCurrentPlacementRequest(request)) return;
      const { mapPlacement: _removedPlacement, ...houseWithoutPlacement } = selectedHouse;
      const form = placementForm(houseWithoutPlacement);
      setPlacementLatitude(form.latitude);
      setPlacementLongitude(form.longitude);
      setFootprintFloorId(form.footprintFloorId);
      setFootprintWidthMeters(form.footprintWidthMeters);
      setPlacementEditing(true);
      setPlacementFeedback({ kind: "success", message: t("placement.removed") });
    } catch {
      if (!isCurrentPlacementRequest(request)) return;
      setPlacementFeedback({ kind: "error", message: t("placement.saveError") });
    } finally {
      if (isCurrentPlacementRequest(request)) setSavingPlacement(false);
    }
  };

  const clearOrientation = async () => {
    const request = beginPlacementRequest();
    setSavingPlacement(true);
    setPlacementFeedback(null);
    try {
      await onGeoreferenceChange(request.houseId, { orientationDegrees: null });
      if (!isCurrentPlacementRequest(request)) return;
      setOrientation("");
      setPlacementFeedback({ kind: "success", message: t("orientation.cleared") });
    } catch {
      if (!isCurrentPlacementRequest(request)) return;
      setPlacementFeedback({ kind: "error", message: t("orientation.saveError") });
    } finally {
      if (isCurrentPlacementRequest(request)) setSavingPlacement(false);
    }
  };

  const updateFromMap = (houseId: string, location: MapLocation) => {
    if (houseId !== house.id) return;
    setPlacementLatitude(location.latitude.toFixed(7));
    setPlacementLongitude(location.longitude.toFixed(7));
    setPlacementEditing(true);
    setPlacementFeedback(null);
  };

  const usePlacementForWeather = () => {
    const source = house.mapPlacement ?? draftMapLocation;
    if (!source) return;
    setLatitude(source.latitude.toFixed(6));
    setLongitude(source.longitude.toFixed(6));
    setLocationLabel("");
    setLocationFeedback(null);
  };

  const savePlacementForWeather = async () => {
    const source = house.mapPlacement;
    if (!source) return;
    const request = beginLocationRequest();
    const discoveredAt = new Date().toISOString();
    const nextLocation: HouseLocation = {
      latitude: source.latitude,
      longitude: source.longitude,
      source: "map-placement",
      confidence: "high",
      discoveredAt,
      userOverridden: false,
    };
    setSavingLocation(true);
    setLocationFeedback(null);
    try {
      const defaults = await api.coordinateDefaults(source.latitude, source.longitude);
      await onHouseUpdate(request.houseId, { location: nextLocation, timezone: defaults.timezone });
      if (!isCurrentLocationRequest(request)) return;
      setLatitude(String(source.latitude));
      setLongitude(String(source.longitude));
      setLocationLabel("");
      setTimezone(defaults.timezone);
      setLocationFeedback({ kind: "success", message: t("weather.locationSaved") });
    } catch {
      if (!isCurrentLocationRequest(request)) return;
      setLocationFeedback({ kind: "error", message: t("weather.locationSaveError") });
    } finally {
      if (isCurrentLocationRequest(request)) setSavingLocation(false);
    }
  };

  const applyDiscoveredDefaults = async (defaults: DiscoveredHomeDefaults) => {
    const request = beginLocationRequest();
    setSavingLocation(true);
    try {
      await onHouseUpdate(request.houseId, { location: defaults.location, timezone: defaults.timezone });
      if (!isCurrentLocationRequest(request)) return;
      setLatitude(String(defaults.location.latitude));
      setLongitude(String(defaults.location.longitude));
      setLocationLabel(defaults.location.label ?? "");
      setTimezone(defaults.timezone);
      setLocationFeedback(null);
    } finally {
      if (isCurrentLocationRequest(request)) setSavingLocation(false);
    }
  };

  const discoveredCount = (discovery?.tpLink.length ?? 0) + (discovery?.homeAssistant.length ?? 0);
  const sensorHardwareDetected = discoveredCount > 0
    || integration.tpLink.discoveredDevices > 0
    || integration.tpLink.mappedDevices > 0
    || integration.homeAssistant.mappedEntities > 0;
  const sensorSourceConfigured = integration.tpLink.configured || integration.homeAssistant.configured;
  const sensorSourceConnected = integration.tpLink.connected || integration.homeAssistant.connected;
  const mappedSensorSources = integration.tpLink.mappedDevices > 0 || integration.homeAssistant.mappedEntities > 0;
  const tpLinkReadyDevices = Math.max(0, integration.tpLink.discoveredDevices - integration.tpLink.mappedDevices);
  const tpLinkHubName = integration.tpLink.hubModel ?? t("setup.tpLinkEnergyDevice");
  const connectedSourceCount = Number(integration.tpLink.connected) + Number(integration.homeAssistant.connected);
  const assignmentCount = homeAssistantAssignments.length + tpLinkAssignments.length;
  const connectedSourceLabel = connectedSourceCount > 1
    ? t("setup.sourcesConnected", { count: connectedSourceCount })
    : integration.tpLink.connected
      ? t("setup.tpLinkConnectedShort")
      : integration.homeAssistant.connected
        ? t("setup.homeAssistantConnectedShort")
        : t("common.notConnected");
  const streamStatusLabel = t(`setup.stream.${streamConnection}`);
  const connectionWorkspaceActive = activeSection === "connections" && sensorSourceConfigured;
  const steps = [
    { icon: Router, title: t("setup.step1"), body: t("setup.step1body"), complete: sensorHardwareDetected },
    { icon: Home, title: t("setup.step2"), body: t("setup.step2body"), complete: sensorSourceConfigured },
    { icon: Link2, title: t("setup.step3"), body: t("setup.step3body"), complete: sensorSourceConnected },
    { icon: ThermometerSun, title: t("setup.step4"), body: t("setup.step4body"), complete: mappedSensorSources },
  ];
  const completeCount = steps.filter((step) => step.complete).length;
  const nextStepIndex = steps.findIndex((step) => !step.complete);
  const nextStep = nextStepIndex >= 0 ? steps[nextStepIndex]! : null;

  const weatherHomes = houses.filter((candidate) => candidate.location).length;
  const notesGrantCount = integration.appleNotes?.grantCount ?? 0;
  const selectedDiscoveredTpLink = discovery?.tpLink.find((candidate) => candidate.host === tpLinkHost);
  const selectedDiscoveredHomeAssistant = discovery?.homeAssistant.find((candidate) => candidate.url === haUrl);

  const setupSections: Array<{ id: SetupSection; label: string; detail: string }> = [
    { id: "overview", label: t("setup.workspaceOverview"), detail: t("setup.workspaceOverviewDetail") },
    { id: "layout", label: t("setup.workspaceLayout"), detail: t("setup.workspaceLayoutDetail", { count: house.floors.length }) },
    { id: "connections", label: t("setup.workspaceConnections"), detail: connectedSourceLabel },
    { id: "weather", label: t("setup.workspaceWeather"), detail: t("setup.workspaceWeatherDetail", { count: weatherHomes }) },
    { id: "operations", label: t("setup.workspaceOperations"), detail: t("setup.workspaceOperationsDetail") },
    { id: "automations", label: t("setup.workspaceAutomations"), detail: t("setup.workspaceAutomationsDetail", { count: notesGrantCount }) },
  ];
  const activeSectionLabel = setupSections.find((section) => section.id === activeSection)?.label ?? t("setup.workspaceOverview");

  const activateSection = (section: SetupSection) => {
    setActiveSection(section);
    writeSetupSection(section);
  };
  const handleSectionKeyDown = (event: KeyboardEvent<HTMLButtonElement>, section: SetupSection) => {
    if (!["ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key)) return;
    event.preventDefault();
    const index = setupSectionOrder.indexOf(section);
    const nextIndex = event.key === "Home"
      ? 0
      : event.key === "End"
        ? setupSectionOrder.length - 1
        : (index + (event.key === "ArrowRight" ? 1 : -1) + setupSectionOrder.length) % setupSectionOrder.length;
    const next = setupSectionOrder[nextIndex]!;
    activateSection(next);
    window.requestAnimationFrame(() => document.getElementById(`setup-tab-${next}`)?.focus());
  };
  const runRecommendedAction = () => {
    if (nextStepIndex === 0) {
      activateSection("connections");
      void scanIntegrations();
      return;
    }
    if (nextStepIndex === 1 || nextStepIndex === 2) {
      activateSection("connections");
      return;
    }
    if (nextStepIndex === 3) {
      if (onOpenSensors) onOpenSensors();
      else activateSection("connections");
    }
  };
  const recommendedActionLabel = discoveredCount > 0 && nextStepIndex === 1
    ? t("setup.reviewFound", { count: discoveredCount })
    : nextStepIndex === 0
    ? t("setup.scan")
    : nextStepIndex === 3 ? t("sensors.add") : t("setup.workspaceConnections");

  return (
    <>
      <header className="page-heading">
        <div><span className="eyebrow"><RadioTower size={14} aria-hidden="true" />{activeSectionLabel}</span><h1>{connectionWorkspaceActive ? t("setup.connectionsTitle") : t("setup.title")}</h1><p>{connectionWorkspaceActive ? t("setup.connectionsDescription") : t("setup.description")}</p></div>
        {!connectionWorkspaceActive && <span className={`integration-pill ${sensorSourceConnected ? "connected" : ""}`}><span aria-hidden="true" />{connectedSourceLabel}</span>}
      </header>
      <div className="setup-workspace-tabs" role="tablist" aria-label={t("setup.workspaceNavigation")}>
        {setupSections.map((section) => (
          <button
            key={section.id}
            id={`setup-tab-${section.id}`}
            type="button"
            role="tab"
            aria-selected={activeSection === section.id}
            aria-controls={`setup-panel-${section.id}`}
            tabIndex={activeSection === section.id ? 0 : -1}
            onClick={() => activateSection(section.id)}
            onKeyDown={(event) => handleSectionKeyDown(event, section.id)}
          >
            <strong>{section.label}</strong><small>{section.detail}</small>
          </button>
        ))}
      </div>

      {(activeSection === "overview" || activeSection === "connections") && <div
        id={`setup-panel-${activeSection}`}
        className={`setup-layout setup-workspace-panel ${activeSection === "connections" ? "connections-workspace" : ""}`}
        role="tabpanel"
        aria-labelledby={`setup-tab-${activeSection}`}
      >
        {activeSection === "connections" && <div className="setup-connection-scope">
          <span className="setup-scope-note"><Home size={16} aria-hidden="true" />{t("setup.connectionsForHome", { home: house.name })}</span>
          <label className="setup-connection-home-picker">
            <span>{t("setup.connectionHome")}</span>
            <select value={house.id} onChange={(event) => selectSetupHouse(event.target.value)}>
              {connectionHouses.map((candidate) => <option key={candidate.id} value={candidate.id}>{candidate.name}</option>)}
            </select>
          </label>
          <small>{t("setup.connectionHomeHelp")}</small>
        </div>}
        {activeSection === "overview" && <section className="panel setup-steps" aria-labelledby="setup-progress-title">
          <div className="panel-header setup-progress"><div><span className="eyebrow" id="setup-progress-title">{t("setup.progress")}</span><small>{nextStep ? t("setup.nextStep") : t("setup.completeTitle")}</small><h2>{nextStep?.title ?? t("setup.completeTitle")}</h2></div><div className="progress-track" role="progressbar" aria-labelledby="setup-progress-title" aria-valuemin={0} aria-valuemax={steps.length} aria-valuenow={completeCount} aria-valuetext={`${completeCount} / ${steps.length}`}><span style={{ width: `${completeCount / steps.length * 100}%` }} /></div></div>
          {nextStep ? <div className="setup-recommended-action">
            <span className="step-icon" aria-hidden="true">{(() => { const Icon = nextStep.icon; return <Icon size={20} />; })()}</span>
            <p>{nextStep.body}</p>
            <button type="button" className="primary-button" disabled={nextStepIndex === 0 && discovering} onClick={runRecommendedAction}>{nextStepIndex === 0 && discovering ? <LoaderCircle className="spin" size={16} aria-hidden="true" /> : <ChevronRight size={16} aria-hidden="true" />}{nextStepIndex === 0 && discovering ? t("setup.scanning") : recommendedActionLabel}</button>
          </div> : <p className="configured-note"><Check size={17} aria-hidden="true" />{t("setup.completeBody")}</p>}
          <details className="setup-checklist-disclosure">
            <summary>{t("setup.reviewChecklist")}</summary>
            <ol className="step-list">
              {steps.map((step, index) => {
                const Icon = step.icon;
                return <li key={step.title} className={step.complete ? "complete" : ""}><span className="step-number">{step.complete ? <Check size={16} aria-hidden="true" /> : index + 1}</span><span className="step-icon" aria-hidden="true"><Icon size={20} /></span><div><h3>{step.title}</h3><p>{step.body}</p></div>{index < steps.length - 1 && <ChevronRight className="step-chevron" size={18} aria-hidden="true" />}</li>;
              })}
            </ol>
          </details>
        </section>}
        <div className="setup-side">
          {activeSection === "connections" && integration.tpLink.configured && <section
            className={`panel tp-link-live-status ${integration.tpLink.connected ? integration.tpLink.error ? "warning" : "connected" : "waiting"}`}
            aria-label={t("setup.tpLinkLiveRegion")}
            aria-busy={tpLinkDevicesLoading || refreshingTpLinkInventory}
          >
            <header className="tp-link-live-header">
              <span className={`tp-link-live-icon ${integration.tpLink.connected ? "connected" : "waiting"}`} aria-hidden="true"><Router size={24} /></span>
              <span className="tp-link-live-copy">
                <span className="eyebrow">{t("setup.tpLinkLiveEyebrow")}</span>
                <h2 id="tp-link-live-status-heading">{t(integration.tpLink.connected ? "setup.tpLinkConnectedTitle" : "setup.tpLinkConnectingTitle", { hub: tpLinkHubName })}</h2>
                <p>{t(integration.tpLink.connected ? "setup.tpLinkConnectedBody" : "setup.tpLinkConnectingBody")}</p>
              </span>
              <span className={`live-stream-pill ${streamConnection}`} role="status"><span aria-hidden="true" />{streamStatusLabel}</span>
            </header>

            {onOpenSensors && <div className="tp-link-live-next">
              <span><strong>{t("setup.tpLinkDeviceSummary", { mapped: integration.tpLink.mappedDevices, ready: tpLinkReadyDevices })}</strong><small>{t("setup.childFoundDetail")}</small></span>
              <button type="button" className="primary-button" onClick={onOpenSensors}><ThermometerSun size={16} aria-hidden="true" />{t("setup.childOpenSensors")}</button>
            </div>}

            {integration.tpLink.error && <div className={`tp-link-live-alert ${integration.tpLink.connected ? "warning" : "error"}`} role="alert"><TriangleAlert size={17} aria-hidden="true" /><span><strong>{t(integration.tpLink.connected ? "setup.tpLinkWarning" : "setup.tpLinkConnectionError")}</strong><small>{integration.tpLink.error}</small></span></div>}
            {(tpLinkDevicesError || tpLinkInventoryRefreshFailed) && <div className="tp-link-live-alert error" role="alert"><TriangleAlert size={17} aria-hidden="true" /><span><strong>{t("setup.tpLinkInventoryError")}</strong><small>{t("setup.tpLinkInventoryErrorDetail")}</small></span></div>}
            {(tpLinkDevicesLoading || refreshingTpLinkInventory) && <p className="tp-link-inventory-refresh" role="status"><LoaderCircle className="spin" size={16} aria-hidden="true" />{t("setup.tpLinkInventoryRefreshing")}</p>}

            {tpLinkChildDiscovery.phase !== "idle" && <div className={`tp-link-child-discovery ${tpLinkChildDiscovery.phase}`} aria-busy={tpLinkChildDiscovery.phase === "settling"}>
              {tpLinkChildDiscovery.phase === "settling" && <>
                <p className="setup-discovery-message" role="status"><LoaderCircle className="spin" size={18} aria-hidden="true" /><span><strong>{t("setup.childSettling", { hub: tpLinkChildDiscovery.hubModel ?? t("setup.tpLinkHub") })}</strong><small>{t("setup.childSettlingDetail", { hub: tpLinkChildDiscovery.hubModel ?? t("setup.tpLinkHub") })}</small></span></p>
                <div className="child-discovery-progress" role="progressbar" aria-label={t("setup.childProgress", { attempt: tpLinkChildDiscovery.attempt, total: TP_LINK_CHILD_DISCOVERY_ATTEMPTS })} aria-valuemin={1} aria-valuemax={TP_LINK_CHILD_DISCOVERY_ATTEMPTS} aria-valuenow={tpLinkChildDiscovery.attempt}><span style={{ width: `${tpLinkChildDiscovery.attempt / TP_LINK_CHILD_DISCOVERY_ATTEMPTS * 100}%` }} /></div>
              </>}
              {tpLinkChildDiscovery.phase === "found" && <p className="setup-discovery-message" role="status"><Check size={18} aria-hidden="true" /><span><strong>{t("setup.childFound", { count: tpLinkChildDiscovery.count })}</strong><small>{t("setup.childFoundDetail")}</small></span></p>}
              {tpLinkChildDiscovery.phase === "empty" && <p className="setup-discovery-message" role="status"><CircleDot size={18} aria-hidden="true" /><span><strong>{t("setup.childEmpty")}</strong><small>{t("setup.childEmptyDetail")}</small></span></p>}
              {tpLinkChildDiscovery.phase === "error" && <p className="setup-discovery-message" role="alert"><TriangleAlert size={18} aria-hidden="true" /><span><strong>{t("setup.childError")}</strong><small>{t("setup.childErrorDetail")}</small></span></p>}
              {tpLinkChildDiscovery.phase !== "settling" && <div className="child-discovery-actions">
                <button type="button" className="secondary-button" onClick={() => void settleTpLinkChildren(tpLinkChildDiscovery.hubModel)}><RefreshCw size={16} aria-hidden="true" />{t("setup.childRetry")}</button>
              </div>}
            </div>}

            <details className="setup-config-disclosure tp-link-detail-disclosure">
              <summary><span><Link2 size={16} aria-hidden="true" />{t("setup.tpLinkDetails")}</span><small>{t("setup.tpLinkDetailsSummary")}</small></summary>
              <div className="tp-link-detail-content">
                <dl className="tp-link-live-metrics">
                  <div><dt>{t("setup.tpLinkSource")}</dt><dd>TP-Link {tpLinkHubName}</dd></div>
                  <div><dt>{t("setup.tpLinkLastPoll")}</dt><dd>{integration.tpLink.lastPollAt ? <time dateTime={integration.tpLink.lastPollAt}>{localDateTime(integration.tpLink.lastPollAt) ?? "—"}</time> : t("setup.tpLinkNoPoll")}</dd></div>
                  <div><dt>{t("setup.tpLinkDiscovered")}</dt><dd>{integration.tpLink.discoveredDevices}</dd></div>
                  <div><dt>{t("setup.tpLinkMapped")}</dt><dd>{integration.tpLink.mappedDevices}</dd></div>
                  <div><dt>{t("setup.tpLinkReady")}</dt><dd>{tpLinkReadyDevices}</dd></div>
                </dl>
                <div className="tp-link-polling-note">
                  <span className={`status-pulse ${integration.tpLink.connected ? "live" : "reconnecting"}`} aria-hidden="true" />
                  <span><strong>{t("setup.tpLinkPollingTitle")}</strong><small>{t(`setup.streamHelp.${streamConnection}`)}</small></span>
                </div>
                <div className="tp-link-live-actions">
                  <button type="button" className="secondary-button" disabled={tpLinkDevicesLoading || refreshingTpLinkInventory} onClick={() => void refreshTpLinkInventory()}>{tpLinkDevicesLoading || refreshingTpLinkInventory ? <LoaderCircle className="spin" size={16} aria-hidden="true" /> : <RefreshCw size={16} aria-hidden="true" />}{t("setup.tpLinkRefreshInventory")}</button>
                  <button type="button" className="secondary-button" disabled={testingDirect} onClick={() => void testDirectConnection()}>{testingDirect ? <LoaderCircle className="spin" size={16} aria-hidden="true" /> : <Router size={16} aria-hidden="true" />}{testingDirect ? t("setup.scanning") : t("setup.testDirect")}</button>
                </div>
                {directResult && <p className={`test-result ${directResult}`} role={directResult === "failure" ? "alert" : "status"}>{directResult === "success" ? <ShieldCheck size={17} aria-hidden="true" /> : <CircleDot size={17} aria-hidden="true" />}{directResult === "success" ? t("setup.directTestSuccess") : t("setup.directTestFailure")}</p>}
              </div>
            </details>
          </section>}
          {activeSection === "connections" && <details className={`panel connection-card discovery-card ${sensorSourceConfigured ? "optional" : ""}`} aria-labelledby="network-discovery-heading" open={!sensorSourceConfigured || discovering || discoveryOutcome !== "idle"}>
            <summary className="connection-card-summary">
              <span className="connection-card-summary-copy"><span className="eyebrow">{t(sensorSourceConfigured ? "setup.addConnectionEyebrow" : "setup.scanTitle")}</span><strong id="network-discovery-heading">{t(sensorSourceConfigured ? "setup.addConnectionTitle" : "setup.scanDescription")}</strong><small>{t(sensorSourceConfigured ? "setup.addConnectionDescription" : "setup.scanScope")}</small></span>
              <span className="ha-mark" aria-hidden="true"><RadioTower size={22} /></span>
            </summary>
            <div className="discovery-card-content">
              <div className="connection-check guided-setup">
              <button type="button" className={`${sensorSourceConfigured ? "secondary-button" : "primary-button"} full-width`} disabled={discovering} onClick={() => void scanIntegrations()}>{discovering ? <LoaderCircle className="spin" size={17} aria-hidden="true" /> : <RefreshCw size={17} aria-hidden="true" />}{discovering ? t("setup.scanning") : t(sensorSourceConfigured ? "setup.findAdditionalSystems" : "setup.scan")}</button>
              <div className={`setup-discovery-feedback ${discovering ? "running" : discoveryOutcome}`} aria-live="polite" aria-busy={discovering}>
                {discovering && <p className="setup-discovery-message" role="status"><LoaderCircle className="spin" size={18} aria-hidden="true" /><span><strong>{t("setup.scanning")}</strong><small>{t("setup.scanProgress")}</small></span></p>}
                {!discovering && discoveryOutcome === "found" && <p className="setup-discovery-message" role="status"><Check size={18} aria-hidden="true" /><span><strong>{t("setup.scanFound", { count: discoveredCount })}</strong><small>{t("setup.scanComplete")}</small></span></p>}
                {!discovering && discoveryOutcome === "empty" && <p className="setup-discovery-message" role="status"><CircleDot size={18} aria-hidden="true" /><span><strong>{t(sensorSourceConfigured ? "setup.scanAdditionalEmpty" : "setup.scanEmpty")}</strong><small>{t(sensorSourceConfigured ? "setup.scanAdditionalEmptyDetail" : "setup.noDevices")}</small></span></p>}
                {!discovering && discoveryOutcome === "error" && <p className="setup-discovery-message" role="alert"><TriangleAlert size={18} aria-hidden="true" /><span><strong>{t("setup.scanError")}</strong><small>{t("setup.scanPartial")}</small></span></p>}
                {!discovering && discoveryOutcome === "found" && (discovery?.warnings.length ?? 0) > 0 && <p className="setup-discovery-partial"><TriangleAlert size={15} aria-hidden="true" />{t("setup.scanPartial")}</p>}
                {!discovering && discovery && discovery.warnings.length > 0 && <ul className="setup-discovery-warnings">{discovery.warnings.map((warning, index) => <li key={`${warning}-${index}`}>{warning}</li>)}</ul>}
              </div>
              </div>
            </div>
          </details>}
          {activeSection === "connections" && <section className="panel connection-card" aria-labelledby="direct-connection-heading">
            <div className="panel-header"><div><span className="eyebrow">{t("setup.directTitle")}</span><h2 id="direct-connection-heading">{t("setup.directConnectionTitle")}</h2></div><span className="ha-mark" aria-hidden="true"><Router size={22} /></span></div>
            <p className="connection-card-description">{t("setup.directDescription")}</p>
            {discovery && discovery.tpLink.length > 0 && <fieldset className="discovery-results setup-found-results"><legend>{t("setup.selectTpLink")}</legend>{discovery.tpLink.map((hub) => <label key={hub.host}><input type="radio" name="tp-link-discovery" value={hub.host} checked={tpLinkHost === hub.host} disabled={savingTpLink} onChange={() => changeTpLinkDraft("host", hub.host)} /><span><strong>{hub.alias ?? `TP-Link ${hub.model}`}</strong><small>{hub.model} · {hub.host}</small></span></label>)}</fieldset>}
            <p className="setup-help setup-child-discovery-explainer">{t(integration.tpLink.configured ? "setup.tpLinkSettingsDescription" : "setup.childDiscoveryExplainer")}</p>
            {!integration.tpLink.configured && (discoveryOutcome === "error" || (discovery && discovery.tpLink.length === 0)) && <p className="setup-help setup-manual-fallback">{t("setup.tpLinkManualFallback")}</p>}
            <details className="setup-config-disclosure" open={tpLinkSettingsOpen} onToggle={(event) => setTpLinkSettingsOpen(event.currentTarget.open)}>
              <summary><span><Router size={16} aria-hidden="true" />{selectedDiscoveredTpLink ? selectedDiscoveredTpLink.alias ?? `TP-Link ${selectedDiscoveredTpLink.model}` : t(integration.tpLink.configured ? "setup.changeSavedTpLink" : "setup.manualConnection")}</span><small>{selectedDiscoveredTpLink ? `${selectedDiscoveredTpLink.model} · ${selectedDiscoveredTpLink.host}` : t(integration.tpLink.configured ? "setup.credentialsSavedShort" : "setup.manualHost")}</small></summary>
            {tpLinkSettingsOpen && <form className="connection-check guided-setup" onSubmit={(event) => void saveTpLink(event)}>
              {integration.tpLink.configured && <p className="configured-note"><Check size={17} aria-hidden="true" />{t("setup.configured")}</p>}
              <label className="field" htmlFor="tp-link-host"><span>{t("setup.host")}</span><input id="tp-link-host" type="text" value={tpLinkHost} maxLength={253} placeholder={t("setup.hostPlaceholder")} aria-describedby="tp-link-host-help" autoCapitalize="none" autoCorrect="off" disabled={savingTpLink} onChange={(event) => changeTpLinkDraft("host", event.target.value)} required /></label>
              <p className="setup-help" id="tp-link-host-help">{t("setup.hostHelp")}</p>
              <label className="field" htmlFor="tp-link-username"><span>{t("setup.username")}</span><input id="tp-link-username" type="email" value={tpLinkUsername} maxLength={320} aria-describedby="tp-link-username-help" autoComplete="username" disabled={savingTpLink} onChange={(event) => changeTpLinkDraft("username", event.target.value)} required /></label>
              <p className="setup-help" id="tp-link-username-help">{t("setup.usernameHelp")}</p>
              <label className="field" htmlFor="tp-link-password"><span>{t("setup.password")}</span><input id="tp-link-password" type={showTpLinkPassword ? "text" : "password"} value={tpLinkPassword} maxLength={4096} autoComplete="current-password" disabled={savingTpLink} onChange={(event) => changeTpLinkDraft("password", event.target.value)} required /></label>
              <label className="show-secret"><input type="checkbox" checked={showTpLinkPassword} onChange={(event) => setShowTpLinkPassword(event.target.checked)} /><span>{t("setup.showSecret")}</span></label>
              <p className="security-note"><LockKeyhole size={15} aria-hidden="true" />{t("setup.security")}</p>
              <button type="submit" className="primary-button full-width" disabled={savingTpLink || testingDirect}>{savingTpLink ? <LoaderCircle className="spin" size={16} aria-hidden="true" /> : <LockKeyhole size={16} aria-hidden="true" />}{savingTpLink ? t("common.saving") : t("setup.saveConnect")}</button>
              {tpLinkFeedback && <p className={`test-result ${tpLinkFeedback.kind}`} role={tpLinkFeedback.kind === "error" ? "alert" : "status"}>{tpLinkFeedback.kind === "success" ? <Check size={17} aria-hidden="true" /> : <TriangleAlert size={17} aria-hidden="true" />}{tpLinkFeedback.message}</p>}
              {!integration.tpLink.configured && tpLinkChildDiscovery.phase !== "idle" && <div className={`tp-link-child-discovery ${tpLinkChildDiscovery.phase}`} aria-live="polite" aria-busy={tpLinkChildDiscovery.phase === "settling"}>
                {tpLinkChildDiscovery.phase === "settling" && <>
                  <p className="setup-discovery-message" role="status"><LoaderCircle className="spin" size={18} aria-hidden="true" /><span><strong>{t("setup.childSettling", { hub: tpLinkChildDiscovery.hubModel ?? t("setup.tpLinkHub") })}</strong><small>{t("setup.childSettlingDetail", { hub: tpLinkChildDiscovery.hubModel ?? t("setup.tpLinkHub") })}</small></span></p>
                  <div className="child-discovery-progress" role="progressbar" aria-label={t("setup.childProgress", { attempt: tpLinkChildDiscovery.attempt, total: TP_LINK_CHILD_DISCOVERY_ATTEMPTS })} aria-valuemin={1} aria-valuemax={TP_LINK_CHILD_DISCOVERY_ATTEMPTS} aria-valuenow={tpLinkChildDiscovery.attempt}><span style={{ width: `${tpLinkChildDiscovery.attempt / TP_LINK_CHILD_DISCOVERY_ATTEMPTS * 100}%` }} /></div>
                </>}
                {tpLinkChildDiscovery.phase === "found" && <p className="setup-discovery-message" role="status"><Check size={18} aria-hidden="true" /><span><strong>{t("setup.childFound", { count: tpLinkChildDiscovery.count })}</strong><small>{t("setup.childFoundDetail")}</small></span></p>}
                {tpLinkChildDiscovery.phase === "empty" && <p className="setup-discovery-message" role="status"><CircleDot size={18} aria-hidden="true" /><span><strong>{t("setup.childEmpty")}</strong><small>{t("setup.childEmptyDetail")}</small></span></p>}
                {tpLinkChildDiscovery.phase === "error" && <p className="setup-discovery-message" role="alert"><TriangleAlert size={18} aria-hidden="true" /><span><strong>{t("setup.childError")}</strong><small>{t("setup.childErrorDetail")}</small></span></p>}
                {tpLinkChildDiscovery.phase !== "settling" && <div className="child-discovery-actions">
                  <button type="button" className="secondary-button" onClick={() => void settleTpLinkChildren(tpLinkChildDiscovery.hubModel)}><RefreshCw size={16} aria-hidden="true" />{t("setup.childRetry")}</button>
                  {onOpenSensors && <button type="button" className="primary-button" onClick={onOpenSensors}><ThermometerSun size={16} aria-hidden="true" />{t("setup.childOpenSensors")}</button>}
                </div>}
              </div>}
              <button type="button" className="secondary-button full-width" disabled={testingDirect || savingTpLink} onClick={() => void testDirectConnection()}>{testingDirect ? <LoaderCircle className="spin" size={16} aria-hidden="true" /> : <Router size={16} aria-hidden="true" />}{testingDirect ? t("setup.scanning") : t("setup.testDirect")}</button>
              {directResult && <p className={`test-result ${directResult}`} role={directResult === "failure" ? "alert" : "status"}>{directResult === "success" ? <ShieldCheck size={17} aria-hidden="true" /> : <CircleDot size={17} aria-hidden="true" />}{directResult === "success" ? t("setup.directTestSuccess") : t("setup.directTestFailure")}</p>}
              <details className="advanced-setup"><summary>{t("setup.advanced")}</summary><pre className="env-example" aria-label={t("setup.directEnvironmentVariables")}><code>TP_LINK_HOST=192.0.2.10{"\n"}TP_LINK_USERNAME=user@example.com{"\n"}TP_LINK_PASSWORD=••••••••</code></pre></details>
            </form>}
            </details>
          </section>}
          {activeSection === "connections" && <section className="panel connection-card" aria-labelledby="connection-heading">
            <div className="panel-header"><div><span className="eyebrow">Home Assistant</span><h2 id="connection-heading">{t("setup.homeAssistantConnectionTitle")}</h2></div><span className="ha-mark" aria-hidden="true"><Home size={22} /></span></div>
            <p className="connection-card-description">{t("setup.homeAssistantConnectionDescription")}</p>
            {discovery && discovery.homeAssistant.length > 0 && <fieldset className="discovery-results setup-found-results"><legend>{t("setup.selectHomeAssistant")}</legend>{discovery.homeAssistant.map((instance) => <label key={instance.url}><input type="radio" name="home-assistant-discovery" value={instance.url} checked={haUrl === instance.url} disabled={savingHomeAssistant} onChange={() => changeHomeAssistantDraft("url", instance.url)} /><span><strong>{instance.name}</strong><small>{instance.url}{instance.version ? ` · ${instance.version}` : ""}</small></span></label>)}</fieldset>}
            <details className="setup-config-disclosure">
              <summary><span><Home size={16} aria-hidden="true" />{selectedDiscoveredHomeAssistant?.name ?? t("setup.manualConnection")}</span><small>{selectedDiscoveredHomeAssistant ? selectedDiscoveredHomeAssistant.url : t("setup.manualService")}</small></summary>
            <form className="connection-check guided-setup" onSubmit={(event) => void saveHomeAssistant(event)}>
              {integration.homeAssistant.configured && <p className="configured-note"><Check size={17} aria-hidden="true" />{t("setup.configured")}</p>}
              <label className="field" htmlFor="home-assistant-url"><span>{t("setup.haUrl")}</span><input id="home-assistant-url" type="url" value={haUrl} maxLength={2048} placeholder={t("setup.haUrlPlaceholder")} aria-describedby="home-assistant-url-help" autoCapitalize="none" autoCorrect="off" disabled={savingHomeAssistant} onChange={(event) => changeHomeAssistantDraft("url", event.target.value)} required /></label>
              <p className="setup-help" id="home-assistant-url-help">{t("setup.haUrlHelp")}</p>
              <label className="field" htmlFor="home-assistant-token"><span>{t("setup.token")}</span><input id="home-assistant-token" type={showHaToken ? "text" : "password"} value={haToken} maxLength={8192} placeholder={t("setup.tokenPlaceholder")} aria-describedby="home-assistant-token-help" autoComplete="off" disabled={savingHomeAssistant} onChange={(event) => changeHomeAssistantDraft("token", event.target.value)} required /></label>
              <p className="setup-help" id="home-assistant-token-help">{t("setup.tokenHelp")}</p>
              <label className="show-secret"><input type="checkbox" checked={showHaToken} onChange={(event) => setShowHaToken(event.target.checked)} /><span>{t("setup.showSecret")}</span></label>
              <p className="security-note"><LockKeyhole size={15} aria-hidden="true" />{t("setup.security")}</p>
              <button type="submit" className="primary-button full-width" disabled={savingHomeAssistant || testing}>{savingHomeAssistant ? <LoaderCircle className="spin" size={16} aria-hidden="true" /> : <LockKeyhole size={16} aria-hidden="true" />}{savingHomeAssistant ? t("common.saving") : t("setup.saveConnect")}</button>
              {homeAssistantFeedback && <p className={`test-result ${homeAssistantFeedback.kind}`} role={homeAssistantFeedback.kind === "error" ? "alert" : "status"}>{homeAssistantFeedback.kind === "success" ? <Check size={17} aria-hidden="true" /> : <TriangleAlert size={17} aria-hidden="true" />}{homeAssistantFeedback.message}</p>}
              <button type="button" className="secondary-button full-width" disabled={testing || savingHomeAssistant} onClick={() => void testConnection()}>{testing ? <LoaderCircle className="spin" size={16} aria-hidden="true" /> : <Link2 size={16} aria-hidden="true" />}{testing ? t("setup.scanning") : t("common.test")}</button>
              {result && <p className={`test-result ${result}`} role={result === "failure" ? "alert" : "status"}>{result === "success" ? <ShieldCheck size={17} aria-hidden="true" /> : <CircleDot size={17} aria-hidden="true" />}{result === "success" ? t("setup.testSuccess") : t("setup.testFailure")}</p>}
              <details className="advanced-setup"><summary>{t("setup.advanced")}</summary><pre className="env-example" aria-label={t("setup.homeAssistantEnvironmentVariables")}><code>HA_URL=http://homeassistant.local:8123{"\n"}HA_TOKEN=••••••••</code></pre></details>
            </form>
            </details>
          </section>}
          {activeSection === "connections" && <details className="panel connection-assignment-manager" aria-labelledby="connection-assignment-title">
            <summary className="connection-manager-summary">
              <span className="ha-mark" aria-hidden="true"><Link2 size={22} /></span>
              <span className="connection-manager-summary-copy"><span className="eyebrow">{t("setup.connectionManagerEyebrow")}</span><strong id="connection-assignment-title">{t("setup.connectionManagerTitle")}</strong><small>{t("setup.connectionManagerCount", { count: assignmentCount })}</small></span>
            </summary>
            <div className="connection-assignment-content">
              <p className="setup-help">{t("setup.connectionManagerBody")}</p>
              {assignmentCount === 0
                ? <p className="connection-assignment-empty">{t("setup.noConnectionAssignments")}</p>
                : <div className="connection-assignment-list">
                  {homeAssistantAssignments.map((assignment) => {
                    const assignedHouse = connectionHouses.find((candidate) => candidate.id === assignment.houseId);
                    const key = `ha:${assignment.houseId}`;
                    const targetHouseId = assignmentHouseDrafts[key] ?? assignment.houseId;
                    const targetHouse = connectionHouses.find((candidate) => candidate.id === targetHouseId);
                    const sourceName = "Home Assistant";
                    return <article key={key} className="connection-assignment-row">
                      <span className={`status-symbol ${assignment.connected ? "positive" : ""}`} aria-hidden="true"><Home size={17} /></span>
                      <span><strong>Home Assistant</strong><small>{t("setup.assignedToHome", { home: assignedHouse?.name ?? assignment.houseId })}</small></span>
                      <label className="connection-assignment-home">
                        <span>{t("setup.assignedHome")}</span>
                        <select value={targetHouseId} disabled={busyAssignment !== null} aria-label={t("setup.assignedHomeFor", { source: sourceName })} onChange={(event) => setAssignmentHouseDrafts((current) => ({ ...current, [key]: event.target.value }))}>
                          {connectionHouses.map((candidate) => <option key={candidate.id} value={candidate.id} disabled={candidate.id !== assignment.houseId && homeAssistantAssignments.some((current) => current.houseId === candidate.id)}>{candidate.name}</option>)}
                        </select>
                      </label>
                      <div className="connection-assignment-actions">
                        <button type="button" className="secondary-button" disabled={busyAssignment !== null || targetHouseId === assignment.houseId} aria-label={t("setup.moveHomeAssistantLabel", { home: targetHouse?.name ?? targetHouseId })} onClick={() => void moveHomeAssistantAssignment(assignment.houseId, targetHouseId)}>{busyAssignment === key ? <LoaderCircle className="spin" size={14} aria-hidden="true" /> : <Move size={14} aria-hidden="true" />}{t("setup.move")}</button>
                        <button type="button" className="danger-button" disabled={busyAssignment !== null} aria-label={t("setup.disconnectHomeAssistantLabel", { home: assignedHouse?.name ?? assignment.houseId })} onClick={() => void disconnectHomeAssistantAssignment(assignment.houseId)}>{busyAssignment === key ? <LoaderCircle className="spin" size={14} aria-hidden="true" /> : <Trash2 size={14} aria-hidden="true" />}{t("setup.disconnect")}</button>
                      </div>
                    </article>;
                  })}
                  {tpLinkAssignments.map((assignment) => {
                    const assignedHouse = connectionHouses.find((candidate) => candidate.id === assignment.houseId);
                    const key = `tp:${assignment.id}`;
                    const targetHouseId = assignmentHouseDrafts[key] ?? assignment.houseId;
                    const targetHouse = connectionHouses.find((candidate) => candidate.id === targetHouseId);
                    const sourceName = `TP-Link ${assignment.hubModel ?? t("setup.tpLinkDefault")}`;
                    return <article key={key} className="connection-assignment-row">
                      <span className={`status-symbol ${assignment.connected ? "positive" : ""}`} aria-hidden="true"><Router size={17} /></span>
                      <span><strong>{sourceName}</strong><small>{t(assignment.connected ? "common.connected" : "common.notConnected")}</small></span>
                      <label className="connection-assignment-home">
                        <span>{t("setup.assignedHome")}</span>
                        <select value={targetHouseId} disabled={busyAssignment !== null} aria-label={t("setup.assignedHomeFor", { source: sourceName })} onChange={(event) => setAssignmentHouseDrafts((current) => ({ ...current, [key]: event.target.value }))}>
                          {connectionHouses.map((candidate) => <option key={candidate.id} value={candidate.id}>{candidate.name}</option>)}
                        </select>
                      </label>
                      <div className="connection-assignment-actions">
                        <button type="button" className="secondary-button" disabled={busyAssignment !== null || targetHouseId === assignment.houseId} aria-label={t("setup.moveTpLinkLabel", { home: targetHouse?.name ?? targetHouseId })} onClick={() => void moveTpLinkAssignment(assignment.id, assignment.houseId, targetHouseId)}>{busyAssignment === key ? <LoaderCircle className="spin" size={14} aria-hidden="true" /> : <Move size={14} aria-hidden="true" />}{t("setup.move")}</button>
                        <button type="button" className="danger-button" disabled={busyAssignment !== null} aria-label={t("setup.disconnectTpLinkLabel", { home: assignedHouse?.name ?? assignment.houseId })} onClick={() => void disconnectTpLinkAssignment(assignment.id, assignment.houseId)}>{busyAssignment === key ? <LoaderCircle className="spin" size={14} aria-hidden="true" /> : <Trash2 size={14} aria-hidden="true" />}{t("setup.disconnect")}</button>
                      </div>
                    </article>;
                  })}
                </div>}
              {assignmentFeedback && <p className={`test-result ${assignmentFeedback.kind}`} role={assignmentFeedback.kind === "error" ? "alert" : "status"}>{assignmentFeedback.kind === "success" ? <Check size={17} aria-hidden="true" /> : <TriangleAlert size={17} aria-hidden="true" />}{assignmentFeedback.message}</p>}
            </div>
          </details>}
          {activeSection === "overview" && <section className="panel integration-status" aria-label={t("status.dataSource")}>
            <div><span className={`status-symbol ${integration.tpLink.connected ? "positive" : ""}`}><Router size={17} aria-hidden="true" /></span><span><strong>TP-Link {integration.tpLink.hubModel ?? (integration.tpLink.connected ? t("setup.tpLinkEnergyDevice") : t("setup.tpLinkDefault"))}</strong><small>{integration.tpLink.lastPollAt ? t("setup.lastPoll", { time: localDateTime(integration.tpLink.lastPollAt) ?? "—" }) : t("setup.mappedDevices", { count: integration.tpLink.mappedDevices })}</small></span><b>{integration.tpLink.connected ? t("common.on") : t("common.off")}</b></div>
            <div><span className={`status-symbol ${integration.homeAssistant.connected ? "positive" : ""}`}><Home size={17} aria-hidden="true" /></span><span><strong>Home Assistant</strong><small>{t("setup.mapped", { count: integration.homeAssistant.mappedEntities })}</small></span><b>{integration.homeAssistant.connected ? t("common.on") : t("common.off")}</b></div>
            <div><span className={`status-symbol ${integration.mock.enabled ? "positive" : ""}`}><RadioTower size={17} aria-hidden="true" /></span><span><strong>{integration.mock.mode === "real" ? t("setup.mockLocked") : t("setup.mockEnabled")}</strong><small>{integration.mock.mode === "real" ? t("setup.realDataMode") : `${integration.mock.intervalMs / 1000}s`}</small></span><b>{integration.mock.enabled ? t("common.on") : t("common.off")}</b></div>
            <div><span className={`status-symbol ${integration.webhook.configured ? "positive" : ""}`}><ExternalLink size={17} aria-hidden="true" /></span><span><strong>DayOps / OpenWearable webhook</strong><small>{integration.webhook.lastDeliveryAt ? t("setup.lastEvent", { time: localDateTime(integration.webhook.lastDeliveryAt) ?? "—" }) : t("common.noData")}</small></span><b>{integration.webhook.configured ? t("common.on") : t("common.off")}</b></div>
            <div><span className={`status-symbol ${integration.weather.configuredHouses > 0 && !integration.weather.error ? "positive" : ""}`}><CloudSun size={17} aria-hidden="true" /></span><span><strong>{t("setup.weatherService")}</strong><small>{integration.weather.error ?? (integration.weather.lastSuccessAt ? t("weather.lastSuccess", { time: localDateTime(integration.weather.lastSuccessAt) ?? "—" }) : t("weather.configuredHouses", { count: integration.weather.configuredHouses }))}</small></span><b>{t("setup.automatic")}</b></div>
          </section>}
        </div>
      </div>}

      {(activeSection === "homes" || activeSection === "weather") && <section
        id={`setup-panel-${activeSection}`}
        className={`weather-section setup-workspace-panel ${activeSection}-workspace`}
        role="tabpanel"
        aria-labelledby={`setup-tab-${activeSection}`}
      >
        <header className="weather-heading">
          <div><span className="eyebrow">{activeSection === "homes" ? <Building2 size={14} aria-hidden="true" /> : <CloudSun size={14} aria-hidden="true" />}{activeSection === "homes" ? t("setup.workspaceHomes") : t("setup.workspaceWeather")}</span><h2>{activeSection === "homes" ? t("placement.title") : t("setup.weatherConfigurationTitle")}</h2><p>{activeSection === "homes" ? t("setup.homesDescription") : t("setup.weatherConfigurationDescription", { house: house.name })}</p></div>
          <div className="weather-heading-actions">
            <label className="weather-house-picker"><span>{t("common.house")}</span><select value={house.id} onChange={(event) => selectSetupHouse(event.target.value)}>{houses.map((candidate) => <option key={candidate.id} value={candidate.id}>{candidate.name}</option>)}</select></label>
            <span className={`weather-freshness ${activeSection === "homes" ? (house.mapPlacement ? "fresh" : "stale") : (house.location ? "fresh" : "stale")}`}>{activeSection === "homes" ? (house.mapPlacement ? <Check size={14} aria-hidden="true" /> : <MapPin size={14} aria-hidden="true" />) : (house.location ? <Check size={14} aria-hidden="true" /> : <MapPin size={14} aria-hidden="true" />)}{activeSection === "homes" ? (house.mapPlacement ? t("placement.scaled") : t("placement.unplaced")) : (house.location ? t("weather.locationSet") : t("weather.locationMissing"))}</span>
          </div>
        </header>

        <div className="weather-location-grid">
          {activeSection === "homes" && <section className="panel weather-location-card" aria-labelledby="weather-location-title">
            <div className="panel-header"><div><span className="eyebrow">{t("placement.eyebrow", { count: houses.length })}</span><h3 id="weather-location-title">{t("placement.title")}</h3></div><span className="weather-card-icon"><Building2 size={20} aria-hidden="true" /></span></div>
            <p className="weather-card-description">{t("placement.description")}</p>
            <div className="house-map-toolbar">
              <div className="house-map-house-list" role="group" aria-label={t("placement.houseList")}>
                {houses.map((candidate) => (
                  <button key={candidate.id} type="button" className={candidate.id === house.id ? "active" : ""} aria-pressed={candidate.id === house.id} onClick={() => selectSetupHouse(candidate.id)}>
                    <Building2 size={14} aria-hidden="true" />
                    <span><strong>{candidate.name}</strong><small>{candidate.mapPlacement ? t("placement.scaled") : candidate.location ? t("placement.pinOnly") : t("placement.unplaced")}</small></span>
                  </button>
                ))}
              </div>
              <div className="house-map-view-actions" role="group" aria-label={t("placement.mapView")}>
                <button type="button" className={mapViewport === "all" ? "active" : ""} aria-pressed={mapViewport === "all"} onClick={() => setMapViewport("all")}><Maximize2 size={14} aria-hidden="true" />{t("placement.showAll")}</button>
                <button type="button" className={mapViewport === "selected" ? "active" : ""} aria-pressed={mapViewport === "selected"} disabled={!draftMapLocation} onClick={() => setMapViewport("selected")}><LocateFixed size={14} aria-hidden="true" />{t("placement.centerSelected")}</button>
              </div>
            </div>
            {!mapLoaded ? <div className="setup-map-gate">
              <MapPin size={28} aria-hidden="true" />
              <div><strong>{t("setup.loadMapTitle")}</strong><p>{t("setup.loadMapDescription")}</p></div>
              <button type="button" className="primary-button" onClick={() => setMapLoaded(true)}><MapPin size={16} aria-hidden="true" />{t("setup.loadMap")}</button>
            </div> : <>
              <Suspense fallback={<output className="setup-map-loading"><LoaderCircle className="spin" size={18} aria-hidden="true" />{t("common.loading")}</output>}>
                <div className={`house-map-shell ${placementEditing ? "editing" : ""}`}>
                  <HouseLocationMap
                    items={mapItems}
                    selectedHouseId={house.id}
                    editable={placementEditing}
                    onSelect={selectSetupHouse}
                    onChange={updateFromMap}
                    ariaLabel={t("placement.mapLabel")}
                    viewport={mapViewport}
                  />
                  {placementEditing && <p className="house-map-editing-cue"><Move size={14} aria-hidden="true" />{t("placement.editingHint", { house: house.name })}</p>}
                </div>
              </Suspense>
              <p className="weather-map-hint">{t("placement.mapHint")}</p>
            </>}
            <details className="setup-config-disclosure home-placement-advanced">
              <summary><span><Ruler size={15} aria-hidden="true" />{t("setup.advancedPlacement")}</span><small>{t("setup.manualCoordinates")}</small></summary>
            <div className="house-placement-fields">
              <label className="field"><span>{t("weather.latitude")}</span><input type="number" min={-90} max={90} step="any" inputMode="decimal" value={placementLatitude} onChange={(event) => { setPlacementLatitude(event.target.value); setPlacementEditing(true); setPlacementFeedback(null); }} required /></label>
              <label className="field"><span>{t("weather.longitude")}</span><input type="number" min={-180} max={180} step="any" inputMode="decimal" value={placementLongitude} onChange={(event) => { setPlacementLongitude(event.target.value); setPlacementEditing(true); setPlacementFeedback(null); }} required /></label>
              {house.floors.length > 0 && <label className="field"><span>{t("placement.footprintFloor")}</span><select value={selectedFootprintFloor?.id ?? ""} onChange={(event) => { setFootprintFloorId(event.target.value); setPlacementEditing(true); setPlacementFeedback(null); }}>{house.floors.filter((floor) => floor.type !== "outdoor").map((floor) => <option key={floor.id} value={floor.id}>{floor.name}</option>)}</select></label>}
              <label className="field"><span>{t("placement.widthMeters")}</span><span className="input-with-icon"><Ruler size={15} aria-hidden="true" /><input type="number" min={1} max={500} step="0.1" inputMode="decimal" value={footprintWidthMeters} onChange={(event) => { setFootprintWidthMeters(event.target.value); setPlacementEditing(true); setPlacementFeedback(null); }} required /></span>{footprintDepthMeters !== null && <small>{t("placement.depthEstimate", { depth: decimal(footprintDepthMeters, locale, 1) })}</small>}</label>
            </div>
            <fieldset className="house-orientation-fieldset">
              <legend><Compass size={15} aria-hidden="true" />{t("orientation.title")}</legend>
              <p>{t("orientation.description")}</p>
              <div className="house-orientation-inputs">
                <label className="field"><span>{t("orientation.degrees")}</span><input type="number" min={0} max={359} step={1} inputMode="numeric" value={orientation} placeholder={t("orientation.unknown")} onChange={(event) => { setOrientation(event.target.value); setPlacementEditing(true); setPlacementFeedback(null); }} /></label>
                <label className="house-orientation-range"><span>{t("orientation.rotate")}</span><input type="range" min={0} max={359} step={1} value={draftOrientation ?? 0} onChange={(event) => { setOrientation(event.target.value); setPlacementEditing(true); setPlacementFeedback(null); }} /></label>
              </div>
              <div className="house-orientation-presets" role="group" aria-label={t("orientation.presets")}>
                {([[0, "N"], [90, "E"], [180, "S"], [270, "W"]] as const).map(([degrees, label]) => <button key={degrees} type="button" className={draftOrientation === degrees ? "active" : ""} aria-pressed={draftOrientation === degrees} onClick={() => { setOrientation(String(degrees)); setPlacementEditing(true); setPlacementFeedback(null); }}>{label}<small>{degrees}{"\u00b0"}</small></button>)}
              </div>
              <p className="house-orientation-explanation" role="status" aria-live="polite"><Compass size={15} aria-hidden="true" /><span>{orientationExplanation}</span></p>
              {house.orientationDegrees !== undefined && <button type="button" className="text-button" disabled={savingPlacement} onClick={() => void clearOrientation()}>{t("orientation.clear")}</button>}
            </fieldset>
            </details>
            <div className="house-placement-actions">
              {!placementEditing && <button type="button" className="primary-button" onClick={() => { setPlacementEditing(true); setPlacementFeedback(null); }}><Move size={16} aria-hidden="true" />{house.mapPlacement ? t("placement.move") : t("placement.place")}</button>}
              {placementEditing && <><button type="button" className="primary-button" disabled={savingPlacement || !draftPlacement} onClick={() => void savePlacement()}>{savingPlacement ? <LoaderCircle className="spin" size={16} aria-hidden="true" /> : <Check size={16} aria-hidden="true" />}{savingPlacement ? t("common.saving") : t("placement.save")}</button><button type="button" className="secondary-button" disabled={savingPlacement} onClick={resetPlacementDraft}>{t("common.cancel")}</button></>}
              {house.mapPlacement && <button type="button" className="secondary-button danger-text" disabled={savingPlacement} onClick={() => void removePlacement()}><Trash2 size={15} aria-hidden="true" />{t("placement.remove")}</button>}
            </div>
            {placementFeedback && <p className={`weather-feedback ${placementFeedback.kind}`} role={placementFeedback.kind === "error" ? "alert" : "status"}>{placementFeedback.kind === "success" ? <Check size={15} aria-hidden="true" /> : <TriangleAlert size={15} aria-hidden="true" />}{placementFeedback.message}</p>}
          </section>}

          {activeSection === "weather" && <section className="panel setup-weather-config-card" aria-labelledby="weather-reference-title">
            <div className="panel-header"><div><span className="eyebrow">{house.name}</span><h3 id="weather-reference-title">{t("placement.weatherReference")}</h3></div><span className="weather-card-icon"><CloudSun size={20} aria-hidden="true" /></span></div>
            <p className="weather-card-description">{t("placement.weatherDescription")}</p>
            <LocationDiscoveryPanel key={house.id} {...(house.location ? { currentLocation: house.location } : {})} currentTimezone={house.timezone} onApply={applyDiscoveredDefaults} />
            <div className="setup-config-summary">
              <div><span>{t("setup.provider")}</span><strong>{t("setup.weatherService")}</strong><small>{t("setup.providerAutomatic")}</small></div>
              <div><span>{t("setup.timezone")}</span><strong>{house.timezone}</strong><small>{t("setup.timezoneManaged")}</small></div>
              <div><span>{t("placement.weatherReference")}</span><strong>{house.location?.label ?? (house.location ? `${decimal(house.location.latitude, locale, 4)}, ${decimal(house.location.longitude, locale, 4)}` : t("weather.locationMissing"))}</strong><small>{house.location ? t("weather.locationSet") : t("setup.weatherNeeded")}</small></div>
            </div>
            {house.mapPlacement && <button type="button" className="primary-button setup-use-placement" disabled={savingLocation} onClick={() => void savePlacementForWeather()}>{savingLocation ? <LoaderCircle className="spin" size={16} aria-hidden="true" /> : <LocateFixed size={16} aria-hidden="true" />}{house.location ? t("setup.syncWeatherLocation") : t("placement.useForWeather")}</button>}
            <details className="setup-config-disclosure weather-reference-details">
              <summary><span><MapPin size={15} aria-hidden="true" />{t("setup.advancedWeather")}</span><small>{t("setup.manualCoordinates")}</small></summary>
              <p>{t("setup.advancedWeatherDescription")}</p>
              <div className="weather-location-fields">
                <label className="field"><span>{t("weather.latitude")}</span><input type="number" min={-90} max={90} step="any" inputMode="decimal" value={latitude} aria-invalid={coordinateValidationVisible || undefined} aria-describedby={coordinateValidationVisible ? "weather-coordinate-error" : undefined} onChange={(event) => { setLatitude(event.target.value); setLocationFeedback(null); }} required /></label>
                <label className="field"><span>{t("weather.longitude")}</span><input type="number" min={-180} max={180} step="any" inputMode="decimal" value={longitude} aria-invalid={coordinateValidationVisible || undefined} aria-describedby={coordinateValidationVisible ? "weather-coordinate-error" : undefined} onChange={(event) => { setLongitude(event.target.value); setLocationFeedback(null); }} required /></label>
                <label className="field weather-location-label"><span>{t("weather.locationLabel")} <small>{t("common.optional")}</small></span><input type="text" maxLength={200} value={locationLabel} placeholder={t("weather.locationPlaceholder")} onChange={(event) => setLocationLabel(event.target.value)} /></label>
                <label className="field weather-location-label"><span>{t("setup.timezone")}</span><input type="text" value={timezone} placeholder="Europe/Helsinki" autoCapitalize="none" autoCorrect="off" aria-invalid={timezoneValidationVisible || undefined} aria-describedby={timezoneValidationVisible ? "weather-timezone-error" : undefined} onChange={(event) => { setTimezone(event.target.value); setLocationFeedback(null); }} required /></label>
                {coordinateValidationVisible && <p id="weather-coordinate-error" className="field-error weather-location-error" role="alert">{t("weather.invalidLocation")}</p>}
                {timezoneValidationVisible && <p id="weather-timezone-error" className="field-error weather-location-error" role="alert">{t("weather.invalidTimezone")}</p>}
              </div>
              <div className="weather-location-actions">
                <button type="button" className="secondary-button" disabled={!house.mapPlacement && !draftMapLocation} onClick={usePlacementForWeather}><LocateFixed size={15} aria-hidden="true" />{t("placement.useForWeather")}</button>
                <button type="button" className="primary-button" disabled={savingLocation} onClick={() => void saveLocation()}>{savingLocation ? <LoaderCircle className="spin" size={16} aria-hidden="true" /> : <MapPin size={16} aria-hidden="true" />}{savingLocation ? t("common.saving") : t("weather.saveLocation")}</button>
                {house.location && <button type="button" className="secondary-button" disabled={savingLocation} onClick={() => void removeLocation()}><Trash2 size={16} aria-hidden="true" />{t("weather.removeLocation")}</button>}
              </div>
            </details>
            {locationFeedback && <p className={`weather-feedback ${locationFeedback.kind}`} role={locationFeedback.kind === "error" ? "alert" : "status"}>{locationFeedback.kind === "success" ? <Check size={15} aria-hidden="true" /> : <TriangleAlert size={15} aria-hidden="true" />}{locationFeedback.message}</p>}
          </section>}

          {activeSection === "weather" && <section className="panel setup-system-card" aria-labelledby="setup-system-title">
            <div className="panel-header"><div><span className="eyebrow">{t("setup.systemEyebrow")}</span><h3 id="setup-system-title">{t("setup.systemTitle")}</h3></div><span className="weather-card-icon current"><RadioTower size={20} aria-hidden="true" /></span></div>
            <p className="weather-card-description">{t("setup.systemDescription")}</p>
            <div className="integration-status compact-status">
              <div><span className={`status-symbol ${integration.weather.configuredHouses > 0 && !integration.weather.error ? "positive" : ""}`}><CloudSun size={17} aria-hidden="true" /></span><span><strong>{t("setup.weatherService")}</strong><small>{integration.weather.error ?? t("weather.configuredHouses", { count: integration.weather.configuredHouses })}</small></span><b>{t("setup.automatic")}</b></div>
              <div><span className={`status-symbol ${integration.mock.enabled ? "positive" : ""}`}><RadioTower size={17} aria-hidden="true" /></span><span><strong>{integration.mock.mode === "real" ? t("setup.mockLocked") : t("setup.mockEnabled")}</strong><small>{integration.mock.mode === "real" ? t("setup.realDataMode") : `${integration.mock.intervalMs / 1000}s`}</small></span><b>{integration.mock.enabled ? t("common.on") : t("common.off")}</b></div>
              <div><span className={`status-symbol ${integration.webhook.configured ? "positive" : ""}`}><ExternalLink size={17} aria-hidden="true" /></span><span><strong>DayOps / OpenWearable webhook</strong><small>{integration.webhook.lastDeliveryAt ? t("setup.lastEvent", { time: localDateTime(integration.webhook.lastDeliveryAt) ?? "—" }) : t("common.noData")}</small></span><b>{integration.webhook.configured ? t("common.on") : t("common.off")}</b></div>
            </div>
          </section>}

        </div>

      </section>}

      {activeSection === "layout" && <section
        id="setup-panel-layout"
        className="setup-workspace-panel layout-workspace"
        role="tabpanel"
        aria-labelledby="setup-tab-layout"
      >
        <section className="panel setup-layout-card">
          <div className="panel-header"><div><span className="eyebrow">{house.name}</span><h2>{t("setup.layoutTitle")}</h2></div><Building2 size={22} aria-hidden="true" /></div>
          <p>{t("setup.layoutDescription")}</p>
          <div className="setup-config-summary">
            <div><span>{t("common.floor")}</span><strong>{house.floors.length}</strong><small>{t("setup.workspaceLayoutDetail", { count: house.floors.length })}</small></div>
            <div><span>{t("setup.layoutRooms")}</span><strong>{house.floors.reduce((count, floor) => count + floor.rooms.length, 0)}</strong><small>{t("setup.layoutRoomsDetail")}</small></div>
          </div>
          {onOpenLayout && <button type="button" className="primary-button" onClick={onOpenLayout}><Building2 size={16} aria-hidden="true" />{t("setup.openLayoutEditor")}</button>}
        </section>
      </section>}

      {activeSection === "automations" && <section
        id="setup-panel-automations"
        className="setup-workspace-panel automations-workspace"
        role="tabpanel"
        aria-labelledby="setup-tab-automations"
      >
        <AutomationSetupPanel
          integration={integration}
          house={house}
          houses={houses}
          onHouse={selectSetupHouse}
          onIntegrationChange={onIntegrationChange}
        />
      </section>}

      {activeSection === "operations" && <section
        id="setup-panel-operations"
        className="setup-workspace-panel"
        role="tabpanel"
        aria-labelledby="setup-tab-operations"
      >
        <SetupOperationsPanel house={house} />
      </section>}

      {setupSectionOrder.filter((section) => section !== activeSection).map((section) => (
        <div
          key={section}
          id={`setup-panel-${section}`}
          role="tabpanel"
          aria-labelledby={`setup-tab-${section}`}
          hidden
        />
      ))}
    </>
  );
}
