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
import { floorMetersPerPlanUnit } from "@climate-twin/contracts";
import type {
  ConnectionState,
  House,
  HouseLocation,
  HouseMapPlacement,
  IntegrationStatus,
  TpLinkDiscoveredDevice,
  UnitSystem,
} from "@climate-twin/contracts";
import {
  api,
  type HouseGeoreferencePatch,
  type HousePatch,
  type IntegrationDiscoveryResult,
  type TpLinkHistoryExportJob,
  type TpLinkHistoryExportJobsResponse,
  type TpLinkHistoryExportJobStatus,
} from "../../api";
import type { HouseLocationMapItem, MapLocation } from "../../components/HouseLocationMap";
import { LocationDiscoveryPanel, type DiscoveredHomeDefaults } from "../../components/LocationDiscoveryPanel";
import { useI18n } from "../../i18n";
import { integrationForHouse } from "../../integrationScope";
import { AutomationSetupPanel } from "../AutomationSetupPanel";
import { SetupOperationsPanel } from "../SetupOperationsPanel";
import { ACTIVE_TP_LINK_EXPORT_STATUSES, HouseLocationMap, RETRYABLE_TP_LINK_EXPORT_STATUSES, TP_LINK_EXPORT_PROVIDER_KEYS, TP_LINK_EXPORT_STATUS_KEYS, connectionError, dateTime, decimal, defaultFootprintWidthMeters, floorPlanSize, footprintFloorFor, mapLocation, placementForm, setupSectionFromPath, setupSectionOrder, validTimeZone, writeSetupSection } from "./support";
import type { DiscoveryOutcome, Feedback, HouseFloor, IntegrationsPageProps, SetupSection, TpLinkChildDiscovery } from "./support";
import { useIntegrationsPagePart05 } from "./part-05";
export function useIntegrationsPagePart06(context: ReturnType<typeof useIntegrationsPagePart05>) {
  const { t, activeSection, house, discovering, sensorSourceConfigured, discoveredCount, nextStepIndex, primarySetupSections, scanIntegrations, activateSection, onOpenSensors } = context;
  const handleSectionKeyDown = (event: KeyboardEvent<HTMLButtonElement>, section: SetupSection) => {
      if (!["ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key)) return;
      event.preventDefault();
      const sectionOrder = primarySetupSections.map((candidate) => candidate.id);
      const index = sectionOrder.indexOf(section);
      const nextIndex = event.key === "Home"
        ? 0
        : event.key === "End"
          ? sectionOrder.length - 1
          : (index + (event.key === "ArrowRight" ? 1 : -1) + sectionOrder.length) % sectionOrder.length;
      const next = sectionOrder[nextIndex]!;
      activateSection(next);
      window.requestAnimationFrame(() => document.getElementById(`setup-tab-${next}`)?.focus());
    };
  const runRecommendedAction = () => {
      if (nextStepIndex === 1) {
        activateSection("connections");
        if (!sensorSourceConfigured && !discovering) void scanIntegrations();
        return;
      }
      if (nextStepIndex === 2) {
        if (onOpenSensors) onOpenSensors();
        else activateSection("connections");
      }
    };
  const recommendedActionLabel = discoveredCount > 0 && nextStepIndex === 1
      ? t("setup.reviewFound", { count: discoveredCount })
      : nextStepIndex === 1 && !sensorSourceConfigured
        ? t("setup.scan")
        : nextStepIndex === 2 ? t("sensors.add") : t("setup.workspaceConnections");
  return Object.assign(context, { handleSectionKeyDown, runRecommendedAction, recommendedActionLabel });
}
