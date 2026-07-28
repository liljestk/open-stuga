import { lazy, Suspense, useCallback, useEffect, useMemo, useRef, useState, type FormEvent } from "react";
import type { Floor, Metric, TpLinkDiscoveredDevice, UnitSystem } from "@climate-twin/contracts";
import { AlertTriangle, HousePlus, LoaderCircle, RotateCcw, ShieldCheck, Wrench } from "lucide-react";
import { AppShell } from "../../components/AppShell";
import { type AppPage, type ViewMode } from "../../domain";
import { useClimateData } from "../../useClimateData";
import { countActionableAlertGroups } from "../../alertGrouping";
import { useI18n } from "../../i18n";
import { enabledDefinitions } from "../../measurements";
import { api, type CreateHouseInput } from "../../api";
import { locationForRoute, routeFromLocation } from "../../routing";
import { StuguMark } from "../../components/StuguMark";
import { RouteErrorBoundary } from "../../components/RouteErrorBoundary";
import { readLocalStorage, writeLocalStorage } from "../../browserStorage";
import {
  clearInvitationBootstrapStorage,
  clearInvitationFragment,
  invitationTokenFromBootstrapStorage,
  invitationTokenFromFragment,
  LocalAuthPage,
} from "../../pages/LocalAuthPage";
import { integrationForHouse } from "../../integrationScope";

export const AlertsPage = lazy(() => import("../../pages/AlertsPage").then((module) => ({ default: module.AlertsPage })));

export const DeveloperPage = lazy(() => import("../../pages/DeveloperPage").then((module) => ({ default: module.DeveloperPage })));

export const SystemUpdatesPage = lazy(() => import("../../pages/SystemUpdatesPage").then((module) => ({ default: module.SystemUpdatesPage })));

export const IntegrationsPage = lazy(() => import("../../pages/IntegrationsPage").then((module) => ({ default: module.IntegrationsPage })));

export const SensorManagementPage = lazy(() => import("../../pages/SensorManagementPage").then((module) => ({ default: module.SensorManagementPage })));

export const DataAnalyticsPage = lazy(() => import("../../pages/DataAnalyticsPage").then((module) => ({ default: module.DataAnalyticsPage })));

export const TwinDashboard = lazy(() => import("../../pages/TwinDashboard").then((module) => ({ default: module.TwinDashboard })));

export const PortfolioOverview = lazy(() => import("../../pages/PortfolioOverview").then((module) => ({ default: module.PortfolioOverview })));

export const PropertyManagementPage = lazy(() => import("../../pages/PropertyManagementPage").then((module) => ({ default: module.PropertyManagementPage })));

export const OutdoorWeatherPage = lazy(() => import("../../pages/OutdoorWeatherPage").then((module) => ({ default: module.OutdoorWeatherPage })));

export const ActivityPage = lazy(() => import("../../pages/ActivityPage").then((module) => ({ default: module.ActivityPage })));

export const MaintenancePage = lazy(() => import("../../pages/MaintenancePage").then((module) => ({ default: module.MaintenancePage })));

export const EnergyPage = lazy(() => import("../../pages/EnergyPage").then((module) => ({ default: module.EnergyPage })));

export const PeopleAccessPage = lazy(() => import("../../pages/PeopleAccessPage").then((module) => ({ default: module.PeopleAccessPage })));

export const StugubyPage = lazy(() => import("../../pages/StugubyPage").then((module) => ({ default: module.StugubyPage })));

export const pageTitleKeys = {
  overview: "nav.overview",
  properties: "nav.properties",
  people: "nav.people",
  stugubys: "nav.stugubys",
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

export const dismissedTpLinkDevicesKey = "stugu-dismissed-tp-link-device-notices";

export const freshTpLinkDiscoveryWindowMs = 60_000;

export interface TpLinkDeviceReference {
  deviceId: string;
  connectionId: string | null;
  model?: string;
  alias?: string | null;
  deviceType?: "climate" | "contact" | "energy" | "unknown";
}

export function tpLinkDeviceKey(device: { deviceId: string; connectionId?: string | null | undefined }): string {
  return `${device.connectionId ?? ""}\u0000${device.deviceId}`;
}

export function storedDismissedTpLinkDevices(): string[] {
  try {
    const value = JSON.parse(readLocalStorage(dismissedTpLinkDevicesKey) ?? "[]") as unknown;
    return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : [];
  } catch {
    return [];
  }
}

export function settleInBackground(promise: Promise<unknown>): void {
  promise.catch(() => undefined);
}

export function latestIso(values: Array<string | null | undefined>): string | null {
  return values.filter((value): value is string => Boolean(value))
    .filter((value) => Number.isFinite(Date.parse(value)))
    .sort((left, right) => left.localeCompare(right)).at(-1) ?? null;
}

export function firstFloor(name: string): Floor {
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
