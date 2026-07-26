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
  TrackingMapSnapshot,
  TrackingTag,
  TrackingTagProvisioningResult,
  TrackedEquipmentState,
} from "@climate-twin/contracts";
import { api, ApiRequestError, subscribeToTrackingEvents, type HouseGeoreferencePatch } from "../api";
import { EquipmentQrLabel } from "../components/EquipmentQrLabel";
import { StugubyMark } from "../components/StugubyMark";
import type { ClimateState } from "../domain";
import { useI18n, type TranslationKey } from "../i18n";
import { derivePropertyTrafficLights, type PropertyTrafficLight } from "../propertyStatus";
import { useNow } from "../useNow";
import "./PropertyManagementPage.css";

const PropertyAreaMap = lazy(() => import("../components/PropertyAreaMap").then((module) => ({ default: module.PropertyAreaMap })));

type WorkspaceTab = "overview" | "map" | "inventory" | "notes" | "access";
type Feedback = { kind: "success" | "error"; text: string } | null;
export const MAX_GUEST_ACCESS_GRANTS = 100;

export function guestActivationUrl(registrationToken: string, origin = window.location.origin): string {
  const url = new URL("/invite-bootstrap", origin);
  url.hash = new URLSearchParams({ invite: registrationToken }).toString();
  return url.toString();
}

const areaKinds: PropertyAreaKind[] = [
  "well", "beach", "garage", "plantation", "garden", "field", "forest", "shoreline", "dock", "road", "yard", "building", "other",
];
const fixedAssetKinds = new Set<PropertyAreaKind>(["well", "garage", "dock", "building"]);
const NEW_FIXED_ASSET_ID = "__new-fixed-asset__";
const EQUIPMENT_DRAFT_MAP_ID = "__equipment-draft-map-pin__";
const TRACKED_ASSETS_REFRESH_MS = 30_000;
const MAX_EQUIPMENT_ATTACHMENT_BYTES = 10 * 1024 * 1024;
const EQUIPMENT_PHOTO_ACCEPT = ".png,.jpg,.jpeg,.webp,image/png,image/jpeg,image/webp";
const EQUIPMENT_DOCUMENT_ACCEPT = ".pdf,.txt,.md,.rtf,.doc,.docx,.odt,application/pdf,text/plain,text/markdown,application/rtf,text/rtf,application/msword,application/vnd.openxmlformats-officedocument.wordprocessingml.document,application/vnd.oasis.opendocument.text";

