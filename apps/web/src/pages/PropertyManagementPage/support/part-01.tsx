import { lazy, Suspense, useCallback, useEffect, useMemo, useRef, useState, type ChangeEvent, type FormEvent, type KeyboardEvent as ReactKeyboardEvent } from "react";
import {
  Building2,
  Battery,
  Boxes,
  Camera,
  Check,
  ChevronRight,
  Clipboard,
  ClipboardList,
  ExternalLink,
  FileText,
  HardHat,
  KeyRound,
  Link as LinkIcon,
  LoaderCircle,
  Map as MapIcon,
  MapPin,
  Move,
  NotebookPen,
  Plus,
  QrCode,
  Radio,
  Redo2,
  Save,
  Search,
  ShieldCheck,
  Tag,
  Trash2,
  Undo2,
  Upload,
  Users,
  UserRound,
  Wrench,
  X,
} from "lucide-react";
import { floorMetersPerPlanUnit } from "@climate-twin/contracts";
import type {
  AreaEquipment,
  AreaEquipmentInput,
  AreaEquipmentPatch,
  AreaEquipmentStatus,
  EquipmentAttachment,
  EquipmentAttachmentKind,
  EquipmentLink,
  GeoCoordinate,
  GuestAccessGrant,
  HouseCreateInput,
  MaintenanceTask,
  MaintenanceTaskInput,
  Property,
  PropertyArea,
  PropertyAreaInput,
  PropertyAreaKind,
  PropertyAreaPatch,
  PropertyCreateInput,
  PropertyNote,
  PropertyNoteInput,
  PropertyNotePatch,
  PropertyPatch,
  TenantMemberSummary,
  TrackingCapabilities,
  TrackingEndpoint,
  TrackingMapSnapshot,
  TrackedEquipmentState,
  HomeMonitoringCollectionResponse,
} from "@climate-twin/contracts";
import { api, ApiRequestError, subscribeToTrackingEvents, type HouseGeoreferencePatch } from "../../../api";
import { EquipmentQrLabel } from "../../../components/EquipmentQrLabel";
import { StugubyMark } from "../../../components/StugubyMark";
import type { ClimateState } from "../../../domain";
import { useI18n, type TranslationKey } from "../../../i18n";
import { derivePropertyTrafficLights, type PropertyTrafficLight } from "../../../propertyStatus";
import { useNow } from "../../../useNow";
import "../../PropertyManagementPage.css";

export const PropertyAreaMap = lazy(() => import("../../../components/PropertyAreaMap").then((module) => ({ default: module.PropertyAreaMap })));

export type WorkspaceTab = "overview" | "map" | "inventory" | "notes" | "access";

export type Feedback = { kind: "success" | "error"; text: string } | null;

export const MAX_GUEST_ACCESS_GRANTS = 100;

export function guestActivationUrl(registrationToken: string, origin = window.location.origin): string {
  const url = new URL("/invite-bootstrap", origin);
  url.hash = new URLSearchParams({ invite: registrationToken }).toString();
  return url.toString();
}

export const areaKinds: PropertyAreaKind[] = [
  "well", "beach", "garage", "plantation", "garden", "field", "forest", "shoreline", "dock", "road", "yard", "building", "other",
];

export const fixedAssetKinds = new Set<PropertyAreaKind>(["well", "garage", "dock", "building"]);

export const NEW_FIXED_ASSET_ID = "__new-fixed-asset__";

export const EQUIPMENT_DRAFT_MAP_ID = "__equipment-draft-map-pin__";

export const TRACKED_ASSETS_REFRESH_MS = 30_000;

export const MAX_EQUIPMENT_ATTACHMENT_BYTES = 10 * 1024 * 1024;

export const EQUIPMENT_PHOTO_ACCEPT = ".png,.jpg,.jpeg,.webp,image/png,image/jpeg,image/webp";

export const EQUIPMENT_DOCUMENT_ACCEPT = ".pdf,.txt,.md,.rtf,.doc,.docx,.odt,application/pdf,text/plain,text/markdown,application/rtf,text/rtf,application/msword,application/vnd.openxmlformats-officedocument.wordprocessingml.document,application/vnd.oasis.opendocument.text";

export const equipmentAttachmentMimeTypes: Readonly<Record<EquipmentAttachmentKind, Readonly<Record<string, string>>>> = {
  photo: {
    png: "image/png",
    jpg: "image/jpeg",
    jpeg: "image/jpeg",
    webp: "image/webp",
  },
  document: {
    pdf: "application/pdf",
    txt: "text/plain",
    md: "text/markdown",
    rtf: "application/rtf",
    doc: "application/msword",
    docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    odt: "application/vnd.oasis.opendocument.text",
  },
};

