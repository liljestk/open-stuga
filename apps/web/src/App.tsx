import { lazy, Suspense, useCallback, useEffect, useMemo, useRef, useState, type FormEvent } from "react";
import type { Floor, Metric, TpLinkDiscoveredDevice, UnitSystem } from "@climate-twin/contracts";
import { AlertTriangle, HousePlus, LoaderCircle, RotateCcw, ShieldCheck, Wrench } from "lucide-react";
import { AppShell } from "./components/AppShell";
import { type AppPage, type ViewMode } from "./domain";
import { useClimateData } from "./useClimateData";
import { countActionableAlertGroups } from "./alertGrouping";
import { useI18n } from "./i18n";
import { enabledDefinitions } from "./measurements";
import { api, type CreateHouseInput } from "./api";
import { locationForRoute, routeFromLocation } from "./routing";
import { StugaMark } from "./components/StugaMark";
import { RouteErrorBoundary } from "./components/RouteErrorBoundary";
import { readLocalStorage, writeLocalStorage } from "./browserStorage";
import {
  clearInvitationBootstrapStorage,
  clearInvitationFragment,
  invitationTokenFromBootstrapStorage,
  invitationTokenFromFragment,
  LocalAuthPage,
} from "./pages/LocalAuthPage";
import { integrationForHouse } from "./integrationScope";

const AlertsPage = lazy(() => import("./pages/AlertsPage").then((module) => ({ default: module.AlertsPage })));
const DeveloperPage = lazy(() => import("./pages/DeveloperPage").then((module) => ({ default: module.DeveloperPage })));
const SystemUpdatesPage = lazy(() => import("./pages/SystemUpdatesPage").then((module) => ({ default: module.SystemUpdatesPage })));
const IntegrationsPage = lazy(() => import("./pages/IntegrationsPage").then((module) => ({ default: module.IntegrationsPage })));
const SensorManagementPage = lazy(() => import("./pages/SensorManagementPage").then((module) => ({ default: module.SensorManagementPage })));
const DataAnalyticsPage = lazy(() => import("./pages/DataAnalyticsPage").then((module) => ({ default: module.DataAnalyticsPage })));
const TwinDashboard = lazy(() => import("./pages/TwinDashboard").then((module) => ({ default: module.TwinDashboard })));
const PortfolioOverview = lazy(() => import("./pages/PortfolioOverview").then((module) => ({ default: module.PortfolioOverview })));
const PropertyManagementPage = lazy(() => import("./pages/PropertyManagementPage").then((module) => ({ default: module.PropertyManagementPage })));
const OutdoorWeatherPage = lazy(() => import("./pages/OutdoorWeatherPage").then((module) => ({ default: module.OutdoorWeatherPage })));
const ActivityPage = lazy(() => import("./pages/ActivityPage").then((module) => ({ default: module.ActivityPage })));
const MaintenancePage = lazy(() => import("./pages/MaintenancePage").then((module) => ({ default: module.MaintenancePage })));
const EnergyPage = lazy(() => import("./pages/EnergyPage").then((module) => ({ default: module.EnergyPage })));
const PeopleAccessPage = lazy(() => import("./pages/PeopleAccessPage").then((module) => ({ default: module.PeopleAccessPage })));
const StugbyPage = lazy(() => import("./pages/StugbyPage").then((module) => ({ default: module.StugbyPage })));

const pageTitleKeys = {
  overview: "nav.overview",
  properties: "nav.properties",
  people: "nav.people",
  stugbys: "nav.stugbys",
  twin: "nav.twin",
  activity: "nav.activity",
  maintenance: "nav.maintenance",
  outdoor: "nav.outdoor",
  energy: "nav.energy",
  sensors: "nav.sensors",
  analytics: "nav.analytics",
  alerts: "nav.alerts",
  integrations: "nav.integrations",
  developer: "nav.developer",
  updates: "nav.updates",
} as const;

const dismissedTpLinkDevicesKey = "stuga-dismissed-tp-link-device-notices";
const freshTpLinkDiscoveryWindowMs = 60_000;

interface TpLinkDeviceReference {
  deviceId: string;
  connectionId: string | null;
}

function tpLinkDeviceKey(device: { deviceId: string; connectionId?: string | null | undefined }): string {
  return `${device.connectionId ?? ""}\u0000${device.deviceId}`;
}

function storedDismissedTpLinkDevices(): string[] {
  try {
    const value = JSON.parse(readLocalStorage(dismissedTpLinkDevicesKey) ?? "[]") as unknown;
    return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : [];
  } catch {
    return [];
  }
}

function settleInBackground(promise: Promise<unknown>): void {
  promise.catch(() => undefined);
}

function latestIso(values: Array<string | null | undefined>): string | null {
  return values.filter((value): value is string => Boolean(value))
    .filter((value) => Number.isFinite(Date.parse(value)))
    .sort((left, right) => left.localeCompare(right)).at(-1) ?? null;
}

function firstFloor(name: string): Floor {
  return {
    id: crypto.randomUUID(),
    name,
    type: "ground",
    width: 10,
    height: 8,
    elevation: 0,
    ceilingHeight: 2.8,
    wallHeight: 2.8,
    walls: [],
    rooms: [],
    planElements: [],
  };
}