const equipmentAttachmentMimeTypes: Readonly<Record<EquipmentAttachmentKind, Readonly<Record<string, string>>>> = {
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

function equipmentAttachmentMimeType(file: File, kind: EquipmentAttachmentKind): string | null {
  const allowed = new Set(Object.values(equipmentAttachmentMimeTypes[kind]));
  const declared = file.type.trim().toLowerCase();
  if (allowed.has(declared)) return declared;
  const extension = file.name.split(".").at(-1)?.toLowerCase() ?? "";
  return equipmentAttachmentMimeTypes[kind][extension] ?? null;
}

function fileDataUrl(file: File, mimeType: string): Promise<string> {
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

function attachmentSize(size: number): string {
  if (size < 1_024) return `${size} B`;
  if (size < 1_024 * 1_024) return `${Math.ceil(size / 1_024)} KiB`;
  return `${(size / (1_024 * 1_024)).toFixed(1)} MiB`;
}
const MAP_ITEM_BATCH_SIZE = 30;

type EquipmentPlacement = `area:${string}` | `house:${string}` | "unassigned";
type InventoryLocationFilter = "all" | EquipmentPlacement | "pinned";
type MapItemKind = "home" | "asset" | "equipment" | "person";
type MapItemFilter = "all" | MapItemKind;
type MapItemSelection = { kind: Exclude<MapItemKind, "person">; id: string } | null;
type MapLayerVisibility = Record<MapItemKind, boolean>;

interface MapCatalogEntry {
  id: string;
  kind: MapItemKind;
  label: string;
  detail: string;
  searchText: string;
}

function equipmentPlacement(item: AreaEquipment): EquipmentPlacement {
  if (item.areaId) return `area:${item.areaId}`;
  if (item.houseId) return `house:${item.houseId}`;
  return "unassigned";
}

function inventoryPlacement(item: AreaEquipment): Exclude<InventoryLocationFilter, "all"> {
  const placement = equipmentPlacement(item);
  return placement === "unassigned" && item.location ? "pinned" : placement;
}

function placementInput(value: EquipmentPlacement): Pick<AreaEquipmentPatch, "areaId" | "houseId"> {
  if (value.startsWith("area:")) return { areaId: value.slice(5), houseId: null };
  if (value.startsWith("house:")) return { areaId: null, houseId: value.slice(6) };
  return { areaId: null, houseId: null };
}

function isForeignSharedHouse(house: Pick<ClimateState["houses"][number], "stuguby">): boolean {
  return Boolean(
    house.stuguby
    && house.stuguby.ownership === "shared"
    && house.stuguby.syncState !== "detached",
  );
}

interface PropertyManagementPageProps {
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
}

interface AreaDraft {
  name: string;
  kind: PropertyAreaKind;
  description: string;
  location: GeoCoordinate | null;
  polygon: GeoCoordinate[];
}

const emptyAreaDraft = (): AreaDraft => ({ name: "", kind: "other", description: "", location: null, polygon: [] });

function mapCoordinateInput(value: number): string {
  return String(Number(value.toFixed(6)));
}

function coordinateText(points: readonly GeoCoordinate[]): string {
  return points.map((point) => `${point.latitude.toFixed(6)}, ${point.longitude.toFixed(6)}`).join("\n");
}

function parseCoordinateText(value: string): GeoCoordinate[] | null {
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

function areaDraft(area: PropertyArea): AreaDraft {
  return {
    name: area.name,
    kind: area.kind,
    description: area.description ?? "",
    location: area.location ? { ...area.location } : null,
    polygon: area.polygon.map((point) => ({ ...point })),
  };
}

function firstHouseFloor(name: string): HouseCreateInput["floors"][number] {
  return {
    id: crypto.randomUUID(), name, type: "ground", width: 10, height: 8, elevation: 0, ceilingHeight: 2.8, wallHeight: 2.8,
    walls: [], rooms: [], planElements: [],
  };
}

function targetLabel(note: PropertyNote, state: ClimateState): string {
  if (note.equipmentId) return state.areaEquipment.find((item) => item.id === note.equipmentId)?.name ?? note.equipmentId;
  if (note.areaId) return state.propertyAreas.find((item) => item.id === note.areaId)?.name ?? note.areaId;
  if (note.houseId) return state.houses.find((item) => item.id === note.houseId)?.name ?? note.houseId;
  return state.properties.find((item) => item.id === note.propertyId)?.name ?? note.propertyId;
}

function PropertyStatusLights({ lights }: Readonly<{ lights: readonly PropertyTrafficLight[] }>) {
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

function normalizeGuestGrants(grants: readonly GuestAccessGrant[], state: ClimateState): GuestAccessGrant[] {
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

function toggledGuestGrants(
  grants: readonly GuestAccessGrant[],
  grant: GuestAccessGrant,
  state: ClimateState,
): GuestAccessGrant[] {
  const normalized = normalizeGuestGrants(grants, state);
  if (normalized.some((item) => item.scopeType === grant.scopeType && item.scopeId === grant.scopeId)) {
    return normalized.filter((item) => item.scopeType !== grant.scopeType || item.scopeId !== grant.scopeId);
  }
  if (grant.scopeType !== "property") return [...normalized, grant];
  const houseIds = new Set(state.houses.filter((house) => house.propertyId === grant.scopeId).map((house) => house.id));
  const areaIds = new Set(state.propertyAreas.filter((area) => area.propertyId === grant.scopeId).map((area) => area.id));
  return [...normalized.filter((item) => item.scopeType === "property"
    || (item.scopeType === "house" ? !houseIds.has(item.scopeId) : !areaIds.has(item.scopeId))), grant];
}

export function AccessPanel({ state, properties, canRemoveGuests, workspaceMode = false }: Readonly<{ state: ClimateState; properties: Property[]; canRemoveGuests: boolean; workspaceMode?: boolean }>) {
  const { locale, t } = useI18n();
  const [members, setMembers] = useState<TenantMemberSummary[]>([]);
  const [invitations, setInvitations] = useState<TenantMemberSummary[]>([]);
  const [selectedEmail, setSelectedEmail] = useState("");
  const [draftGrants, setDraftGrants] = useState<GuestAccessGrant[]>([]);
  const [inviteEmail, setInviteEmail] = useState("");
  const [loading, setLoading] = useState(true);
  const [pending, setPending] = useState(false);
  const [feedback, setFeedback] = useState<Feedback>(null);
  const [activation, setActivation] = useState<{
    email: string;
    url: string;
    expiresAt: string;
    cloudflareStatus: "disabled" | "pending" | "synced";
  } | null>(null);
  const [activationCopy, setActivationCopy] = useState<"idle" | "copied" | "failed">("idle");
  const [removeConfirmationEmail, setRemoveConfirmationEmail] = useState("");

  const guests = useMemo(() => [...members, ...invitations]
    .filter((member) => member.role === "guest")
    .sort((left, right) => left.email.localeCompare(right.email)), [invitations, members]);
  const selected = guests.find((member) => member.email === selectedEmail);
  const grantResources = useMemo(() => {
    const housesByProperty = new globalThis.Map<string, ClimateState["houses"]>();
    const areasByProperty = new globalThis.Map<string, ClimateState["propertyAreas"]>();
    for (const house of state.houses) {
      const houses = housesByProperty.get(house.propertyId) ?? [];
      houses.push(house);
      housesByProperty.set(house.propertyId, houses);
    }
    for (const area of state.propertyAreas) {
      const areas = areasByProperty.get(area.propertyId) ?? [];
      areas.push(area);
      areasByProperty.set(area.propertyId, areas);
    }
    return properties.map((property) => ({
      property,
      houses: housesByProperty.get(property.id) ?? [],
      areas: areasByProperty.get(property.id) ?? [],
    }));
  }, [properties, state.houses, state.propertyAreas]);
  const checkedGrantKeys = useMemo(() => new Set(draftGrants.map((grant) => `${grant.scopeType}:${grant.scopeId}`)), [draftGrants]);

  useEffect(() => {
    let current = true;
    setLoading(true);
    void api.tenantMembers().then((result) => {
      if (!current) return;
      setMembers(result.members);
      setInvitations(result.invitations);
      const available = [...result.members, ...result.invitations];
      setSelectedEmail((selectedEmail) => selectedEmail && available.some((member) => member.email === selectedEmail)
        ? selectedEmail
        : available.find((member) => member.role === "guest")?.email ?? "");
    }).catch(() => {
      if (current) setFeedback({ kind: "error", text: t("properties.loadAccessFailed") });
    }).finally(() => {
      if (current) setLoading(false);
    });
    return () => { current = false; };
  }, [t]);
  useEffect(() => { setDraftGrants(selected ? normalizeGuestGrants(selected.grants, state) : []); }, [selected?.email, selected?.grants, state.houses, state.propertyAreas]);
  useEffect(() => { setRemoveConfirmationEmail(""); }, [selectedEmail]);

  const toggle = (grant: GuestAccessGrant) => {
    const next = toggledGuestGrants(draftGrants, grant, state);
    if (next.length > MAX_GUEST_ACCESS_GRANTS) {
      setFeedback({ kind: "error", text: t("properties.accessGrantLimit", { max: MAX_GUEST_ACCESS_GRANTS }) });
      return;
    }
    setDraftGrants(next);
    setFeedback(null);
  };
  const checked = (scopeType: GuestAccessGrant["scopeType"], scopeId: string) => checkedGrantKeys.has(`${scopeType}:${scopeId}`);

  const invite = async (event: FormEvent) => {
    event.preventDefault();
    const email = inviteEmail.trim().toLowerCase();
    if (!email || pending) return;
    setPending(true);
    setFeedback(null);
    try {
      const created = await api.inviteGuest(email);
      setInvitations((current) => [...current.filter((item) => item.email !== email), created.invitation]);
      setSelectedEmail(email);
      setInviteEmail("");
      setActivation({
        email,
        url: guestActivationUrl(created.registrationToken),
        expiresAt: created.expiresAt,
        cloudflareStatus: created.cloudflareAccess?.status ?? "disabled",
      });
      setActivationCopy("idle");
      setFeedback({ kind: "success", text: t("properties.guestInvited") });
    } catch {
      setFeedback({ kind: "error", text: t("properties.guestInviteFailed") });
    } finally {
      setPending(false);
    }
  };

  const copyActivation = async () => {
    if (!activation) return;
    try {
      if (!navigator.clipboard?.writeText) throw new Error("Clipboard unavailable");
      await navigator.clipboard.writeText(activation.url);
      setActivationCopy("copied");
    } catch {
      setActivationCopy("failed");
    }
  };

  const save = async () => {
    if (!selected || pending) return;
    if (draftGrants.length > MAX_GUEST_ACCESS_GRANTS) {
      setFeedback({ kind: "error", text: t("properties.accessGrantLimit", { max: MAX_GUEST_ACCESS_GRANTS }) });
      return;
    }
    setPending(true);
    setFeedback(null);
    try {
      const saved = await api.updateMemberAccess(selected.email, draftGrants);
      const joinedAt = saved.joinedAt ?? selected.joinedAt;
      const invitedAt = saved.invitedAt ?? selected.invitedAt;
      const savedWithStatus: TenantMemberSummary = {
        ...selected,
        ...saved,
        ...(joinedAt === undefined ? {} : { joinedAt }),
        ...(invitedAt === undefined ? {} : { invitedAt }),
      };
      const replace = (items: TenantMemberSummary[]) => items.map((item) => item.email === saved.email ? savedWithStatus : item);
      setMembers(replace);
      setInvitations(replace);
      setFeedback({ kind: "success", text: t("properties.accessSaved") });
    } catch {
      setFeedback({ kind: "error", text: t("properties.accessSaveFailed") });
    } finally {
      setPending(false);
    }
  };

  const removeGuest = async () => {
    if (!selected || !canRemoveGuests || pending || removeConfirmationEmail !== selected.email) return;
    setPending(true);
    setFeedback(null);
    try {
      await api.removeTenantMember(selected.email);
      setMembers((current) => current.filter((member) => member.email !== selected.email));
      setInvitations((current) => current.filter((member) => member.email !== selected.email));
      if (activation?.email === selected.email) setActivation(null);
      setSelectedEmail("");
      setRemoveConfirmationEmail("");
      setFeedback({ kind: "success", text: t("properties.guestRemoved") });
    } catch {
      setFeedback({ kind: "error", text: t("properties.guestRemoveFailed") });
    } finally {
      setPending(false);
    }
  };

  if (loading) return <output className="property-loading"><LoaderCircle className="spin" size={18} />{t("common.loading")}</output>;
  return <div className="property-access-grid">
    <section className="panel guest-list-panel">
      <div className="panel-header"><div><span className="eyebrow">{t("properties.guests")}</span><h2>{t("properties.guestAccounts")}</h2></div><Users size={20} /></div>
      {workspaceMode && <form className="guest-invite-form" onSubmit={(event) => void invite(event)}><label className="field"><span>{t("properties.guestEmail")}</span><input type="email" required value={inviteEmail} onChange={(event) => setInviteEmail(event.target.value)} placeholder={t("properties.guestEmail")} /></label><button className="primary-button" type="submit" disabled={pending || !inviteEmail.trim()}><Plus size={15} />{pending ? t("auth.working") : t("properties.inviteGuest")}</button></form>}
      {workspaceMode && activation && <section className="guest-activation-card" aria-labelledby="guest-activation-title" aria-live="polite">
        <div><span><KeyRound size={15} aria-hidden="true" /></span><div><h3 id="guest-activation-title">{t("properties.activationReady")}</h3><p>{t("properties.activationReadyHelp", { email: activation.email })}</p></div><button type="button" className="icon-button small" onClick={() => setActivation(null)} aria-label={t("properties.dismissActivation")}><X size={15} aria-hidden="true" /></button></div>
        <label className="field"><span>{t("properties.activationLink")}</span><div className="guest-activation-copy"><input readOnly value={activation.url} onFocus={(event) => event.currentTarget.select()} /><button type="button" className="secondary-button" onClick={() => void copyActivation()}><Clipboard size={14} aria-hidden="true" />{t("properties.copyActivation")}</button></div></label>
        <small>{t("properties.activationExpires", { time: new Intl.DateTimeFormat(locale, { dateStyle: "medium", timeStyle: "short" }).format(new Date(activation.expiresAt)) })}</small>
        {activation.cloudflareStatus === "pending" && <p className="inline-error" role="status">{t("properties.cloudflareAccessPending")}</p>}
        {activationCopy !== "idle" && <p className={activationCopy === "failed" ? "inline-error" : "property-feedback success"} role={activationCopy === "failed" ? "alert" : "status"}>{activationCopy === "copied" ? <><Check size={14} aria-hidden="true" />{t("properties.activationCopied")}</> : t("properties.activationCopyFailed")}</p>}
      </section>}
      {guests.length === 0 ? <p className="property-empty-copy">{t("properties.noGuests")}</p> : <div className="guest-list">{guests.map((guest) => <button key={guest.email} type="button" disabled={pending} aria-pressed={selectedEmail === guest.email} className={selectedEmail === guest.email ? "active" : ""} onClick={() => setSelectedEmail(guest.email)}><KeyRound size={15} aria-hidden="true" /><span><strong>{guest.email}</strong><small>{guest.joinedAt ? t("properties.activeGuest") : t("properties.invitedGuest")}</small></span></button>)}</div>}
    </section>
    <section className="panel guest-access-panel">
      <div className="panel-header"><div><span className="eyebrow">{selected?.email ?? t("properties.selectGuest")}</span><h2>{t("properties.visibleResources")}</h2></div><ShieldCheck size={20} /></div>
      {!selected ? <p className="property-empty-copy">{t("properties.selectGuestHelp")}</p> : <>
        <p className="property-help">{t("properties.accessHelp")}</p>
        <p className="property-help">{t("properties.accessGrantCount", { count: draftGrants.length, max: MAX_GUEST_ACCESS_GRANTS })}</p>
        {draftGrants.length >= MAX_GUEST_ACCESS_GRANTS && <p className="property-help">{t("properties.accessGrantLimit", { max: MAX_GUEST_ACCESS_GRANTS })}</p>}
        <div className="grant-tree">{grantResources.map(({ property, houses, areas }) => {
          const propertyGranted = checked("property", property.id);
          return <fieldset key={property.id}><legend><label><input type="checkbox" checked={propertyGranted} onChange={() => toggle({ scopeType: "property", scopeId: property.id })} /><Building2 size={14} />{property.name}</label></legend>
            <div>{houses.map((house) => { const directlyGranted = checked("house", house.id); return <label key={house.id}><input type="checkbox" checked={propertyGranted || directlyGranted} disabled={propertyGranted || (!directlyGranted && draftGrants.length >= MAX_GUEST_ACCESS_GRANTS)} onChange={() => toggle({ scopeType: "house", scopeId: house.id })} /><Building2 size={13} />{house.name}</label>; })}</div>
            <div>{areas.map((area) => { const directlyGranted = checked("area", area.id); return <label key={area.id}><input type="checkbox" checked={propertyGranted || directlyGranted} disabled={propertyGranted || (!directlyGranted && draftGrants.length >= MAX_GUEST_ACCESS_GRANTS)} onChange={() => toggle({ scopeType: "area", scopeId: area.id })} /><MapPin size={13} />{area.name}</label>; })}</div>
          </fieldset>;
        })}</div>
        <div className="access-actions"><button type="button" className="primary-button access-save" disabled={pending || draftGrants.length > MAX_GUEST_ACCESS_GRANTS} onClick={() => void save()}><Save size={15} />{pending ? t("common.saving") : t("properties.saveAccess")}</button>{workspaceMode && canRemoveGuests && removeConfirmationEmail !== selected.email && <button type="button" className="secondary-button danger-text" disabled={pending} onClick={() => setRemoveConfirmationEmail(selected.email)}><Trash2 size={15} />{t("properties.removeGuest")}</button>}</div>
        {workspaceMode && canRemoveGuests && removeConfirmationEmail === selected.email && <div className="guest-remove-confirmation" role="alert">
          <p>{t("properties.removeGuestConfirm", { email: selected.email })}</p>
          <div><button type="button" className="secondary-button" disabled={pending} onClick={() => setRemoveConfirmationEmail("")}>{t("common.cancel")}</button><button type="button" className="secondary-button danger-text" disabled={pending} onClick={() => void removeGuest()}><Trash2 size={15} />{t("properties.confirmRemoveGuest")}</button></div>
        </div>}
      </>}
      {feedback && <p className={`property-feedback ${feedback.kind}`} role={feedback.kind === "error" ? "alert" : "status"}>{feedback.text}</p>}
    </section>
  </div>;
}

export function PropertyManagementPage(props: Readonly<PropertyManagementPageProps>) {
  const { state } = props;
  const { t } = useI18n();
  const now = useNow();
  const propertySummary = (homeCount: number, areaCount: number) => `${t(homeCount === 1 ? "properties.homeCountOne" : "properties.homeCountMany", { count: homeCount })} · ${t(areaCount === 1 ? "properties.areaCountOne" : "properties.areaCountMany", { count: areaCount })}`;
  const workspaceReadOnly = state.session.readOnly;
  const canManageAccess = !workspaceReadOnly && (state.session.tenant.role === "owner" || state.session.tenant.role === "admin");
  const [tab, setTab] = useState<WorkspaceTab>(() => props.initialTab ?? "map");
  const properties = state.properties;
  const initialPropertyAvailable = Boolean(props.initialPropertyId
    && properties.some((candidate) => candidate.id === props.initialPropertyId));
  const appliedInitialPropertyIdRef = useRef<string | null>(initialPropertyAvailable ? props.initialPropertyId ?? null : null);
  const lastInitialPropertyIdRef = useRef(props.initialPropertyId);
  const [internalPropertyId, setInternalPropertyId] = useState(() => initialPropertyAvailable
    ? props.initialPropertyId ?? ""
    : properties[0]?.id ?? "");
  const controlledPropertyAvailable = Boolean(props.propertyId
    && properties.some((candidate) => candidate.id === props.propertyId));
  const propertyId = controlledPropertyAvailable ? props.propertyId! : internalPropertyId;
  const setPropertyId = useCallback((nextPropertyId: string) => {
    setInternalPropertyId(nextPropertyId);
    props.onProperty?.(nextPropertyId);
  }, [props.onProperty]);
  const property = useMemo(() => properties.find((item) => item.id === propertyId) ?? properties[0], [properties, propertyId]);
  const readOnly = workspaceReadOnly || Boolean(
    property?.stuguby
    && !property.stuguby.isAuthority
    && property.stuguby.syncState !== "detached"
    && property.stuguby.editPolicy === "read-only",
  );
  const houses = useMemo(() => state.houses.filter((house) => house.propertyId === property?.id), [property?.id, state.houses]);
  const houseReadOnly = useCallback((house: ClimateState["houses"][number]) => (
    readOnly
    || Boolean(house.stuguby
      && house.stuguby.ownership === "shared"
      && house.stuguby.syncState !== "detached"
      && house.stuguby.editPolicy === "read-only")
  ), [readOnly]);
  const [mapLoaded, setMapLoaded] = useState(false);
  const areas = useMemo(() => state.propertyAreas.filter((area) => area.propertyId === property?.id), [property?.id, state.propertyAreas]);
  const fixedAssets = useMemo(() => areas.filter((area) => area.location || area.polygon.length === 0 || fixedAssetKinds.has(area.kind)), [areas]);
  const equipment = useMemo(() => state.areaEquipment.filter((item) => item.propertyId === property?.id), [property?.id, state.areaEquipment]);
  const propertyTrafficLights = useMemo(() => derivePropertyTrafficLights(state, property?.id ?? "", now), [now, property?.id, state]);
  const notes = useMemo(() => state.propertyNotes.filter((note) => note.propertyId === property?.id), [property?.id, state.propertyNotes]);
  const [selectedAreaId, setSelectedAreaId] = useState<string | null>(null);
  const selectedArea = areas.find((area) => area.id === selectedAreaId);
  const selectedAreaEquipmentIds = useMemo(() => new Set(selectedArea
    ? equipment.filter((item) => item.areaId === selectedArea.id).map((item) => item.id)
    : []), [equipment, selectedArea]);
  const selectedAreaTasks = useMemo(() => selectedArea
    ? state.maintenanceTasks.filter((task) => task.propertyId === property?.id
      && (task.areaId === selectedArea.id || Boolean(task.equipmentId && selectedAreaEquipmentIds.has(task.equipmentId))))
      .sort((left, right) => (left.dueBy ?? left.plannedFor ?? left.createdAt).localeCompare(right.dueBy ?? right.plannedFor ?? right.createdAt))
    : [], [property?.id, selectedArea, selectedAreaEquipmentIds, state.maintenanceTasks]);
  const [isNewArea, setIsNewArea] = useState(false);
  const [isNewFixedAsset, setIsNewFixedAsset] = useState(false);
  const [drawing, setDrawing] = useState(false);
  const [areaForm, setAreaForm] = useState<AreaDraft>(emptyAreaDraft);
  const [redoVertices, setRedoVertices] = useState<GeoCoordinate[]>([]);
  const [coordinateInput, setCoordinateInput] = useState("");
  const [coordinateError, setCoordinateError] = useState(false);
  const [newPropertyName, setNewPropertyName] = useState("");
  const [newHouseName, setNewHouseName] = useState("");
  const [areaDestinationPropertyId, setAreaDestinationPropertyId] = useState("");
  const [equipmentDestination, setEquipmentDestination] = useState<EquipmentPlacement>("unassigned");
  const [editingProperty, setEditingProperty] = useState(false);
  const propertyEditButtonRef = useRef<HTMLButtonElement>(null);
  const propertyNameInputRef = useRef<HTMLInputElement>(null);
  const [propertyName, setPropertyName] = useState("");
  const [propertyDescription, setPropertyDescription] = useState("");
  const [pending, setPending] = useState(false);
  const [feedback, setFeedback] = useState<Feedback>(null);
  const [editingEquipmentId, setEditingEquipmentId] = useState<string | null>(null);
  const [equipmentName, setEquipmentName] = useState("");
  const [equipmentKind, setEquipmentKind] = useState("");
  const [equipmentManufacturer, setEquipmentManufacturer] = useState("");
  const [equipmentModel, setEquipmentModel] = useState("");
  const [equipmentSerialNumber, setEquipmentSerialNumber] = useState("");
  const [equipmentStatus, setEquipmentStatus] = useState<AreaEquipmentStatus>("active");
  const [equipmentNotes, setEquipmentNotes] = useState("");
  const [equipmentLatitude, setEquipmentLatitude] = useState("");
  const [equipmentLongitude, setEquipmentLongitude] = useState("");
  const [equipmentPinMapOpen, setEquipmentPinMapOpen] = useState(false);
  const [inventoryQuery, setInventoryQuery] = useState("");
  const [inventoryStatus, setInventoryStatus] = useState<"all" | AreaEquipmentStatus>("all");
  const [inventoryLocation, setInventoryLocation] = useState<InventoryLocationFilter>("all");
  const [structureQuery, setStructureQuery] = useState("");
  const [mapItemQuery, setMapItemQuery] = useState("");
  const [mapItemFilter, setMapItemFilter] = useState<MapItemFilter>("all");
  const [mapItemLimit, setMapItemLimit] = useState(MAP_ITEM_BATCH_SIZE);
  const [mapItemSelection, setMapItemSelection] = useState<MapItemSelection>(() => (
    houses[0] ? { kind: "home", id: houses[0].id } : null
  ));
  const [mapLayers, setMapLayers] = useState<MapLayerVisibility>({
    home: true,
    asset: true,
    equipment: true,
    person: true,
  });
  const [inventoryFormOpen, setInventoryFormOpen] = useState(false);
  const [trackedEquipment, setTrackedEquipment] = useState<TrackedEquipmentState[]>([]);
  const [trackingCapabilities, setTrackingCapabilities] = useState<TrackingCapabilities | null>(null);
  const [trackingSnapshot, setTrackingSnapshot] = useState<TrackingMapSnapshot | null>(null);
  const [trackingTags, setTrackingTags] = useState<TrackingTag[]>([]);
  const [trackingConnection, setTrackingConnection] = useState<"off" | "live" | "reconnecting">("off");
  const [selectedEquipmentId, setSelectedEquipmentId] = useState<string | null>(null);
  const [equipmentAttachments, setEquipmentAttachments] = useState<EquipmentAttachment[]>([]);
  const [equipmentLinks, setEquipmentLinks] = useState<EquipmentLink[]>([]);
  const [equipmentResourcesState, setEquipmentResourcesState] = useState<"idle" | "loading" | "ready" | "error">("idle");
  const [equipmentResourcesBusy, setEquipmentResourcesBusy] = useState(false);
  const [equipmentResourcesRefresh, setEquipmentResourcesRefresh] = useState(0);
  const [equipmentResourcesFeedback, setEquipmentResourcesFeedback] = useState<Feedback>(null);
  const [equipmentLinkLabel, setEquipmentLinkLabel] = useState("");
  const [equipmentLinkUrl, setEquipmentLinkUrl] = useState("");
  const equipmentPhotoInputRef = useRef<HTMLInputElement>(null);
  const equipmentDocumentInputRef = useRef<HTMLInputElement>(null);
  const [newTagSerial, setNewTagSerial] = useState("");
  const [newTagModel, setNewTagModel] = useState("");
  const [selectedTagId, setSelectedTagId] = useState("");
  const [provisionedTag, setProvisionedTag] = useState<TrackingTagProvisioningResult | null>(null);
  const [noteText, setNoteText] = useState("");
  const [noteKind, setNoteKind] = useState<PropertyNote["kind"]>("note");
  const [noteTarget, setNoteTarget] = useState("property:");
  const [editingNoteId, setEditingNoteId] = useState<string | null>(null);
  const [maintenanceTitle, setMaintenanceTitle] = useState("");
  const [maintenanceHouseId, setMaintenanceHouseId] = useState("");
  const [maintenanceEquipmentId, setMaintenanceEquipmentId] = useState("");
  const [placementHouseId, setPlacementHouseId] = useState("");
  const [placementLatitude, setPlacementLatitude] = useState("");
  const [placementLongitude, setPlacementLongitude] = useState("");
  const [placementWidth, setPlacementWidth] = useState("12");
  const [placementOrientation, setPlacementOrientation] = useState("");
  const [placementEditing, setPlacementEditing] = useState(false);
  const [placementAssetId, setPlacementAssetId] = useState("");
  const [assetPlacementEditing, setAssetPlacementEditing] = useState(false);
  const [assetDraftLocation, setAssetDraftLocation] = useState<GeoCoordinate | null>(null);
  const [assetLatitudeInput, setAssetLatitudeInput] = useState("");
  const [assetLongitudeInput, setAssetLongitudeInput] = useState("");

  const trackingStates = trackingSnapshot && property && trackingSnapshot.propertyId === property.id
    ? trackingSnapshot.assets
    : trackedEquipment;
  const trackingByEquipmentId = useMemo(
    () => new Map(trackingStates.map((item) => [item.equipment.id, item])),
    [trackingStates],
  );
  const trackingEnabled = trackingCapabilities?.flags["tracking.enabled"] === true;
  const liveMapEnabled = trackingEnabled
    && trackingCapabilities?.flags["tracking.liveMap.enabled"] === true;
  const selectedEquipment = equipment.find((item) => item.id === selectedEquipmentId) ?? null;
  const selectedEquipmentResourceId = selectedEquipment?.id ?? null;
  const selectedTracking = selectedEquipment ? trackingByEquipmentId.get(selectedEquipment.id) ?? null : null;
  const sharedMembers = useMemo(() => (
    trackingCapabilities?.flags["tracking.userLocationSharing.enabled"]
      ? trackingSnapshot?.members.filter((member) => (
        Number.isFinite(member.coordinate.latitude)
        && member.coordinate.latitude >= -90
        && member.coordinate.latitude <= 90
        && Number.isFinite(member.coordinate.longitude)
        && member.coordinate.longitude >= -180
        && member.coordinate.longitude <= 180
        && Number.isFinite(member.horizontalAccuracyMeters)
        && member.horizontalAccuracyMeters > 0
        && Date.parse(member.sharingUntil) > now
      )) ?? []
      : []
  ), [now, trackingCapabilities, trackingSnapshot?.members]);
  const assignedTagIds = useMemo(
    () => new Set(trackingStates.flatMap((item) => item.assignment ? [item.assignment.tagId] : [])),
    [trackingStates],
  );
  const availableTrackingTags = trackingTags.filter((tag) => (
    tag.status === "active" && !assignedTagIds.has(tag.id)
  ));
  const equipmentLatitudeValue = Number(equipmentLatitude);
  const equipmentLongitudeValue = Number(equipmentLongitude);
  const equipmentPinEmpty = !equipmentLatitude.trim() && !equipmentLongitude.trim();
  const equipmentPinValid = equipmentPinEmpty || (
    equipmentLatitude.trim() !== ""
    && equipmentLongitude.trim() !== ""
    && Number.isFinite(equipmentLatitudeValue)
    && equipmentLatitudeValue >= -90
    && equipmentLatitudeValue <= 90
    && Number.isFinite(equipmentLongitudeValue)
    && equipmentLongitudeValue >= -180
    && equipmentLongitudeValue <= 180
  );
  const equipmentDraftMapLocation = !equipmentPinEmpty && equipmentPinValid
    ? { latitude: equipmentLatitudeValue, longitude: equipmentLongitudeValue }
    : null;
  const equipmentPinMapItem = useMemo<AreaEquipment | null>(() => {
    if (!property) return null;
    const placement = placementInput(equipmentDestination);
    return {
      id: EQUIPMENT_DRAFT_MAP_ID,
      propertyId: property.id,
      areaId: placement.areaId ?? null,
      houseId: placement.houseId ?? null,
      ...(equipmentDraftMapLocation ? { location: equipmentDraftMapLocation } : {}),
      name: equipmentName.trim() || t("properties.inventoryManualPin"),
      kind: equipmentKind.trim() || "equipment",
      manufacturer: equipmentManufacturer.trim() || null,
      model: equipmentModel.trim() || null,
      serialNumber: equipmentSerialNumber.trim() || null,
      status: equipmentStatus,
      notes: equipmentNotes.trim() || null,
      createdAt: "",
      updatedAt: "",
    };
  }, [
    equipmentDestination,
    equipmentDraftMapLocation,
    equipmentKind,
    equipmentManufacturer,
    equipmentModel,
    equipmentName,
    equipmentNotes,
    equipmentSerialNumber,
    equipmentStatus,
    property,
    t,
  ]);
  const updateEquipmentPinFromMap = useCallback((_id: string, point: GeoCoordinate) => {
    setEquipmentLatitude(mapCoordinateInput(point.latitude));
    setEquipmentLongitude(mapCoordinateInput(point.longitude));
  }, []);
  const equipmentLocationLabel = useCallback((item: AreaEquipment): string => {
    if (item.areaId) return areas.find((area) => area.id === item.areaId)?.name ?? t("properties.inventoryUnknownArea");
    if (item.houseId) return houses.find((house) => house.id === item.houseId)?.name ?? t("properties.inventoryUnknownHome");
    if (item.location) return t("properties.inventoryPinnedLocation");
    return t("properties.inventoryUnassigned");
  }, [areas, houses, t]);
  const normalizedStructureQuery = structureQuery.trim().toLocaleLowerCase();
  const sidebarHouses = useMemo(() => houses.filter((house) => !normalizedStructureQuery || [
    house.name,
    house.location?.label,
    house.timezone,
  ].some((value) => value?.toLocaleLowerCase().includes(normalizedStructureQuery))), [houses, normalizedStructureQuery]);
  const sidebarAreas = useMemo(() => areas.filter((area) => !normalizedStructureQuery || [
    area.name,
    area.description,
    t(`properties.areaKind.${area.kind}` as TranslationKey),
  ].some((value) => value?.toLocaleLowerCase().includes(normalizedStructureQuery))), [areas, normalizedStructureQuery, t]);
  const mapCatalogItems = useMemo<MapCatalogEntry[]>(() => {
    const entries: MapCatalogEntry[] = [
      ...houses.map((house) => {
        const detail = house.mapPlacement
          ? t("placement.scaled")
          : house.location ? t("placement.pinOnly") : t("placement.unplaced");
        return {
          id: house.id,
          kind: "home" as const,
          label: house.name,
          detail,
          searchText: `${house.name} ${house.location?.label ?? ""} ${house.timezone} ${t("properties.houses")} ${detail}`,
        };
      }),
      ...fixedAssets.map((asset) => {
        const detail = asset.location ? t("properties.assetPlaced") : t("placement.unplaced");
        return {
          id: asset.id,
          kind: "asset" as const,
          label: asset.name,
          detail,
          searchText: `${asset.name} ${asset.description ?? ""} ${t(`properties.areaKind.${asset.kind}` as TranslationKey)} ${t("properties.fixedAssets")} ${detail}`,
        };
      }),
      ...equipment.map((item) => {
        const tracking = trackingByEquipmentId.get(item.id);
        const detail = tracking?.position?.freshnessState
          ? t(`properties.inventoryTracking.${tracking.position.freshnessState}` as TranslationKey)
          : equipmentLocationLabel(item);
        return {
          id: item.id,
          kind: "equipment" as const,
          label: item.name,
          detail,
          searchText: `${item.name} ${item.kind} ${item.manufacturer ?? ""} ${item.model ?? ""} ${item.serialNumber ?? ""} ${t("properties.mapEquipment")} ${detail}`,
        };
      }),
      ...sharedMembers.map((member) => {
        const detail = t("properties.mapMemberAccuracy", { meters: Math.round(member.horizontalAccuracyMeters) });
        return {
          id: member.id,
          kind: "person" as const,
          label: member.memberLabel,
          detail,
          searchText: `${member.memberLabel} ${t("properties.mapPeople")} ${detail}`,
        };
      }),
    ];
    const kindOrder: Record<MapItemKind, number> = { home: 0, asset: 1, equipment: 2, person: 3 };
    return entries.sort((left, right) => kindOrder[left.kind] - kindOrder[right.kind] || left.label.localeCompare(right.label));
  }, [equipment, equipmentLocationLabel, fixedAssets, houses, sharedMembers, t, trackingByEquipmentId]);
  const normalizedMapItemQuery = mapItemQuery.trim().toLocaleLowerCase();
  const matchingMapCatalogItems = useMemo(() => mapCatalogItems.filter((item) => (
    (mapItemFilter === "all" || item.kind === mapItemFilter)
    && (!normalizedMapItemQuery || item.searchText.toLocaleLowerCase().includes(normalizedMapItemQuery))
  )), [mapCatalogItems, mapItemFilter, normalizedMapItemQuery]);
  const visibleMapCatalogItems = matchingMapCatalogItems.slice(0, mapItemLimit);
  const remainingMapCatalogItems = Math.max(0, matchingMapCatalogItems.length - visibleMapCatalogItems.length);
  const inventoryLocationCount = useMemo(() => new Set(equipment.flatMap((item) => {
    if (item.areaId) return [`area:${item.areaId}`];
    if (item.houseId) return [`house:${item.houseId}`];
    if (item.location) return [`pin:${item.location.latitude}:${item.location.longitude}`];
    return [];
  })).size, [equipment]);
  const inventoryEquipmentVersion = useMemo(
    () => equipment.map((item) => `${item.id}:${item.updatedAt}`).sort().join("|"),
    [equipment],
  );
  const visibleInventory = useMemo(() => {
    const query = inventoryQuery.trim().toLocaleLowerCase();
    return equipment.filter((item) => {
      if (inventoryStatus !== "all" && item.status !== inventoryStatus) return false;
      if (inventoryLocation !== "all" && inventoryPlacement(item) !== inventoryLocation) return false;
      if (!query) return true;
      const areaName = areas.find((area) => area.id === item.areaId)?.name ?? "";
      const houseName = houses.find((house) => house.id === item.houseId)?.name ?? "";
      return [
        item.name,
        item.kind,
        item.manufacturer,
        item.model,
        item.serialNumber,
        item.notes,
        areaName,
        houseName,
      ].some((value) => value?.toLocaleLowerCase().includes(query));
    }).sort((left, right) => left.name.localeCompare(right.name));
  }, [areas, equipment, houses, inventoryLocation, inventoryQuery, inventoryStatus]);
  const inventoryAttentionCount = useMemo(() => equipment.filter((item) => {
    if (item.status === "out-of-service") return true;
    const tracked = trackingByEquipmentId.get(item.id);
    return Boolean(
      tracked
      && ((tracked.tag?.batteryPercent ?? 101) <= 20
        || ["stale", "unknown"].includes(tracked.position?.freshnessState ?? "unknown")),
    );
  }).length, [equipment, trackingByEquipmentId]);

  const placementAsset = areas.find((area) => area.id === placementAssetId);
  const editingFixedAsset = isNewFixedAsset || Boolean(selectedArea && selectedArea.polygon.length === 0);
  const assetLatitude = Number(assetLatitudeInput);
  const assetLongitude = Number(assetLongitudeInput);
  const assetCoordinateInputsValid = assetLatitudeInput.trim() !== "" && assetLongitudeInput.trim() !== ""
    && Number.isFinite(assetLatitude) && assetLatitude >= -90 && assetLatitude <= 90
    && Number.isFinite(assetLongitude) && assetLongitude >= -180 && assetLongitude <= 180;
  const updateFixedAssetCoordinate = (axis: "latitude" | "longitude", value: string) => {
    const latitudeText = axis === "latitude" ? value : assetLatitudeInput;
    const longitudeText = axis === "longitude" ? value : assetLongitudeInput;
    if (axis === "latitude") setAssetLatitudeInput(value);
    else setAssetLongitudeInput(value);
    const latitude = Number(latitudeText);
    const longitude = Number(longitudeText);
    if (!latitudeText.trim() || !longitudeText.trim() || !Number.isFinite(latitude) || latitude < -90 || latitude > 90 || !Number.isFinite(longitude) || longitude < -180 || longitude > 180) return;
    const location = { latitude, longitude };
    setAreaForm((current) => ({ ...current, location }));
    setAssetDraftLocation(location);
    setAssetPlacementEditing(true);
  };
  const mapAreas = useMemo(() => {
    const positioned = areas.map((area) => area.id === placementAsset?.id && assetPlacementEditing
      ? { ...area, ...(assetDraftLocation ? { location: assetDraftLocation } : {}) }
      : area);
    if (!isNewArea || !isNewFixedAsset || !property) return positioned;
    const draft: PropertyArea = {
      id: NEW_FIXED_ASSET_ID,
      propertyId: property.id,
      name: areaForm.name.trim() || t("properties.newFixedAsset"),
      kind: areaForm.kind,
      description: areaForm.description.trim() || null,
      ...(areaForm.location ? { location: areaForm.location } : {}),
      polygon: [],
      createdAt: "",
      updatedAt: "",
    };
    return [...positioned, draft];
  }, [areaForm, areas, assetDraftLocation, assetPlacementEditing, isNewArea, isNewFixedAsset, placementAsset?.id, property, t]);

  useEffect(() => {
    if (!selectedEquipmentResourceId) {
      setEquipmentAttachments([]);
      setEquipmentLinks([]);
      setEquipmentResourcesState("idle");
      setEquipmentResourcesFeedback(null);
      setEquipmentLinkLabel("");
      setEquipmentLinkUrl("");
      return;
    }
    let active = true;
    setEquipmentResourcesState("loading");
    setEquipmentResourcesFeedback(null);
    Promise.all([
      api.equipmentAttachments(selectedEquipmentResourceId),
      api.equipmentLinks(selectedEquipmentResourceId),
    ]).then(([attachments, links]) => {
      if (!active) return;
      setEquipmentAttachments(attachments);
      setEquipmentLinks(links);
      setEquipmentResourcesState("ready");
    }).catch(() => {
      if (!active) return;
      setEquipmentAttachments([]);
      setEquipmentLinks([]);
      setEquipmentResourcesState("error");
    });
    return () => { active = false; };
  }, [equipmentResourcesRefresh, selectedEquipmentResourceId]);

  useEffect(() => {
    if (!properties.some((candidate) => candidate.id === propertyId)) setPropertyId(properties[0]?.id ?? "");
  }, [properties, propertyId]);
  useEffect(() => {
    if (controlledPropertyAvailable && props.propertyId !== internalPropertyId) {
      setInternalPropertyId(props.propertyId!);
    }
  }, [controlledPropertyAvailable, internalPropertyId, props.propertyId]);
  useEffect(() => {
    const initialPropertyChanged = lastInitialPropertyIdRef.current !== props.initialPropertyId;
    lastInitialPropertyIdRef.current = props.initialPropertyId;
    if (!props.initialPropertyId
      || !properties.some((candidate) => candidate.id === props.initialPropertyId)
      || (!initialPropertyChanged && appliedInitialPropertyIdRef.current === props.initialPropertyId)) return;
    appliedInitialPropertyIdRef.current = props.initialPropertyId;
    setPropertyId(props.initialPropertyId);
  }, [props.initialPropertyId, properties]);
  useEffect(() => {
    setSelectedAreaId(null);
    setIsNewArea(false);
    setIsNewFixedAsset(false);
    setDrawing(false);
    setAreaForm(emptyAreaDraft());
    setRedoVertices([]);
    setCoordinateInput("");
    setCoordinateError(false);
    setEditingProperty(false);
    setEditingEquipmentId(null);
    setEquipmentName("");
    setEquipmentKind("");
    setEquipmentManufacturer("");
    setEquipmentModel("");
    setEquipmentSerialNumber("");
    setEquipmentStatus("active");
    setEquipmentNotes("");
    setEquipmentDestination("unassigned");
    setEquipmentLatitude("");
    setEquipmentLongitude("");
    setEquipmentPinMapOpen(false);
    setInventoryQuery("");
    setInventoryStatus("all");
    setInventoryLocation("all");
    setStructureQuery("");
    setMapItemQuery("");
    setMapItemFilter("all");
    setMapItemLimit(MAP_ITEM_BATCH_SIZE);
    setMapItemSelection(houses[0] ? { kind: "home", id: houses[0].id } : null);
    setMapLayers({ home: true, asset: true, equipment: true, person: true });
    setInventoryFormOpen(false);
    setTrackedEquipment([]);
    setTrackingCapabilities(null);
    setTrackingSnapshot(null);
    setTrackingTags([]);
    setTrackingConnection("off");
    setSelectedEquipmentId(null);
    setNewTagSerial("");
    setNewTagModel("");
    setSelectedTagId("");
    setProvisionedTag(null);
    setEditingNoteId(null);
    setNoteText("");
    setNoteKind("note");
    setNoteTarget("property:");
    setFeedback(null);
    setPropertyName(property?.name ?? "");
    setPropertyDescription(property?.description ?? "");
    setMaintenanceTitle("");
    setMaintenanceHouseId("");
    setMaintenanceEquipmentId("");
    setPlacementEditing(false);
    setPlacementAssetId("");
    setAssetPlacementEditing(false);
    setAssetDraftLocation(null);
    setAssetLatitudeInput("");
    setAssetLongitudeInput("");
    setNewHouseName("");
    setAreaDestinationPropertyId(property?.id ?? "");
  }, [property?.id]);
  useEffect(() => {
    setMaintenanceHouseId((current) => houses.some((house) => house.id === current) ? current : "");
    setPlacementHouseId((current) => {
      const next = houses.some((house) => house.id === current) ? current : houses[0]?.id ?? "";
      if (next !== current) setPlacementEditing(false);
      return next;
    });
    setMapItemSelection((current) => current?.kind === "home" && !houses.some((house) => house.id === current.id)
      ? houses[0] ? { kind: "home", id: houses[0].id } : null
      : current);
  }, [houses]);
  useEffect(() => {
    setSelectedTagId("");
    setProvisionedTag(null);
  }, [selectedEquipmentId]);
  const placementHouse = houses.find((house) => house.id === placementHouseId) ?? houses[0];
  useEffect(() => {
    if (!placementHouse || placementEditing) return;
    const source = placementHouse.mapPlacement ?? placementHouse.location;
    const floor = placementHouse.floors.find((candidate) => candidate.id === placementHouse.mapPlacement?.footprintFloorId)
      ?? placementHouse.floors.find((candidate) => candidate.type === "ground")
      ?? placementHouse.floors[0];
    setPlacementLatitude(source ? String(source.latitude) : "");
    setPlacementLongitude(source ? String(source.longitude) : "");
    const horizontalScale = floor ? floorMetersPerPlanUnit(floor, placementHouse) : null;
    setPlacementWidth(horizontalScale !== null && floor
      ? String(Number((horizontalScale * Math.max(1, floor.width)).toFixed(2)))
      : "12");
    setPlacementOrientation(placementHouse.orientationDegrees === undefined ? "" : String(placementHouse.orientationDegrees));
  }, [placementEditing, placementHouse?.id, placementHouse?.floors, placementHouse?.mapPlacement, placementHouse?.location, placementHouse?.orientationDegrees]);
  const mapHouses = useMemo(() => {
    if (!placementEditing || !placementHouse) return houses;
    const latitude = Number(placementLatitude);
    const longitude = Number(placementLongitude);
    const width = Number(placementWidth);
    const floor = placementHouse.floors.find((candidate) => candidate.type === "ground") ?? placementHouse.floors[0];
    if (!floor || !Number.isFinite(latitude) || latitude < -90 || latitude > 90
      || !Number.isFinite(longitude) || longitude < -180 || longitude > 180
      || !Number.isFinite(width) || width < 1 || width > 500) return houses;
    return houses.map((candidate) => candidate.id === placementHouse.id ? {
      ...candidate,
      mapPlacement: {
        latitude,
        longitude,
        metersPerPlanUnit: width / Math.max(1, floor.width),
        footprintFloorId: floor.id,
      },
    } : candidate);
  }, [houses, placementEditing, placementHouse, placementLatitude, placementLongitude, placementWidth]);
  const visibleMapHouses = useMemo(() => mapLayers.home
    ? mapHouses
    : mapHouses.filter((house) => mapItemSelection?.kind === "home" && house.id === mapItemSelection.id), [mapHouses, mapItemSelection, mapLayers.home]);
  const visibleAssetIds = useMemo<ReadonlySet<string> | null>(() => {
    if (mapLayers.asset) return null;
    return new Set(mapItemSelection?.kind === "asset" ? [mapItemSelection.id] : []);
  }, [mapItemSelection, mapLayers.asset]);
  const visibleMapEquipment = useMemo(() => mapLayers.equipment
    ? equipment
    : equipment.filter((item) => mapItemSelection?.kind === "equipment" && item.id === mapItemSelection.id), [equipment, mapItemSelection, mapLayers.equipment]);
  const visibleMapMembers = mapLayers.person ? sharedMembers : [];
  const placementDraftIsValid = useMemo(() => {
    if (!placementHouse) return false;
    const latitude = Number(placementLatitude);
    const longitude = Number(placementLongitude);
    const width = Number(placementWidth);
    const orientation = placementOrientation.trim() ? Number(placementOrientation) : null;
    const floor = placementHouse.floors.find((candidate) => candidate.type === "ground") ?? placementHouse.floors[0];
    return Boolean(floor)
      && Number.isFinite(latitude) && latitude >= -90 && latitude <= 90
      && Number.isFinite(longitude) && longitude >= -180 && longitude <= 180
      && Number.isFinite(width) && width > 0 && width <= 500
      && (orientation === null || (Number.isFinite(orientation) && orientation >= 0 && orientation < 360));
  }, [placementHouse, placementLatitude, placementLongitude, placementOrientation, placementWidth]);
  useEffect(() => {
    if (!canManageAccess && tab === "access") setTab("overview");
  }, [canManageAccess, tab]);
  useEffect(() => {
    if (!property) return;
    let current = true;
    void api.trackingCapabilities()
      .then((capabilities) => {
        if (!current) return;
        setTrackingCapabilities(capabilities);
        if (!capabilities.flags["tracking.enabled"]) {
          setTrackingConnection("off");
          setTrackingSnapshot(null);
          setTrackingTags([]);
        }
      })
      .catch(() => {
        if (current) {
          setTrackingCapabilities(null);
          setTrackingConnection("off");
        }
      });
    return () => { current = false; };
  }, [property?.id]);
  useEffect(() => {
    if (tab !== "inventory" || !property) return;
    let current = true;
    let pollingEnabled = true;
    let requestInFlight = false;
    const refresh = () => {
      if (!pollingEnabled || requestInFlight) return;
      requestInFlight = true;
      void api.trackedAssets(property.id)
        .then((assets) => {
          if (current) setTrackedEquipment(assets);
        })
        .catch((error: unknown) => {
          if (error instanceof ApiRequestError && (error.status === 403 || error.status === 404)) {
            pollingEnabled = false;
            if (current) setTrackedEquipment([]);
            return;
          }
          // Keep the last confirmed snapshot during a transient refresh failure.
        })
        .finally(() => {
          requestInFlight = false;
        });
    };
    refresh();
    const timer = window.setInterval(refresh, TRACKED_ASSETS_REFRESH_MS);
    return () => {
      current = false;
      pollingEnabled = false;
      window.clearInterval(timer);
    };
  }, [inventoryEquipmentVersion, property?.id, tab]);
  useEffect(() => {
    if (tab !== "inventory" || !property || !trackingEnabled || !canManageAccess) {
      setTrackingTags([]);
      return;
    }
    let current = true;
    void api.trackingTags(property.id)
      .then((tags) => { if (current) setTrackingTags(tags); })
      .catch(() => { if (current) setTrackingTags([]); });
    return () => { current = false; };
  }, [canManageAccess, property?.id, tab, trackingEnabled]);
  useEffect(() => {
    if (tab !== "map" || !mapLoaded || !property || !trackingEnabled) {
      if (!trackingEnabled) {
        setTrackingConnection("off");
        setTrackingSnapshot(null);
      }
      return;
    }
    let current = true;
    let inFlight = false;
    let refreshTimer: number | null = null;
    const refresh = () => {
      if (!current || inFlight) return;
      inFlight = true;
      void api.trackingMapSnapshot(property.id)
        .then((snapshot) => {
          if (!current) return;
          setTrackingSnapshot(snapshot);
          setTrackedEquipment(snapshot.assets.filter((item) => item.assignment));
          if (!liveMapEnabled) setTrackingConnection("off");
        })
        .catch((error: unknown) => {
          if (!current) return;
          if (error instanceof ApiRequestError && (error.status === 403 || error.status === 404)) {
            setTrackingConnection("off");
            setTrackingSnapshot(null);
          } else {
            setTrackingConnection("reconnecting");
          }
        })
        .finally(() => { inFlight = false; });
    };
    const scheduleRefresh = () => {
      if (refreshTimer !== null) window.clearTimeout(refreshTimer);
      refreshTimer = window.setTimeout(refresh, 250);
    };
    refresh();
    setTrackingConnection(liveMapEnabled ? "reconnecting" : "off");
    const dispose = liveMapEnabled && typeof EventSource !== "undefined"
      ? subscribeToTrackingEvents(property.id, scheduleRefresh, setTrackingConnection)
      : () => undefined;
    const poll = window.setInterval(refresh, TRACKED_ASSETS_REFRESH_MS);
    return () => {
      current = false;
      dispose();
      window.clearInterval(poll);
      if (refreshTimer !== null) window.clearTimeout(refreshTimer);
    };
  }, [liveMapEnabled, mapLoaded, property?.id, tab, trackingEnabled]);
  useEffect(() => {
    setEditingEquipmentId(null);
    setEquipmentName("");
    setEquipmentKind("");
    setEquipmentManufacturer("");
    setEquipmentModel("");
    setEquipmentSerialNumber("");
    setEquipmentStatus("active");
    setEquipmentNotes("");
    setEquipmentDestination(selectedArea ? `area:${selectedArea.id}` : "unassigned");
    setEquipmentLatitude("");
    setEquipmentLongitude("");
    setMaintenanceTitle("");
    setMaintenanceEquipmentId("");
    if (!selectedArea) return;
    if (assetPlacementEditing && selectedArea.id === placementAssetId) return;
    const draft = areaDraft(selectedArea);
    setAreaForm(draft);
    setRedoVertices([]);
    setCoordinateInput(coordinateText(draft.polygon));
    setCoordinateError(false);
    setIsNewArea(false);
    setIsNewFixedAsset(false);
    setAreaDestinationPropertyId(selectedArea.propertyId);
    setDrawing(false);
    setPlacementAssetId(selectedArea.id);
    setAssetDraftLocation(selectedArea.location ? { ...selectedArea.location } : null);
    setAssetLatitudeInput(selectedArea.location ? String(selectedArea.location.latitude) : "");
    setAssetLongitudeInput(selectedArea.location ? String(selectedArea.location.longitude) : "");
    setAssetPlacementEditing(false);
  }, [assetPlacementEditing, placementAssetId, selectedArea?.id, selectedArea?.updatedAt]);

  const tabs: Array<{ id: WorkspaceTab; key: TranslationKey; icon: typeof MapIcon }> = [
    { id: "overview", key: "nav.overview", icon: Building2 },
    { id: "map", key: "properties.map", icon: MapIcon },
    { id: "inventory", key: "properties.inventory", icon: Boxes },
    { id: "notes", key: "properties.notes", icon: NotebookPen },
    ...(canManageAccess ? [{ id: "access" as const, key: "properties.access" as TranslationKey, icon: Users }] : []),
  ];
  const chooseTabFromKeyboard = (event: ReactKeyboardEvent<HTMLButtonElement>, index: number) => {
    let nextIndex = index;
    if (event.key === "ArrowRight" || event.key === "ArrowDown") nextIndex = (index + 1) % tabs.length;
    else if (event.key === "ArrowLeft" || event.key === "ArrowUp") nextIndex = (index - 1 + tabs.length) % tabs.length;
    else if (event.key === "Home") nextIndex = 0;
    else if (event.key === "End") nextIndex = tabs.length - 1;
    else return;
    event.preventDefault();
    setTab(tabs[nextIndex]!.id);
    const buttons = event.currentTarget.parentElement?.querySelectorAll<HTMLButtonElement>("[role='tab']");
    buttons?.[nextIndex]?.focus();
  };
  const vertexLabel = useCallback((index: number, canFinish: boolean) => canFinish
    ? t("properties.finishBoundaryPoint")
    : t("properties.moveBoundaryPoint", { number: index + 1 }), [t]);
  const midpointLabel = useCallback((index: number) => t("properties.addBoundaryPoint", { number: index + 1 }), [t]);

  const startArea = () => {
    setMapLoaded(true);
    setPlacementEditing(false);
    setAssetPlacementEditing(false);
    setMapItemSelection(null);
    setSelectedAreaId(null);
    setIsNewArea(true);
    setIsNewFixedAsset(false);
    setDrawing(true);
    setAreaForm(emptyAreaDraft());
    setAreaDestinationPropertyId(property?.id ?? "");
    setRedoVertices([]);
    setCoordinateInput("");
    setFeedback(null);
  };
  const startFixedAsset = () => {
    setMapLoaded(true);
    setPlacementEditing(false);
    setMapItemSelection({ kind: "asset", id: NEW_FIXED_ASSET_ID });
    setSelectedAreaId(null);
    setIsNewArea(true);
    setIsNewFixedAsset(true);
    setDrawing(false);
    setAreaForm(emptyAreaDraft());
    setPlacementAssetId(NEW_FIXED_ASSET_ID);
    setAssetDraftLocation(null);
    setAssetLatitudeInput("");
    setAssetLongitudeInput("");
    setAssetPlacementEditing(true);
    setAreaDestinationPropertyId(property?.id ?? "");
    setRedoVertices([]);
    setCoordinateInput("");
    setFeedback(null);
  };
  const appendVertex = (point: GeoCoordinate) => {
    if (readOnly || !drawing) return;
    setAreaForm((current) => {
      const next = { ...current, polygon: [...current.polygon, point] };
      setCoordinateInput(coordinateText(next.polygon));
      return next;
    });
    setRedoVertices([]);
  };
  const moveVertex = (index: number, point: GeoCoordinate) => {
    setAreaForm((current) => {
      const polygon = current.polygon.map((candidate, candidateIndex) => candidateIndex === index ? point : candidate);
      setCoordinateInput(coordinateText(polygon));
      return { ...current, polygon };
    });
    setRedoVertices([]);
  };
  const insertVertex = (index: number, point: GeoCoordinate) => {
    setAreaForm((current) => {
      const polygon = [...current.polygon.slice(0, index), point, ...current.polygon.slice(index)];
      setCoordinateInput(coordinateText(polygon));
      return { ...current, polygon };
    });
    setRedoVertices([]);
  };
  const undoVertex = () => setAreaForm((current) => {
    const removed = current.polygon.at(-1);
    if (!removed) return current;
    const polygon = current.polygon.slice(0, -1);
    setRedoVertices((redo) => [...redo, removed]);
    setCoordinateInput(coordinateText(polygon));
    return { ...current, polygon };
  });
  const redoVertex = () => setRedoVertices((redo) => {
    const restored = redo.at(-1);
    if (!restored) return redo;
    setAreaForm((current) => {
      const polygon = [...current.polygon, restored];
      setCoordinateInput(coordinateText(polygon));
      return { ...current, polygon };
    });
    return redo.slice(0, -1);
  });
  const applyCoordinates = () => {
    const parsed = parseCoordinateText(coordinateInput);
    if (!parsed) { setCoordinateError(true); return; }
    setCoordinateError(false);
    setAreaForm((current) => ({ ...current, polygon: parsed }));
    setRedoVertices([]);
  };

  useEffect(() => {
    if (!drawing || readOnly) return;
    const onKeyDown = (event: KeyboardEvent) => {
      const target = event.target as HTMLElement | null;
      if (target?.matches("input, textarea, select, [contenteditable=true]")) return;
      if (event.key === "Escape" || event.key === "Enter") { event.preventDefault(); setDrawing(false); return; }
      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "z") { event.preventDefault(); event.shiftKey ? redoVertex() : undoVertex(); }
      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "y") { event.preventDefault(); redoVertex(); }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [drawing, readOnly]);

  const saveArea = async () => {
    if (!property || readOnly || pending || !areaForm.name.trim()
      || (editingFixedAsset ? !areaForm.location || !assetCoordinateInputsValid : areaForm.polygon.length < 3)) return;
    setPending(true);
    setFeedback(null);
    try {
      const common = {
        name: areaForm.name.trim(),
        kind: areaForm.kind,
        description: areaForm.description.trim() || null,
        polygon: areaForm.polygon,
        ...(areaForm.location ? { location: areaForm.location } : {}),
      };
      const destinationPropertyId = areaDestinationPropertyId || property.id;
      if (selectedArea && destinationPropertyId !== selectedArea.propertyId
        && !window.confirm(t("properties.moveAreaConfirm", { name: selectedArea.name }))) return;
      const saved = isNewArea
        ? await props.onCreateArea({ propertyId: property.id, ...common })
        : selectedArea ? await props.onUpdateArea(selectedArea.id, { ...common, propertyId: destinationPropertyId }) : null;
      if (saved) {
        setPropertyId(saved.propertyId);
        setSelectedAreaId(saved.id);
        setIsNewArea(false);
        setIsNewFixedAsset(false);
        setDrawing(false);
        setPlacementAssetId(saved.id);
        setMapItemSelection(editingFixedAsset ? { kind: "asset", id: saved.id } : null);
        setAssetPlacementEditing(false);
        setAssetDraftLocation(saved.location ? { ...saved.location } : null);
        setFeedback({ kind: "success", text: t("properties.areaSaved") });
      }
    } catch { setFeedback({ kind: "error", text: t("properties.areaSaveFailed") }); }
    finally { setPending(false); }
  };

  const removeArea = async () => {
    if (!selectedArea || readOnly || pending || !window.confirm(t("properties.deleteAreaConfirm", { name: selectedArea.name }))) return;
    setPending(true);
    try {
      await props.onDeleteArea(selectedArea.id);
      setSelectedAreaId(null);
      setPlacementAssetId("");
      setMapItemSelection(null);
      setAssetPlacementEditing(false);
      setAreaForm(emptyAreaDraft());
      setCoordinateInput("");
      setFeedback({ kind: "success", text: t("properties.areaDeleted") });
    } catch { setFeedback({ kind: "error", text: t("properties.areaDeleteFailed") }); }
    finally { setPending(false); }
  };

  const createProperty = async (event: FormEvent) => {
    event.preventDefault();
    if (workspaceReadOnly || pending || !newPropertyName.trim()) return;
    setPending(true);
    try {
      const saved = await props.onCreateProperty({ name: newPropertyName.trim() });
      setPropertyId(saved.id);
      setNewPropertyName("");
    } catch { setFeedback({ kind: "error", text: t("properties.propertySaveFailed") }); }
    finally { setPending(false); }
  };

  const saveProperty = async (event: FormEvent) => {
    event.preventDefault();
    if (!property || readOnly || pending || !propertyName.trim()) return;
    setPending(true);
    try {
      await props.onUpdateProperty(property.id, { name: propertyName.trim(), description: propertyDescription.trim() || null });
      setEditingProperty(false);
      window.requestAnimationFrame(() => propertyEditButtonRef.current?.focus());
      setFeedback({ kind: "success", text: t("properties.propertySaved") });
    } catch { setFeedback({ kind: "error", text: t("properties.propertySaveFailed") }); }
    finally { setPending(false); }
  };

  const createHouse = async (event: FormEvent) => {
    event.preventDefault();
    if (!property || readOnly || pending || !newHouseName.trim()) return;
    setPending(true);
    setFeedback(null);
    try {
      await props.onCreateHouse({
        propertyId: property.id,
        name: newHouseName.trim(),
        timezone: Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC",
        floors: [firstHouseFloor(t("bootstrap.groundFloor"))],
      });
      setNewHouseName("");
      setFeedback({ kind: "success", text: t("properties.houseAdded") });
    } catch { setFeedback({ kind: "error", text: t("properties.houseAddFailed") }); }
    finally { setPending(false); }
  };

  const removeProperty = async () => {
    if (!property || (property.stuguby && property.stuguby.syncState !== "detached")
      || readOnly || pending || !window.confirm(t("properties.deletePropertyConfirm", { name: property.name }))) return;
    setPending(true);
    setFeedback(null);
    try {
      await props.onDeleteProperty(property.id);
      setPropertyId(properties.find((candidate) => candidate.id !== property.id)?.id ?? "");
    } catch { setFeedback({ kind: "error", text: t("properties.propertyDeleteFailed") }); }
    finally { setPending(false); }
  };

  const clearEquipmentDraft = (placement: EquipmentPlacement = "unassigned") => {
    setEditingEquipmentId(null);
    setEquipmentName("");
    setEquipmentKind("");
    setEquipmentManufacturer("");
    setEquipmentModel("");
    setEquipmentSerialNumber("");
    setEquipmentStatus("active");
    setEquipmentNotes("");
    setEquipmentDestination(placement);
    setEquipmentLatitude("");
    setEquipmentLongitude("");
    setEquipmentPinMapOpen(false);
  };

  const beginEquipmentEdit = (item: AreaEquipment) => {
    setEditingEquipmentId(item.id);
    setEquipmentName(item.name);
    setEquipmentKind(item.kind);
    setEquipmentManufacturer(item.manufacturer ?? "");
    setEquipmentModel(item.model ?? "");
    setEquipmentSerialNumber(item.serialNumber ?? "");
    setEquipmentStatus(item.status);
    setEquipmentNotes(item.notes ?? "");
    setEquipmentDestination(equipmentPlacement(item));
    setEquipmentLatitude(item.location ? String(item.location.latitude) : "");
    setEquipmentLongitude(item.location ? String(item.location.longitude) : "");
    setEquipmentPinMapOpen(false);
    setSelectedEquipmentId(item.id);
    setInventoryFormOpen(true);
    setTab("inventory");
  };

  const saveEquipment = async (event: FormEvent) => {
    event.preventDefault();
    if (!property || readOnly || pending || !equipmentName.trim() || !equipmentKind.trim() || !equipmentPinValid) return;
    if (editingEquipmentId && !equipment.some((item) => item.id === editingEquipmentId)) {
      clearEquipmentDraft();
      setFeedback({ kind: "error", text: t("properties.equipmentSaveFailed") });
      return;
    }
    setPending(true);
    setFeedback(null);
    try {
      const placement = placementInput(equipmentDestination);
      const location = equipmentPinEmpty
        ? null
        : { latitude: equipmentLatitudeValue, longitude: equipmentLongitudeValue };
      const common = {
        ...placement,
        location,
        name: equipmentName.trim(),
        kind: equipmentKind.trim(),
        manufacturer: equipmentManufacturer.trim() || null,
        model: equipmentModel.trim() || null,
        serialNumber: equipmentSerialNumber.trim() || null,
        status: equipmentStatus,
        notes: equipmentNotes.trim() || null,
      };
      if (editingEquipmentId) {
        const currentEquipment = state.areaEquipment.find((item) => item.id === editingEquipmentId);
        if (currentEquipment && equipmentPlacement(currentEquipment) !== equipmentDestination
          && !window.confirm(t("properties.moveEquipmentConfirm", { name: currentEquipment.name }))) return;
        const saved = await props.onUpdateEquipment(editingEquipmentId, common);
        setSelectedEquipmentId(editingEquipmentId);
        if (saved.propertyId !== property.id) setPropertyId(saved.propertyId);
      }
      else {
        const created = await props.onCreateEquipment({
          propertyId: property.id,
          ...placement,
          ...(location ? { location } : {}),
          name: common.name,
          kind: common.kind,
          manufacturer: common.manufacturer,
          model: common.model,
          serialNumber: common.serialNumber,
          status: common.status,
          notes: common.notes,
        });
        setSelectedEquipmentId(created.id);
      }
      if (equipmentDestination.startsWith("area:")) setSelectedAreaId(equipmentDestination.slice(5));
      clearEquipmentDraft(tab === "map" && selectedArea ? `area:${selectedArea.id}` : "unassigned");
      if (tab === "inventory") setInventoryFormOpen(false);
      setFeedback({ kind: "success", text: t("properties.equipmentSaved") });
    } catch { setFeedback({ kind: "error", text: t("properties.equipmentSaveFailed") }); }
    finally { setPending(false); }
  };

  const moveHouse = async (houseId: string, nextPropertyId: string) => {
    if (!property || readOnly || pending || nextPropertyId === property.id) return;
    const movingHouse = houses.find((house) => house.id === houseId);
    if (!movingHouse || houseReadOnly(movingHouse)) return;
    if (movingHouse && !window.confirm(t("properties.moveHouseConfirm", { name: movingHouse.name }))) return;
    setPending(true);
    setFeedback(null);
    try {
      await props.onUpdateHouse(houseId, { propertyId: nextPropertyId });
      setFeedback({ kind: "success", text: t("properties.houseMoved") });
    } catch {
      setFeedback({ kind: "error", text: t("properties.houseMoveFailed") });
    } finally {
      setPending(false);
    }
  };

  const removeEquipment = async (id: string) => {
    const item = equipment.find((candidate) => candidate.id === id);
    if (readOnly || pending || !item || !window.confirm(t("properties.deleteEquipmentConfirm", { name: item.name }))) return;
    setPending(true);
    try { await props.onDeleteEquipment(id); setFeedback({ kind: "success", text: t("properties.equipmentDeleted") }); }
    catch { setFeedback({ kind: "error", text: t("properties.equipmentDeleteFailed") }); }
    finally { setPending(false); }
  };

  const uploadEquipmentAttachments = async (
    event: ChangeEvent<HTMLInputElement>,
    kind: EquipmentAttachmentKind,
  ) => {
    const files = Array.from(event.currentTarget.files ?? []);
    event.currentTarget.value = "";
    if (!selectedEquipment || readOnly || equipmentResourcesBusy || files.length === 0) return;
    const invalidSize = files.find((file) => file.size < 1 || file.size > MAX_EQUIPMENT_ATTACHMENT_BYTES);
    if (invalidSize) {
      setEquipmentResourcesFeedback({
        kind: "error",
        text: t("properties.inventoryAttachmentTooLarge", { name: invalidSize.name }),
      });
      return;
    }
    const typedFiles = files.map((file) => ({ file, mimeType: equipmentAttachmentMimeType(file, kind) }));
    const invalidType = typedFiles.find((item) => !item.mimeType);
    if (invalidType) {
      setEquipmentResourcesFeedback({
        kind: "error",
        text: t("properties.inventoryAttachmentUnsupported", { name: invalidType.file.name }),
      });
      return;
    }
    setEquipmentResourcesBusy(true);
    setEquipmentResourcesFeedback(null);
    try {
      for (const { file, mimeType } of typedFiles) {
        const attachment = await api.uploadEquipmentAttachment(selectedEquipment.id, {
          kind,
          name: file.name,
          mimeType: mimeType!,
          data: await fileDataUrl(file, mimeType!),
        });
        setEquipmentAttachments((current) => [attachment, ...current]);
      }
      setEquipmentResourcesState("ready");
      setEquipmentResourcesFeedback({
        kind: "success",
        text: t("properties.inventoryAttachmentsUploaded", { count: files.length }),
      });
    } catch {
      setEquipmentResourcesFeedback({ kind: "error", text: t("properties.inventoryAttachmentUploadFailed") });
    } finally {
      setEquipmentResourcesBusy(false);
    }
  };

  const removeEquipmentAttachment = async (attachment: EquipmentAttachment) => {
    if (!selectedEquipment || readOnly || equipmentResourcesBusy
      || !window.confirm(t("properties.inventoryAttachmentDeleteConfirm", { name: attachment.name }))) return;
    setEquipmentResourcesBusy(true);
    setEquipmentResourcesFeedback(null);
    try {
      await api.deleteEquipmentAttachment(selectedEquipment.id, attachment.id);
      setEquipmentAttachments((current) => current.filter((item) => item.id !== attachment.id));
      setEquipmentResourcesFeedback({ kind: "success", text: t("properties.inventoryAttachmentDeleted") });
    } catch {
      setEquipmentResourcesFeedback({ kind: "error", text: t("properties.inventoryAttachmentDeleteFailed") });
    } finally {
      setEquipmentResourcesBusy(false);
    }
  };

  const addEquipmentLink = async (event: FormEvent) => {
    event.preventDefault();
    if (!selectedEquipment || readOnly || equipmentResourcesBusy
      || !equipmentLinkLabel.trim() || !equipmentLinkUrl.trim()) return;
    setEquipmentResourcesBusy(true);
    setEquipmentResourcesFeedback(null);
    try {
      const link = await api.createEquipmentLink(selectedEquipment.id, {
        label: equipmentLinkLabel.trim(),
        url: equipmentLinkUrl.trim(),
      });
      setEquipmentLinks((current) => [...current, link].sort((left, right) => left.label.localeCompare(right.label)));
      setEquipmentLinkLabel("");
      setEquipmentLinkUrl("");
      setEquipmentResourcesFeedback({ kind: "success", text: t("properties.inventoryLinkAdded") });
    } catch {
      setEquipmentResourcesFeedback({ kind: "error", text: t("properties.inventoryLinkAddFailed") });
    } finally {
      setEquipmentResourcesBusy(false);
    }
  };

  const removeEquipmentLink = async (link: EquipmentLink) => {
    if (!selectedEquipment || readOnly || equipmentResourcesBusy
      || !window.confirm(t("properties.inventoryLinkDeleteConfirm", { label: link.label }))) return;
    setEquipmentResourcesBusy(true);
    setEquipmentResourcesFeedback(null);
    try {
      await api.deleteEquipmentLink(selectedEquipment.id, link.id);
      setEquipmentLinks((current) => current.filter((item) => item.id !== link.id));
      setEquipmentResourcesFeedback({ kind: "success", text: t("properties.inventoryLinkDeleted") });
    } catch {
      setEquipmentResourcesFeedback({ kind: "error", text: t("properties.inventoryLinkDeleteFailed") });
    } finally {
      setEquipmentResourcesBusy(false);
    }
  };

  const refreshInventoryTracking = async () => {
    if (!property || !trackingEnabled) return;
    const [assets, tags] = await Promise.all([
      api.trackedAssets(property.id),
      canManageAccess ? api.trackingTags(property.id) : Promise.resolve([]),
    ]);
    setTrackedEquipment(assets);
    if (canManageAccess) setTrackingTags(tags);
  };

  const assignTag = async (tagId: string) => {
    if (!selectedEquipment || !canManageAccess || pending) return;
    setPending(true);
    setFeedback(null);
    try {
      await api.assignTrackingTag(tagId, selectedEquipment.id);
      await refreshInventoryTracking();
      setFeedback({ kind: "success", text: t("properties.trackingTagAssigned") });
    } catch {
      setFeedback({ kind: "error", text: t("properties.trackingTagAssignFailed") });
    } finally {
      setPending(false);
    }
  };

  const unassignTag = async () => {
    const tagId = selectedTracking?.tag?.id;
    if (!tagId || !canManageAccess || pending) return;
    setPending(true);
    setFeedback(null);
    try {
      await api.unassignTrackingTag(tagId);
      await refreshInventoryTracking();
      setFeedback({ kind: "success", text: t("properties.trackingTagUnassigned") });
    } catch {
      setFeedback({ kind: "error", text: t("properties.trackingTagUnassignFailed") });
    } finally {
      setPending(false);
    }
  };

  const claimTag = async (tagId: string) => {
    if (!canManageAccess || pending) return;
    setPending(true);
    try {
      await api.claimTrackingTag(tagId);
      await refreshInventoryTracking();
    } catch {
      setFeedback({ kind: "error", text: t("properties.trackingTagClaimFailed") });
    } finally {
      setPending(false);
    }
  };

  const createTag = async (event: FormEvent) => {
    event.preventDefault();
    if (!property || !canManageAccess || pending || !newTagSerial.trim() || !newTagModel.trim()) return;
    setPending(true);
    setProvisionedTag(null);
    try {
      const result = await api.createTrackingTag({
        propertyId: property.id,
        serialNumber: newTagSerial.trim(),
        hardwareModel: newTagModel.trim(),
      });
      setProvisionedTag(result);
      setNewTagSerial("");
      setNewTagModel("");
      setTrackingTags((current) => [...current.filter((tag) => tag.id !== result.tag.id), result.tag]);
    } catch {
      setFeedback({ kind: "error", text: t("properties.trackingTagCreateFailed") });
    } finally {
      setPending(false);
    }
  };

  const showEquipmentOnMap = (equipmentId: string) => {
    setSelectedEquipmentId(equipmentId);
    setMapItemSelection({ kind: "equipment", id: equipmentId });
    setPlacementEditing(false);
    setAssetPlacementEditing(false);
    setDrawing(false);
    setMapLoaded(true);
    setTab("map");
  };

  const removeNote = async (id: string) => {
    if (readOnly || pending || !window.confirm(t("properties.deleteNoteConfirm"))) return;
    setPending(true);
    setFeedback(null);
    try {
      await props.onDeleteNote(id);
      if (editingNoteId === id) {
        setEditingNoteId(null);
        setNoteText("");
      }
      setFeedback({ kind: "success", text: t("properties.noteDeleted") });
    } catch {
      setFeedback({ kind: "error", text: t("properties.noteDeleteFailed") });
    } finally {
      setPending(false);
    }
  };

  const noteTargetParts = () => {
    const separator = noteTarget.indexOf(":");
    if (separator < 0) return null;
    const target = { kind: noteTarget.slice(0, separator), id: noteTarget.slice(separator + 1) };
    if (target.kind === "property") return target.id ? null : target;
    if (target.kind === "house") return houses.some((house) => house.id === target.id) ? target : null;
    if (target.kind === "area") return areas.some((area) => area.id === target.id) ? target : null;
    if (target.kind === "equipment") return equipment.some((item) => item.id === target.id) ? target : null;
    return null;
  };
  const saveNote = async (event: FormEvent) => {
    event.preventDefault();
    if (!property || readOnly || pending || !noteText.trim()) return;
    const target = noteTargetParts();
    if (!target) {
      setNoteTarget("property:");
      setFeedback({ kind: "error", text: t("properties.noteSaveFailed") });
      return;
    }
    const common = {
      kind: noteKind,
      text: noteText.trim(),
      houseId: target.kind === "house" ? target.id : null,
      areaId: target.kind === "area" ? target.id : null,
      equipmentId: target.kind === "equipment" ? target.id : null,
    };
    setPending(true);
    try {
      if (editingNoteId) await props.onUpdateNote(editingNoteId, common);
      else await props.onCreateNote({ propertyId: property.id, ...common });
      setNoteText(""); setEditingNoteId(null);
      setFeedback({ kind: "success", text: t("properties.noteSaved") });
    } catch { setFeedback({ kind: "error", text: t("properties.noteSaveFailed") }); }
    finally { setPending(false); }
  };

  const planMaintenance = async (event: FormEvent) => {
    event.preventDefault();
    if (!property || !selectedArea || readOnly || pending || !maintenanceTitle.trim()) return;
    if ((maintenanceHouseId && !houses.some((house) => house.id === maintenanceHouseId))
      || (maintenanceEquipmentId && !equipment.some((item) => item.id === maintenanceEquipmentId && item.areaId === selectedArea.id))) {
      setMaintenanceHouseId("");
      setMaintenanceEquipmentId("");
      setFeedback({ kind: "error", text: t("properties.maintenanceSaveFailed") });
      return;
    }
    setPending(true);
    try {
      await props.onCreateMaintenanceTask({
        propertyId: property.id,
        houseId: maintenanceHouseId || null,
        title: maintenanceTitle.trim(),
        basis: "scheduled",
        areaId: selectedArea.id,
        equipmentId: maintenanceEquipmentId || null,
      });
      setMaintenanceTitle("");
      setFeedback({ kind: "success", text: t("properties.maintenanceSaved") });
    } catch { setFeedback({ kind: "error", text: t("properties.maintenanceSaveFailed") }); }
    finally { setPending(false); }
  };

  const selectMapArea = (areaId: string) => {
    setMapItemSelection(null);
    setSelectedAreaId(areaId);
  };

  const selectMapEquipment = (equipmentId: string) => {
    if (!equipment.some((item) => item.id === equipmentId)) return;
    setPlacementEditing(false);
    setAssetPlacementEditing(false);
    setDrawing(false);
    setSelectedEquipmentId(equipmentId);
    setMapItemSelection({ kind: "equipment", id: equipmentId });
    setFeedback(null);
  };

  const selectPlacementHouse = (houseId: string) => {
    if (!houses.some((house) => house.id === houseId)) return;
    setAssetPlacementEditing(false);
    setPlacementEditing(false);
    setPlacementHouseId(houseId);
    setMapItemSelection({ kind: "home", id: houseId });
    setFeedback(null);
  };

  const updatePlacementFromMap = useCallback((houseId: string, point: GeoCoordinate) => {
    const house = houses.find((candidate) => candidate.id === houseId);
    if (!house || houseReadOnly(house) || pending || !props.onSetHouseGeoreference) return;
    setPlacementHouseId(houseId);
    setMapItemSelection({ kind: "home", id: houseId });
    setAssetPlacementEditing(false);
    setPlacementLatitude(String(point.latitude));
    setPlacementLongitude(String(point.longitude));
    setPlacementEditing(true);
    setMapLoaded(true);
    setFeedback(null);
  }, [houseReadOnly, houses, pending, props.onSetHouseGeoreference]);

  const selectPlacementAsset = (assetId: string) => {
    if (assetId === NEW_FIXED_ASSET_ID) return;
    const asset = areas.find((candidate) => candidate.id === assetId);
    if (!asset) return;
    setPlacementEditing(false);
    setAssetPlacementEditing(false);
    setPlacementAssetId(asset.id);
    setMapItemSelection({ kind: "asset", id: asset.id });
    setAssetDraftLocation(asset.location ? { ...asset.location } : null);
    setAssetLatitudeInput(asset.location ? String(asset.location.latitude) : "");
    setAssetLongitudeInput(asset.location ? String(asset.location.longitude) : "");
    setAreaForm(areaDraft(asset));
    setSelectedAreaId(asset.id);
    setFeedback(null);
  };

  const updateAssetPlacementFromMap = useCallback((assetId: string, point: GeoCoordinate) => {
    if (readOnly || pending) return;
    setPlacementEditing(false);
    setDrawing(false);
    setMapLoaded(true);
    if (assetId === NEW_FIXED_ASSET_ID && isNewArea && isNewFixedAsset) {
      setMapItemSelection({ kind: "asset", id: NEW_FIXED_ASSET_ID });
      setAreaForm((current) => ({ ...current, location: point }));
      setAssetDraftLocation(point);
      setAssetLatitudeInput(String(point.latitude));
      setAssetLongitudeInput(String(point.longitude));
      setAssetPlacementEditing(true);
      setFeedback(null);
      return;
    }
    const asset = areas.find((candidate) => candidate.id === assetId);
    if (!asset) return;
    setSelectedAreaId(asset.id);
    setPlacementAssetId(asset.id);
    setMapItemSelection({ kind: "asset", id: asset.id });
    setAssetDraftLocation(point);
    setAssetLatitudeInput(String(point.latitude));
    setAssetLongitudeInput(String(point.longitude));
    setAreaForm({ ...areaDraft(asset), location: point });
    setAssetPlacementEditing(true);
    setFeedback(null);
  }, [areas, isNewArea, isNewFixedAsset, pending, readOnly]);

  const saveAssetPlacement = async () => {
    if (!placementAsset || !assetDraftLocation || readOnly || pending) return;
    setPending(true);
    setFeedback(null);
    try {
      const saved = await props.onUpdateArea(placementAsset.id, { location: assetDraftLocation });
      setSelectedAreaId(saved.id);
      setAreaForm(areaDraft(saved));
      setAssetDraftLocation(saved.location ? { ...saved.location } : null);
      setAssetLatitudeInput(saved.location ? String(saved.location.latitude) : "");
      setAssetLongitudeInput(saved.location ? String(saved.location.longitude) : "");
      setAssetPlacementEditing(false);
      setFeedback({ kind: "success", text: t("properties.assetPlacementSaved") });
    } catch { setFeedback({ kind: "error", text: t("properties.assetPlacementFailed") }); }
    finally { setPending(false); }
  };

  const removeAssetPlacement = async () => {
    if (!placementAsset?.location || readOnly || pending
      || !window.confirm(t("properties.removeAssetPlacementConfirm", { name: placementAsset.name }))) return;
    setPending(true);
    setFeedback(null);
    try {
      const saved = await props.onUpdateArea(placementAsset.id, { location: null });
      setAreaForm(areaDraft(saved));
      setAssetDraftLocation(null);
      setAssetLatitudeInput("");
      setAssetLongitudeInput("");
      setAssetPlacementEditing(false);
      setFeedback({ kind: "success", text: t("properties.assetPlacementRemoved") });
    } catch { setFeedback({ kind: "error", text: t("properties.assetPlacementFailed") }); }
    finally { setPending(false); }
  };

  const saveHousePlacement = async (event: FormEvent) => {
    event.preventDefault();
    if (!placementHouse || !props.onSetHouseGeoreference || houseReadOnly(placementHouse) || pending) return;
    const latitude = Number(placementLatitude);
    const longitude = Number(placementLongitude);
    const width = Number(placementWidth);
    const orientation = placementOrientation.trim() ? Number(placementOrientation) : null;
    const floor = placementHouse.floors.find((candidate) => candidate.type === "ground") ?? placementHouse.floors[0];
    if (!floor || !Number.isFinite(latitude) || latitude < -90 || latitude > 90 || !Number.isFinite(longitude) || longitude < -180 || longitude > 180 || !Number.isFinite(width) || width < 1 || width > 500 || (orientation !== null && (!Number.isFinite(orientation) || orientation < 0 || orientation >= 360))) {
      setFeedback({ kind: "error", text: t("placement.saveError") });
      return;
    }
    setPending(true);
    setFeedback(null);
    try {
      await props.onSetHouseGeoreference(placementHouse.id, {
        mapPlacement: {
          latitude,
          longitude,
          metersPerPlanUnit: width / Math.max(1, floor.width),
          footprintFloorId: floor.id,
        },
        orientationDegrees: orientation,
      });
      setMapLoaded(true);
      setPlacementEditing(false);
      setFeedback({ kind: "success", text: t("placement.saved") });
    } catch { setFeedback({ kind: "error", text: t("placement.saveError") }); }
    finally { setPending(false); }
  };

  const removeHousePlacement = async () => {
    if (!placementHouse?.mapPlacement || !props.onSetHouseGeoreference || houseReadOnly(placementHouse) || pending || !window.confirm(t("properties.removePlacementConfirm", { name: placementHouse.name }))) return;
    setPending(true);
    setFeedback(null);
    try {
      await props.onSetHouseGeoreference(placementHouse.id, { mapPlacement: null, orientationDegrees: null });
      setPlacementEditing(false);
      setFeedback({ kind: "success", text: t("placement.removed") });
    } catch { setFeedback({ kind: "error", text: t("placement.saveError") }); }
    finally { setPending(false); }
  };

  const propertyShareLabel = (item: Property) => {
    if (!item.stuguby) return null;
    if (item.stuguby.syncState === "detached") return t("properties.stuguby.detached");
    if (item.stuguby.syncState === "conflict") return t("properties.stuguby.conflict");
    if (item.stuguby.syncState === "offline") return t("properties.stuguby.offline");
    if (item.stuguby.pendingChangeCount > 0) return t("properties.stuguby.pending", { count: item.stuguby.pendingChangeCount });
    if (item.stuguby.isAuthority) return t("properties.stuguby.authority");
    return item.stuguby.editPolicy === "read-only"
      ? t("properties.stuguby.inheritedReadOnly")
      : t("properties.stuguby.inheritedEditable");
  };
  const houseShareLabel = (house: ClimateState["houses"][number]) => {
    if (!house.stuguby) return null;
    if (house.stuguby.syncState === "detached") return t("properties.stuguby.localAfterDisconnect");
    if (house.stuguby.syncState === "conflict") return t("properties.stuguby.conflict");
    if (house.stuguby.syncState === "offline") return t("properties.stuguby.offline");
    if (house.stuguby.pendingChangeCount > 0) return t("properties.stuguby.pending", { count: house.stuguby.pendingChangeCount });
    if (house.stuguby.ownership === "local") return t("properties.stuguby.ownedHouse");
    return house.stuguby.editPolicy === "read-only"
      ? t("properties.stuguby.sharedHouseReadOnly")
      : t("properties.stuguby.sharedHouseEditable");
  };

  if (properties.length === 0) return <section className="property-empty-page"><MapPin size={28} /><h1>{workspaceReadOnly ? t("properties.noAccessTitle") : t("properties.emptyTitle")}</h1><p>{workspaceReadOnly ? t("properties.noAccessBody") : t("properties.emptyBody")}</p>{!workspaceReadOnly && <form onSubmit={(event) => void createProperty(event)}><label className="field"><span>{t("properties.propertyName")}</span><input autoFocus required value={newPropertyName} onChange={(event) => setNewPropertyName(event.target.value)} /></label><button type="submit" className="primary-button"><Plus size={15} />{t("properties.addProperty")}</button></form>}</section>;
  if (props.indexMode) return <div className="page-stack property-management-page property-index-page">
    <header className="page-heading property-heading"><div><span className="eyebrow"><MapPin size={14} />{t("properties.eyebrow", { count: properties.length })}</span><h1>{t("properties.title")}</h1><p>{t("properties.description")}</p></div>{workspaceReadOnly && <span className="read-only-badge"><ShieldCheck size={15} />{t("properties.guestReadOnly")}</span>}</header>
    <section className="property-index-grid" aria-label={t("properties.title")}>
      {properties.map((item) => {
        const homeCount = state.houses.filter((home) => home.propertyId === item.id).length;
        const areaCount = state.propertyAreas.filter((area) => area.propertyId === item.id).length;
        const shareLabel = propertyShareLabel(item);
        return <article className={`panel property-index-card${item.stuguby ? " stuguby-shared" : ""}`} key={item.id}><span className="property-index-icon" aria-hidden="true">{item.stuguby ? <StugubyMark className="small" /> : <MapPin size={19} />}</span><div><h2>{item.name}</h2>{shareLabel && <span className="property-stuguby-label">{shareLabel}</span>}{item.description && <p>{item.description}</p>}<small>{propertySummary(homeCount, areaCount)}</small></div><button type="button" className="secondary-button" onClick={() => setPropertyId(item.id)}>{t("properties.openProperty", { property: item.name })}</button></article>;
      })}
    </section>
    {!workspaceReadOnly && <form className="panel property-index-create" onSubmit={(event) => void createProperty(event)}><label className="field"><span>{t("properties.addAnotherProperty")}</span><input value={newPropertyName} onChange={(event) => setNewPropertyName(event.target.value)} /></label><button type="submit" className="primary-button" disabled={pending || !newPropertyName.trim()}><Plus size={14} />{t("properties.addProperty")}</button></form>}
    {feedback && <p className={`property-feedback ${feedback.kind}`} role={feedback.kind === "error" ? "alert" : "status"}>{feedback.text}</p>}
  </div>;
  if (!property) return null;

  return <div className="page-stack property-management-page">
    <header className="page-heading property-heading"><div><span className="eyebrow">{property.stuguby ? <StugubyMark className="small" /> : <MapPin size={14} />}{property.stuguby ? propertyShareLabel(property) : t("bootstrap.propertyForHome")}</span><h1>{property.name}</h1><p>{property.description || t("properties.description")}</p></div>{readOnly && <span className="read-only-badge"><ShieldCheck size={15} />{workspaceReadOnly ? t("properties.guestReadOnly") : t("properties.stuguby.readOnly")}</span>}</header>
    <div className="property-layout">
      <aside className="panel property-sidebar">
        {!props.onProperty && <label className="field"><span>{t("properties.activeProperty")}</span><select value={property.id} onChange={(event) => setPropertyId(event.target.value)}>{properties.map((item) => <option key={item.id} value={item.id}>{item.name}</option>)}</select></label>}
        {editingProperty && !readOnly ? <form className="property-edit-form" onSubmit={(event) => void saveProperty(event)}><label className="field"><span>{t("properties.propertyName")}</span><input ref={propertyNameInputRef} autoFocus required value={propertyName} onChange={(event) => setPropertyName(event.target.value)} /></label><label className="field"><span>{t("properties.propertyDescription")}</span><textarea rows={3} value={propertyDescription} onChange={(event) => setPropertyDescription(event.target.value)} /></label><div><button type="button" className="secondary-button" onClick={() => { setEditingProperty(false); window.requestAnimationFrame(() => propertyEditButtonRef.current?.focus()); }}>{t("common.cancel")}</button><button type="submit" className="primary-button"><Save size={14} />{t("properties.saveProperty")}</button></div></form> : <div className="property-summary"><strong>{property.name}</strong>{property.description && <p>{property.description}</p>}<small>{propertySummary(houses.length, areas.length)}</small>{!readOnly && <button ref={propertyEditButtonRef} type="button" className="text-button" onClick={() => { setEditingProperty(true); window.requestAnimationFrame(() => propertyNameInputRef.current?.focus()); }}>{t("properties.editProperty")}</button>}</div>}
        {!readOnly && (!property.stuguby || property.stuguby.syncState === "detached") && property.id !== "property-main" && properties.length > 1 && houses.length === 0 && areas.length === 0 && equipment.length === 0 && notes.length === 0 && !state.maintenanceTasks.some((task) => task.propertyId === property.id) && <button type="button" className="text-button danger-text" disabled={pending} onClick={() => void removeProperty()}><Trash2 size={14} />{t("properties.deleteEmptyProperty")}</button>}
        {houses.length + areas.length > 8 && <label className="field property-sidebar-search"><span>{t("properties.mapItemSearch")}</span><div><Search size={14} aria-hidden="true" /><input type="search" value={structureQuery} placeholder={t("properties.mapItemSearchHint")} onChange={(event) => setStructureQuery(event.target.value)} /></div></label>}
        <section className="property-house-group">
          <h2><Building2 size={15} />{t("properties.houses")}</h2>
          {sidebarHouses.length ? <ul>{sidebarHouses.map((house) => {
            const shareLabel = houseShareLabel(house);
            const foreignShared = isForeignSharedHouse(house);
            const locked = houseReadOnly(house);
            const activeStugubyAssociation = Boolean(house.stuguby && house.stuguby.syncState !== "detached");
            const moveTargets = properties.filter((candidate) => candidate.id === property.id
              || !candidate.stuguby || candidate.stuguby.syncState === "detached");
            return <li key={house.id} className={foreignShared ? "stuguby-shared" : ""}>{foreignShared ? <StugubyMark className="small" /> : <Building2 size={13} />}<span><strong>{house.name}</strong>{shareLabel && <small className="property-stuguby-label">{shareLabel}</small>}<small>{house.location?.label ?? house.timezone}</small>{!locked && !activeStugubyAssociation && moveTargets.length > 1 && <label><span>{t("properties.moveHouse")}</span><select value={property.id} disabled={pending} onChange={(event) => void moveHouse(house.id, event.target.value)}>{moveTargets.map((candidate) => <option key={candidate.id} value={candidate.id}>{candidate.name}</option>)}</select></label>}</span></li>;
          })}</ul> : <p>{t(houses.length ? "properties.mapItemsNoMatches" : "properties.noHouses")}</p>}
          {!readOnly && <form className="property-create-form compact" onSubmit={(event) => void createHouse(event)}><label className="field"><span>{t("properties.addHomeToProperty")}</span><input value={newHouseName} onChange={(event) => setNewHouseName(event.target.value)} placeholder={t("bootstrap.defaultHomeName")} /></label><button type="submit" className="secondary-button" disabled={pending || !newHouseName.trim()}><Plus size={14} />{t("properties.addHome")}</button></form>}
        </section>
        <section className="property-area-list"><div><h2><MapIcon size={15} />{t("properties.areas")}</h2><span>{areas.length}</span></div>{sidebarAreas.length ? <div>{sidebarAreas.map((area) => <button key={area.id} type="button" aria-pressed={selectedAreaId === area.id} className={selectedAreaId === area.id ? "active" : ""} onClick={() => selectMapArea(area.id)}><MapPin size={14} /><span><strong>{area.name}</strong><small>{t(`properties.areaKind.${area.kind}` as TranslationKey)}</small></span></button>)}</div> : <p>{t(areas.length ? "properties.mapItemsNoMatches" : "properties.noAreas")}</p>}{!readOnly && <button type="button" className="structure-add-button" onClick={startArea}><Plus size={15} />{t("properties.addArea")}</button>}</section>
        {!workspaceReadOnly && <form className="property-create-form" onSubmit={(event) => void createProperty(event)}><label className="field"><span>{t("properties.addAnotherProperty")}</span><input value={newPropertyName} onChange={(event) => setNewPropertyName(event.target.value)} /></label><button type="submit" className="secondary-button" disabled={!newPropertyName.trim()}><Plus size={14} />{t("common.add")}</button></form>}
      </aside>
      <div className="property-workspace">
        <div className="property-tabs" role="tablist" aria-label={t("properties.workspaceNavigation")}>{tabs.map(({ id, key, icon: Icon }, index) => <button key={id} id={`property-tab-${id}`} type="button" role="tab" aria-selected={tab === id} aria-controls={`property-panel-${id}`} tabIndex={tab === id ? 0 : -1} onKeyDown={(event) => chooseTabFromKeyboard(event, index)} onClick={() => setTab(id)}><Icon size={16} />{t(key)}</button>)}</div>

        {tab === "overview" && <section id="property-panel-overview" className="property-overview-workspace" role="tabpanel" aria-labelledby="property-tab-overview">
          <section className="panel property-overview-status">
            <div className="panel-header"><div><span className="eyebrow">{property.name}</span><h2>{t("properties.status.title")}</h2></div><Building2 size={20} aria-hidden="true" /></div>
            <PropertyStatusLights lights={propertyTrafficLights} />
          </section>
          <div className="property-overview-actions">
            <button type="button" className="panel" onClick={() => setTab("map")}><MapIcon size={22} aria-hidden="true" /><span><strong>{t("properties.map")}</strong><small>{propertySummary(houses.length, areas.length)}</small></span><ChevronRight size={18} aria-hidden="true" /></button>
            <button type="button" className="panel" onClick={() => setTab("inventory")}><Boxes size={22} aria-hidden="true" /><span><strong>{t("properties.inventory")}</strong><small>{t("properties.inventoryCount", { count: equipment.length })}</small></span><ChevronRight size={18} aria-hidden="true" /></button>
            <button type="button" className="panel" onClick={() => setTab("notes")}><NotebookPen size={22} aria-hidden="true" /><span><strong>{t("properties.notes")}</strong><small>{notes.length}</small></span><ChevronRight size={18} aria-hidden="true" /></button>
            {props.onOpenMaintenance && <button type="button" className="panel" onClick={props.onOpenMaintenance}><Wrench size={22} aria-hidden="true" /><span><strong>{t("nav.maintenance")}</strong><small>{state.maintenanceTasks.filter((task) => task.propertyId === property.id && task.status !== "verified" && task.status !== "cancelled").length}</small></span><ChevronRight size={18} aria-hidden="true" /></button>}
          </div>
        </section>}

        {tab === "map" && <section id="property-panel-map" className="property-map-workspace" role="tabpanel" aria-labelledby="property-tab-map">
          <div className="panel property-map-panel">
            <div className="panel-header"><div><span className="eyebrow">{property.name}</span><h2>{t("properties.mapTitle")}</h2></div>{!readOnly && <button type="button" className="primary-button" onClick={startArea}><Plus size={15} />{t("properties.drawArea")}</button>}</div>
            {!mapLoaded ? <div className="setup-map-gate"><MapIcon size={28} /><div><strong>{t("properties.loadMapTitle")}</strong><p>{t("properties.loadMapBody")}</p></div><button type="button" className="primary-button" onClick={() => setMapLoaded(true)}><MapIcon size={15} />{t("properties.loadMap")}</button></div> : <Suspense fallback={<output className="property-loading"><LoaderCircle className="spin" />{t("common.loading")}</output>}>
              <div className={`property-map-shell ${drawing ? "drawing" : ""}${placementEditing || assetPlacementEditing ? " placing-house" : ""}`}>
                <PropertyAreaMap
                  areas={mapAreas}
                  houses={visibleMapHouses}
                  propertyLocation={property.location}
                  propertyLabel={property.name}
                  selectedAreaId={selectedAreaId}
                  selectedHouseId={mapItemSelection?.kind === "home" ? placementHouse?.id ?? null : null}
                  editableHouseId={placementEditing && placementHouse && !houseReadOnly(placementHouse) ? placementHouse.id : null}
                  selectedAssetId={mapItemSelection?.kind === "asset" ? mapItemSelection.id : null}
                  editableAssetId={assetPlacementEditing && !readOnly ? (isNewArea && isNewFixedAsset ? NEW_FIXED_ASSET_ID : placementAsset?.id ?? null) : null}
                  visibleAssetIds={visibleAssetIds}
                  equipment={visibleMapEquipment}
                  trackedAssets={trackingSnapshot?.assets ?? trackedEquipment}
                  members={visibleMapMembers}
                  selectedEquipmentId={selectedEquipmentId}
                  draftPolygon={!isNewFixedAsset && (isNewArea || selectedArea) ? areaForm.polygon : null}
                  drawing={drawing && !readOnly}
                  onSelectArea={selectMapArea}
                  onSelectHouse={selectPlacementHouse}
                  onMoveHouse={updatePlacementFromMap}
                  onSelectAsset={selectPlacementAsset}
                  onMoveAsset={updateAssetPlacementFromMap}
                  onSelectEquipment={selectMapEquipment}
                  onAppendVertex={appendVertex}
                  onMoveVertex={moveVertex}
                  onInsertVertex={insertVertex}
                  onFinishDrawing={() => setDrawing(false)}
                  vertexLabel={vertexLabel}
                  midpointLabel={midpointLabel}
                  ariaLabel={t("properties.mapAria", { property: property.name })}
                  viewportKey={property.id}
                  equipmentLabel={(item, tracking, source) => `${item.name}. ${t(`properties.mapEquipmentSource.${source}` as TranslationKey)}${tracking?.position ? `. ${t(`properties.inventoryTracking.${tracking.position.freshnessState}` as TranslationKey)}` : ""}`}
                  memberLabel={(member) => `${member.memberLabel}. ${t("properties.mapMemberAccuracy", { meters: Math.round(member.horizontalAccuracyMeters) })}. ${t("properties.mapMemberExpires", { time: new Date(member.sharingUntil).toLocaleTimeString() })}`}
                />
                {drawing && <span className="property-drawing-cue"><MapPin size={14} />{t("properties.drawHint")}</span>}
                {placementEditing && placementHouse && <span className="property-drawing-cue"><Move size={14} />{t("placement.editingHint", { house: placementHouse.name })}</span>}
                {assetPlacementEditing && <span className="property-drawing-cue"><Move size={14} />{t("properties.assetPlacementHint")}</span>}
              </div>
            </Suspense>}
          </div>
          {(houses.length > 0 || fixedAssets.length > 0 || equipment.length > 0 || sharedMembers.length > 0 || !readOnly) && <section className="panel property-home-placement">
            <div className="panel-header"><div><span className="eyebrow">{property.name}</span><h2>{t("properties.mapItems")}</h2></div>{!readOnly && <button type="button" className="text-button" onClick={startFixedAsset}><Plus size={14} aria-hidden="true" />{t("properties.addFixedAsset")}</button>}</div>
            <p className="property-help">{t("properties.mapItemsHelp")}</p>
            <div className="property-map-catalog-controls">
              <label className="field property-map-item-search"><span>{t("properties.mapItemSearch")}</span><div><Search size={14} aria-hidden="true" /><input type="search" value={mapItemQuery} placeholder={t("properties.mapItemSearchHint")} onChange={(event) => { setMapItemQuery(event.target.value); setMapItemLimit(MAP_ITEM_BATCH_SIZE); }} /></div></label>
              <label className="field"><span>{t("properties.mapItemType")}</span><select value={mapItemFilter} onChange={(event) => { setMapItemFilter(event.target.value as MapItemFilter); setMapItemLimit(MAP_ITEM_BATCH_SIZE); }}><option value="all">{t("properties.mapItemTypeAll")}</option><option value="home">{t("properties.houses")}</option><option value="asset">{t("properties.fixedAssets")}</option><option value="equipment">{t("properties.mapEquipment")}</option><option value="person">{t("properties.mapPeople")}</option></select></label>
            </div>
            <fieldset className="property-map-layer-controls">
              <legend>{t("properties.mapLayers")}</legend>
              <label><input type="checkbox" checked={mapLayers.home} onChange={(event) => setMapLayers((current) => ({ ...current, home: event.target.checked }))} /><Building2 size={13} aria-hidden="true" /><span>{t("properties.houses")}</span><small>{houses.length}</small></label>
              <label><input type="checkbox" checked={mapLayers.asset} onChange={(event) => setMapLayers((current) => ({ ...current, asset: event.target.checked }))} /><MapPin size={13} aria-hidden="true" /><span>{t("properties.fixedAssets")}</span><small>{fixedAssets.length}</small></label>
              <label><input type="checkbox" checked={mapLayers.equipment} onChange={(event) => setMapLayers((current) => ({ ...current, equipment: event.target.checked }))} /><Boxes size={13} aria-hidden="true" /><span>{t("properties.mapEquipment")}</span><small>{equipment.length}</small></label>
              <label><input type="checkbox" checked={mapLayers.person} onChange={(event) => setMapLayers((current) => ({ ...current, person: event.target.checked }))} /><UserRound size={13} aria-hidden="true" /><span>{t("properties.mapPeople")}</span><small>{sharedMembers.length}</small></label>
            </fieldset>
            <p className="property-map-result-count" aria-live="polite">{t("properties.inventoryShowing", { count: matchingMapCatalogItems.length })}</p>
            {visibleMapCatalogItems.length > 0 ? <ul className="property-placement-house-list property-map-item-list" aria-label={t("properties.mapItems")}>
              {visibleMapCatalogItems.map((entry) => {
                const selected = mapItemSelection?.kind === entry.kind && mapItemSelection.id === entry.id;
                const candidate = entry.kind === "home" ? houses.find((house) => house.id === entry.id) : null;
                const asset = entry.kind === "asset" ? fixedAssets.find((item) => item.id === entry.id) : null;
                const kindLabel = entry.kind === "home" ? t("common.house") : entry.kind === "asset" ? t("properties.fixedAssets") : entry.kind === "equipment" ? t("properties.equipment") : t("properties.mapPeople");
                if (entry.kind === "person") return <li key={`${entry.kind}:${entry.id}`}><article className="property-map-person-row"><UserRound size={15} aria-hidden="true" /><span><strong>{entry.label}</strong><small>{kindLabel} · {entry.detail}</small></span></article></li>;
                return <li key={`${entry.kind}:${entry.id}`}><button type="button" data-kind={entry.kind} draggable={entry.kind === "home" ? Boolean(candidate && !houseReadOnly(candidate)) : entry.kind === "asset" ? !readOnly : false} aria-pressed={selected} onClick={() => { if (entry.kind === "home") selectPlacementHouse(entry.id); else if (entry.kind === "asset") selectPlacementAsset(entry.id); else selectMapEquipment(entry.id); }} onDragStart={(event) => {
                  if (entry.kind === "home") {
                    if (!candidate || houseReadOnly(candidate)) { event.preventDefault(); return; }
                    selectPlacementHouse(entry.id);
                    event.dataTransfer.effectAllowed = "move";
                    event.dataTransfer.setData("application/x-stugu-house-id", entry.id);
                  } else if (entry.kind === "asset" && asset && !readOnly) {
                    selectPlacementAsset(entry.id);
                    event.dataTransfer.effectAllowed = "move";
                    event.dataTransfer.setData("application/x-stugu-property-asset-id", entry.id);
                  } else event.preventDefault();
                }}>{entry.kind === "home" && candidate && isForeignSharedHouse(candidate) ? <StugubyMark className="small" /> : entry.kind === "home" ? <Building2 size={15} aria-hidden="true" /> : entry.kind === "asset" ? <MapPin size={15} aria-hidden="true" /> : <Boxes size={15} aria-hidden="true" />}<span><strong>{entry.label}</strong><small>{kindLabel} · {entry.detail}</small></span></button></li>;
              })}
            </ul> : <p className="property-map-empty">{t("properties.mapItemsNoMatches")}</p>}
            {remainingMapCatalogItems > 0 && <button type="button" className="secondary-button property-map-show-more" onClick={() => setMapItemLimit((current) => current + MAP_ITEM_BATCH_SIZE)}>{t("properties.mapItemsShowMore", { count: Math.min(MAP_ITEM_BATCH_SIZE, remainingMapCatalogItems) })}</button>}
            <details className="property-live-map">
              <summary><Radio size={15} aria-hidden="true" /><span><strong>{t("properties.liveAssetsPeople")}</strong><small>{t("properties.liveMapDetails")}</small></span><span className={`tracking-connection connection-${trackingConnection}`}>{trackingConnection === "live" ? t("properties.trackingConnectionLive") : trackingConnection === "reconnecting" ? t("properties.trackingConnectionReconnecting") : t("properties.trackingConnectionOff")}</span><ChevronRight size={15} aria-hidden="true" /></summary>
              <div><p className="property-help">{t("properties.liveMapConsentHelp")}</p>{sharedMembers.length === 0 && <p className="property-empty-copy">{t("properties.noSharedPeople")}</p>}</div>
            </details>
            {mapItemSelection?.kind === "home" && placementHouse && props.onSetHouseGeoreference && <section className="property-map-item-editor">
            <form className="property-placement-form" onSubmit={(event) => void saveHousePlacement(event)}>
              <details className="property-placement-advanced">
                <summary><span>{t("setup.advancedPlacement")}</span><small>{t("setup.manualCoordinates")}</small></summary>
                <div className="property-placement-fields">
                  <label className="field"><span>{t("weather.latitude")}</span><input type="number" min={-90} max={90} step="any" required disabled={houseReadOnly(placementHouse)} value={placementLatitude} onChange={(event) => { setPlacementLatitude(event.target.value); setPlacementEditing(true); }} /></label>
                  <label className="field"><span>{t("weather.longitude")}</span><input type="number" min={-180} max={180} step="any" required disabled={houseReadOnly(placementHouse)} value={placementLongitude} onChange={(event) => { setPlacementLongitude(event.target.value); setPlacementEditing(true); }} /></label>
                  <label className="field"><span>{t("placement.widthMeters")}</span><input type="number" min={1} max={500} step="0.1" required disabled={houseReadOnly(placementHouse)} value={placementWidth} onChange={(event) => { setPlacementWidth(event.target.value); setPlacementEditing(true); }} /></label>
                  <label className="field"><span>{t("orientation.degrees")}</span><input type="number" min={0} max={359} step={1} disabled={houseReadOnly(placementHouse)} value={placementOrientation} onChange={(event) => { setPlacementOrientation(event.target.value); setPlacementEditing(true); }} /></label>
                </div>
              </details>
              <div className="property-placement-actions">
                {houseReadOnly(placementHouse) ? <span className="property-stuguby-read-only"><ShieldCheck size={14} />{t("properties.stuguby.houseReadOnlyHelp")}</span> : <>
                  {!placementEditing && <button type="button" className="primary-button" onClick={() => { setMapLoaded(true); setDrawing(false); setPlacementEditing(true); setFeedback(null); }}><Move size={15} aria-hidden="true" />{placementHouse.mapPlacement ? t("placement.move") : t("placement.place")}</button>}
                  {placementEditing && <><button type="submit" className="primary-button" disabled={pending || !placementDraftIsValid}>{pending ? <LoaderCircle className="spin" size={15} aria-hidden="true" /> : <Save size={15} aria-hidden="true" />}{pending ? t("common.saving") : t("placement.save")}</button><button type="button" className="secondary-button" disabled={pending} onClick={() => setPlacementEditing(false)}>{t("common.cancel")}</button></>}
                  {placementHouse.mapPlacement && <button type="button" className="secondary-button danger-text" disabled={pending} onClick={() => void removeHousePlacement()}><Trash2 size={15} aria-hidden="true" />{t("placement.remove")}</button>}
                </>}
              </div>
            </form>
            </section>}
            {mapItemSelection?.kind === "asset" && placementAsset && <section className="property-map-item-editor">
              <div className="property-placement-actions">
                {!assetPlacementEditing && <button type="button" className="primary-button" onClick={() => { setMapLoaded(true); setDrawing(false); setPlacementEditing(false); setAssetDraftLocation(placementAsset.location ? { ...placementAsset.location } : null); setAssetPlacementEditing(true); setFeedback(null); }}><MapPin size={15} aria-hidden="true" />{placementAsset.location ? t("properties.moveAsset") : t("properties.placeAsset")}</button>}
                {assetPlacementEditing && <><button type="button" className="primary-button" disabled={pending || !assetDraftLocation || !assetCoordinateInputsValid} onClick={() => void saveAssetPlacement()}><Save size={15} aria-hidden="true" />{pending ? t("common.saving") : t("placement.save")}</button><button type="button" className="secondary-button" disabled={pending} onClick={() => { const location = placementAsset.location ? { ...placementAsset.location } : null; setAreaForm(areaDraft(placementAsset)); setAssetDraftLocation(location); setAssetLatitudeInput(location ? String(location.latitude) : ""); setAssetLongitudeInput(location ? String(location.longitude) : ""); setAssetPlacementEditing(false); }}>{t("common.cancel")}</button></>}
                {placementAsset.location && <button type="button" className="secondary-button danger-text" disabled={pending} onClick={() => void removeAssetPlacement()}><Trash2 size={15} aria-hidden="true" />{t("placement.remove")}</button>}
              </div>
            </section>}
            {mapItemSelection?.kind === "equipment" && selectedEquipment && <div className="property-map-item-editor property-map-equipment-selection"><span><Boxes size={15} aria-hidden="true" /><strong>{selectedEquipment.name}</strong></span><button type="button" className="secondary-button" onClick={() => setTab("inventory")}>{t("properties.inventory")}</button></div>}
          </section>}
          {(selectedArea || isNewArea) && <section className="panel area-editor"><div className="panel-header"><div><span className="eyebrow">{isNewFixedAsset ? t("properties.newFixedAsset") : isNewArea ? t("properties.newArea") : t("properties.selectedArea")}</span><h2>{areaForm.name || (editingFixedAsset ? t("properties.unnamedFixedAsset") : t("properties.unnamedArea"))}</h2></div><MapPin size={20} /></div>
            <div className="area-form-grid">
              <label className="field"><span>{editingFixedAsset ? t("properties.assetName") : t("properties.areaName")}</span><input required value={areaForm.name} disabled={readOnly} onChange={(event) => setAreaForm((current) => ({ ...current, name: event.target.value }))} /></label>
              <label className="field"><span>{editingFixedAsset ? t("properties.assetKind") : t("properties.areaKind")}</span><select value={areaForm.kind} disabled={readOnly} onChange={(event) => setAreaForm((current) => ({ ...current, kind: event.target.value as PropertyAreaKind }))}>{areaKinds.map((kind) => <option key={kind} value={kind}>{t(`properties.areaKind.${kind}` as TranslationKey)}</option>)}</select></label>
              {selectedArea && properties.length > 1 && <label className="field area-description"><span>{t("properties.moveAreaTo")}</span><select value={areaDestinationPropertyId} disabled={readOnly || pending} onChange={(event) => setAreaDestinationPropertyId(event.target.value)}>{properties.map((candidate) => <option key={candidate.id} value={candidate.id}>{candidate.name}</option>)}</select><small>{t("properties.moveAreaHelp")}</small></label>}
              <label className="field area-description"><span>{t("properties.areaDescription")}</span><textarea rows={2} value={areaForm.description} disabled={readOnly} onChange={(event) => setAreaForm((current) => ({ ...current, description: event.target.value }))} /></label>
            </div>
            {editingFixedAsset ? <><div className="property-placement-fields area-fixed-asset-coordinates">
              <label className="field"><span>{t("weather.latitude")}</span><input type="number" min={-90} max={90} step="any" required value={assetLatitudeInput} disabled={readOnly} onChange={(event) => updateFixedAssetCoordinate("latitude", event.target.value)} /></label>
              <label className="field"><span>{t("weather.longitude")}</span><input type="number" min={-180} max={180} step="any" required value={assetLongitudeInput} disabled={readOnly} onChange={(event) => updateFixedAssetCoordinate("longitude", event.target.value)} /></label>
            </div>{!assetCoordinateInputsValid && (assetLatitudeInput || assetLongitudeInput) && <p className="inline-error" role="alert">{t("weather.invalidLocation")}</p>}<p className={`property-asset-location-status ${assetCoordinateInputsValid ? "placed" : ""}`}><MapPin size={15} aria-hidden="true" />{assetCoordinateInputsValid ? t("properties.assetDraftPlaced") : t("properties.assetDraftHint")}</p></> : <>
              {!readOnly && <div className="area-drawing-actions"><button type="button" className={drawing ? "secondary-button active" : "secondary-button"} onClick={() => setDrawing((value) => !value)}><MapPin size={14} />{drawing ? t("properties.finishDrawing") : t("properties.editBoundary")}</button><button type="button" className="secondary-button" disabled={!areaForm.polygon.length} onClick={undoVertex}><Undo2 size={14} />{t("common.undo")}</button><button type="button" className="secondary-button" disabled={!redoVertices.length} onClick={redoVertex}><Redo2 size={14} />{t("common.redo")}</button><button type="button" className="secondary-button" disabled={!areaForm.polygon.length} onClick={() => { setAreaForm((current) => ({ ...current, polygon: [] })); setCoordinateInput(""); setRedoVertices([]); }}>{t("properties.clear")}</button></div>}
              <details className="area-coordinate-editor"><summary>{t("properties.manualCoordinates")}</summary><p>{t("properties.manualCoordinatesHelp")}</p><label className="field"><span>{t("properties.vertices")}</span><textarea rows={Math.max(4, areaForm.polygon.length)} value={coordinateInput} disabled={readOnly} onChange={(event) => { setCoordinateInput(event.target.value); setCoordinateError(false); }} /></label>{coordinateError && <p className="inline-error" role="alert">{t("properties.invalidCoordinates")}</p>}{!readOnly && <button type="button" className="secondary-button" onClick={applyCoordinates}><Check size={14} />{t("properties.applyCoordinates")}</button>}</details>
              <p className="property-help">{t("properties.vertexCount", { count: areaForm.polygon.length })}</p>
            </>}
            {!readOnly && <div className="area-editor-actions"><button type="button" className="primary-button" disabled={pending || !areaForm.name.trim() || (editingFixedAsset ? !areaForm.location || !assetCoordinateInputsValid : areaForm.polygon.length < 3)} onClick={() => void saveArea()}><Save size={15} />{pending ? t("common.saving") : editingFixedAsset ? t("properties.saveFixedAsset") : t("properties.saveArea")}</button>{selectedArea && <button type="button" className="secondary-button danger-text" disabled={pending} onClick={() => void removeArea()}><Trash2 size={14} />{t("common.delete")}</button>}</div>}
          </section>}
        </section>}

        {tab === "inventory" && <section id="property-panel-inventory" className="property-inventory-workspace" role="tabpanel" aria-labelledby="property-tab-inventory">
          <section className="panel inventory-overview">
            <div className="panel-header">
              <div><span className="eyebrow">{property.name}</span><h2>{t("properties.inventory")}</h2><p>{t("properties.inventoryHelp")}</p></div>
              {!readOnly && <button type="button" className="primary-button" onClick={() => {
                clearEquipmentDraft("unassigned");
                setInventoryFormOpen(true);
              }}><Plus size={15} aria-hidden="true" />{t("properties.addInventoryItem")}</button>}
            </div>
            <div className="inventory-summary" aria-label={t("properties.inventorySummary")}>
              <article><Boxes size={18} aria-hidden="true" /><span><strong>{equipment.length}</strong><small>{t("properties.inventoryTotal")}</small></span></article>
              <article data-attention={inventoryAttentionCount > 0}><Wrench size={18} aria-hidden="true" /><span><strong>{inventoryAttentionCount}</strong><small>{t("properties.inventoryAttention")}</small></span></article>
              <article><MapPin size={18} aria-hidden="true" /><span><strong>{inventoryLocationCount}</strong><small>{t("properties.inventoryLocations")}</small></span></article>
              <article><Radio size={18} aria-hidden="true" /><span><strong>{trackingStates.filter((item) => item.assignment).length}</strong><small>{t("properties.inventoryTracked")}</small></span></article>
            </div>
          </section>

          <section className="panel inventory-catalog">
            <div className="inventory-controls">
              <label className="field inventory-search"><span>{t("properties.inventorySearch")}</span><div><Search size={15} aria-hidden="true" /><input type="search" value={inventoryQuery} onChange={(event) => setInventoryQuery(event.target.value)} placeholder={t("properties.inventorySearchHint")} /></div></label>
              <label className="field"><span>{t("properties.inventoryStatusFilter")}</span><select value={inventoryStatus} onChange={(event) => setInventoryStatus(event.target.value as "all" | AreaEquipmentStatus)}><option value="all">{t("properties.inventoryAllStatuses")}</option><option value="active">{t("properties.equipmentStatus.active")}</option><option value="out-of-service">{t("properties.equipmentStatus.out-of-service")}</option><option value="retired">{t("properties.equipmentStatus.retired")}</option></select></label>
              <label className="field"><span>{t("properties.inventoryLocationFilter")}</span><select value={inventoryLocation} onChange={(event) => setInventoryLocation(event.target.value as InventoryLocationFilter)}><option value="all">{t("properties.inventoryAllLocations")}</option><option value="pinned">{t("properties.inventoryPinnedLocation")}</option><option value="unassigned">{t("properties.inventoryUnassigned")}</option>{houses.length > 0 && <optgroup label={t("properties.houses")}>{houses.map((house) => <option key={house.id} value={`house:${house.id}`}>{house.name}</option>)}</optgroup>}{areas.length > 0 && <optgroup label={t("properties.areas")}>{areas.map((area) => <option key={area.id} value={`area:${area.id}`}>{area.name}</option>)}</optgroup>}</select></label>
            </div>
            <p className="inventory-result-count" aria-live="polite">{t("properties.inventoryShowing", { count: visibleInventory.length })}</p>
            {visibleInventory.length > 0 ? <div className="inventory-list">
              {visibleInventory.map((item) => {
                const tracked = trackingByEquipmentId.get(item.id);
                const trackingState = tracked?.position?.freshnessState ?? (tracked ? "unknown" : null);
                return <article key={item.id} data-status={item.status} data-selected={selectedEquipmentId === item.id}>
                  <div className="inventory-item-icon" aria-hidden="true"><Boxes size={18} /></div>
                  <div className="inventory-item-copy">
                    <div><span className="inventory-item-kind">{item.kind}</span><h3>{item.name}</h3></div>
                    <p><MapPin size={13} aria-hidden="true" />{equipmentLocationLabel(item)}</p>
                    {(item.manufacturer || item.model || item.serialNumber) && <dl>
                      {item.manufacturer && <><dt>{t("properties.equipmentManufacturer")}</dt><dd>{item.manufacturer}</dd></>}
                      {item.model && <><dt>{t("properties.equipmentModel")}</dt><dd>{item.model}</dd></>}
                      {item.serialNumber && <><dt>{t("properties.equipmentSerialNumber")}</dt><dd>{item.serialNumber}</dd></>}
                    </dl>}
                    {item.notes && <p className="inventory-item-notes">{item.notes}</p>}
                  </div>
                  <div className="inventory-item-state">
                    <span className={`inventory-status status-${item.status}`}>{t(`properties.equipmentStatus.${item.status}` as TranslationKey)}</span>
                    {trackingState && <span className={`inventory-tracking tracking-${trackingState}`}>{t(`properties.inventoryTracking.${trackingState}` as TranslationKey)}{tracked?.tag?.batteryPercent !== null && tracked?.tag?.batteryPercent !== undefined ? ` · ${tracked.tag.batteryPercent}%` : ""}</span>}
                  </div>
                  <div className="inventory-item-actions">
                    <button type="button" className="secondary-button" aria-label={`${t("properties.equipmentQrLabel")}: ${item.name}`} onClick={() => setSelectedEquipmentId(item.id)}><QrCode size={14} aria-hidden="true" />{t("properties.equipmentQrLabel")}</button>
                    <button type="button" className="secondary-button" aria-label={`${t("properties.showOnMap")}: ${item.name}`} onClick={() => showEquipmentOnMap(item.id)}><MapPin size={14} aria-hidden="true" />{t("properties.showOnMap")}</button>
                    {!readOnly && <><button type="button" className="secondary-button" disabled={pending} aria-label={`${t("properties.editInventoryItem")}: ${item.name}`} onClick={() => beginEquipmentEdit(item)}><ClipboardList size={14} aria-hidden="true" />{t("properties.editInventoryItem")}</button>
                    <button type="button" className="icon-button small danger-icon" disabled={pending} aria-label={`${t("common.delete")}: ${item.name}`} onClick={() => void removeEquipment(item.id)}><Trash2 size={14} /></button></>}
                  </div>
                </article>;
              })}
            </div> : <div className="inventory-empty"><Boxes size={24} aria-hidden="true" /><h3>{equipment.length ? t("properties.inventoryNoMatches") : t("properties.inventoryEmpty")}</h3><p>{equipment.length ? t("properties.inventoryNoMatchesHelp") : t("properties.inventoryEmptyHelp")}</p></div>}
          </section>

          {selectedEquipment && <section className="panel inventory-detail">
            <div className="panel-header">
              <div><span className="eyebrow">{selectedEquipment.kind}</span><h2>{selectedEquipment.name}</h2><p>{t("properties.inventoryDetailHelp")}</p></div>
              <button type="button" className="icon-button small" aria-label={t("common.close")} onClick={() => setSelectedEquipmentId(null)}><X size={15} aria-hidden="true" /></button>
            </div>
            <EquipmentQrLabel
              equipment={selectedEquipment}
              propertyName={property.name}
              locationLabel={equipmentLocationLabel(selectedEquipment)}
            />
            <div className="inventory-location-comparison">
              <article>
                <span className="eyebrow"><MapPin size={14} aria-hidden="true" />{t("properties.savedExpectedLocation")}</span>
                <strong>{equipmentLocationLabel(selectedEquipment)}</strong>
                {selectedEquipment.location && <small>{selectedEquipment.location.latitude.toFixed(6)}, {selectedEquipment.location.longitude.toFixed(6)}</small>}
                <p>{t("properties.savedExpectedLocationHelp")}</p>
              </article>
              <article>
                <span className="eyebrow"><Radio size={14} aria-hidden="true" />{t("properties.liveLocationEstimate")}</span>
                {selectedTracking?.position ? <>
                  <strong>{t(`properties.inventoryTracking.${selectedTracking.position.freshnessState}` as TranslationKey)}</strong>
                  <small>{selectedTracking.position.positionType === "confirmed-zone" && selectedTracking.position.zoneId
                    ? areas.find((area) => area.id === selectedTracking.position!.zoneId)?.name ?? selectedTracking.position.zoneId
                    : selectedTracking.position.coordinate
                      ? `${selectedTracking.position.coordinate.latitude.toFixed(6)}, ${selectedTracking.position.coordinate.longitude.toFixed(6)}`
                      : t("properties.inventoryLocationUnknown")}</small>
                  <dl>
                    <div><dt>{t("properties.trackingConfidence")}</dt><dd>{Math.round(selectedTracking.position.confidence * 100)}% · {selectedTracking.position.confidenceLevel}</dd></div>
                    <div><dt>{t("properties.trackingAccuracy")}</dt><dd>{selectedTracking.position.accuracyRadiusMeters === null ? t("properties.inventoryLocationUnknown") : `±${Math.round(selectedTracking.position.accuracyRadiusMeters)} m`}</dd></div>
                    <div><dt>{t("properties.trackingObserved")}</dt><dd>{selectedTracking.position.lastObservedAt ? new Date(selectedTracking.position.lastObservedAt).toLocaleString() : t("properties.inventoryLocationUnknown")}</dd></div>
                  </dl>
                </> : <><strong>{t("properties.inventoryLocationUnknown")}</strong><p>{t("properties.liveLocationEstimateHelp")}</p></>}
              </article>
            </div>
            <section className="inventory-resources-panel" aria-labelledby="inventory-resources-title">
              <div className="property-placement-group-header">
                <div><h3 id="inventory-resources-title"><FileText size={15} aria-hidden="true" />{t("properties.inventoryResources")}</h3><p>{t("properties.inventoryResourcesHelp")}</p></div>
              </div>
              {equipmentResourcesState === "loading" ? <output className="inventory-resources-loading"><LoaderCircle className="spin" size={16} aria-hidden="true" />{t("properties.inventoryResourcesLoading")}</output>
                : equipmentResourcesState === "error" ? <div className="inventory-resources-error"><p>{t("properties.inventoryResourcesLoadFailed")}</p><button type="button" className="secondary-button" onClick={() => setEquipmentResourcesRefresh((current) => current + 1)}>{t("common.retry")}</button></div>
                  : <div className="inventory-resources-grid">
                    <article className="inventory-resource-group">
                      <div className="inventory-resource-heading"><span><Camera size={15} aria-hidden="true" /><strong>{t("properties.inventoryPhotos")}</strong></span>{!readOnly && <>
                        <input ref={equipmentPhotoInputRef} className="sr-only" type="file" multiple accept={EQUIPMENT_PHOTO_ACCEPT} aria-label={t("properties.inventoryAddPhotos")} onChange={(event) => void uploadEquipmentAttachments(event, "photo")} />
                        <button type="button" className="secondary-button" disabled={equipmentResourcesBusy} onClick={() => equipmentPhotoInputRef.current?.click()}><Upload size={14} aria-hidden="true" />{t("properties.inventoryAddPhotos")}</button>
                      </>}</div>
                      <p>{t("properties.inventoryPhotoUploadHelp")}</p>
                      {equipmentAttachments.some((attachment) => attachment.kind === "photo") ? <div className="inventory-photo-grid">{equipmentAttachments.filter((attachment) => attachment.kind === "photo").map((attachment) => <figure key={attachment.id}>
                        <a href={api.equipmentAttachmentUrl(selectedEquipment.id, attachment.id)} target="_blank" rel="noreferrer"><img src={api.equipmentAttachmentUrl(selectedEquipment.id, attachment.id)} alt={attachment.name} /></a>
                        <figcaption><span title={attachment.name}>{attachment.name}</span><small>{attachmentSize(attachment.size)}</small></figcaption>
                        {!readOnly && <button type="button" className="icon-button small danger-icon" disabled={equipmentResourcesBusy} aria-label={`${t("common.delete")}: ${attachment.name}`} onClick={() => void removeEquipmentAttachment(attachment)}><Trash2 size={13} aria-hidden="true" /></button>}
                      </figure>)}</div> : <p className="inventory-resource-empty">{t("properties.inventoryNoPhotos")}</p>}
                    </article>
                    <article className="inventory-resource-group">
                      <div className="inventory-resource-heading"><span><FileText size={15} aria-hidden="true" /><strong>{t("properties.inventoryDocuments")}</strong></span>{!readOnly && <>
                        <input ref={equipmentDocumentInputRef} className="sr-only" type="file" multiple accept={EQUIPMENT_DOCUMENT_ACCEPT} aria-label={t("properties.inventoryAddDocuments")} onChange={(event) => void uploadEquipmentAttachments(event, "document")} />
                        <button type="button" className="secondary-button" disabled={equipmentResourcesBusy} onClick={() => equipmentDocumentInputRef.current?.click()}><Upload size={14} aria-hidden="true" />{t("properties.inventoryAddDocuments")}</button>
                      </>}</div>
                      <p>{t("properties.inventoryDocumentUploadHelp")}</p>
                      {equipmentAttachments.some((attachment) => attachment.kind === "document") ? <ul className="inventory-document-list">{equipmentAttachments.filter((attachment) => attachment.kind === "document").map((attachment) => <li key={attachment.id}>
                        <a href={api.equipmentAttachmentUrl(selectedEquipment.id, attachment.id)}><FileText size={15} aria-hidden="true" /><span><strong>{attachment.name}</strong><small>{attachment.mimeType}{" \u00b7 "}{attachmentSize(attachment.size)}</small></span></a>
                        {!readOnly && <button type="button" className="icon-button small danger-icon" disabled={equipmentResourcesBusy} aria-label={`${t("common.delete")}: ${attachment.name}`} onClick={() => void removeEquipmentAttachment(attachment)}><Trash2 size={13} aria-hidden="true" /></button>}
                      </li>)}</ul> : <p className="inventory-resource-empty">{t("properties.inventoryNoDocuments")}</p>}
                    </article>
                    <article className="inventory-resource-group inventory-link-group">
                      <div className="inventory-resource-heading"><span><LinkIcon size={15} aria-hidden="true" /><strong>{t("properties.inventoryLinks")}</strong></span></div>
                      <p>{t("properties.inventoryLinksHelp")}</p>
                      {equipmentLinks.length ? <ul className="inventory-link-list">{equipmentLinks.map((link) => <li key={link.id}>
                        <a href={link.url} target="_blank" rel="noreferrer"><span><strong>{link.label}</strong><small>{link.url}</small></span><ExternalLink size={14} aria-hidden="true" /></a>
                        {!readOnly && <button type="button" className="icon-button small danger-icon" disabled={equipmentResourcesBusy} aria-label={`${t("common.delete")}: ${link.label}`} onClick={() => void removeEquipmentLink(link)}><Trash2 size={13} aria-hidden="true" /></button>}
                      </li>)}</ul> : <p className="inventory-resource-empty">{t("properties.inventoryNoLinks")}</p>}
                      {!readOnly && <form className="inventory-link-form" onSubmit={(event) => void addEquipmentLink(event)}>
                        <label className="field"><span>{t("properties.inventoryLinkLabel")}</span><input required maxLength={200} value={equipmentLinkLabel} onChange={(event) => setEquipmentLinkLabel(event.target.value)} /></label>
                        <label className="field"><span>{t("properties.inventoryLinkUrl")}</span><input required type="url" maxLength={2048} value={equipmentLinkUrl} onChange={(event) => setEquipmentLinkUrl(event.target.value)} /></label>
                        <button type="submit" className="secondary-button" disabled={equipmentResourcesBusy || !equipmentLinkLabel.trim() || !equipmentLinkUrl.trim()}><Plus size={14} aria-hidden="true" />{t("properties.inventoryAddLink")}</button>
                      </form>}
                    </article>
                  </div>}
              {equipmentResourcesFeedback && <p className={`inventory-resources-feedback ${equipmentResourcesFeedback.kind}`} role={equipmentResourcesFeedback.kind === "error" ? "alert" : "status"}>{equipmentResourcesFeedback.text}</p>}
            </section>
            <section className="inventory-tag-panel">
              <div className="property-placement-group-header"><h3><Tag size={15} aria-hidden="true" />{t("properties.trackingTag")}</h3>{selectedTracking?.tag?.batteryPercent !== null && selectedTracking?.tag?.batteryPercent !== undefined && <span><Battery size={14} aria-hidden="true" />{selectedTracking.tag.batteryPercent}%</span>}</div>
              {!trackingEnabled ? <p className="property-help">{t("properties.trackingDisabledHelp")}</p> : selectedTracking?.tag ? <div className="inventory-assigned-tag">
                <div><strong>{selectedTracking.tag.serialNumber}</strong><small>{selectedTracking.tag.hardwareModel} · {selectedTracking.tag.status}</small></div>
                {canManageAccess && <button type="button" className="secondary-button danger-text" disabled={pending} onClick={() => void unassignTag()}>{t("properties.trackingTagUnassign")}</button>}
              </div> : canManageAccess ? <div className="inventory-tag-assignment">
                <label className="field"><span>{t("properties.trackingAvailableTag")}</span><select value={selectedTagId} onChange={(event) => setSelectedTagId(event.target.value)}><option value="">{t("properties.trackingChooseTag")}</option>{availableTrackingTags.map((tag) => <option key={tag.id} value={tag.id}>{tag.serialNumber} · {tag.hardwareModel}</option>)}</select></label>
                <button type="button" className="primary-button" disabled={pending || !selectedTagId} onClick={() => void assignTag(selectedTagId)}>{t("properties.trackingTagAssign")}</button>
              </div> : <p className="property-help">{t("properties.trackingNoTag")}</p>}
              {canManageAccess && trackingEnabled && trackingTags.some((tag) => tag.status === "provisioning") && <div className="inventory-provisioning-tags">
                {trackingTags.filter((tag) => tag.status === "provisioning").map((tag) => <article key={tag.id}><span><strong>{tag.serialNumber}</strong><small>{tag.hardwareModel}</small></span><button type="button" className="secondary-button" disabled={pending} onClick={() => void claimTag(tag.id)}>{t("properties.trackingTagClaim")}</button></article>)}
              </div>}
              {canManageAccess && trackingEnabled && <details className="inventory-tag-create">
                <summary>{t("properties.trackingRegisterTag")}</summary>
                <form onSubmit={(event) => void createTag(event)}>
                  <label className="field"><span>{t("properties.trackingTagSerial")}</span><input value={newTagSerial} onChange={(event) => setNewTagSerial(event.target.value)} /></label>
                  <label className="field"><span>{t("properties.trackingTagModel")}</span><input value={newTagModel} onChange={(event) => setNewTagModel(event.target.value)} /></label>
                  <button type="submit" className="secondary-button" disabled={pending || !newTagSerial.trim() || !newTagModel.trim()}>{t("properties.trackingRegisterTag")}</button>
                </form>
                {provisionedTag && <div className="inventory-provisioning-secret" role="status"><strong>{t("properties.trackingProvisioningSecret")}</strong><code>{provisionedTag.provisioningSecret}</code><small>{t("properties.trackingProvisioningSecretHelp")}</small></div>}
              </details>}
            </section>
          </section>}

          {!readOnly && <details className="panel inventory-editor" open={inventoryFormOpen} onToggle={(event) => {
            setInventoryFormOpen(event.currentTarget.open);
          }}>
            <summary><Plus size={17} aria-hidden="true" /><span><strong>{editingEquipmentId ? t("properties.editInventoryItem") : t("properties.addInventoryItem")}</strong><small>{t("properties.inventoryFormHelp")}</small></span><ChevronRight size={17} aria-hidden="true" /></summary>
            <form className="inventory-form" onSubmit={(event) => void saveEquipment(event)}>
              <label className="field"><span>{t("properties.equipmentName")}</span><input required value={equipmentName} onChange={(event) => setEquipmentName(event.target.value)} /></label>
              <label className="field"><span>{t("properties.equipmentKind")}</span><input required value={equipmentKind} onChange={(event) => setEquipmentKind(event.target.value)} /></label>
              <label className="field"><span>{t("properties.savedExpectedLocation")}</span><select value={equipmentDestination} onChange={(event) => setEquipmentDestination(event.target.value as EquipmentPlacement)}><option value="unassigned">{t("properties.inventoryUnassigned")}</option>{houses.length > 0 && <optgroup label={t("properties.houses")}>{houses.map((house) => <option key={house.id} value={`house:${house.id}`}>{house.name}</option>)}</optgroup>}{areas.length > 0 && <optgroup label={t("properties.areas")}>{areas.map((area) => <option key={area.id} value={`area:${area.id}`}>{area.name}</option>)}</optgroup>}{editingEquipmentId && properties.filter((candidate) => candidate.id !== property.id).map((candidate) => {
                const candidateHouses = state.houses.filter((house) => house.propertyId === candidate.id);
                const candidateAreas = state.propertyAreas.filter((area) => area.propertyId === candidate.id);
                if (!candidateHouses.length && !candidateAreas.length) return null;
                return <optgroup key={candidate.id} label={candidate.name}>
                  {candidateHouses.map((house) => <option key={house.id} value={`house:${house.id}`}>{t("properties.houses")}: {house.name}</option>)}
                  {candidateAreas.map((area) => <option key={area.id} value={`area:${area.id}`}>{t("properties.areas")}: {area.name}</option>)}
                </optgroup>;
              })}</select><small>{t("properties.savedExpectedLocationHelp")}</small></label>
              <label className="field"><span>{t("properties.equipmentStatusLabel")}</span><select value={equipmentStatus} onChange={(event) => setEquipmentStatus(event.target.value as AreaEquipmentStatus)}><option value="active">{t("properties.equipmentStatus.active")}</option><option value="out-of-service">{t("properties.equipmentStatus.out-of-service")}</option><option value="retired">{t("properties.equipmentStatus.retired")}</option></select></label>
              <label className="field"><span>{t("properties.equipmentManufacturer")}</span><input value={equipmentManufacturer} onChange={(event) => setEquipmentManufacturer(event.target.value)} /></label>
              <label className="field"><span>{t("properties.equipmentModel")}</span><input value={equipmentModel} onChange={(event) => setEquipmentModel(event.target.value)} /></label>
              <label className="field"><span>{t("properties.equipmentSerialNumber")}</span><input value={equipmentSerialNumber} onChange={(event) => setEquipmentSerialNumber(event.target.value)} /></label>
              <fieldset className="inventory-form-pin">
                <legend>{t("properties.inventoryManualPin")}</legend>
                <p>{t("properties.inventoryManualPinHelp")}</p>
                <details
                  className="inventory-pin-map-picker"
                  open={equipmentPinMapOpen}
                  onToggle={(event) => setEquipmentPinMapOpen(event.currentTarget.open)}
                >
                  <summary><MapIcon size={15} aria-hidden="true" />{t("properties.inventoryChooseOnMap")}</summary>
                  {equipmentPinMapOpen && <div className="inventory-pin-map-body">
                    <p>{t("properties.inventoryMapHint")}</p>
                    <div className="inventory-pin-map-shell">
                      <Suspense fallback={<output className="property-loading"><LoaderCircle className="spin" />{t("common.loading")}</output>}>
                        <PropertyAreaMap
                          areas={areas}
                          houses={houses}
                          propertyLocation={property.location}
                          propertyLabel={property.name}
                          selectedAreaId={null}
                          selectedEquipmentId={EQUIPMENT_DRAFT_MAP_ID}
                          editableEquipmentId={EQUIPMENT_DRAFT_MAP_ID}
                          equipment={equipmentPinMapItem ? [equipmentPinMapItem] : []}
                          onSelectArea={() => undefined}
                          onSelectHouse={() => undefined}
                          onSelectAsset={() => undefined}
                          onSelectEquipment={() => undefined}
                          onMoveEquipment={updateEquipmentPinFromMap}
                          onAppendVertex={() => undefined}
                          vertexLabel={() => ""}
                          midpointLabel={() => ""}
                          viewportKey={`inventory-pin:${property.id}`}
                          ariaLabel={t("properties.inventoryMapAria", {
                            name: equipmentName.trim() || t("properties.inventoryManualPin"),
                          })}
                        />
                      </Suspense>
                    </div>
                  </div>}
                </details>
                <label className="field"><span>{t("weather.latitude")}</span><input type="number" min={-90} max={90} step="any" inputMode="decimal" value={equipmentLatitude} onChange={(event) => setEquipmentLatitude(event.target.value)} /></label>
                <label className="field"><span>{t("weather.longitude")}</span><input type="number" min={-180} max={180} step="any" inputMode="decimal" value={equipmentLongitude} onChange={(event) => setEquipmentLongitude(event.target.value)} /></label>
                {!equipmentPinEmpty && <button type="button" className="text-button inventory-pin-clear" onClick={() => { setEquipmentLatitude(""); setEquipmentLongitude(""); }}>{t("properties.inventoryClearPin")}</button>}
                {!equipmentPinValid && <p className="inline-error" role="alert">{t("weather.invalidLocation")}</p>}
              </fieldset>
              <label className="field inventory-form-notes"><span>{t("properties.equipmentNotes")}</span><textarea rows={3} value={equipmentNotes} onChange={(event) => setEquipmentNotes(event.target.value)} /></label>
              <div className="inventory-form-actions"><button type="submit" className="primary-button" disabled={pending || !equipmentName.trim() || !equipmentKind.trim() || !equipmentPinValid}><Save size={14} aria-hidden="true" />{pending ? t("common.saving") : editingEquipmentId ? t("properties.saveEquipment") : t("properties.addEquipment")}</button>{editingEquipmentId && <button type="button" className="secondary-button" onClick={() => { clearEquipmentDraft("unassigned"); setInventoryFormOpen(false); }}>{t("common.cancel")}</button>}</div>
            </form>
          </details>}
        </section>}

        {tab === "map" && selectedArea && <details className="panel property-secondary-tools">
          <summary><HardHat size={17} aria-hidden="true" /><span><strong>{t("properties.areaOperations")}</strong><small>{selectedArea.name}</small></span><ChevronRight size={17} aria-hidden="true" /></summary>
          <section className="property-assets-grid" aria-label={t("properties.assets")}>
          <section className="panel">
            <div className="panel-header"><div><span className="eyebrow">{selectedArea?.name ?? t("properties.selectArea")}</span><h2>{t("properties.equipment")}</h2></div><HardHat size={20} /></div>
            {!selectedArea ? <p className="property-empty-copy">{t("properties.selectAreaHelp")}</p> : <>
              {equipment.filter((item) => item.areaId === selectedArea.id).length ? <div className="equipment-list">{equipment.filter((item) => item.areaId === selectedArea.id).map((item) => <article key={item.id}><div><strong>{item.name}</strong><small>{item.kind} · {t(`properties.equipmentStatus.${item.status}` as TranslationKey)}</small>{item.notes && <p>{item.notes}</p>}</div>{!readOnly && <div><button type="button" className="icon-button small" aria-label={`${t("properties.editInventoryItem")}: ${item.name}`} onClick={() => beginEquipmentEdit(item)}><ClipboardList size={14} /></button><button type="button" className="icon-button small danger-icon" aria-label={`${t("common.delete")}: ${item.name}`} onClick={() => void removeEquipment(item.id)}><Trash2 size={14} /></button></div>}</article>)}</div> : <p className="property-empty-copy">{t("properties.noEquipment")}</p>}
              {!readOnly && <button type="button" className="primary-button" onClick={() => { clearEquipmentDraft(`area:${selectedArea.id}`); setInventoryFormOpen(true); setTab("inventory"); }}><Plus size={14} />{t("properties.addEquipment")}</button>}
            </>}
          </section>
          <section className="panel">
            <div className="panel-header"><div><span className="eyebrow">{selectedArea?.name ?? t("properties.selectArea")}</span><h2>{t("properties.planMaintenance")}</h2></div><Wrench size={20} /></div>
            {!selectedArea ? <p className="property-empty-copy">{t("properties.selectAreaHelp")}</p> : <>
              {selectedAreaTasks.length > 0 ? <div className="area-maintenance-list">{selectedAreaTasks.map((task) => {
                const taskEquipment = equipment.find((item) => item.id === task.equipmentId);
                return <article key={task.id}><div><strong>{task.title}</strong><small>{t(`maintenance.status.${task.status}` as TranslationKey)}{taskEquipment ? ` · ${taskEquipment.name}` : ""}</small>{task.description && <p>{task.description}</p>}</div>{(task.dueBy || task.plannedFor) && <time dateTime={task.dueBy ?? task.plannedFor ?? undefined}>{task.dueBy ? t("maintenance.dueDate", { date: task.dueBy }) : t("maintenance.plannedDate", { date: task.plannedFor ?? "" })}</time>}</article>;
              })}</div> : <p className="property-empty-copy">{t("properties.noAreaMaintenance")}</p>}
              {readOnly ? <p className="property-help">{t("properties.readOnlyMaintenance")}</p> : <form className="maintenance-area-form" onSubmit={(event) => void planMaintenance(event)}><label className="field"><span>{t("properties.workTitle")}</span><input required value={maintenanceTitle} onChange={(event) => setMaintenanceTitle(event.target.value)} /></label>{houses.length > 0 && <label className="field"><span>{t("common.house")} · {t("common.optional")}</span><select value={maintenanceHouseId} onChange={(event) => setMaintenanceHouseId(event.target.value)}><option value="">{t("properties.noSchedulingHouse")}</option>{houses.map((house) => <option key={house.id} value={house.id}>{house.name}</option>)}</select></label>}<label className="field"><span>{t("properties.equipmentOptional")}</span><select value={maintenanceEquipmentId} onChange={(event) => setMaintenanceEquipmentId(event.target.value)}><option value="">{t("properties.wholeArea")}</option>{equipment.filter((item) => item.areaId === selectedArea.id).map((item) => <option key={item.id} value={item.id}>{item.name}</option>)}</select></label><button type="submit" className="primary-button" disabled={pending || !maintenanceTitle.trim()}><Wrench size={14} />{t("properties.planWork")}</button></form>}
            </>}
          </section>
          </section>
        </details>}

        {tab === "notes" && <section id="property-panel-notes" className="property-notes-grid" role="tabpanel" aria-labelledby="property-tab-notes"><section className="panel"><div className="panel-header"><div><span className="eyebrow">{property.name}</span><h2>{t("properties.notes")}</h2></div><NotebookPen size={20} /></div>{notes.length ? <div className="property-note-list">{notes.slice().sort((left, right) => right.updatedAt.localeCompare(left.updatedAt)).map((note) => <article key={note.id}><div><span>{t(`properties.noteKind.${note.kind}` as TranslationKey)}</span><strong>{targetLabel(note, state)}</strong><p>{note.text}</p><time dateTime={note.updatedAt}>{new Date(note.updatedAt).toLocaleDateString()}</time></div>{!readOnly && <div><button type="button" className="icon-button small" disabled={pending} aria-label={`${t("common.edit")}: ${note.text}`} onClick={() => { setEditingNoteId(note.id); setNoteText(note.text); setNoteKind(note.kind); setNoteTarget(note.equipmentId ? `equipment:${note.equipmentId}` : note.areaId ? `area:${note.areaId}` : note.houseId ? `house:${note.houseId}` : "property:"); }}><ClipboardList size={14} /></button><button type="button" className="icon-button small danger-icon" disabled={pending} aria-label={`${t("common.delete")}: ${note.text}`} onClick={() => void removeNote(note.id)}><Trash2 size={14} /></button></div>}</article>)}</div> : <p className="property-empty-copy">{t("properties.noNotes")}</p>}</section>{!readOnly && <section className="panel"><div className="panel-header"><div><span className="eyebrow">{editingNoteId ? t("properties.editNote") : t("properties.newNote")}</span><h2>{t("properties.recordContext")}</h2></div><Plus size={20} /></div><form className="property-note-form" onSubmit={(event) => void saveNote(event)}><label className="field"><span>{t("properties.noteKind")}</span><select value={noteKind} onChange={(event) => setNoteKind(event.target.value as PropertyNote["kind"])}><option value="note">{t("properties.noteKind.note")}</option><option value="inspection">{t("properties.noteKind.inspection")}</option><option value="maintenance">{t("properties.noteKind.maintenance")}</option></select></label><label className="field"><span>{t("properties.assignTo")}</span><select value={noteTarget} onChange={(event) => setNoteTarget(event.target.value)}><option value="property:">{property.name}</option><optgroup label={t("properties.houses")}>{houses.map((house) => <option key={house.id} value={`house:${house.id}`}>{house.name}</option>)}</optgroup><optgroup label={t("properties.areas")}>{areas.map((area) => <option key={area.id} value={`area:${area.id}`}>{area.name}</option>)}</optgroup><optgroup label={t("properties.equipment")}>{equipment.map((item) => <option key={item.id} value={`equipment:${item.id}`}>{item.name}</option>)}</optgroup></select></label><label className="field"><span>{t("properties.noteText")}</span><textarea required rows={5} value={noteText} onChange={(event) => setNoteText(event.target.value)} /></label><button type="submit" className="primary-button" disabled={pending || !noteText.trim()}><Save size={14} />{t("properties.saveNote")}</button></form></section>}</section>}

        {tab === "access" && canManageAccess && <section id="property-panel-access" role="tabpanel" aria-labelledby="property-tab-access"><AccessPanel
          state={state}
          properties={[property]}
          canRemoveGuests={false}
        /></section>}
        {feedback && <p className={`property-feedback ${feedback.kind}`} role={feedback.kind === "error" ? "alert" : "status"}>{feedback.text}</p>}
      </div>
    </div>
  </div>;
}
