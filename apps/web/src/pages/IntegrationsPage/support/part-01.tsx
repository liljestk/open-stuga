import { lazy } from "react";
import { floorMetersPerPlanUnit } from "@climate-twin/contracts";
import type { ConnectionState, House, HousePatch, IntegrationDiscoveryJob, IntegrationStatus, TpLinkDiscoveredDevice, UnitSystem } from "@climate-twin/contracts";
import { api, type HouseGeoreferencePatch, type TpLinkHistoryExportJob, type TpLinkHistoryExportJobStatus } from "../../../api";
import type { MapLocation } from "../../../components/HouseLocationMap";
import { formatInTimeZone } from "../../../dateTime";
export {
  forgetIntegrationDiscovery,
  rememberIntegrationDiscovery,
  rememberedIntegrationDiscovery,
} from "../../../integrationDiscoveryStorage";

export const HouseLocationMap = lazy(() => import("../../../components/HouseLocationMap").then((module) => ({ default: module.HouseLocationMap })));

export interface IntegrationsPageProps {
  integration: IntegrationStatus;
  house: House;
  houses: House[];
  /** All workspace Homes available to the connection manager, including other Properties. */
  connectionHouses?: House[];
  units: UnitSystem;
  streamConnection: ConnectionState;
  tpLinkDevicesLoading?: boolean;
  tpLinkDevicesError?: string | null;
  canManageIntegrations?: boolean;
  onHouse: (houseId: string) => void;
  onHouseUpdate: (houseId: string, patch: HousePatch) => Promise<unknown>;
  onGeoreferenceChange: (houseId: string, patch: HouseGeoreferencePatch) => Promise<void>;
  onIntegrationChange: (integration: IntegrationStatus) => void;
  onRefreshTpLinkDevices?: (houseId?: string) => Promise<TpLinkDiscoveredDevice[]>;
  onDisconnectHomeAssistant?: (houseId: string) => ReturnType<typeof api.disconnectHomeAssistant>;
  onDisconnectTpLink?: (connectionId: string) => ReturnType<typeof api.disconnectTpLink>;
  onMoveHomeAssistant?: (fromHouseId: string, houseId: string) => ReturnType<typeof api.moveHomeAssistant>;
  onMoveTpLink?: (connectionId: string, houseId: string) => ReturnType<typeof api.moveTpLink>;
  onOpenSensors?: (device?: {
    deviceId: string;
    connectionId: string | null;
    model?: string;
    alias?: string | null;
    deviceType?: "climate" | "contact" | "energy" | "unknown";
  }) => void;
  onOpenLayout?: () => void;
  onDiscoveryStarted?: (job: IntegrationDiscoveryJob) => void;
}

export type Feedback = { kind: "success" | "error"; message: string } | null;

export type SetupSection = "overview" | "layout" | "connections" | "weather" | "automations" | "operations";

export type DiscoveryOutcome = "idle" | "found" | "empty" | "error";

export type TpLinkChildDiscovery =
  | { phase: "idle" }
  | { phase: "settling"; hubModel: "H100" | "H200" | "H500" | null; baselineLastPollAt: string | null }
  | { phase: "found"; count: number; hubModel: "H100" | "H200" | "H500" | null }
  | { phase: "empty" | "error"; hubModel: "H100" | "H200" | "H500" | null };

export const setupSectionOrder: SetupSection[] = ["overview", "layout", "connections", "weather", "operations", "automations"];

export const RETRYABLE_TP_LINK_EXPORT_STATUSES = new Set<TpLinkHistoryExportJobStatus>(["failed", "needs-attention"]);

export const ACTIVE_TP_LINK_EXPORT_STATUSES = new Set<TpLinkHistoryExportJobStatus>(["queued", "claimed", "running", "waiting-email"]);

export const TP_LINK_EXPORT_STATUS_KEYS = {
  queued: "setup.tpLinkHistoryStatusQueued",
  claimed: "setup.tpLinkHistoryStatusClaimed",
  running: "setup.tpLinkHistoryStatusRunning",
  "waiting-email": "setup.tpLinkHistoryStatusWaitingEmail",
  "needs-attention": "setup.tpLinkHistoryStatusNeedsAttention",
  completed: "setup.tpLinkHistoryStatusCompleted",
  failed: "setup.tpLinkHistoryStatusFailed",
  cancelled: "setup.tpLinkHistoryStatusCancelled",
} as const satisfies Record<TpLinkHistoryExportJobStatus, string>;

export const TP_LINK_EXPORT_PROVIDER_KEYS = {
  appium: "setup.tpLinkHistoryProviderApp",
  "private-cloud": "setup.tpLinkHistoryProviderPrivateCloud",
} as const satisfies Record<TpLinkHistoryExportJob["provider"], string>;

