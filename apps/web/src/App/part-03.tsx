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
import { useAppPart02 } from "./part-02";
export function useAppPart03(context: ReturnType<typeof useAppPart02>) {
  const { t, climate, state, workspaceReadOnly, canManagePeople, loadSeriesInBackground, initialRoute, initialHouse, initialPropertyId, initialSelectedHouse, page, setPage, routeLoading, routeNotFound, setRouteNotFound, setRouteRevision, propertyId, setPropertyId, houseId, setHouseId, floorId, setFloorId, metric, setMetric, viewMode, setViewMode, selectedSensorId, setSelectedSensorId, units, setUnitsState, firstHomeName, setFirstHomeName, firstPropertyName, setFirstPropertyName, firstHomePropertyId, setFirstHomePropertyId, bootstrapAction, setBootstrapAction, maintenanceObservationId, setMaintenanceObservationId, requestedSensorDevice, setRequestedSensorDevice, dismissedTpLinkDeviceIds, setDismissedTpLinkDeviceIds, invitationToken, setInvitationToken, logoutUncertain, setLogoutUncertain, previousPage, logout, property, propertyReadOnly, propertyElectricityAvailable, propertyHouses, selectedPropertyHouse, house, activeSharedHouse, houseReadOnly, houseLocalAuthority, locationRoute, readOnly, routeHouse, routeScopeInvalid, effectiveRouteNotFound, floor, measurementDefinitions, availableMeasurements, lastUpdated, openAlertCount, scopedIntegration, availableTpLinkDevices, currentTpLinkDevices, undisclosedTpLinkDevices, discoveredSensorNotice, applyHouse, setUnits, dismissTpLinkDeviceNotices, navigate, chooseHouse, chooseProperty, createHouse, deleteHouse, createFirstHome, repairHome, renderFirstHomeCard } = context;
  const renderNoAccessCard = () => (
      <section className="property-empty-page" aria-labelledby="workspace-no-access-title">
        <ShieldCheck size={28} aria-hidden="true" />
        <h1 id="workspace-no-access-title">{t("properties.noAccessTitle")}</h1>
        <p>{t("properties.noAccessBody")}</p>
      </section>
    );
  return Object.assign(context, { renderNoAccessCard });
}