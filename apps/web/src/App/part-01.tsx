import { lazy, Suspense, useCallback, useEffect, useMemo, useRef, useState, type FormEvent } from "react";
import type { Floor, Metric, TpLinkDiscoveredDevice, UnitSystem } from "@climate-twin/contracts";
import { AlertTriangle, HousePlus, LoaderCircle, RotateCcw, ShieldCheck, Wrench } from "lucide-react";
import { AppShell } from "../components/AppShell";
import { type AppPage, type ViewMode } from "../domain";
import { useClimateData } from "../useClimateData";
import { countActionableAlertGroups } from "../alertGrouping";
import { useI18n } from "../i18n";
import { enabledDefinitions } from "../measurements";
import { api, type CreateHouseInput } from "../api";
import { locationForRoute, routeFromLocation } from "../routing";
import { StuguMark } from "../components/StuguMark";
import { RouteErrorBoundary } from "../components/RouteErrorBoundary";
import { readLocalStorage, writeLocalStorage } from "../browserStorage";
import {
  clearInvitationBootstrapStorage,
  clearInvitationFragment,
  invitationTokenFromBootstrapStorage,
  invitationTokenFromFragment,
  LocalAuthPage,
} from "../pages/LocalAuthPage";
import { integrationForHouse } from "../integrationScope";
import { ActivityPage, AlertsPage, DataAnalyticsPage, DeveloperPage, EnergyPage, IntegrationsPage, MaintenancePage, OutdoorWeatherPage, PeopleAccessPage, PortfolioOverview, PropertyManagementPage, SensorManagementPage, StugubyPage, SystemUpdatesPage, TwinDashboard, dismissedTpLinkDevicesKey, firstFloor, freshTpLinkDiscoveryWindowMs, latestIso, pageTitleKeys, settleInBackground, storedDismissedTpLinkDevices, tpLinkDeviceKey } from "./support";
import type { TpLinkDeviceReference } from "./support";
export function useAppPart01(context: Record<string, never>) {
  const { t } = useI18n();
  const climate = useClimateData();
  const { state } = climate;
  const workspaceReadOnly = state.session?.readOnly ?? true;
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
  const propertyReadOnly = workspaceReadOnly || Boolean(
      property?.stuguby
      && !property.stuguby.isAuthority
      && property.stuguby.syncState !== "detached"
      && property.stuguby.editPolicy === "read-only",
    );
  const propertyElectricityAvailable = property ? (
      !propertyReadOnly
      || (state.session?.grants ?? []).some((grant) => grant.scopeType === "property" && grant.scopeId === property.id)
    ) : false;
  const propertyHouses = useMemo(
      () => state.houses.filter((item) => item.propertyId === property?.id),
      [property?.id, state.houses],
    );
  const selectedPropertyHouse = propertyHouses.find((item) => item.id === houseId);
  const house = selectedPropertyHouse;
  const activeSharedHouse = Boolean(
      house?.stuguby
      && house.stuguby.ownership === "shared"
      && house.stuguby.syncState !== "detached",
    );
  const houseReadOnly = workspaceReadOnly || Boolean(activeSharedHouse && house?.stuguby?.editPolicy === "read-only");
  const houseLocalAuthority = !activeSharedHouse;
  const locationRoute = routeFromLocation(window.location);
  const readOnly = page === "properties" || page === "maintenance" || (page === "energy" && !locationRoute.houseId)
      ? propertyReadOnly
      : ["twin", "activity", "outdoor", "energy", "sensors", "integrations", "analytics"].includes(page)
        ? houseReadOnly
        : workspaceReadOnly;
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
  return Object.assign(context, { t, climate, state, workspaceReadOnly, canManagePeople, loadSeriesInBackground, initialRoute, initialHouse, initialPropertyId, initialSelectedHouse, page, setPage, routeLoading, routeNotFound, setRouteNotFound, setRouteRevision, propertyId, setPropertyId, houseId, setHouseId, floorId, setFloorId, metric, setMetric, viewMode, setViewMode, selectedSensorId, setSelectedSensorId, units, setUnitsState, firstHomeName, setFirstHomeName, firstPropertyName, setFirstPropertyName, firstHomePropertyId, setFirstHomePropertyId, bootstrapAction, setBootstrapAction, maintenanceObservationId, setMaintenanceObservationId, requestedSensorDevice, setRequestedSensorDevice, dismissedTpLinkDeviceIds, setDismissedTpLinkDeviceIds, invitationToken, setInvitationToken, logoutUncertain, setLogoutUncertain, previousPage, logout, property, propertyReadOnly, propertyElectricityAvailable, propertyHouses, selectedPropertyHouse, house, activeSharedHouse, houseReadOnly, houseLocalAuthority, locationRoute, readOnly, routeHouse, routeScopeInvalid, effectiveRouteNotFound, floor, measurementDefinitions, availableMeasurements, lastUpdated, openAlertCount, scopedIntegration, availableTpLinkDevices, currentTpLinkDevices, undisclosedTpLinkDevices, discoveredSensorNotice });
}