import { lazy, Suspense, useCallback, useEffect, useMemo, useRef, useState, type FormEvent } from "react";
import type { Floor, Metric, TpLinkDiscoveredDevice, UnitSystem } from "@climate-twin/contracts";
import { AlertTriangle, HousePlus, LoaderCircle, RotateCcw, ShieldCheck, Sparkles, Wrench } from "lucide-react";
import { AppShell } from "../components/AppShell";
import { type AppPage, type ViewMode } from "../domain";
import { useClimateData } from "../useClimateData";
import { countActionableAlertGroups } from "../alertGrouping";
import { useI18n } from "../i18n";
import { enabledDefinitions } from "../measurements";
import { api, type CreateHouseInput } from "../api";
import { locationForPropertySection, locationForRoute, routeFromLocation } from "../routing";
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
  // Seed from the already-selected scope so initial URL canonicalization is not
  // mistaken for user-initiated SPA navigation and does not steal focus.
  const previousFocusScope = useRef(`${page}:${locationRoute.propertyId ?? (page === "twin" ? propertyId : "")}:${locationRoute.houseId ?? (page === "twin" ? houseId : "")}`);
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
      const propertyOnlyRoute = Boolean(route.propertyId && !route.houseId
        && ["properties", "maintenance", "energy"].includes(route.page));
      if (propertyOnlyRoute) {
        if (houseId) setHouseId("");
        if (floorId) setFloorId("");
        if (selectedSensorId) setSelectedSensorId(null);
        return;
      }
      const currentHouse = state.houses.find((candidate) => candidate.id === houseId && candidate.propertyId === scopedPropertyId);
      if (currentHouse) return;
      const nextHouse = state.houses.find((candidate) => candidate.propertyId === scopedPropertyId);
      if (nextHouse) applyHouse(nextHouse.id);
      else {
        setHouseId("");
        setFloorId("");
        setSelectedSensorId(null);
      }
    }, [applyHouse, climate.bootstrapStatus, floorId, houseId, propertyId, routeScopeInvalid, selectedSensorId, state.houses, state.properties]);
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
      const pageTitle = t(effectiveRouteNotFound ? "route.notFoundTitle" : pageTitleKeys[page]);
      const homeScoped = Boolean(locationRoute.houseId && house);
      const propertyScoped = Boolean(locationRoute.propertyId && property);
      const scopeTitle = homeScoped
        ? `${house!.name} — ${property?.name ?? ""}`
        : propertyScoped
          ? property!.name
          : "";
      document.title = [pageTitle, scopeTitle, t("app.name")].filter(Boolean).join(" — ");
      const focusScope = `${page}:${locationRoute.propertyId ?? (page === "twin" ? propertyId : "")}:${locationRoute.houseId ?? (page === "twin" ? houseId : "")}`;
      if (previousPage.current === page && previousFocusScope.current === focusScope) return;
      previousPage.current = page;
      previousFocusScope.current = focusScope;
      const frame = window.requestAnimationFrame(() => document.getElementById("main-content")?.focus());
      return () => window.cancelAnimationFrame(frame);
    }, [effectiveRouteNotFound, house, houseId, locationRoute.houseId, locationRoute.propertyId, page, property, propertyId, t]);
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
      setPropertyId(id);
      setFirstHomePropertyId(id);
      const currentRoute = routeFromLocation(window.location);
      const homeScoped = Boolean(currentRoute.houseId)
        || ["twin", "activity", "outdoor", "sensors", "analytics", "integrations"].includes(page);
      setHouseId("");
      setFloorId("");
      setSelectedSensorId(null);
      if (page === "properties" && currentRoute.propertySection) {
        const url = locationForPropertySection(id, currentRoute.propertySection);
        if (`${window.location.pathname}${window.location.search}` !== url) {
          window.history.pushState({ page, propertyId: id, houseId: null, propertySection: currentRoute.propertySection }, "", url);
          setRouteRevision((current) => current + 1);
        }
        setRouteNotFound(false);
        return;
      }
      navigate(homeScoped ? "properties" : page, null, false, window.location.pathname, id);
    }, [navigate, page, state.properties]);
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
          if (propertyId !== routeHouse.propertyId || houseId !== routeHouse.id) applyHouse(routeHouse.id);
        } else if (route.propertyId && state.properties.some((candidate) => candidate.id === route.propertyId)) {
          setPropertyId(route.propertyId);
          setHouseId("");
          setFloorId("");
          setSelectedSensorId(null);
        }
      };
      window.addEventListener("popstate", restoreRoute);
      return () => window.removeEventListener("popstate", restoreRoute);
    }, [applyHouse, climate.bootstrapStatus, houseId, propertyId, state.houses, state.properties]);
  useEffect(() => {
      const route = routeFromLocation(window.location);
      if (!route.legacy || route.notFound || !property) return;
      const legacyHouse = route.houseId
        ? state.houses.find((candidate) => candidate.id === route.houseId)
        : house;
      if (route.houseId && !legacyHouse) return;
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
        const createdHome = await climate.createHouse({
          name,
          timezone: inferredTimezone,
          floors: [firstFloor(t("bootstrap.groundFloor"))],
          propertyId,
        });
        setPropertyId(propertyId);
        setHouseId(createdHome.id);
        setFloorId(createdHome.floors[0]?.id ?? "");
        setPage("integrations");
        window.history.replaceState(
          { page: "integrations", propertyId, houseId: createdHome.id },
          "",
          locationForRoute("integrations", { propertyId, houseId: createdHome.id }, "/setup/overview"),
        );
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
  const inferredTimezone = Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
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
          {state.properties.length > 0 ? <label className="field">
            <span>{t("bootstrap.propertyForHome")}</span>
            <select value={firstHomePropertyId} required onChange={(event) => setFirstHomePropertyId(event.target.value)}>
              {state.properties.map((property) => <option key={property.id} value={property.id}>{property.name}</option>)}
            </select>
            <small>{t("bootstrap.propertyForHomeHelp")}</small>
          </label> : <>
            <p className="bootstrap-inferred"><Sparkles size={17} aria-hidden="true" /><span>{t("bootstrap.inferredSetup", {
              property: firstPropertyName.trim() || t("bootstrap.defaultPropertyName"),
              floor: t("bootstrap.groundFloor"),
              timezone: inferredTimezone,
            })}</span></p>
            <details className="bootstrap-advanced">
              <summary>{t("bootstrap.propertyDetails")}</summary>
              <label className="field">
                <span>{t("bootstrap.propertyName")}</span>
                <input value={firstPropertyName} onChange={(event) => setFirstPropertyName(event.target.value)} />
                <small>{t("bootstrap.propertyNameHelp")}</small>
              </label>
            </details>
          </>}
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