export function App() {
  const { t } = useI18n();
  const climate = useClimateData();
  const { state } = climate;
  const readOnly = state.session?.readOnly ?? true;
  const canManagePeople = state.session?.tenant.role === "owner" || state.session?.tenant.role === "admin";
  const loadSeriesInBackground = useCallback((...args: Parameters<typeof climate.loadSeries>) => {
    settleInBackground(climate.loadSeries(...args));
  }, [climate.loadSeries]);
  const initialRoute = useMemo(() => routeFromLocation(window.location), []);
  const initialHouse = state.houses.find((candidate) => candidate.id === initialRoute.houseId);
  const initialPropertyId = initialRoute.propertyId
    ?? initialHouse?.propertyId
    ?? state.properties[0]?.id
    ?? "";
  const initialSelectedHouse = initialHouse
    ?? (!initialRoute.houseId ? state.houses.find((candidate) => candidate.propertyId === initialPropertyId) : undefined);
  const [page, setPage] = useState<AppPage>(initialRoute.page);
  const routeLoading = <output className="page-loading"><LoaderCircle className="spin" size={20} aria-hidden="true" />{t("common.loading")}: {t(pageTitleKeys[page])}</output>;
  const [routeNotFound, setRouteNotFound] = useState(Boolean(initialRoute.notFound));
  const [, setRouteRevision] = useState(0);
  const [propertyId, setPropertyId] = useState(initialPropertyId);
  const [houseId, setHouseId] = useState(() => initialRoute.houseId ?? initialSelectedHouse?.id ?? "");
  const [floorId, setFloorId] = useState(() => initialSelectedHouse?.floors[0]?.id ?? "");
  const [metric, setMetric] = useState<Metric>("temperature");
  const [viewMode, setViewMode] = useState<ViewMode>("plan");
  const [selectedSensorId, setSelectedSensorId] = useState<string | null>(() => state.sensors[0]?.id ?? null);
  const [units, setUnitsState] = useState<UnitSystem>(() => readLocalStorage("climate-twin-units") === "imperial" ? "imperial" : "metric");
  const [firstHomeName, setFirstHomeName] = useState(() => t("bootstrap.defaultHomeName"));
  const [firstPropertyName, setFirstPropertyName] = useState(() => t("bootstrap.defaultPropertyName"));
  const [firstHomePropertyId, setFirstHomePropertyId] = useState(() => initialPropertyId || state.properties[0]?.id || "");
  const [bootstrapAction, setBootstrapAction] = useState<"idle" | "saving" | "error">("idle");
  const [maintenanceObservationId, setMaintenanceObservationId] = useState<string | null>(null);
  const [requestedSensorDevice, setRequestedSensorDevice] = useState<TpLinkDeviceReference | null>(null);
  const [dismissedTpLinkDeviceIds, setDismissedTpLinkDeviceIds] = useState(storedDismissedTpLinkDevices);
  const [invitationToken, setInvitationToken] = useState(
    () => invitationTokenFromFragment() ?? invitationTokenFromBootstrapStorage(),
  );
  const [logoutUncertain, setLogoutUncertain] = useState(false);
  const previousPage = useRef(page);

  useEffect(() => {
    clearInvitationFragment();
    clearInvitationBootstrapStorage();
  }, []);

  useEffect(() => {
    if (climate.bootstrapStatus === "ready" && state.session.authenticated) setInvitationToken(null);
  }, [climate.bootstrapStatus, state.session.authenticated]);

  useEffect(() => {
    setFirstHomePropertyId((current) => state.properties.some((property) => property.id === current)
      ? current
      : state.properties[0]?.id ?? "");
  }, [state.properties]);

  const logout = useCallback(async () => {
    let uncertain = false;
    try {
      await api.logout();
    } catch {
      // The browser must still lock and purge the local workspace when server
      // revocation cannot be confirmed. Do not immediately bootstrap against a
      // cookie that may remain valid.
      uncertain = true;
    } finally {
      setLogoutUncertain(uncertain);
      climate.endSession();
    }
  }, [climate.endSession]);

  const property = state.properties.find((item) => item.id === propertyId);
  const propertyElectricityAvailable = property ? (
    !readOnly
    || (state.session?.grants ?? []).some((grant) => grant.scopeType === "property" && grant.scopeId === property.id)
  ) : false;
  const propertyHouses = useMemo(
    () => state.houses.filter((item) => item.propertyId === property?.id),
    [property?.id, state.houses],
  );
  const selectedPropertyHouse = propertyHouses.find((item) => item.id === houseId);
  const house = selectedPropertyHouse;
  const locationRoute = routeFromLocation(window.location);
  const routeHouse = locationRoute.houseId
    ? state.houses.find((candidate) => candidate.id === locationRoute.houseId)
    : undefined;
  const routeScopeInvalid = climate.bootstrapStatus === "ready" && (
    Boolean(locationRoute.propertyId && !state.properties.some((candidate) => candidate.id === locationRoute.propertyId))
    || Boolean(locationRoute.houseId && !routeHouse)
    || Boolean(locationRoute.propertyId && routeHouse && routeHouse.propertyId !== locationRoute.propertyId)
  );
  const effectiveRouteNotFound = routeNotFound || Boolean(locationRoute.notFound) || routeScopeInvalid;
  const floor = house?.floors.find((item) => item.id === floorId) ?? house?.floors[0];
  const measurementDefinitions = useMemo(() => enabledDefinitions(state.measurementDefinitions), [state.measurementDefinitions]);
  const availableMeasurements = useMemo(() => {
    const houseSensors = state.sensors.filter((sensor) => sensor.houseId === house?.id && sensor.enabled);
    const houseMeasurements = measurementDefinitions.filter((definition) => houseSensors.some((sensor) =>
      state.latestMeasurements[sensor.id]?.[definition.id]
      || (state.measurementHistory[sensor.id]?.[definition.id]?.length ?? 0) > 0
      || Boolean(sensor.measurementEntityIds?.[definition.id]),
    ));
    return houseMeasurements.length ? houseMeasurements : measurementDefinitions;
  }, [house?.id, measurementDefinitions, state.sensors, state.latestMeasurements, state.measurementHistory]);
  const lastUpdated = useMemo(() => {
    const sensorIds = new Set(state.sensors.filter((sensor) => sensor.houseId === house?.id && sensor.enabled).map((sensor) => sensor.id));
    const times = Object.entries(state.latestMeasurements).flatMap(([sensorId, measurements]) => sensorIds.has(sensorId)
      ? Object.values(measurements).map((sample) => sample.timestamp)
      : []).sort((left, right) => left.localeCompare(right));
    return times.at(-1) ?? null;
  }, [house?.id, state.sensors, state.latestMeasurements]);
  const openAlertCount = useMemo(
    () => countActionableAlertGroups(state.alerts, state.alertRules),
    [state.alertRules, state.alerts],
  );
  const scopedIntegration = useMemo(
    () => house ? integrationForHouse(state.integration, house.id, Boolean(house.location)) : null,
    [house?.id, house?.location, state.integration],
  );
  const availableTpLinkDevices = useMemo(() => {
    if (!house) return [];
    const assignedDeviceIds = new Set(state.sensors.flatMap((sensor) => sensor.tpLinkDeviceId ? [tpLinkDeviceKey({
      deviceId: sensor.tpLinkDeviceId,
      connectionId: sensor.tpLinkConnectionId,
    })] : []));
    return climate.tpLinkDevices.filter((device) => device.houseId === house.id
      && device.mappedSensorId === null
      && !assignedDeviceIds.has(tpLinkDeviceKey(device)));
  }, [climate.tpLinkDevices, house?.id, state.sensors]);
  const currentTpLinkDevices = useMemo(() => {
    const lastPollAt = Date.parse(scopedIntegration?.tpLink.lastPollAt ?? "");
    if (!scopedIntegration?.tpLink.connected || !Number.isFinite(lastPollAt)) return [];
    return availableTpLinkDevices.filter((device) => {
      const lastSeenAt = Date.parse(device.lastSeenAt);
      return Number.isFinite(lastSeenAt) && Math.abs(lastPollAt - lastSeenAt) <= freshTpLinkDiscoveryWindowMs;
    });
  }, [availableTpLinkDevices, scopedIntegration?.tpLink.connected, scopedIntegration?.tpLink.lastPollAt]);
  const undisclosedTpLinkDevices = useMemo(() => {
    const dismissed = new Set(dismissedTpLinkDeviceIds);
    return currentTpLinkDevices.filter((device) => !dismissed.has(tpLinkDeviceKey(device)) && !dismissed.has(device.deviceId));
  }, [currentTpLinkDevices, dismissedTpLinkDeviceIds]);
  const discoveredSensorNotice = scopedIntegration?.tpLink.configured ? undisclosedTpLinkDevices[0] : undefined;

  const applyHouse = useCallback((id: string) => {
    const next = state.houses.find((item) => item.id === id);
    if (!next) return;
    setPropertyId(next.propertyId);
    setHouseId(id);
    const nextFloorId = next.floors[0]?.id ?? "";
    setFloorId(nextFloorId);
    setSelectedSensorId(state.sensors.find((sensor) => sensor.houseId === id && sensor.floorId === nextFloorId && sensor.enabled)?.id ?? null);
    settleInBackground(climate.selectHouse(id));
  }, [climate.selectHouse, state.houses, state.sensors]);

  useEffect(() => {
    if (climate.bootstrapStatus !== "ready" || routeScopeInvalid) return;
    const route = routeFromLocation(window.location);
    const scopedHouse = route.houseId
      ? state.houses.find((candidate) => candidate.id === route.houseId)
      : undefined;
    if (scopedHouse) {
      if (propertyId !== scopedHouse.propertyId || houseId !== scopedHouse.id) applyHouse(scopedHouse.id);
      return;
    }

    const scopedPropertyId = route.propertyId
      ?? (state.properties.some((candidate) => candidate.id === propertyId) ? propertyId : state.properties[0]?.id)
      ?? "";
    if (!scopedPropertyId) return;
    if (propertyId !== scopedPropertyId) setPropertyId(scopedPropertyId);
    const currentHouse = state.houses.find((candidate) => candidate.id === houseId && candidate.propertyId === scopedPropertyId);
    if (currentHouse) return;
    const nextHouse = state.houses.find((candidate) => candidate.propertyId === scopedPropertyId);
    if (nextHouse) applyHouse(nextHouse.id);
    else {
      setHouseId("");
      setFloorId("");
      setSelectedSensorId(null);
    }
  }, [applyHouse, climate.bootstrapStatus, houseId, propertyId, routeScopeInvalid, state.houses, state.properties]);
  useEffect(() => {
    if (house && !house.floors.some((item) => item.id === floorId)) setFloorId(house.floors[0]?.id ?? "");
  }, [house, floorId]);
  useEffect(() => {
    if (floor && !state.sensors.some((sensor) => sensor.id === selectedSensorId && sensor.houseId === house?.id && sensor.floorId === floor.id && sensor.enabled)) {
      setSelectedSensorId(state.sensors.find((sensor) => sensor.houseId === house?.id && sensor.floorId === floor.id && sensor.enabled)?.id ?? null);
    }
  }, [house?.id, floor, selectedSensorId, state.sensors]);
  useEffect(() => {
    if (availableMeasurements.length && !availableMeasurements.some((definition) => definition.id === metric)) {
      setMetric(availableMeasurements[0]!.id);
    }
  }, [availableMeasurements, metric]);

  useEffect(() => {
    document.title = `${t(effectiveRouteNotFound ? "route.notFoundTitle" : pageTitleKeys[page])} — ${t("app.name")}`;
    if (previousPage.current === page) return;
    previousPage.current = page;
    const frame = window.requestAnimationFrame(() => document.getElementById("main-content")?.focus());
    return () => window.cancelAnimationFrame(frame);
  }, [effectiveRouteNotFound, page, t]);

  const setUnits = (next: UnitSystem) => {
    if (next === "imperial") {
      writeLocalStorage("climate-twin-units", "imperial");
    } else {
      writeLocalStorage("climate-twin-units", "metric");
    }
    setUnitsState(next);
  };

  const dismissTpLinkDeviceNotices = useCallback((devices: Array<Pick<TpLinkDiscoveredDevice, "deviceId" | "connectionId">>) => {
    setDismissedTpLinkDeviceIds((current) => {
      const next = [...new Set([...current, ...devices.map(tpLinkDeviceKey)])];
      writeLocalStorage(dismissedTpLinkDevicesKey, JSON.stringify(next));
      return next;
    });
  }, []);

  const navigate = useCallback((
    nextPage: AppPage,
    nextHouseId: string | null | undefined = houseId,
    replace = false,
    routePathname = window.location.pathname,
    nextPropertyId?: string | null,
  ) => {
    const targetHouse = nextHouseId ? state.houses.find((candidate) => candidate.id === nextHouseId) : undefined;
    const targetPropertyId = nextPropertyId === undefined ? targetHouse?.propertyId ?? propertyId : nextPropertyId;
    const scopedHouseId = targetHouse?.propertyId === targetPropertyId ? targetHouse.id : null;
    const url = locationForRoute(nextPage, { propertyId: targetPropertyId, houseId: scopedHouseId }, routePathname);
    if (`${window.location.pathname}${window.location.search}` !== url) {
      window.history[replace ? "replaceState" : "pushState"]({ page: nextPage, propertyId: targetPropertyId, houseId: scopedHouseId }, "", url);
      setRouteRevision((current) => current + 1);
    }
    if (targetPropertyId && state.properties.some((candidate) => candidate.id === targetPropertyId)) setPropertyId(targetPropertyId);
    setRouteNotFound(false);
    setPage(nextPage);
  }, [houseId, propertyId, state.houses, state.properties]);

  const chooseHouse = useCallback((id: string) => {
    setMaintenanceObservationId(null);
    applyHouse(id);
    const next = state.houses.find((candidate) => candidate.id === id);
    if (!next) return;
    const url = locationForRoute(page, { propertyId: next.propertyId, houseId: id }, window.location.pathname);
    if (`${window.location.pathname}${window.location.search}` !== url) {
      window.history.pushState({ page, propertyId: next.propertyId, houseId: id }, "", url);
      setRouteRevision((current) => current + 1);
    }
  }, [applyHouse, page, state.houses]);

  const chooseProperty = useCallback((id: string) => {
    const nextProperty = state.properties.find((candidate) => candidate.id === id);
    if (!nextProperty) return;
    const nextHouse = state.houses.find((candidate) => candidate.propertyId === id);
    setPropertyId(id);
    setFirstHomePropertyId(id);
    if (nextHouse) applyHouse(nextHouse.id);
    else {
      setHouseId("");
      setFloorId("");
      setSelectedSensorId(null);
    }
    const currentRoute = routeFromLocation(window.location);
    const homeScoped = ["twin", "activity", "outdoor", "sensors", "analytics", "integrations"].includes(page)
      || (page === "energy" && Boolean(currentRoute.houseId));
    navigate(homeScoped && !nextHouse ? "properties" : page, homeScoped ? nextHouse?.id ?? null : null, false, window.location.pathname, id);
  }, [applyHouse, navigate, page, state.houses, state.properties]);

  useEffect(() => {
    const restoreRoute = () => {
      const route = routeFromLocation(window.location);
      setRouteRevision((current) => current + 1);
      const routeHouse = state.houses.find((candidate) => candidate.id === route.houseId);
      const invalidScope = climate.bootstrapStatus === "ready" && Boolean(
        (route.propertyId && !state.properties.some((candidate) => candidate.id === route.propertyId))
        || (route.houseId && !routeHouse)
        || (route.propertyId && routeHouse && routeHouse.propertyId !== route.propertyId),
      );
      setRouteNotFound(Boolean(route.notFound) || invalidScope);
      setPage(route.page);
      if (routeHouse && (!route.propertyId || routeHouse.propertyId === route.propertyId)) {
        applyHouse(routeHouse.id);
      } else if (route.propertyId && state.properties.some((candidate) => candidate.id === route.propertyId)) {
        setPropertyId(route.propertyId);
        const firstPropertyHouse = state.houses.find((candidate) => candidate.propertyId === route.propertyId);
        if (firstPropertyHouse) applyHouse(firstPropertyHouse.id);
        else {
          setHouseId("");
          setFloorId("");
          setSelectedSensorId(null);
        }
      }
    };
    window.addEventListener("popstate", restoreRoute);
    return () => window.removeEventListener("popstate", restoreRoute);
  }, [applyHouse, climate.bootstrapStatus, state.houses, state.properties]);

  useEffect(() => {
    const route = routeFromLocation(window.location);
    if (!route.legacy || route.notFound || !property) return;
    const legacyHouse = state.houses.find((candidate) => candidate.id === route.houseId) ?? house;
    const canonicalPage = !legacyHouse && ["twin", "activity", "outdoor", "sensors", "analytics", "integrations"].includes(page)
      ? "properties"
      : page;
    navigate(canonicalPage, legacyHouse?.id ?? null, true, window.location.pathname, legacyHouse?.propertyId ?? property.id);
  }, [house, navigate, page, property, state.houses]);

  const createHouse = async (input: CreateHouseInput) => {
    return climate.createHouse(input);
  };

  const deleteHouse = async (id: string) => {
    const fallback = state.houses.find((item) => item.id !== id);
    await climate.deleteHouse(id);
    if (houseId === id && fallback) chooseHouse(fallback.id);
  };

  const createFirstHome = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const name = firstHomeName.trim();
    if (!name || bootstrapAction === "saving") return;
    setBootstrapAction("saving");
    try {
      let propertyId = firstHomePropertyId;
      if (!state.properties.some((property) => property.id === propertyId)) {
        const createdProperty = await climate.createProperty({
          name: firstPropertyName.trim() || t("bootstrap.defaultPropertyName"),
        });
        propertyId = createdProperty.id;
        setFirstHomePropertyId(propertyId);
      }
      await climate.createHouse({
        name,
        timezone: Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC",
        floors: [firstFloor(t("bootstrap.groundFloor"))],
        propertyId,
      });
      climate.retryBootstrap();
    } catch {
      setBootstrapAction("error");
    }
  };

  const repairHome = async () => {
    if (!house || bootstrapAction === "saving") return;
    const floor = firstFloor(t("bootstrap.groundFloor"));
    setBootstrapAction("saving");
    try {
      await climate.updateHouse(house.id, { floors: [floor] });
      setFloorId(floor.id);
      setBootstrapAction("idle");
    } catch {
      setBootstrapAction("error");
    }
  };

  const renderFirstHomeCard = () => (
    <section className="bootstrap-card" aria-labelledby="bootstrap-empty-title">
      <StugaMark />
      <span className="bootstrap-icon" aria-hidden="true"><HousePlus size={22} /></span>
      <div>
        <span className="eyebrow">{t("bootstrap.welcomeEyebrow")}</span>
        <h1 id="bootstrap-empty-title">{t("bootstrap.emptyTitle")}</h1>
        <p>{t("bootstrap.emptyBody")}</p>
      </div>
      <form onSubmit={(event) => void createFirstHome(event)}>
        {state.properties.length > 0 ? <label className="field">
          <span>{t("bootstrap.propertyForHome")}</span>
          <select value={firstHomePropertyId} required onChange={(event) => setFirstHomePropertyId(event.target.value)}>
            {state.properties.map((property) => <option key={property.id} value={property.id}>{property.name}</option>)}
          </select>
          <small>{t("bootstrap.propertyForHomeHelp")}</small>
        </label> : <label className="field">
          <span>{t("bootstrap.propertyName")}</span>
          <input required value={firstPropertyName} onChange={(event) => setFirstPropertyName(event.target.value)} />
          <small>{t("bootstrap.propertyNameHelp")}</small>
        </label>}
        <label className="field">
          <span>{t("bootstrap.homeName")}</span>
          <input
            autoFocus
            required
            value={firstHomeName}
            onChange={(event) => {
              setFirstHomeName(event.target.value);
              setBootstrapAction("idle");
            }}
            placeholder={t("bootstrap.homeNamePlaceholder")}
          />
        </label>
        <button type="submit" className="primary-button" disabled={!firstHomeName.trim() || bootstrapAction === "saving"}>
          {bootstrapAction === "saving"
            ? <LoaderCircle className="spin" size={16} aria-hidden="true" />
            : <HousePlus size={16} aria-hidden="true" />}
          {t(bootstrapAction === "saving" ? "bootstrap.creating" : "bootstrap.createHome")}
        </button>
        {bootstrapAction === "error" && <p className="inline-error" role="alert">{t("bootstrap.createFailed")}</p>}
      </form>
    </section>
  );
  const renderNoAccessCard = () => (
    <section className="property-empty-page" aria-labelledby="workspace-no-access-title">
      <ShieldCheck size={28} aria-hidden="true" />
      <h1 id="workspace-no-access-title">{t("properties.noAccessTitle")}</h1>
      <p>{t("properties.noAccessBody")}</p>
    </section>
  );

  if (climate.loading || climate.bootstrapStatus === "loading") {
    return <output className="loading-screen"><span className="loading-logo" aria-hidden="true" /><strong>{t("app.name")}</strong><span>{t("common.loading")}</span></output>;
  }

  if (climate.bootstrapStatus === "setup-required") {
    return <LocalAuthPage mode="setup" onAuthenticated={climate.retryBootstrap} onAuthStateChanged={climate.retryBootstrap} />;
  }

  if (climate.bootstrapStatus === "login-required") {
    return <LocalAuthPage
      mode={invitationToken ? "invitation" : "login"}
      invitationToken={invitationToken}
      noticeKey={logoutUncertain ? "auth.logoutUncertain" : null}
      onAuthStateChanged={climate.retryBootstrap}
      onAuthenticated={() => {
        setLogoutUncertain(false);
        setInvitationToken(null);
        climate.retryBootstrap();
      }}
      onCancelInvitation={() => setInvitationToken(null)}
    />;
  }

  if (climate.bootstrapStatus === "unavailable") {
    return <main className="bootstrap-screen"><section className="bootstrap-card" aria-labelledby="bootstrap-unavailable-title"><StugaMark /><span className="bootstrap-icon exception" aria-hidden="true"><AlertTriangle size={22} /></span><div><span className="eyebrow">{t("bootstrap.connectionEyebrow")}</span><h1 id="bootstrap-unavailable-title">{t("bootstrap.unavailableTitle")}</h1><p>{t("bootstrap.unavailableBody")}</p></div><button type="button" className="primary-button" onClick={climate.retryBootstrap}><RotateCcw size={16} aria-hidden="true" />{t("bootstrap.retry")}</button>{climate.bootstrapError && <details><summary>{t("bootstrap.technicalDetails")}</summary><code>{climate.bootstrapError}</code></details>}</section></main>;
  }

  if (climate.bootstrapStatus === "empty") return <main className="bootstrap-screen">{renderFirstHomeCard()}</main>;

  if (effectiveRouteNotFound) {
    return <AppShell
      page={page}
      canManagePeople={canManagePeople}
      onPage={(next, scope) => navigate(next, scope?.houseId, false, window.location.pathname, scope?.propertyId)}
      connection={climate.connection}
      units={units}
      onUnits={setUnits}
      lastUpdated={null}
      dataMode={climate.dataMode}
      pollingFallback={climate.pollingFallback}
      resourceErrors={[...new Set(Object.values(climate.resourceErrors ?? {}))]}
      openAlertCount={openAlertCount}
      properties={state.properties}
      propertyId={propertyId}
      onProperty={chooseProperty}
      houses={state.houses}
      readOnly={readOnly}
      propertyElectricityAvailable={propertyElectricityAvailable}
      principalEmail={state.session?.principal.email ?? null}
      onLogout={logout}
      onRetryConnection={climate.retryBootstrap}
    >
      <section className="route-recovery" aria-labelledby="route-recovery-title">
        <span className="bootstrap-icon exception" aria-hidden="true"><AlertTriangle size={22} /></span>
        <div><span className="eyebrow">{t("route.notFoundEyebrow")}</span><h1 id="route-recovery-title">{t("route.notFoundTitle")}</h1><p>{t("route.notFoundBody")}</p></div>
        <button type="button" className="primary-button" onClick={() => navigate("overview", null, true, window.location.pathname, null)}>{t("route.openOverview")}</button>
      </section>
    </AppShell>;
  }

  if (page === "overview" || page === "people" || page === "stugbys" || page === "alerts" || page === "developer" || page === "updates") {
    return <AppShell
      page={page}
      onPage={(next, scope) => navigate(next, scope?.houseId, false, window.location.pathname, scope?.propertyId)}
      connection={climate.connection}
      units={units}
      onUnits={setUnits}
      lastUpdated={null}
      dataMode={climate.dataMode}
      pollingFallback={climate.pollingFallback}
      resourceErrors={[...new Set(Object.values(climate.resourceErrors ?? {}))]}
      openAlertCount={openAlertCount}
      canManagePeople={canManagePeople}
      properties={state.properties}
      propertyId={propertyId}
      onProperty={chooseProperty}
      houses={state.houses}
      readOnly={readOnly}
      propertyElectricityAvailable={propertyElectricityAvailable}
      principalEmail={state.session?.principal.email ?? null}
      onLogout={logout}
      onRetryConnection={climate.retryBootstrap}
    >
      {routeNotFound ? (
        <section className="route-recovery" aria-labelledby="route-recovery-title">
          <span className="bootstrap-icon exception" aria-hidden="true"><AlertTriangle size={22} /></span>
          <div><span className="eyebrow">{t("route.notFoundEyebrow")}</span><h1 id="route-recovery-title">{t("route.notFoundTitle")}</h1><p>{t("route.notFoundBody")}</p></div>
          <button type="button" className="primary-button" onClick={() => navigate("overview", null, true, window.location.pathname, null)}>{t("route.openOverview")}</button>
        </section>
      ) : <RouteErrorBoundary
        resetKey={`${page}:workspace`}
        onReload={() => window.location.reload()}
        renderFallback={(reload) => (
          <section className="route-recovery" aria-labelledby="route-load-failed-title">
            <span className="bootstrap-icon exception" aria-hidden="true"><AlertTriangle size={22} /></span>
            <div><span className="eyebrow">{t("route.loadFailedEyebrow")}</span><h1 id="route-load-failed-title">{t("route.loadFailedTitle")}</h1><p>{t("route.loadFailedBody")}</p></div>
            <button type="button" className="primary-button" onClick={reload}><RotateCcw size={16} aria-hidden="true" />{t("route.reload")}</button>
          </section>
        )}
      ><Suspense fallback={routeLoading}><>
        {page === "overview" && <PortfolioOverview
          properties={state.properties}
          propertyAreas={state.propertyAreas}
          houses={state.houses}
          sensors={state.sensors}
          latestMeasurements={state.latestMeasurements}
          measurementHistory={state.measurementHistory}
          alerts={state.alerts}
          alertRules={state.alertRules}
          integration={state.integration}
          onOpenProperty={(id) => {
            const firstPropertyHouse = state.houses.find((candidate) => candidate.propertyId === id);
            if (firstPropertyHouse) applyHouse(firstPropertyHouse.id);
            else {
              setPropertyId(id);
              setHouseId("");
            }
            navigate("properties", firstPropertyHouse?.id ?? null, false, window.location.pathname, id);
          }}
          onOpenTwin={(id) => { applyHouse(id); navigate("twin", id); }}
          onOpenOutdoor={(id) => { applyHouse(id); navigate("outdoor", id); }}
          onOpenSetup={(id) => { applyHouse(id); navigate("integrations", id); }}
          readOnly={readOnly}
        />}
        {page === "alerts" && <AlertsPage
          state={state}
          units={units}
          onCreateRule={climate.createRule}
          onUpdateRule={climate.updateRule}
          onAcknowledge={climate.acknowledgeAlert}
          onIntegrationChange={climate.applyIntegrationStatus}
          readOnly={readOnly}
          onInspectAlert={(alert) => {
            const sensor = state.sensors.find((candidate) => candidate.id === alert.sensorId);
            if (!sensor) return;
            applyHouse(sensor.houseId);
            setFloorId(sensor.floorId);
            setSelectedSensorId(sensor.id);
            navigate("twin", sensor.houseId);
          }}
        />}
        {page === "people" && <PeopleAccessPage state={state} />}
        {page === "stugbys" && (canManagePeople
          ? <StugbyPage houses={state.houses} />
          : <section className="route-recovery" aria-labelledby="stugby-access-title"><ShieldCheck size={24} aria-hidden="true" /><div><span className="eyebrow">{t("properties.guestReadOnly")}</span><h1 id="stugby-access-title">{t("properties.adminOnlyTitle")}</h1><p>{t("properties.adminOnlyBody")}</p></div><button type="button" className="primary-button" onClick={() => navigate("overview", null, true, window.location.pathname, null)}>{t("route.openOverview")}</button></section>)}
        {page === "developer" && <DeveloperPage />}
        {page === "updates" && (canManagePeople
          ? <SystemUpdatesPage />
          : <section className="route-recovery" aria-labelledby="updates-access-title"><ShieldCheck size={24} aria-hidden="true" /><div><span className="eyebrow">{t("properties.guestReadOnly")}</span><h1 id="updates-access-title">{t("properties.adminOnlyTitle")}</h1><p>{t("properties.adminOnlyBody")}</p></div><button type="button" className="primary-button" onClick={() => navigate("overview", null, true, window.location.pathname, null)}>{t("route.openOverview")}</button></section>)}
      </></Suspense></RouteErrorBoundary>}
    </AppShell>;
  }

  if (page === "maintenance" && property) {
    return <AppShell
      page="maintenance"
      canManagePeople={canManagePeople}
      onPage={(next, scope) => navigate(next, scope?.houseId, false, window.location.pathname, scope?.propertyId)}
      connection={climate.connection}
      units={units}
      onUnits={setUnits}
      lastUpdated={null}
      dataMode={climate.dataMode}
      pollingFallback={climate.pollingFallback}
      resourceErrors={[...new Set(Object.values(climate.resourceErrors ?? {}))]}
      openAlertCount={openAlertCount}
      properties={state.properties}
      propertyId={property.id}
      onProperty={chooseProperty}
      houses={state.houses}
      houseId={selectedPropertyHouse?.id ?? ""}
      onHouse={chooseHouse}
      onBack={() => navigate("properties", null, true, window.location.pathname, property.id)}
      onBackLabel={t("header.backToProperty")}
      readOnly={readOnly}
      propertyElectricityAvailable={propertyElectricityAvailable}
      principalEmail={state.session?.principal.email ?? null}
      onLogout={logout}
      onRetryConnection={climate.retryBootstrap}
    ><Suspense fallback={routeLoading}><MaintenancePage
      state={state}
      propertyId={property.id}
      {...(locationRoute.houseId && selectedPropertyHouse ? { house: selectedPropertyHouse } : {})}
      houses={propertyHouses}
      initialObservationId={maintenanceObservationId}
      onSeedConsumed={() => setMaintenanceObservationId(null)}
      onCreateTask={climate.createMaintenanceTask}
      onUpdateTask={climate.updateMaintenanceTask}
      onReloadTask={climate.reloadMaintenanceTask}
      onLoadTaskRevisions={climate.maintenanceTaskRevisions}
      areas={state.propertyAreas.filter((area) => area.propertyId === property.id)}
      equipment={state.areaEquipment.filter((item) => item.propertyId === property.id)}
      readOnly={readOnly}
    /></Suspense></AppShell>;
  }

  if (page === "energy" && property) {
    const contextualHouse = locationRoute.houseId ? house ?? null : null;
    const propertyEnergyDenied = !contextualHouse && !propertyElectricityAvailable;
    return <AppShell
      page="energy"
      canManagePeople={canManagePeople}
      onPage={(next, scope) => navigate(next, scope?.houseId, false, window.location.pathname, scope?.propertyId)}
      connection={climate.connection}
      units={units}
      onUnits={setUnits}
      lastUpdated={contextualHouse ? lastUpdated : null}
      dataMode={climate.dataMode}
      pollingFallback={climate.pollingFallback}
      resourceErrors={[...new Set(Object.values(climate.resourceErrors ?? {}))]}
      openAlertCount={openAlertCount}
      properties={state.properties}
      propertyId={property.id}
      onProperty={chooseProperty}
      houses={state.houses}
      houseId={selectedPropertyHouse?.id ?? ""}
      onHouse={chooseHouse}
      onBack={() => contextualHouse
        ? navigate("twin", contextualHouse.id, true)
        : navigate("properties", null, true, window.location.pathname, property.id)}
      onBackLabel={t(contextualHouse ? "header.backToHome" : "header.backToProperty")}
      readOnly={readOnly}
      propertyElectricityAvailable={propertyElectricityAvailable}
      principalEmail={state.session?.principal.email ?? null}
      onLogout={logout}
      onRetryConnection={climate.retryBootstrap}
    >{propertyEnergyDenied ? <section className="route-recovery" aria-labelledby="property-electricity-access-title">
      <ShieldCheck size={24} aria-hidden="true" />
      <div><span className="eyebrow">{t("properties.guestReadOnly")}</span><h1 id="property-electricity-access-title">{t("properties.adminOnlyTitle")}</h1><p>{t("properties.adminOnlyBody")}</p></div>
      <button type="button" className="primary-button" onClick={() => navigate("properties", null, true, window.location.pathname, property.id)}>{t("bootstrap.propertyForHome")}</button>
    </section> : <Suspense fallback={routeLoading}><EnergyPage
      state={state}
      house={contextualHouse}
      propertyId={property.id}
      units={units}
      onLoadSeries={loadSeriesInBackground}
      seriesStates={climate.seriesStates ?? {}}
      {...(contextualHouse && !readOnly ? { onOpenSensors: () => navigate("sensors", contextualHouse.id) } : {})}
      onOpenAlerts={() => navigate("alerts", null, false, window.location.pathname, null)}
      readOnly={readOnly}
    /></Suspense>}</AppShell>;
  }

  if (page === "properties" || (readOnly && (!house || !floor))) {
    const propertyIndex = page === "properties" && !locationRoute.propertyId;
    return <AppShell
      page="properties"
      canManagePeople={canManagePeople}
      onPage={(next, scope) => navigate(next, scope?.houseId, false, window.location.pathname, scope?.propertyId)}
      connection={climate.connection}
      units={units}
      onUnits={setUnits}
      lastUpdated={null}
      dataMode={climate.dataMode}
      pollingFallback={climate.pollingFallback}
      resourceErrors={[...new Set(Object.values(climate.resourceErrors ?? {}))]}
      properties={state.properties}
      propertyId={propertyIndex ? "" : propertyId}
      onProperty={chooseProperty}
      houses={state.houses}
      houseId={propertyIndex ? "" : selectedPropertyHouse?.id ?? ""}
      onHouse={chooseHouse}
      homeAvailable={!readOnly || Boolean(house && floor)}
      readOnly={readOnly}
      propertyElectricityAvailable={propertyElectricityAvailable}
      principalEmail={state.session?.principal.email ?? null}
      onLogout={logout}
      onRetryConnection={climate.retryBootstrap}
    ><Suspense fallback={routeLoading}><PropertyManagementPage
      state={state}
      initialTab="overview"
      indexMode={propertyIndex}
      propertyId={propertyIndex ? undefined : propertyId}
      onProperty={chooseProperty}
      onCreateProperty={climate.createProperty}
      onUpdateProperty={climate.updateProperty}
      onDeleteProperty={climate.deleteProperty}
      onCreateHouse={climate.createHouse}
      onUpdateHouse={climate.updateHouse}
      onCreateArea={climate.createPropertyArea}
      onUpdateArea={climate.updatePropertyArea}
      onDeleteArea={climate.deletePropertyArea}
      onCreateEquipment={climate.createAreaEquipment}
      onUpdateEquipment={climate.updateAreaEquipment}
      onDeleteEquipment={climate.deleteAreaEquipment}
      onCreateNote={climate.createPropertyNote}
      onUpdateNote={climate.updatePropertyNote}
      onDeleteNote={climate.deletePropertyNote}
      onCreateMaintenanceTask={climate.createMaintenanceTask}
      onOpenMaintenance={() => navigate("maintenance", houseId || null, false, window.location.pathname, propertyId)}
      onSetHouseGeoreference={climate.setHouseGeoreference}
    /></Suspense></AppShell>;
  }

  if (!house && state.properties.length > 0 && page === "twin") {
    return <AppShell
      page="twin"
      canManagePeople={canManagePeople}
      onPage={(next, scope) => navigate(next, scope?.houseId, false, window.location.pathname, scope?.propertyId)}
      connection={climate.connection}
      units={units}
      onUnits={setUnits}
      lastUpdated={null}
      dataMode={climate.dataMode}
      pollingFallback={climate.pollingFallback}
      resourceErrors={[...new Set(Object.values(climate.resourceErrors ?? {}))]}
      properties={state.properties}
      propertyId={propertyId}
      onProperty={chooseProperty}
      houses={state.houses}
      readOnly={readOnly}
      propertyElectricityAvailable={propertyElectricityAvailable}
      principalEmail={state.session?.principal.email ?? null}
      onLogout={logout}
      onRetryConnection={climate.retryBootstrap}
    ><div className="home-empty-state">{readOnly ? renderNoAccessCard() : renderFirstHomeCard()}</div></AppShell>;
  }

  if (!house) {
    return <main className="bootstrap-screen">{readOnly ? renderNoAccessCard() : <section className="bootstrap-card"><AlertTriangle size={24} aria-hidden="true" /><h1>{t("bootstrap.inventoryUnavailable")}</h1><button type="button" className="primary-button" onClick={climate.retryBootstrap}><RotateCcw size={16} aria-hidden="true" />{t("bootstrap.retry")}</button></section>}</main>;
  }

  if (!floor) {
    return <main className="bootstrap-screen"><section className="bootstrap-card" aria-labelledby="bootstrap-floor-title"><StugaMark /><span className="bootstrap-icon exception" aria-hidden="true"><Wrench size={22} /></span><div><span className="eyebrow">{house.name}</span><h1 id="bootstrap-floor-title">{t("bootstrap.floorMissingTitle")}</h1><p>{t("bootstrap.floorMissingBody")}</p></div><button type="button" className="primary-button" disabled={bootstrapAction === "saving"} onClick={() => void repairHome()}>{bootstrapAction === "saving" ? <LoaderCircle className="spin" size={16} aria-hidden="true" /> : <Wrench size={16} aria-hidden="true" />}{t("bootstrap.addGroundFloor")}</button>{bootstrapAction === "error" && <p className="inline-error" role="alert">{t("bootstrap.repairFailed")}</p>}</section></main>;
  }

  const pageLastUpdated = page === "activity"
    ? latestIso([
      ...state.observations.filter((item) => item.houseId === house.id).map((item) => item.updatedAt),
      ...state.maintenanceTasks.filter((item) => item.houseId === house.id).map((item) => item.updatedAt),
      ...state.alerts.filter((item) => state.sensors.some((sensor) => sensor.houseId === house.id && sensor.id === item.sensorId)).flatMap((item) => [item.startedAt, item.acknowledgedAt, item.resolvedAt]),
    ])
    : page === "integrations"
      ? latestIso([state.integration.homeAssistant.lastEventAt, state.integration.tpLink.lastPollAt, state.integration.weather.lastSuccessAt])
      : page === "outdoor" ? null : lastUpdated;
  const freshnessLabel = page === "activity" ? t("nav.activity")
    : page === "integrations" ? t("nav.integrations")
      : page === "sensors" ? t("nav.sensors")
        : page === "analytics" ? t("nav.analytics")
        : page === "energy" ? t("nav.energyUse")
          : page === "twin" ? t("nav.twin") : undefined;

  return (
    <AppShell
      page={page}
      canManagePeople={canManagePeople}
      onPage={(next, scope) => navigate(next, scope?.houseId, false, window.location.pathname, scope?.propertyId)}
      connection={climate.connection}
      units={units}
      onUnits={setUnits}
      lastUpdated={pageLastUpdated}
      freshnessLabel={freshnessLabel}
      dataMode={climate.dataMode}
      pollingFallback={climate.pollingFallback}
      resourceErrors={[...new Set(Object.values(climate.resourceErrors ?? {}))]}
      openAlertCount={openAlertCount}
      readOnly={readOnly}
      propertyElectricityAvailable={propertyElectricityAvailable}
      principalEmail={state.session?.principal.email ?? null}
      onLogout={logout}
      properties={state.properties}
      propertyId={propertyId}
      onProperty={chooseProperty}
      houses={state.houses}
      houseId={selectedPropertyHouse?.id ?? house.id}
      onHouse={chooseHouse}
      onBack={() => page === "twin"
        ? navigate("properties", null, true, window.location.pathname, propertyId)
        : navigate("twin", house.id, true)}
      onBackLabel={t(page === "twin" ? "header.backToProperty" : "header.backToHome")}
      onRetryConnection={climate.retryBootstrap}
      sensorDiscoveryNotice={!readOnly && discoveredSensorNotice ? {
        name: discoveredSensorNotice.alias?.trim() || t("sensors.unnamedDevice"),
        model: discoveredSensorNotice.model,
        additionalCount: undisclosedTpLinkDevices.length - 1,
      } : undefined}
      onAddDiscoveredSensor={discoveredSensorNotice ? () => {
        dismissTpLinkDeviceNotices([discoveredSensorNotice]);
        setRequestedSensorDevice({
          deviceId: discoveredSensorNotice.deviceId,
          connectionId: discoveredSensorNotice.connectionId ?? null,
        });
        navigate("sensors", house.id);
      } : undefined}
      onDismissDiscoveredSensors={undisclosedTpLinkDevices.length > 0
        ? () => dismissTpLinkDeviceNotices(undisclosedTpLinkDevices)
        : undefined}
    >
      {routeNotFound ? (
        <section className="route-recovery" aria-labelledby="route-recovery-title">
          <span className="bootstrap-icon exception" aria-hidden="true"><AlertTriangle size={22} /></span>
          <div><span className="eyebrow">{t("route.notFoundEyebrow")}</span><h1 id="route-recovery-title">{t("route.notFoundTitle")}</h1><p>{t("route.notFoundBody")}</p></div>
          <button type="button" className="primary-button" onClick={() => navigate("overview", house.id, true)}>{t("route.openOverview")}</button>
        </section>
      ) : <RouteErrorBoundary
        resetKey={`${page}:${house.id}`}
        onReload={() => window.location.reload()}
        renderFallback={(reload) => (
          <section className="route-recovery" aria-labelledby="route-load-failed-title">
            <span className="bootstrap-icon exception" aria-hidden="true"><AlertTriangle size={22} /></span>
            <div><span className="eyebrow">{t("route.loadFailedEyebrow")}</span><h1 id="route-load-failed-title">{t("route.loadFailedTitle")}</h1><p>{t("route.loadFailedBody")}</p></div>
            <button type="button" className="primary-button" onClick={reload}><RotateCcw size={16} aria-hidden="true" />{t("route.reload")}</button>
          </section>
        )}
      ><Suspense fallback={routeLoading}><>
      {page === "twin" && (
        <TwinDashboard
          state={{ ...state, houses: propertyHouses }} house={house} floor={floor} houseId={house.id} floorId={floor.id} metric={metric} units={units} viewMode={viewMode}
          selectedSensorId={selectedSensorId} saveState={climate.saveState} scenario={climate.scenario} connection={climate.connection} dataMode={climate.dataMode}
          onHouse={chooseHouse} onFloor={setFloorId} onMetric={setMetric} onViewMode={setViewMode} onSensorSelect={setSelectedSensorId}
          onSensorMove={climate.moveSensor} onSensorUpdate={climate.updateSensor} onFloorChange={(next) => climate.updateFloor(house.id, next)}
          onHouseChange={(next) => climate.updateHouseDraft(next.id, { name: next.name, timezone: next.timezone, floors: next.floors })}
          onHouseCreate={createHouse} onHouseDelete={deleteHouse}
          onSaveLayout={(next) => climate.saveLayout(next.id, next)} onLoadSeries={loadSeriesInBackground} onLoadReplaySeries={climate.loadHistoricalSeries}
          onRunScenario={(next) => settleInBackground(climate.runScenario(next))} onCreateObservation={climate.createObservation}
          onUpdateObservation={climate.updateObservation}
          onReloadObservation={climate.reloadObservation}
          onLoadObservationRevisions={climate.observationRevisions}
          onCreateStaticParameter={climate.createStaticParameter}
          onOpenSensors={(id) => { applyHouse(id); navigate("sensors", id); }}
          onOpenConnections={(id) => { applyHouse(id); navigate("integrations", id, false, "/setup/connections"); }}
          onOpenActivity={() => navigate("activity", house.id)}
          onOpenMaintenance={() => navigate("maintenance", house.id)}
          onOpenEnergy={() => navigate("energy", house.id)}
          onOpenOutdoor={() => navigate("outdoor", house.id)}
          onOpenAnalytics={() => navigate("analytics", house.id)}
          readOnly={readOnly}
        />
      )}
      {page === "activity" && <ActivityPage
        state={state}
        house={house}
        onCreateObservation={climate.createObservation}
        onUpdateObservation={climate.updateObservation}
        onReloadObservation={climate.reloadObservation}
        onLoadObservationRevisions={climate.observationRevisions}
        onOpenFloor={(targetFloorId) => { setFloorId(targetFloorId); setViewMode("plan"); navigate("twin", house.id); }}
        onPlanMaintenance={(observation) => { setMaintenanceObservationId(observation.id); navigate("maintenance", house.id); }}
        readOnly={readOnly}
      />}
      {page === "outdoor" && (
        <OutdoorWeatherPage
          house={house}
          units={units}
          {...(!readOnly ? { onConfigureLocation: () => navigate("integrations", house.id, false, "/setup/weather") } : {})}
        />
      )}
      {page === "sensors" && (
        <SensorManagementPage
          state={state}
          house={house}
          houses={propertyHouses}
          integration={state.integration}
          tpLinkDevices={climate.tpLinkDevices}
          tpLinkDevicesLoading={climate.tpLinkDevicesLoading}
          tpLinkDevicesError={climate.tpLinkDevicesError}
          requestedDevice={requestedSensorDevice}
          readOnly={readOnly}
          units={units}
          onLoadSeries={loadSeriesInBackground}
          onRequestedDeviceHandled={() => setRequestedSensorDevice(null)}
          onHouse={chooseHouse}
          onRefreshDevices={async () => { await climate.refreshTpLinkDevices(house.id); }}
          onCreateSensor={climate.createSensor}
          onUpdateSensor={climate.updateSensor}
          onDeleteSensor={climate.deleteSensor}
          onImportHistoricalData={(samples, onProgress) => climate.importHistoricalMeasurements(house.id, samples, onProgress)}
        />
      )}
      {page === "analytics" && (
        <DataAnalyticsPage
          state={state}
          house={house}
          units={units}
          dataMode={climate.dataMode}
          onLoadSeries={loadSeriesInBackground}
        />
      )}
      {page === "integrations" && !readOnly && (
        <IntegrationsPage
          integration={state.integration}
          house={house}
          houses={propertyHouses}
          connectionHouses={propertyHouses}
          units={units}
          streamConnection={climate.connection}
          tpLinkDevicesLoading={climate.tpLinkDevicesLoading}
          tpLinkDevicesError={climate.tpLinkDevicesError}
          onHouse={chooseHouse}
          onHouseUpdate={climate.updateHouse}
          onGeoreferenceChange={climate.setHouseGeoreference}
          onIntegrationChange={climate.applyIntegrationStatus}
          onRefreshTpLinkDevices={climate.refreshTpLinkDevices}
          onDisconnectHomeAssistant={climate.disconnectHomeAssistant}
          onDisconnectTpLink={climate.disconnectTpLink}
          onMoveHomeAssistant={climate.moveHomeAssistant}
          onMoveTpLink={climate.moveTpLink}
          onOpenSensors={() => navigate("sensors", house.id)}
          onOpenLayout={() => navigate("twin", house.id)}
        />
      )}
      {page === "integrations" && readOnly && <section className="route-recovery"><ShieldCheck size={24} aria-hidden="true" /><div><span className="eyebrow">{t("properties.guestReadOnly")}</span><h1>{t("properties.adminOnlyTitle")}</h1><p>{t("properties.adminOnlyBody")}</p></div><button type="button" className="primary-button" onClick={() => navigate("properties", house.id, true)}>{t("nav.properties")}</button></section>}
      </></Suspense></RouteErrorBoundary>}
    </AppShell>
  );
}