export function setupSectionFromPath(pathname = typeof window === "undefined" ? "" : window.location.pathname): SetupSection {
  const candidate = pathname.match(/\/setup\/([^/]+)\/?$/)?.[1];
  return setupSectionOrder.includes(candidate as SetupSection) ? candidate as SetupSection : "overview";
}

export function writeSetupSection(section: SetupSection, replace = false): void {
  if (typeof window === "undefined") return;
  const setupPath = /^(.*\/setup)(?:\/(?:overview|homes|layout|connections|weather|automations|operations))?\/?$/.exec(window.location.pathname);
  if (!setupPath) return;
  const next = `${setupPath[1]}/${section}${window.location.search}${window.location.hash}`;
  if (`${window.location.pathname}${window.location.search}${window.location.hash}` === next) return;
  window.history[replace ? "replaceState" : "pushState"](null, "", next);
}

export function dateTime(value: string | null | undefined, locale: string, timeZone: string, options?: Intl.DateTimeFormatOptions): string | null {
  if (!value) return null;
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) return null;
  return formatInTimeZone(date, locale, timeZone, options ?? { dateStyle: "short", timeStyle: "short" });
}

export function decimal(value: number, locale: string, maximumFractionDigits = 1): string {
  return new Intl.NumberFormat(locale, { maximumFractionDigits }).format(value);
}

export function validTimeZone(value: string): boolean {
  if (!value.trim()) return false;
  try {
    new Intl.DateTimeFormat("en", { timeZone: value.trim() }).format();
    return true;
  } catch {
    return false;
  }
}

export type HouseFloor = House["floors"][number];

export function footprintFloorFor(candidate: House): HouseFloor | undefined {
  const explicitlySelected = candidate.mapPlacement?.footprintFloorId
    ? candidate.floors.find((floor) => floor.id === candidate.mapPlacement?.footprintFloorId)
    : undefined;
  if (explicitlySelected) return explicitlySelected;
  const usable = candidate.floors.filter((floor) => floor.type !== "outdoor");
  return usable.find((floor) => floor.type === "ground")
    ?? [...usable].filter((floor) => floor.elevation >= 0).sort((first, second) => first.elevation - second.elevation)[0]
    ?? [...usable].sort((first, second) => first.elevation - second.elevation)[0];
}

export function floorPlanSize(floor: HouseFloor | undefined): { width: number; depth: number } {
  if (!floor) return { width: 1, depth: 1 };
  const points = floor.walls.flatMap((wall) => [wall.from, wall.to])
    .filter((point) => Number.isFinite(point.x) && Number.isFinite(point.y));
  const minX = Math.min(0, ...points.map((point) => point.x));
  const minY = Math.min(0, ...points.map((point) => point.y));
  const maxX = Math.max(Number.isFinite(floor.width) ? floor.width : 1, ...points.map((point) => point.x));
  const maxY = Math.max(Number.isFinite(floor.height) ? floor.height : 1, ...points.map((point) => point.y));
  return { width: Math.max(0.001, maxX - minX), depth: Math.max(0.001, maxY - minY) };
}

export function defaultFootprintWidthMeters(floor: HouseFloor | undefined): number {
  const planWidth = floorPlanSize(floor).width;
  return planWidth >= 2 && planWidth <= 80 ? Number(planWidth.toFixed(2)) : 12;
}

export function mapLocation(latitude: string, longitude: string): MapLocation | null {
  if (!latitude.trim() || !longitude.trim()) return null;
  const parsedLatitude = Number(latitude);
  const parsedLongitude = Number(longitude);
  return Number.isFinite(parsedLatitude) && parsedLatitude >= -90 && parsedLatitude <= 90
    && Number.isFinite(parsedLongitude) && parsedLongitude >= -180 && parsedLongitude <= 180
    ? { latitude: parsedLatitude, longitude: parsedLongitude }
    : null;
}

export function placementForm(candidate: House): {
  latitude: string;
  longitude: string;
  footprintFloorId: string;
  footprintWidthMeters: string;
} {
  const floor = footprintFloorFor(candidate);
  const source = candidate.mapPlacement ?? candidate.location;
  const planWidth = floorPlanSize(floor).width;
  const horizontalScale = floor ? floorMetersPerPlanUnit(floor, candidate) : null;
  const physicalWidth = horizontalScale !== null
    ? horizontalScale * planWidth
    : defaultFootprintWidthMeters(floor);
  return {
    latitude: source ? String(source.latitude) : "",
    longitude: source ? String(source.longitude) : "",
    footprintFloorId: floor?.id ?? "",
    footprintWidthMeters: Number(physicalWidth.toFixed(2)).toString(),
  };
}
