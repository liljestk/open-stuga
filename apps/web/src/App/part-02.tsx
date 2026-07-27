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
import { useAppPart01 } from "./part-01";
export function useAppPart02(context: ReturnType<typeof useAppPart01>) {
  const { t, climate, state, workspaceReadOnly, canManagePeople, loadSeriesInBackground, initialRoute, initialHouse, initialPropertyId, initialSelectedHouse, page, setPage, routeLoading, routeNotFound, setRouteNotFound, setRouteRevision, propertyId, setPropertyId, houseId, setHouseId, floorId, setFloorId, metric, setMetric, viewMode, setViewMode, selectedSensorId, setSelectedSensorId, units, setUnitsState, firstHomeName, setFirstHomeName, firstPropertyName, setFirstPropertyName, firstHomePropertyId, setFirstHomePropertyId, bootstrapAction, setBootstrapAction, maintenanceObservationId, setMaintenanceObservationId, requestedSensorDevice, setRequestedSensorDevice, dismissedTpLinkDeviceIds, setDismissedTpLinkDeviceIds, invitationToken, setInvitationToken, logoutUncertain, setLogoutUncertain, previousPage, logout, property, propertyReadOnly, propertyElectricityAvailable, propertyHouses, selectedPropertyHouse, house, activeSharedHouse, houseReadOnly, houseLocalAuthority, locationRoute, readOnly, routeHouse, routeScopeInvalid, effectiveRouteNotFound, floor, measurementDefinitions, availableMeasurements, lastUpdated, openAlertCount, scopedIntegration, availableTpLinkDevices, currentTpLinkDevices, undisclosedTpLinkDevices, discoveredSensorNotice } = context;
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
        <StuguMark />
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
  return Object.assign(context, { applyHouse, setUnits, dismissTpLinkDeviceNotices, navigate, chooseHouse, chooseProperty, createHouse, deleteHouse, createFirstHome, repairHome, renderFirstHomeCard });
}