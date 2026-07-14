import { useEffect, useMemo, useRef, useState, type FormEvent, type KeyboardEvent } from "react";
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
  House,
  HouseLocation,
  HouseMapPlacement,
  IntegrationStatus,
  UnitSystem,
} from "@climate-twin/contracts";
import { api, type HouseGeoreferencePatch, type HousePatch, type IntegrationDiscoveryResult } from "../api";
import { HouseLocationMap, type HouseLocationMapItem, type MapLocation } from "../components/HouseLocationMap";
import { LocationDiscoveryPanel, type DiscoveredHomeDefaults } from "../components/LocationDiscoveryPanel";
import { useI18n } from "../i18n";

interface IntegrationsPageProps {
  integration: IntegrationStatus;
  house: House;
  houses: House[];
  units: UnitSystem;
  onHouse: (houseId: string) => void;
  onHouseUpdate: (houseId: string, patch: HousePatch) => Promise<unknown>;
  onGeoreferenceChange: (houseId: string, patch: HouseGeoreferencePatch) => Promise<void>;
  onIntegrationChange: (integration: IntegrationStatus) => void;
}

type Feedback = { kind: "success" | "error"; message: string } | null;
type SetupSection = "overview" | "homes" | "connections" | "weather";

const setupSectionOrder: SetupSection[] = ["overview", "homes", "connections", "weather"];

function setupSectionFromPath(pathname = typeof window === "undefined" ? "" : window.location.pathname): SetupSection {
  const candidate = pathname.match(/^\/setup\/([^/]+)/)?.[1];
  return setupSectionOrder.includes(candidate as SetupSection) ? candidate as SetupSection : "overview";
}