export function equipmentAttachmentMimeType(file: File, kind: EquipmentAttachmentKind): string | null {
  const allowed = new Set(Object.values(equipmentAttachmentMimeTypes[kind]));
  const declared = file.type.trim().toLowerCase();
  if (allowed.has(declared)) return declared;
  const extension = file.name.split(".").at(-1)?.toLowerCase() ?? "";
  return equipmentAttachmentMimeTypes[kind][extension] ?? null;
}

export function fileDataUrl(file: File, mimeType: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.addEventListener("load", () => {
      const result = String(reader.result);
      const separator = result.indexOf(",");
      if (separator < 0) {
        reject(new Error("File could not be encoded"));
        return;
      }
      resolve(`data:${mimeType};base64,${result.slice(separator + 1)}`);
    });
    reader.addEventListener("error", () => reject(reader.error ?? new Error("File could not be read")));
    reader.readAsDataURL(file);
  });
}

export function attachmentSize(size: number): string {
  if (size < 1_024) return `${size} B`;
  if (size < 1_024 * 1_024) return `${Math.ceil(size / 1_024)} KiB`;
  return `${(size / (1_024 * 1_024)).toFixed(1)} MiB`;
}

export const MAP_ITEM_BATCH_SIZE = 30;

export type EquipmentPlacement = `area:${string}` | `house:${string}` | "unassigned";

export type InventoryLocationFilter = "all" | EquipmentPlacement | "pinned";

export type MapItemKind = "home" | "asset" | "equipment" | "person";

export type MapItemFilter = "all" | MapItemKind;

export type MapItemSelection = { kind: Exclude<MapItemKind, "person">; id: string } | null;

export type MapLayerVisibility = Record<MapItemKind, boolean>;

export interface MapCatalogEntry {
  id: string;
  kind: MapItemKind;
  label: string;
  detail: string;
  searchText: string;
}

export function equipmentPlacement(item: AreaEquipment): EquipmentPlacement {
  if (item.areaId) return `area:${item.areaId}`;
  if (item.houseId) return `house:${item.houseId}`;
  return "unassigned";
}

export function inventoryPlacement(item: AreaEquipment): Exclude<InventoryLocationFilter, "all"> {
  const placement = equipmentPlacement(item);
  return placement === "unassigned" && item.location ? "pinned" : placement;
}

export function placementInput(value: EquipmentPlacement): Pick<AreaEquipmentPatch, "areaId" | "houseId"> {
  if (value.startsWith("area:")) return { areaId: value.slice(5), houseId: null };
  if (value.startsWith("house:")) return { areaId: null, houseId: value.slice(6) };
  return { areaId: null, houseId: null };
}

export function isForeignSharedHouse(house: Pick<ClimateState["houses"][number], "stuguby">): boolean {
  return Boolean(
    house.stuguby
    && house.stuguby.ownership === "shared"
    && house.stuguby.syncState !== "detached",
  );
}

export interface PropertyManagementPageProps {
  state: ClimateState;
  /** Workspace-level Property index; no Property is implicitly active in the URL. */
  indexMode?: boolean;
  /** Controlled Property context used by the application router. */
  propertyId?: string | undefined;
  onProperty?: ((propertyId: string) => void) | undefined;
  /** Standalone compatibility for embedders that do not control selection. */
  initialPropertyId?: string | undefined;
  initialTab?: WorkspaceTab;
  onCreateProperty: (input: PropertyCreateInput) => Promise<Property>;
  onUpdateProperty: (id: string, patch: PropertyPatch) => Promise<Property>;
  onDeleteProperty: (id: string) => Promise<void>;
  onCreateHouse: (input: HouseCreateInput) => Promise<unknown>;
  onUpdateHouse: (id: string, patch: { propertyId: string }) => Promise<unknown>;
  onCreateArea: (input: PropertyAreaInput) => Promise<PropertyArea>;
  onUpdateArea: (id: string, patch: PropertyAreaPatch) => Promise<PropertyArea>;
  onDeleteArea: (id: string) => Promise<void>;
  onCreateEquipment: (input: AreaEquipmentInput) => Promise<AreaEquipment>;
  onUpdateEquipment: (id: string, patch: AreaEquipmentPatch) => Promise<AreaEquipment>;
  onDeleteEquipment: (id: string) => Promise<void>;
  onCreateNote: (input: PropertyNoteInput) => Promise<PropertyNote>;
  onUpdateNote: (id: string, patch: PropertyNotePatch) => Promise<PropertyNote>;
  onDeleteNote: (id: string) => Promise<void>;
  onCreateMaintenanceTask: (input: MaintenanceTaskInput) => Promise<MaintenanceTask>;
  onOpenMaintenance?: () => void;
  onSetHouseGeoreference?: (houseId: string, patch: HouseGeoreferencePatch) => Promise<void>;
  dataMode?: "demo" | "real" | "unknown";
  monitoring?: HomeMonitoringCollectionResponse;
}

