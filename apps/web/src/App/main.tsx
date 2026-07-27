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
import { useAppPart02 } from "./part-02";
import { useAppPart03 } from "./part-03";
import { renderApp } from "./render";

export function App() {
  const context0 = {  };
  const context1 = useAppPart01(context0);
  const context2 = useAppPart02(context1);
  const context3 = useAppPart03(context2);
  return renderApp(context3);
}