function writeSetupSection(section: SetupSection, replace = false): void {
  if (typeof window === "undefined" || !/^\/setup(?:\/|$)/.test(window.location.pathname)) return;
  const next = `/setup/${section}${window.location.search}${window.location.hash}`;
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

export function IntegrationsPage({ integration, house: initialHouse, houses, onHouse, onHouseUpdate, onGeoreferenceChange, onIntegrationChange }: IntegrationsPageProps) {
  const { locale, t } = useI18n();
  const [setupHouseId, setSetupHouseId] = useState(initialHouse.id);
  const house = houses.find((candidate) => candidate.id === setupHouseId) ?? initialHouse;
  const [activeSection, setActiveSection] = useState<SetupSection>(() => setupSectionFromPath());
  const [mapLoaded, setMapLoaded] = useState(false);
  const [testing, setTesting] = useState(false);
  const [result, setResult] = useState<"success" | "failure" | null>(null);
  const [testingDirect, setTestingDirect] = useState(false);
  const [directResult, setDirectResult] = useState<"success" | "failure" | null>(null);
  const [discovering, setDiscovering] = useState(false);
  const [discovery, setDiscovery] = useState<IntegrationDiscoveryResult | null>(null);
  const [discoveryFailed, setDiscoveryFailed] = useState(false);
  const discoveryAttempted = useRef(false);
  const [tpLinkHost, setTpLinkHost] = useState("");
  const [tpLinkUsername, setTpLinkUsername] = useState("");
  const [tpLinkPassword, setTpLinkPassword] = useState("");
  const [showTpLinkPassword, setShowTpLinkPassword] = useState(false);
  const [savingTpLink, setSavingTpLink] = useState(false);
  const [tpLinkFeedback, setTpLinkFeedback] = useState<Feedback>(null);
  const [haUrl, setHaUrl] = useState("");
  const [haToken, setHaToken] = useState("");
  const [showHaToken, setShowHaToken] = useState(false);
  const [savingHomeAssistant, setSavingHomeAssistant] = useState(false);
  const [homeAssistantFeedback, setHomeAssistantFeedback] = useState<Feedback>(null);
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
  const localDateTime = (value: string | null | undefined, options?: Intl.DateTimeFormatOptions) => dateTime(value, locale, house.timezone, options);

  useEffect(() => {
    setSetupHouseId(initialHouse.id);
  }, [initialHouse.id]);

  useEffect(() => {
    if (!houses.some((candidate) => candidate.id === setupHouseId)) setSetupHouseId(initialHouse.id);
  }, [houses, initialHouse.id, setupHouseId]);

  useEffect(() => {
    const restoreSection = () => setActiveSection(setupSectionFromPath());
    window.addEventListener("popstate", restoreSection);
    writeSetupSection(setupSectionFromPath(), true);
    return () => window.removeEventListener("popstate", restoreSection);
  }, []);

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
    setLocationFeedback(null);
    setPlacementFeedback(null);
    setLocationValidationAttempted(false);
  }, [house.id]);

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
    setSetupHouseId(houseId);
    onHouse(houseId);
  };

  const testConnection = async () => {
    setTesting(true);
    setResult(null);
    try {
      const response = await api.testHomeAssistant();
      setResult(response.ok ? "success" : "failure");
    } catch { setResult("failure"); }
    finally { setTesting(false); }
  };

  const testDirectConnection = async () => {
    setTestingDirect(true);
    setDirectResult(null);
    try {
      const response = await api.testTpLink();
      setDirectResult(response.ok ? "success" : "failure");
    } catch { setDirectResult("failure"); }
    finally { setTestingDirect(false); }
  };

  const scanIntegrations = async () => {
    discoveryAttempted.current = true;
    setDiscovering(true);
    setDiscoveryFailed(false);
    try {
      setDiscovery(await api.discoverIntegrations());
    } catch {
      setDiscovery(null);
      setDiscoveryFailed(true);
    } finally {
      setDiscovering(false);
    }
  };

  useEffect(() => {
    if (activeSection === "connections" && !discoveryAttempted.current) void scanIntegrations();
  }, [activeSection]);

  const saveTpLink = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    setSavingTpLink(true);
    setTpLinkFeedback(null);
    try {
      const configured = await api.configureTpLink({ host: tpLinkHost, username: tpLinkUsername, password: tpLinkPassword });
      onIntegrationChange(configured.integration);
      setTpLinkPassword("");
      setShowTpLinkPassword(false);
      setTpLinkFeedback({ kind: "success", message: t("setup.credentialsSaved") });
    } catch {
      setTpLinkFeedback({ kind: "error", message: t("setup.credentialsError") });
    } finally {
      setSavingTpLink(false);
    }
  };

  const saveHomeAssistant = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    setSavingHomeAssistant(true);
    setHomeAssistantFeedback(null);
    try {
      const configured = await api.configureHomeAssistant({ url: haUrl, token: haToken });
      onIntegrationChange(configured.integration);
      setHaToken("");
      setShowHaToken(false);
      setHomeAssistantFeedback({ kind: "success", message: t("setup.credentialsSaved") });
    } catch {
      setHomeAssistantFeedback({ kind: "error", message: t("setup.credentialsError") });
    } finally {
      setSavingHomeAssistant(false);
    }
  };

  const saveLocation = async () => {
    setLocationValidationAttempted(true);
    if (!draftLocation || !validTimeZone(timezone)) {
      setLocationFeedback(null);
      return;
    }
    setSavingLocation(true);
    setLocationFeedback(null);
    try {
      await onHouseUpdate(house.id, {
        location: {
          ...draftLocation,
          source: "manual",
          confidence: "high",
          discoveredAt: new Date().toISOString(),
          userOverridden: true,
        },
        timezone: timezone.trim(),
      });
      setLocationValidationAttempted(false);
      setLocationFeedback({ kind: "success", message: t("weather.locationSaved") });
    } catch {
      setLocationFeedback({ kind: "error", message: t("weather.locationSaveError") });
    } finally {
      setSavingLocation(false);
    }
  };

  const removeLocation = async () => {
    setSavingLocation(true);
    setLocationFeedback(null);
    try {
      await onGeoreferenceChange(house.id, { location: null });
      setLatitude("");
      setLongitude("");
      setLocationLabel("");
      setLocationFeedback({ kind: "success", message: t("weather.locationRemoved") });
    } catch {
      setLocationFeedback({ kind: "error", message: t("weather.locationSaveError") });
    } finally {
      setSavingLocation(false);
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
    setSavingPlacement(true);
    setPlacementFeedback(null);
    try {
      await onGeoreferenceChange(house.id, patch);
      setPlacementEditing(false);
      setPlacementFeedback({ kind: "success", message: t("placement.saved") });
    } catch {
      setPlacementFeedback({ kind: "error", message: t("placement.saveError") });
    } finally {
      setSavingPlacement(false);
    }
  };

  const removePlacement = async () => {
    setSavingPlacement(true);
    setPlacementFeedback(null);
    try {
      await onGeoreferenceChange(house.id, { mapPlacement: null });
      const { mapPlacement: _removedPlacement, ...houseWithoutPlacement } = house;
      const form = placementForm(houseWithoutPlacement);
      setPlacementLatitude(form.latitude);
      setPlacementLongitude(form.longitude);
      setFootprintFloorId(form.footprintFloorId);
      setFootprintWidthMeters(form.footprintWidthMeters);
      setPlacementEditing(true);
      setPlacementFeedback({ kind: "success", message: t("placement.removed") });
    } catch {
      setPlacementFeedback({ kind: "error", message: t("placement.saveError") });
    } finally {
      setSavingPlacement(false);
    }
  };

  const clearOrientation = async () => {
    setSavingPlacement(true);
    setPlacementFeedback(null);
    try {
      await onGeoreferenceChange(house.id, { orientationDegrees: null });
      setOrientation("");
      setPlacementFeedback({ kind: "success", message: t("orientation.cleared") });
    } catch {
      setPlacementFeedback({ kind: "error", message: t("orientation.saveError") });
    } finally {
      setSavingPlacement(false);
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
      await onHouseUpdate(house.id, { location: nextLocation, timezone: defaults.timezone });
      setLatitude(String(source.latitude));
      setLongitude(String(source.longitude));
      setLocationLabel("");
      setTimezone(defaults.timezone);
      setLocationFeedback({ kind: "success", message: t("weather.locationSaved") });
    } catch {
      setLocationFeedback({ kind: "error", message: t("weather.locationSaveError") });
    } finally {
      setSavingLocation(false);
    }
  };

  const applyDiscoveredDefaults = async (defaults: DiscoveredHomeDefaults) => {
    await onHouseUpdate(house.id, { location: defaults.location, timezone: defaults.timezone });
    setLatitude(String(defaults.location.latitude));
    setLongitude(String(defaults.location.longitude));
    setLocationLabel(defaults.location.label ?? "");
    setTimezone(defaults.timezone);
    setLocationFeedback(null);
  };

  const sensorSourceConfigured = integration.tpLink.configured || integration.homeAssistant.configured;
  const sensorSourceConnected = integration.tpLink.connected || integration.homeAssistant.connected;
  const mappedSensorSources = integration.tpLink.mappedDevices > 0 || integration.homeAssistant.mappedEntities > 0;
  const steps = [
    { icon: Router, title: t("setup.step1"), body: t("setup.step1body"), complete: true },
    { icon: Home, title: t("setup.step2"), body: t("setup.step2body"), complete: sensorSourceConfigured },
    { icon: Link2, title: t("setup.step3"), body: t("setup.step3body"), complete: sensorSourceConnected },
    { icon: ThermometerSun, title: t("setup.step4"), body: t("setup.step4body"), complete: mappedSensorSources },
  ];
  const completeCount = steps.filter((step) => step.complete).length;

  const placedHomes = houses.filter((candidate) => candidate.mapPlacement).length;
  const weatherHomes = houses.filter((candidate) => candidate.location).length;
  const discoveredCount = (discovery?.tpLink.length ?? 0) + (discovery?.homeAssistant.length ?? 0);

  const setupSections: Array<{ id: SetupSection; label: string; detail: string }> = [
    { id: "overview", label: t("setup.workspaceOverview"), detail: t("setup.workspaceOverviewDetail") },
    { id: "homes", label: t("setup.workspaceHomes"), detail: t("setup.workspaceHomesDetail", { placed: placedHomes, count: houses.length }) },
    { id: "connections", label: t("setup.workspaceConnections"), detail: sensorSourceConnected ? t("common.connected") : t("common.notConnected") },
    { id: "weather", label: t("setup.workspaceWeather"), detail: t("setup.workspaceWeatherDetail", { count: weatherHomes }) },
  ];

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

  return (
    <>
      <header className="page-heading">
        <div><span className="eyebrow"><RadioTower size={14} aria-hidden="true" />TP-Link Tapo · Direct / Home Assistant</span><h1>{t("setup.title")}</h1><p>{t("setup.description")}</p></div>
        <span className={`integration-pill ${sensorSourceConnected ? "connected" : ""}`}><span aria-hidden="true" />{sensorSourceConnected ? t("common.connected") : t("common.notConnected")}</span>
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
        {activeSection === "overview" && <section className="panel setup-steps" aria-labelledby="setup-progress-title">
          <div className="panel-header setup-progress"><div><span className="eyebrow" id="setup-progress-title">{t("setup.progress")}</span><h2>{completeCount} / {steps.length}</h2></div><div className="progress-track" role="progressbar" aria-labelledby="setup-progress-title" aria-valuemin={0} aria-valuemax={steps.length} aria-valuenow={completeCount} aria-valuetext={`${completeCount} / ${steps.length}`}><span style={{ width: `${completeCount / steps.length * 100}%` }} /></div></div>
          <ol className="step-list">
            {steps.map((step, index) => {
              const Icon = step.icon;
              return <li key={step.title} className={step.complete ? "complete" : ""}><span className="step-number">{step.complete ? <Check size={16} aria-hidden="true" /> : index + 1}</span><span className="step-icon" aria-hidden="true"><Icon size={20} /></span><div><h3>{step.title}</h3><p>{step.body}</p></div>{index < steps.length - 1 && <ChevronRight className="step-chevron" size={18} aria-hidden="true" />}</li>;
            })}
          </ol>
        </section>}
        <div className="setup-side">
          <section className="panel connection-card discovery-card" aria-labelledby="network-discovery-heading">
            <div className="panel-header"><div><span className="eyebrow">{t("setup.scanTitle")}</span><h2 id="network-discovery-heading">{t("setup.scanDescription")}</h2></div><span className="ha-mark" aria-hidden="true"><RadioTower size={22} /></span></div>
            <div className="connection-check guided-setup">
              <button type="button" className="primary-button full-width" disabled={discovering} onClick={() => void scanIntegrations()}>{discovering ? <LoaderCircle className="spin" size={17} aria-hidden="true" /> : <RefreshCw size={17} aria-hidden="true" />}{discovering ? t("setup.scanning") : t("setup.scan")}</button>
              <div aria-live="polite">
                {discovery && <p className="test-result success"><Check size={17} aria-hidden="true" />{t("setup.scanComplete")}</p>}
                {(discoveryFailed || (discovery?.warnings.length ?? 0) > 0) && <p className="test-result failure" role="alert"><TriangleAlert size={17} aria-hidden="true" />{t("setup.scanPartial")}</p>}
                {discovery && discovery.tpLink.length === 0 && discovery.homeAssistant.length === 0 && <p className="setup-help">{t("setup.noDevices")}</p>}
                {discoveredCount > 0 && <button type="button" className="secondary-button full-width" onClick={() => activateSection("connections")}><Link2 size={16} aria-hidden="true" />{t("setup.reviewFound", { count: discoveredCount })}</button>}
              </div>
            </div>
          </section>
          {activeSection === "connections" && <section className="panel connection-card" aria-labelledby="direct-connection-heading">
            <div className="panel-header"><div><span className="eyebrow">{t("setup.directTitle")}</span><h2 id="direct-connection-heading">{t("setup.directDescription")}</h2></div><span className="ha-mark" aria-hidden="true"><Router size={22} /></span></div>
            {discovery && discovery.tpLink.length > 0 && <fieldset className="discovery-results setup-found-results"><legend>{t("setup.selectTpLink")}</legend>{discovery.tpLink.map((hub) => <label key={hub.host}><input type="radio" name="tp-link-discovery" value={hub.host} checked={tpLinkHost === hub.host} onChange={() => setTpLinkHost(hub.host)} /><span><strong>{hub.alias ?? `TP-Link ${hub.model}`}</strong><small>{hub.model} · {hub.host}</small></span></label>)}</fieldset>}
            <details className="setup-config-disclosure">
              <summary><span><Router size={16} aria-hidden="true" />{t("setup.manualConnection")}</span><small>{t("setup.manualHost")}</small></summary>
            <form className="connection-check guided-setup" onSubmit={(event) => void saveTpLink(event)}>
              {integration.tpLink.configured && <p className="configured-note"><Check size={17} aria-hidden="true" />{t("setup.configured")}</p>}
              <label className="field" htmlFor="tp-link-host"><span>{t("setup.host")}</span><input id="tp-link-host" type="text" value={tpLinkHost} maxLength={253} placeholder={t("setup.hostPlaceholder")} aria-describedby="tp-link-host-help" autoCapitalize="none" autoCorrect="off" onChange={(event) => setTpLinkHost(event.target.value)} required /></label>
              <p className="setup-help" id="tp-link-host-help">{t("setup.hostHelp")}</p>
              <label className="field" htmlFor="tp-link-username"><span>{t("setup.username")}</span><input id="tp-link-username" type="email" value={tpLinkUsername} maxLength={320} aria-describedby="tp-link-username-help" autoComplete="username" onChange={(event) => setTpLinkUsername(event.target.value)} required /></label>
              <p className="setup-help" id="tp-link-username-help">{t("setup.usernameHelp")}</p>
              <label className="field" htmlFor="tp-link-password"><span>{t("setup.password")}</span><input id="tp-link-password" type={showTpLinkPassword ? "text" : "password"} value={tpLinkPassword} maxLength={4096} autoComplete="current-password" onChange={(event) => setTpLinkPassword(event.target.value)} required /></label>
              <label className="show-secret"><input type="checkbox" checked={showTpLinkPassword} onChange={(event) => setShowTpLinkPassword(event.target.checked)} /><span>{t("setup.showSecret")}</span></label>
              <p className="security-note"><LockKeyhole size={15} aria-hidden="true" />{t("setup.security")}</p>
              <button type="submit" className="primary-button full-width" disabled={savingTpLink}>{savingTpLink ? <LoaderCircle className="spin" size={16} aria-hidden="true" /> : <LockKeyhole size={16} aria-hidden="true" />}{savingTpLink ? t("common.saving") : t("setup.saveConnect")}</button>
              {tpLinkFeedback && <p className={`test-result ${tpLinkFeedback.kind}`} role={tpLinkFeedback.kind === "error" ? "alert" : "status"}>{tpLinkFeedback.kind === "success" ? <Check size={17} aria-hidden="true" /> : <TriangleAlert size={17} aria-hidden="true" />}{tpLinkFeedback.message}</p>}
              <button type="button" className="secondary-button full-width" disabled={testingDirect} onClick={() => void testDirectConnection()}>{testingDirect ? <LoaderCircle className="spin" size={16} aria-hidden="true" /> : <Router size={16} aria-hidden="true" />}{testingDirect ? t("setup.scanning") : t("setup.testDirect")}</button>
              {directResult && <p className={`test-result ${directResult}`} role="status">{directResult === "success" ? <ShieldCheck size={17} aria-hidden="true" /> : <CircleDot size={17} aria-hidden="true" />}{directResult === "success" ? t("setup.directTestSuccess") : t("setup.directTestFailure")}</p>}
              <details className="advanced-setup"><summary>{t("setup.advanced")}</summary><pre className="env-example" aria-label="Direct TP-Link environment variables"><code>TP_LINK_HOST=192.0.2.10{"\n"}TP_LINK_USERNAME=user@example.com{"\n"}TP_LINK_PASSWORD=••••••••</code></pre></details>
            </form>
            </details>
          </section>}
          {activeSection === "connections" && <section className="panel connection-card" aria-labelledby="connection-heading">
            <div className="panel-header"><div><span className="eyebrow">Home Assistant</span><h2 id="connection-heading">{t("setup.haDescription")}</h2></div><span className="ha-mark" aria-hidden="true"><Home size={22} /></span></div>
            {discovery && discovery.homeAssistant.length > 0 && <fieldset className="discovery-results setup-found-results"><legend>{t("setup.selectHomeAssistant")}</legend>{discovery.homeAssistant.map((instance) => <label key={instance.url}><input type="radio" name="home-assistant-discovery" value={instance.url} checked={haUrl === instance.url} onChange={() => setHaUrl(instance.url)} /><span><strong>{instance.name}</strong><small>{instance.url}{instance.version ? ` · ${instance.version}` : ""}</small></span></label>)}</fieldset>}
            <details className="setup-config-disclosure">
              <summary><span><Home size={16} aria-hidden="true" />{t("setup.manualConnection")}</span><small>{t("setup.manualService")}</small></summary>
            <form className="connection-check guided-setup" onSubmit={(event) => void saveHomeAssistant(event)}>
              {integration.homeAssistant.configured && <p className="configured-note"><Check size={17} aria-hidden="true" />{t("setup.configured")}</p>}
              <label className="field" htmlFor="home-assistant-url"><span>{t("setup.haUrl")}</span><input id="home-assistant-url" type="url" value={haUrl} maxLength={2048} placeholder={t("setup.haUrlPlaceholder")} aria-describedby="home-assistant-url-help" autoCapitalize="none" autoCorrect="off" onChange={(event) => setHaUrl(event.target.value)} required /></label>
              <p className="setup-help" id="home-assistant-url-help">{t("setup.haUrlHelp")}</p>
              <label className="field" htmlFor="home-assistant-token"><span>{t("setup.token")}</span><input id="home-assistant-token" type={showHaToken ? "text" : "password"} value={haToken} maxLength={8192} placeholder={t("setup.tokenPlaceholder")} aria-describedby="home-assistant-token-help" autoComplete="off" onChange={(event) => setHaToken(event.target.value)} required /></label>
              <p className="setup-help" id="home-assistant-token-help">{t("setup.tokenHelp")}</p>
              <label className="show-secret"><input type="checkbox" checked={showHaToken} onChange={(event) => setShowHaToken(event.target.checked)} /><span>{t("setup.showSecret")}</span></label>
              <p className="security-note"><LockKeyhole size={15} aria-hidden="true" />{t("setup.security")}</p>
              <button type="submit" className="primary-button full-width" disabled={savingHomeAssistant}>{savingHomeAssistant ? <LoaderCircle className="spin" size={16} aria-hidden="true" /> : <LockKeyhole size={16} aria-hidden="true" />}{savingHomeAssistant ? t("common.saving") : t("setup.saveConnect")}</button>
              {homeAssistantFeedback && <p className={`test-result ${homeAssistantFeedback.kind}`} role={homeAssistantFeedback.kind === "error" ? "alert" : "status"}>{homeAssistantFeedback.kind === "success" ? <Check size={17} aria-hidden="true" /> : <TriangleAlert size={17} aria-hidden="true" />}{homeAssistantFeedback.message}</p>}
              <button type="button" className="secondary-button full-width" disabled={testing} onClick={() => void testConnection()}>{testing ? <LoaderCircle className="spin" size={16} aria-hidden="true" /> : <Link2 size={16} aria-hidden="true" />}{testing ? t("setup.scanning") : t("common.test")}</button>
              {result && <p className={`test-result ${result}`} role="status">{result === "success" ? <ShieldCheck size={17} aria-hidden="true" /> : <CircleDot size={17} aria-hidden="true" />}{result === "success" ? t("setup.testSuccess") : t("setup.testFailure")}</p>}
              <details className="advanced-setup"><summary>{t("setup.advanced")}</summary><pre className="env-example" aria-label="Home Assistant environment variables"><code>HA_URL=http://homeassistant.local:8123{"\n"}HA_TOKEN=••••••••</code></pre></details>
            </form>
            </details>
          </section>}
          {activeSection === "overview" && <section className="panel integration-status" aria-label={t("status.dataSource")}>
            <div><span className={`status-symbol ${integration.tpLink.connected ? "positive" : ""}`}><Router size={17} aria-hidden="true" /></span><span><strong>TP-Link {integration.tpLink.hubModel ?? "H100/H200"}</strong><small>{integration.tpLink.lastPollAt ? t("setup.lastPoll", { time: localDateTime(integration.tpLink.lastPollAt) ?? "—" }) : t("setup.mappedDevices", { count: integration.tpLink.mappedDevices })}</small></span><b>{integration.tpLink.connected ? t("common.on") : t("common.off")}</b></div>
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
            {placementFeedback && <p className={`weather-feedback ${placementFeedback.kind}`} role="status">{placementFeedback.kind === "success" ? <Check size={15} aria-hidden="true" /> : <TriangleAlert size={15} aria-hidden="true" />}{placementFeedback.message}</p>}
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