export interface AreaDraft {
  name: string;
  kind: PropertyAreaKind;
  description: string;
  location: GeoCoordinate | null;
  polygon: GeoCoordinate[];
}

export const emptyAreaDraft = (): AreaDraft => ({ name: "", kind: "other", description: "", location: null, polygon: [] });

export function mapCoordinateInput(value: number): string {
  return String(Number(value.toFixed(6)));
}

export function coordinateText(points: readonly GeoCoordinate[]): string {
  return points.map((point) => `${point.latitude.toFixed(6)}, ${point.longitude.toFixed(6)}`).join("\n");
}

export function parseCoordinateText(value: string): GeoCoordinate[] | null {
  const lines = value.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  const points: GeoCoordinate[] = [];
  for (const line of lines) {
    const [latitudeText, longitudeText, ...extra] = line.split(/[;,\s]+/).filter(Boolean);
    const latitude = Number(latitudeText);
    const longitude = Number(longitudeText);
    if (extra.length || !Number.isFinite(latitude) || latitude < -90 || latitude > 90 || !Number.isFinite(longitude) || longitude < -180 || longitude > 180) return null;
    points.push({ latitude, longitude });
  }
  return points;
}

export function areaDraft(area: PropertyArea): AreaDraft {
  return {
    name: area.name,
    kind: area.kind,
    description: area.description ?? "",
    location: area.location ? { ...area.location } : null,
    polygon: area.polygon.map((point) => ({ ...point })),
  };
}

export function firstHouseFloor(name: string): HouseCreateInput["floors"][number] {
  return {
    id: crypto.randomUUID(), name, type: "ground", width: 10, height: 8, elevation: 0, ceilingHeight: 2.8, wallHeight: 2.8,
    walls: [], rooms: [], planElements: [],
  };
}

export function targetLabel(note: PropertyNote, state: ClimateState): string {
  if (note.equipmentId) return state.areaEquipment.find((item) => item.id === note.equipmentId)?.name ?? note.equipmentId;
  if (note.areaId) return state.propertyAreas.find((item) => item.id === note.areaId)?.name ?? note.areaId;
  if (note.houseId) return state.houses.find((item) => item.id === note.houseId)?.name ?? note.houseId;
  return state.properties.find((item) => item.id === note.propertyId)?.name ?? note.propertyId;
}

export function PropertyStatusLights({ lights }: Readonly<{ lights: readonly PropertyTrafficLight[] }>) {
  const { t } = useI18n();
  if (!lights.length) return <p className="property-status-empty">{t("properties.status.none")}</p>;
  return <section className="property-status-lights" aria-label={t("properties.status.title")}>
    {lights.map((light) => {
      const label = t(`properties.status.${light.id}` as TranslationKey);
      const level = t(`properties.status.level.${light.level}` as TranslationKey);
      const reason = t(`properties.status.reason.${light.reason}` as TranslationKey);
      return <article key={light.id} data-status={light.level} aria-label={`${label}: ${level}. ${reason}`} title={reason}>
        <span className="property-status-signal" aria-hidden="true" />
        <span><strong>{label}</strong><small>{level} · {reason}</small></span>
      </article>;
    })}
  </section>;
}

export function normalizeGuestGrants(grants: readonly GuestAccessGrant[], state: ClimateState): GuestAccessGrant[] {
  const inheritedPropertyIds = new Set(grants.filter((grant) => grant.scopeType === "property").map((grant) => grant.scopeId));
  return grants.filter((grant, index) => {
    if (grants.findIndex((candidate) => candidate.scopeType === grant.scopeType && candidate.scopeId === grant.scopeId) !== index) return false;
    if (grant.scopeType === "house") {
      const propertyId = state.houses.find((house) => house.id === grant.scopeId)?.propertyId;
      return !propertyId || !inheritedPropertyIds.has(propertyId);
    }
    if (grant.scopeType === "area") {
      const propertyId = state.propertyAreas.find((area) => area.id === grant.scopeId)?.propertyId;
      return !propertyId || !inheritedPropertyIds.has(propertyId);
    }
    return true;
  });
}
