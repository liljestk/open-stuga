import { lazy, Suspense, useCallback, useEffect, useMemo, useRef, useState, type FormEvent, type KeyboardEvent as ReactKeyboardEvent } from "react";
import {
  Building2,
  Check,
  ChevronRight,
  Clipboard,
  ClipboardList,
  HardHat,
  KeyRound,
  LoaderCircle,
  Map as MapIcon,
  MapPin,
  Move,
  NotebookPen,
  Plus,
  Redo2,
  Save,
  ShieldCheck,
  Trash2,
  Undo2,
  Users,
  Wrench,
  X,
} from "lucide-react";
import type {
  AreaEquipment,
  AreaEquipmentInput,
  AreaEquipmentPatch,
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
} from "@climate-twin/contracts";
import { api, type HouseGeoreferencePatch } from "../api";
import type { ClimateState } from "../domain";
import { useI18n, type TranslationKey } from "../i18n";
import { derivePropertyTrafficLights, type PropertyTrafficLight } from "../propertyStatus";
import { useNow } from "../useNow";
import "./PropertyManagementPage.css";

const PropertyAreaMap = lazy(() => import("../components/PropertyAreaMap").then((module) => ({ default: module.PropertyAreaMap })));

type WorkspaceTab = "overview" | "map" | "notes" | "access";
type Feedback = { kind: "success" | "error"; text: string } | null;
export const MAX_GUEST_ACCESS_GRANTS = 100;

export function guestActivationUrl(registrationToken: string, origin = window.location.origin): string {
  const url = new URL("/", origin);
  url.hash = new URLSearchParams({ invite: registrationToken }).toString();
  return url.toString();
}

const areaKinds: PropertyAreaKind[] = [
  "well", "beach", "garage", "plantation", "garden", "field", "forest", "shoreline", "dock", "road", "yard", "building", "other",
];
const fixedAssetKinds = new Set<PropertyAreaKind>(["well", "garage", "dock", "building"]);
const NEW_FIXED_ASSET_ID = "__new-fixed-asset__";

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
  const [activation, setActivation] = useState<{ email: string; url: string; expiresAt: string } | null>(null);
  const [activationCopy, setActivationCopy] = useState<"idle" | "copied" | "failed">("idle");

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
      setActivation({ email, url: guestActivationUrl(created.registrationToken), expiresAt: created.expiresAt });
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
    if (!selected || !canRemoveGuests || pending || !window.confirm(t("properties.removeGuestConfirm", { email: selected.email }))) return;
    setPending(true);
    setFeedback(null);
    try {
      await api.removeTenantMember(selected.email);
      setMembers((current) => current.filter((member) => member.email !== selected.email));
      setInvitations((current) => current.filter((member) => member.email !== selected.email));
      if (activation?.email === selected.email) setActivation(null);
      setSelectedEmail("");
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
        <div className="access-actions"><button type="button" className="primary-button access-save" disabled={pending || draftGrants.length > MAX_GUEST_ACCESS_GRANTS} onClick={() => void save()}><Save size={15} />{pending ? t("common.saving") : t("properties.saveAccess")}</button>{workspaceMode && canRemoveGuests && <button type="button" className="secondary-button danger-text" disabled={pending} onClick={() => void removeGuest()}><Trash2 size={15} />{t("properties.removeGuest")}</button>}</div>
      </>}
      {feedback && <p className={`property-feedback ${feedback.kind}`} role={feedback.kind === "error" ? "alert" : "status"}>{feedback.text}</p>}
    </section>
  </div>;
}

export function PropertyManagementPage(props: Readonly<PropertyManagementPageProps>) {
  const { state } = props;
  const { t } = useI18n();
  const now = useNow();
  const readOnly = state.session.readOnly;
  const canManageAccess = !readOnly && (state.session.tenant.role === "owner" || state.session.tenant.role === "admin");
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
  const houses = useMemo(() => state.houses.filter((house) => house.propertyId === property?.id), [property?.id, state.houses]);
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
  const [equipmentDestinationAreaId, setEquipmentDestinationAreaId] = useState("");
  const [editingProperty, setEditingProperty] = useState(false);
  const [propertyName, setPropertyName] = useState("");
  const [propertyDescription, setPropertyDescription] = useState("");
  const [pending, setPending] = useState(false);
  const [feedback, setFeedback] = useState<Feedback>(null);
  const [editingEquipmentId, setEditingEquipmentId] = useState<string | null>(null);
  const [equipmentName, setEquipmentName] = useState("");
  const [equipmentKind, setEquipmentKind] = useState("");
  const [equipmentNotes, setEquipmentNotes] = useState("");
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

  const placementAsset = areas.find((area) => area.id === placementAssetId);
  const editingFixedAsset = isNewFixedAsset || Boolean(selectedArea && selectedArea.polygon.length === 0);
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
    setEquipmentNotes("");
    setEquipmentDestinationAreaId("");
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
  }, [houses]);
  const placementHouse = houses.find((house) => house.id === placementHouseId) ?? houses[0];
  useEffect(() => {
    if (!placementHouse || placementEditing) return;
    const source = placementHouse.mapPlacement ?? placementHouse.location;
    const floor = placementHouse.floors.find((candidate) => candidate.id === placementHouse.mapPlacement?.footprintFloorId)
      ?? placementHouse.floors.find((candidate) => candidate.type === "ground")
      ?? placementHouse.floors[0];
    setPlacementLatitude(source ? String(source.latitude) : "");
    setPlacementLongitude(source ? String(source.longitude) : "");
    setPlacementWidth(placementHouse.mapPlacement && floor
      ? String(Number((placementHouse.mapPlacement.metersPerPlanUnit * Math.max(1, floor.width)).toFixed(2)))
      : "12");
    setPlacementOrientation(placementHouse.orientationDegrees === undefined ? "" : String(placementHouse.orientationDegrees));
  }, [placementEditing, placementHouse?.id, placementHouse?.mapPlacement, placementHouse?.location, placementHouse?.orientationDegrees]);
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
    setEditingEquipmentId(null);
    setEquipmentName("");
    setEquipmentKind("");
    setEquipmentNotes("");
    setEquipmentDestinationAreaId("");
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
    setAssetPlacementEditing(false);
  }, [assetPlacementEditing, placementAssetId, selectedArea?.id, selectedArea?.updatedAt]);

  const tabs: Array<{ id: WorkspaceTab; key: TranslationKey; icon: typeof MapIcon }> = [
    { id: "overview", key: "nav.overview", icon: Building2 },
    { id: "map", key: "properties.map", icon: MapIcon },
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
    setSelectedAreaId(null);
    setIsNewArea(true);
    setIsNewFixedAsset(true);
    setDrawing(false);
    setAreaForm(emptyAreaDraft());
    setPlacementAssetId(NEW_FIXED_ASSET_ID);
    setAssetDraftLocation(null);
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
      || (editingFixedAsset ? !areaForm.location : areaForm.polygon.length < 3)) return;
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
      setAssetPlacementEditing(false);
      setAreaForm(emptyAreaDraft());
      setCoordinateInput("");
      setFeedback({ kind: "success", text: t("properties.areaDeleted") });
    } catch { setFeedback({ kind: "error", text: t("properties.areaDeleteFailed") }); }
    finally { setPending(false); }
  };

  const createProperty = async (event: FormEvent) => {
    event.preventDefault();
    if (readOnly || pending || !newPropertyName.trim()) return;
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
    if (!property || readOnly || pending || !window.confirm(t("properties.deletePropertyConfirm", { name: property.name }))) return;
    setPending(true);
    setFeedback(null);
    try {
      await props.onDeleteProperty(property.id);
      setPropertyId(properties.find((candidate) => candidate.id !== property.id)?.id ?? "");
    } catch { setFeedback({ kind: "error", text: t("properties.propertyDeleteFailed") }); }
    finally { setPending(false); }
  };

  const saveEquipment = async (event: FormEvent) => {
    event.preventDefault();
    if (!property || !selectedArea || readOnly || pending || !equipmentName.trim() || !equipmentKind.trim()) return;
    if (editingEquipmentId && !equipment.some((item) => item.id === editingEquipmentId && item.areaId === selectedArea.id)) {
      setEditingEquipmentId(null);
      setEquipmentName("");
      setEquipmentKind("");
      setEquipmentNotes("");
      setFeedback({ kind: "error", text: t("properties.equipmentSaveFailed") });
      return;
    }
    setPending(true);
    try {
      const destinationAreaId = editingEquipmentId ? equipmentDestinationAreaId || selectedArea.id : selectedArea.id;
      const destinationArea = state.propertyAreas.find((area) => area.id === destinationAreaId);
      if (!destinationArea) throw new Error("Destination area is unavailable");
      const common = { areaId: destinationArea.id, name: equipmentName.trim(), kind: equipmentKind.trim(), notes: equipmentNotes.trim() || null };
      if (editingEquipmentId) {
        const currentEquipment = state.areaEquipment.find((item) => item.id === editingEquipmentId);
        if (currentEquipment && currentEquipment.areaId !== destinationArea.id
          && !window.confirm(t("properties.moveEquipmentConfirm", { name: currentEquipment.name }))) return;
        await props.onUpdateEquipment(editingEquipmentId, common);
        setPropertyId(destinationArea.propertyId);
        setSelectedAreaId(destinationArea.id);
      }
      else await props.onCreateEquipment({ propertyId: property.id, ...common });
      setEquipmentName(""); setEquipmentKind(""); setEquipmentNotes(""); setEditingEquipmentId(null); setEquipmentDestinationAreaId("");
      setFeedback({ kind: "success", text: t("properties.equipmentSaved") });
    } catch { setFeedback({ kind: "error", text: t("properties.equipmentSaveFailed") }); }
    finally { setPending(false); }
  };

  const moveHouse = async (houseId: string, nextPropertyId: string) => {
    if (!property || readOnly || pending || nextPropertyId === property.id) return;
    const movingHouse = houses.find((house) => house.id === houseId);
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

  const selectPlacementHouse = (houseId: string) => {
    setAssetPlacementEditing(false);
    setPlacementEditing(false);
    setPlacementHouseId(houseId);
    setFeedback(null);
  };

  const updatePlacementFromMap = useCallback((houseId: string, point: GeoCoordinate) => {
    if (readOnly || pending || !props.onSetHouseGeoreference || !houses.some((house) => house.id === houseId)) return;
    setPlacementHouseId(houseId);
    setAssetPlacementEditing(false);
    setPlacementLatitude(String(point.latitude));
    setPlacementLongitude(String(point.longitude));
    setPlacementEditing(true);
    setMapLoaded(true);
    setFeedback(null);
  }, [houses, pending, props.onSetHouseGeoreference, readOnly]);

  const selectPlacementAsset = (assetId: string) => {
    if (assetId === NEW_FIXED_ASSET_ID) return;
    const asset = areas.find((candidate) => candidate.id === assetId);
    if (!asset) return;
    setPlacementEditing(false);
    setAssetPlacementEditing(false);
    setPlacementAssetId(asset.id);
    setAssetDraftLocation(asset.location ? { ...asset.location } : null);
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
      setAreaForm((current) => ({ ...current, location: point }));
      setAssetDraftLocation(point);
      setAssetPlacementEditing(true);
      setFeedback(null);
      return;
    }
    const asset = areas.find((candidate) => candidate.id === assetId);
    if (!asset) return;
    setSelectedAreaId(asset.id);
    setPlacementAssetId(asset.id);
    setAssetDraftLocation(point);
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
      await props.onUpdateArea(placementAsset.id, { location: null });
      setAssetDraftLocation(null);
      setAssetPlacementEditing(false);
      setFeedback({ kind: "success", text: t("properties.assetPlacementRemoved") });
    } catch { setFeedback({ kind: "error", text: t("properties.assetPlacementFailed") }); }
    finally { setPending(false); }
  };

  const saveHousePlacement = async (event: FormEvent) => {
    event.preventDefault();
    if (!placementHouse || !props.onSetHouseGeoreference || readOnly || pending) return;
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
    if (!placementHouse?.mapPlacement || !props.onSetHouseGeoreference || readOnly || pending || !window.confirm(t("properties.removePlacementConfirm", { name: placementHouse.name }))) return;
    setPending(true);
    setFeedback(null);
    try {
      await props.onSetHouseGeoreference(placementHouse.id, { mapPlacement: null, orientationDegrees: null });
      setPlacementEditing(false);
      setFeedback({ kind: "success", text: t("placement.removed") });
    } catch { setFeedback({ kind: "error", text: t("placement.saveError") }); }
    finally { setPending(false); }
  };

  if (properties.length === 0) return <section className="property-empty-page"><MapPin size={28} /><h1>{readOnly ? t("properties.noAccessTitle") : t("properties.emptyTitle")}</h1><p>{readOnly ? t("properties.noAccessBody") : t("properties.emptyBody")}</p>{!readOnly && <form onSubmit={(event) => void createProperty(event)}><label className="field"><span>{t("properties.propertyName")}</span><input autoFocus required value={newPropertyName} onChange={(event) => setNewPropertyName(event.target.value)} /></label><button type="submit" className="primary-button"><Plus size={15} />{t("properties.addProperty")}</button></form>}</section>;
  if (props.indexMode) return <div className="page-stack property-management-page property-index-page">
    <header className="page-heading property-heading"><div><span className="eyebrow"><MapPin size={14} />{t("properties.eyebrow", { count: properties.length })}</span><h1>{t("properties.title")}</h1><p>{t("properties.description")}</p></div>{readOnly && <span className="read-only-badge"><ShieldCheck size={15} />{t("properties.guestReadOnly")}</span>}</header>
    <section className="property-index-grid" aria-label={t("properties.title")}>
      {properties.map((item) => {
        const homeCount = state.houses.filter((home) => home.propertyId === item.id).length;
        const areaCount = state.propertyAreas.filter((area) => area.propertyId === item.id).length;
        return <article className="panel property-index-card" key={item.id}><span className="property-index-icon" aria-hidden="true"><MapPin size={19} /></span><div><h2>{item.name}</h2>{item.description && <p>{item.description}</p>}<small>{t("properties.summary", { houses: homeCount, areas: areaCount })}</small></div><button type="button" className="secondary-button" onClick={() => setPropertyId(item.id)}>{t("properties.openProperty", { property: item.name })}</button></article>;
      })}
    </section>
    {!readOnly && <form className="panel property-index-create" onSubmit={(event) => void createProperty(event)}><label className="field"><span>{t("properties.addAnotherProperty")}</span><input value={newPropertyName} onChange={(event) => setNewPropertyName(event.target.value)} /></label><button type="submit" className="primary-button" disabled={pending || !newPropertyName.trim()}><Plus size={14} />{t("properties.addProperty")}</button></form>}
    {feedback && <p className={`property-feedback ${feedback.kind}`} role={feedback.kind === "error" ? "alert" : "status"}>{feedback.text}</p>}
  </div>;
  if (!property) return null;

  return <div className="page-stack property-management-page">
    <header className="page-heading property-heading"><div><span className="eyebrow"><MapPin size={14} />{t("bootstrap.propertyForHome")}</span><h1>{property.name}</h1><p>{property.description || t("properties.description")}</p></div>{readOnly && <span className="read-only-badge"><ShieldCheck size={15} />{t("properties.guestReadOnly")}</span>}</header>
    <div className="property-layout">
      <aside className="panel property-sidebar">
        {!props.onProperty && <label className="field"><span>{t("properties.activeProperty")}</span><select value={property.id} onChange={(event) => setPropertyId(event.target.value)}>{properties.map((item) => <option key={item.id} value={item.id}>{item.name}</option>)}</select></label>}
        {editingProperty && !readOnly ? <form className="property-edit-form" onSubmit={(event) => void saveProperty(event)}><label className="field"><span>{t("properties.propertyName")}</span><input required value={propertyName} onChange={(event) => setPropertyName(event.target.value)} /></label><label className="field"><span>{t("properties.propertyDescription")}</span><textarea rows={3} value={propertyDescription} onChange={(event) => setPropertyDescription(event.target.value)} /></label><div><button type="button" className="secondary-button" onClick={() => setEditingProperty(false)}>{t("common.cancel")}</button><button type="submit" className="primary-button"><Save size={14} />{t("properties.saveProperty")}</button></div></form> : <div className="property-summary"><strong>{property.name}</strong>{property.description && <p>{property.description}</p>}<small>{t("properties.summary", { houses: houses.length, areas: areas.length })}</small>{!readOnly && <button type="button" className="text-button" onClick={() => setEditingProperty(true)}>{t("properties.editProperty")}</button>}</div>}
        {!readOnly && property.id !== "property-main" && properties.length > 1 && houses.length === 0 && areas.length === 0 && equipment.length === 0 && notes.length === 0 && !state.maintenanceTasks.some((task) => task.propertyId === property.id) && <button type="button" className="text-button danger-text" disabled={pending} onClick={() => void removeProperty()}><Trash2 size={14} />{t("properties.deleteEmptyProperty")}</button>}
        <section className="property-house-group">
          <h2><Building2 size={15} />{t("properties.houses")}</h2>
          {houses.length ? <ul>{houses.map((house) => <li key={house.id}><Building2 size={13} /><span><strong>{house.name}</strong><small>{house.location?.label ?? house.timezone}</small>{!readOnly && properties.length > 1 && <label><span>{t("properties.moveHouse")}</span><select value={property.id} disabled={pending} onChange={(event) => void moveHouse(house.id, event.target.value)}>{properties.map((candidate) => <option key={candidate.id} value={candidate.id}>{candidate.name}</option>)}</select></label>}</span></li>)}</ul> : <p>{t("properties.noHouses")}</p>}
          {!readOnly && <form className="property-create-form compact" onSubmit={(event) => void createHouse(event)}><label className="field"><span>{t("properties.addHomeToProperty")}</span><input value={newHouseName} onChange={(event) => setNewHouseName(event.target.value)} placeholder={t("bootstrap.defaultHomeName")} /></label><button type="submit" className="secondary-button" disabled={pending || !newHouseName.trim()}><Plus size={14} />{t("properties.addHome")}</button></form>}
        </section>
        <section className="property-area-list"><div><h2><MapIcon size={15} />{t("properties.areas")}</h2><span>{areas.length}</span></div>{areas.length ? <div>{areas.map((area) => <button key={area.id} type="button" aria-pressed={selectedAreaId === area.id} className={selectedAreaId === area.id ? "active" : ""} onClick={() => setSelectedAreaId(area.id)}><MapPin size={14} /><span><strong>{area.name}</strong><small>{t(`properties.areaKind.${area.kind}` as TranslationKey)}</small></span></button>)}</div> : <p>{t("properties.noAreas")}</p>}{!readOnly && <button type="button" className="structure-add-button" onClick={startArea}><Plus size={15} />{t("properties.addArea")}</button>}</section>
        {!readOnly && <form className="property-create-form" onSubmit={(event) => void createProperty(event)}><label className="field"><span>{t("properties.addAnotherProperty")}</span><input value={newPropertyName} onChange={(event) => setNewPropertyName(event.target.value)} /></label><button type="submit" className="secondary-button" disabled={!newPropertyName.trim()}><Plus size={14} />{t("common.add")}</button></form>}
      </aside>
      <div className="property-workspace">
        <div className="property-tabs" role="tablist" aria-label={t("properties.workspaceNavigation")}>{tabs.map(({ id, key, icon: Icon }, index) => <button key={id} id={`property-tab-${id}`} type="button" role="tab" aria-selected={tab === id} aria-controls={`property-panel-${id}`} tabIndex={tab === id ? 0 : -1} onKeyDown={(event) => chooseTabFromKeyboard(event, index)} onClick={() => setTab(id)}><Icon size={16} />{t(key)}</button>)}</div>

        {tab === "overview" && <section id="property-panel-overview" className="property-overview-workspace" role="tabpanel" aria-labelledby="property-tab-overview">
          <section className="panel property-overview-status">
            <div className="panel-header"><div><span className="eyebrow">{property.name}</span><h2>{t("properties.status.title")}</h2></div><Building2 size={20} aria-hidden="true" /></div>
            <PropertyStatusLights lights={propertyTrafficLights} />
          </section>
          <div className="property-overview-actions">
            <button type="button" className="panel" onClick={() => setTab("map")}><MapIcon size={22} aria-hidden="true" /><span><strong>{t("properties.map")}</strong><small>{t("properties.summary", { houses: houses.length, areas: areas.length })}</small></span><ChevronRight size={18} aria-hidden="true" /></button>
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
                  houses={mapHouses}
                  propertyLocation={property.location}
                  selectedAreaId={selectedAreaId}
                  selectedHouseId={placementHouse?.id ?? null}
                  editableHouseId={placementEditing && !readOnly ? placementHouse?.id ?? null : null}
                  selectedAssetId={isNewArea && isNewFixedAsset ? NEW_FIXED_ASSET_ID : placementAsset?.id ?? null}
                  editableAssetId={assetPlacementEditing && !readOnly ? (isNewArea && isNewFixedAsset ? NEW_FIXED_ASSET_ID : placementAsset?.id ?? null) : null}
                  draftPolygon={!isNewFixedAsset && (isNewArea || selectedArea) ? areaForm.polygon : null}
                  drawing={drawing && !readOnly}
                  onSelectArea={setSelectedAreaId}
                  onSelectHouse={selectPlacementHouse}
                  onMoveHouse={updatePlacementFromMap}
                  onSelectAsset={selectPlacementAsset}
                  onMoveAsset={updateAssetPlacementFromMap}
                  onAppendVertex={appendVertex}
                  onMoveVertex={moveVertex}
                  onInsertVertex={insertVertex}
                  onFinishDrawing={() => setDrawing(false)}
                  vertexLabel={vertexLabel}
                  midpointLabel={midpointLabel}
                  ariaLabel={t("properties.mapAria", { property: property.name })}
                  viewportKey={property.id}
                />
                {drawing && <span className="property-drawing-cue"><MapPin size={14} />{t("properties.drawHint")}</span>}
                {placementEditing && placementHouse && <span className="property-drawing-cue"><Move size={14} />{t("placement.editingHint", { house: placementHouse.name })}</span>}
                {assetPlacementEditing && <span className="property-drawing-cue"><Move size={14} />{t("properties.assetPlacementHint")}</span>}
              </div>
            </Suspense>}
          </div>
          {(houses.length > 0 || fixedAssets.length > 0 || !readOnly) && <section className="panel property-home-placement">
            <div className="panel-header"><div><span className="eyebrow">{property.name}</span><h2>{t("properties.mapItems")}</h2></div><MapPin size={20} aria-hidden="true" /></div>
            <p className="property-help">{t("properties.mapItemsHelp")}</p>
            {houses.length > 0 && props.onSetHouseGeoreference && <section className="property-placement-group">
            <h3><Building2 size={15} aria-hidden="true" />{t("properties.houses")}</h3>
            <div className="property-placement-house-list" role="group" aria-label={t("placement.houseList")}>{houses.map((candidate) => <button key={candidate.id} type="button" draggable={!readOnly} aria-pressed={candidate.id === placementHouse?.id} onClick={() => selectPlacementHouse(candidate.id)} onDragStart={(event) => { selectPlacementHouse(candidate.id); event.dataTransfer.effectAllowed = "move"; event.dataTransfer.setData("application/x-stuga-house-id", candidate.id); }}><Building2 size={15} aria-hidden="true" /><span><strong>{candidate.name}</strong><small>{candidate.mapPlacement ? t("placement.scaled") : candidate.location ? t("placement.pinOnly") : t("placement.unplaced")}</small></span></button>)}</div>
            {placementHouse && <form className="property-placement-form" onSubmit={(event) => void saveHousePlacement(event)}>
              <details className="property-placement-advanced">
                <summary><span>{t("setup.advancedPlacement")}</span><small>{t("setup.manualCoordinates")}</small></summary>
                <div className="property-placement-fields">
                  <label className="field"><span>{t("weather.latitude")}</span><input type="number" min={-90} max={90} step="any" required value={placementLatitude} onChange={(event) => { setPlacementLatitude(event.target.value); setPlacementEditing(true); }} /></label>
                  <label className="field"><span>{t("weather.longitude")}</span><input type="number" min={-180} max={180} step="any" required value={placementLongitude} onChange={(event) => { setPlacementLongitude(event.target.value); setPlacementEditing(true); }} /></label>
                  <label className="field"><span>{t("placement.widthMeters")}</span><input type="number" min={1} max={500} step="0.1" required value={placementWidth} onChange={(event) => { setPlacementWidth(event.target.value); setPlacementEditing(true); }} /></label>
                  <label className="field"><span>{t("orientation.degrees")}</span><input type="number" min={0} max={359} step={1} value={placementOrientation} onChange={(event) => { setPlacementOrientation(event.target.value); setPlacementEditing(true); }} /></label>
                </div>
              </details>
              <div className="property-placement-actions">
                {!placementEditing && <button type="button" className="primary-button" onClick={() => { setMapLoaded(true); setDrawing(false); setPlacementEditing(true); setFeedback(null); }}><Move size={15} aria-hidden="true" />{placementHouse.mapPlacement ? t("placement.move") : t("placement.place")}</button>}
                {placementEditing && <><button type="submit" className="primary-button" disabled={pending || !placementDraftIsValid}>{pending ? <LoaderCircle className="spin" size={15} aria-hidden="true" /> : <Save size={15} aria-hidden="true" />}{pending ? t("common.saving") : t("placement.save")}</button><button type="button" className="secondary-button" disabled={pending} onClick={() => setPlacementEditing(false)}>{t("common.cancel")}</button></>}
                {placementHouse.mapPlacement && <button type="button" className="secondary-button danger-text" disabled={pending} onClick={() => void removeHousePlacement()}><Trash2 size={15} aria-hidden="true" />{t("placement.remove")}</button>}
              </div>
            </form>}
            </section>}
            <section className="property-placement-group">
              <div className="property-placement-group-header"><h3><MapPin size={15} aria-hidden="true" />{t("properties.fixedAssets")}</h3>{!readOnly && <button type="button" className="text-button" onClick={startFixedAsset}><Plus size={14} aria-hidden="true" />{t("properties.addFixedAsset")}</button>}</div>
              {fixedAssets.length > 0 ? <div className="property-placement-house-list property-placement-asset-list" role="group" aria-label={t("properties.fixedAssets")}>
                {fixedAssets.map((asset) => <button key={asset.id} type="button" draggable={!readOnly} aria-pressed={asset.id === placementAsset?.id} onClick={() => selectPlacementAsset(asset.id)} onDragStart={(event) => { selectPlacementAsset(asset.id); event.dataTransfer.effectAllowed = "move"; event.dataTransfer.setData("application/x-stuga-property-asset-id", asset.id); }}><MapPin size={15} aria-hidden="true" /><span><strong>{asset.name}</strong><small>{asset.location ? t("properties.assetPlaced") : t("placement.unplaced")}</small></span></button>)}
              </div> : <p className="property-empty-copy">{t("properties.noFixedAssets")}</p>}
              {placementAsset && <div className="property-placement-actions">
                {!assetPlacementEditing && <button type="button" className="primary-button" onClick={() => { setMapLoaded(true); setDrawing(false); setPlacementEditing(false); setAssetDraftLocation(placementAsset.location ? { ...placementAsset.location } : null); setAssetPlacementEditing(true); setFeedback(null); }}><MapPin size={15} aria-hidden="true" />{placementAsset.location ? t("properties.moveAsset") : t("properties.placeAsset")}</button>}
                {assetPlacementEditing && <><button type="button" className="primary-button" disabled={pending || !assetDraftLocation} onClick={() => void saveAssetPlacement()}><Save size={15} aria-hidden="true" />{pending ? t("common.saving") : t("placement.save")}</button><button type="button" className="secondary-button" disabled={pending} onClick={() => { setAssetDraftLocation(placementAsset.location ? { ...placementAsset.location } : null); setAssetPlacementEditing(false); }}>{t("common.cancel")}</button></>}
                {placementAsset.location && <button type="button" className="secondary-button danger-text" disabled={pending} onClick={() => void removeAssetPlacement()}><Trash2 size={15} aria-hidden="true" />{t("placement.remove")}</button>}
              </div>}
            </section>
          </section>}
          {(selectedArea || isNewArea) && <section className="panel area-editor"><div className="panel-header"><div><span className="eyebrow">{isNewFixedAsset ? t("properties.newFixedAsset") : isNewArea ? t("properties.newArea") : t("properties.selectedArea")}</span><h2>{areaForm.name || (editingFixedAsset ? t("properties.unnamedFixedAsset") : t("properties.unnamedArea"))}</h2></div><MapPin size={20} /></div>
            <div className="area-form-grid">
              <label className="field"><span>{editingFixedAsset ? t("properties.assetName") : t("properties.areaName")}</span><input required value={areaForm.name} disabled={readOnly} onChange={(event) => setAreaForm((current) => ({ ...current, name: event.target.value }))} /></label>
              <label className="field"><span>{editingFixedAsset ? t("properties.assetKind") : t("properties.areaKind")}</span><select value={areaForm.kind} disabled={readOnly} onChange={(event) => setAreaForm((current) => ({ ...current, kind: event.target.value as PropertyAreaKind }))}>{areaKinds.map((kind) => <option key={kind} value={kind}>{t(`properties.areaKind.${kind}` as TranslationKey)}</option>)}</select></label>
              {selectedArea && properties.length > 1 && <label className="field area-description"><span>{t("properties.moveAreaTo")}</span><select value={areaDestinationPropertyId} disabled={readOnly || pending} onChange={(event) => setAreaDestinationPropertyId(event.target.value)}>{properties.map((candidate) => <option key={candidate.id} value={candidate.id}>{candidate.name}</option>)}</select><small>{t("properties.moveAreaHelp")}</small></label>}
              <label className="field area-description"><span>{t("properties.areaDescription")}</span><textarea rows={2} value={areaForm.description} disabled={readOnly} onChange={(event) => setAreaForm((current) => ({ ...current, description: event.target.value }))} /></label>
            </div>
            {editingFixedAsset ? <p className={`property-asset-location-status ${areaForm.location ? "placed" : ""}`}><MapPin size={15} aria-hidden="true" />{areaForm.location ? t("properties.assetDraftPlaced") : t("properties.assetDraftHint")}</p> : <>
              {!readOnly && <div className="area-drawing-actions"><button type="button" className={drawing ? "secondary-button active" : "secondary-button"} onClick={() => setDrawing((value) => !value)}><MapPin size={14} />{drawing ? t("properties.finishDrawing") : t("properties.editBoundary")}</button><button type="button" className="secondary-button" disabled={!areaForm.polygon.length} onClick={undoVertex}><Undo2 size={14} />{t("common.undo")}</button><button type="button" className="secondary-button" disabled={!redoVertices.length} onClick={redoVertex}><Redo2 size={14} />{t("common.redo")}</button><button type="button" className="secondary-button" disabled={!areaForm.polygon.length} onClick={() => { setAreaForm((current) => ({ ...current, polygon: [] })); setCoordinateInput(""); setRedoVertices([]); }}>{t("properties.clear")}</button></div>}
              <details className="area-coordinate-editor"><summary>{t("properties.manualCoordinates")}</summary><p>{t("properties.manualCoordinatesHelp")}</p><label className="field"><span>{t("properties.vertices")}</span><textarea rows={Math.max(4, areaForm.polygon.length)} value={coordinateInput} disabled={readOnly} onChange={(event) => { setCoordinateInput(event.target.value); setCoordinateError(false); }} /></label>{coordinateError && <p className="inline-error" role="alert">{t("properties.invalidCoordinates")}</p>}{!readOnly && <button type="button" className="secondary-button" onClick={applyCoordinates}><Check size={14} />{t("properties.applyCoordinates")}</button>}</details>
              <p className="property-help">{t("properties.vertexCount", { count: areaForm.polygon.length })}</p>
            </>}
            {!readOnly && <div className="area-editor-actions"><button type="button" className="primary-button" disabled={pending || !areaForm.name.trim() || (editingFixedAsset ? !areaForm.location : areaForm.polygon.length < 3)} onClick={() => void saveArea()}><Save size={15} />{pending ? t("common.saving") : editingFixedAsset ? t("properties.saveFixedAsset") : t("properties.saveArea")}</button>{selectedArea && <button type="button" className="secondary-button danger-text" disabled={pending} onClick={() => void removeArea()}><Trash2 size={14} />{t("common.delete")}</button>}</div>}
          </section>}
        </section>}

        {tab === "map" && selectedArea && <details className="panel property-secondary-tools">
          <summary><HardHat size={17} aria-hidden="true" /><span><strong>{t("properties.areaOperations")}</strong><small>{selectedArea.name}</small></span><ChevronRight size={17} aria-hidden="true" /></summary>
          <section className="property-assets-grid" aria-label={t("properties.assets")}>
          <section className="panel">
            <div className="panel-header"><div><span className="eyebrow">{selectedArea?.name ?? t("properties.selectArea")}</span><h2>{t("properties.equipment")}</h2></div><HardHat size={20} /></div>
            {!selectedArea ? <p className="property-empty-copy">{t("properties.selectAreaHelp")}</p> : <>
              {equipment.filter((item) => item.areaId === selectedArea.id).length ? <div className="equipment-list">{equipment.filter((item) => item.areaId === selectedArea.id).map((item) => <article key={item.id}><div><strong>{item.name}</strong><small>{item.kind} · {t(`properties.equipmentStatus.${item.status}` as TranslationKey)}</small>{item.notes && <p>{item.notes}</p>}</div>{!readOnly && <div><button type="button" className="icon-button small" aria-label={`${t("common.edit")}: ${item.name}`} onClick={() => { setEditingEquipmentId(item.id); setEquipmentName(item.name); setEquipmentKind(item.kind); setEquipmentNotes(item.notes ?? ""); setEquipmentDestinationAreaId(item.areaId); }}><ClipboardList size={14} /></button><button type="button" className="icon-button small danger-icon" aria-label={`${t("common.delete")}: ${item.name}`} onClick={() => void removeEquipment(item.id)}><Trash2 size={14} /></button></div>}</article>)}</div> : <p className="property-empty-copy">{t("properties.noEquipment")}</p>}
              {!readOnly && <form className="equipment-form" onSubmit={(event) => void saveEquipment(event)}>
                <label className="field"><span>{t("properties.equipmentName")}</span><input required value={equipmentName} onChange={(event) => setEquipmentName(event.target.value)} /></label>
                <label className="field"><span>{t("properties.equipmentKind")}</span><input required value={equipmentKind} onChange={(event) => setEquipmentKind(event.target.value)} /></label>
                {editingEquipmentId && <label className="field equipment-target"><span>{t("properties.moveEquipmentTo")}</span><select value={equipmentDestinationAreaId} onChange={(event) => setEquipmentDestinationAreaId(event.target.value)}>{properties.map((candidate) => <optgroup key={candidate.id} label={candidate.name}>{state.propertyAreas.filter((area) => area.propertyId === candidate.id).map((area) => <option key={area.id} value={area.id}>{area.name}</option>)}</optgroup>)}</select><small>{t("properties.moveEquipmentHelp")}</small></label>}
                <label className="field equipment-notes"><span>{t("properties.equipmentNotes")}</span><textarea rows={2} value={equipmentNotes} onChange={(event) => setEquipmentNotes(event.target.value)} /></label>
                <button type="submit" className="primary-button" disabled={pending || !equipmentName.trim() || !equipmentKind.trim() || Boolean(editingEquipmentId && !equipmentDestinationAreaId)}><Plus size={14} />{editingEquipmentId ? t("properties.saveEquipment") : t("properties.addEquipment")}</button>
              </form>}
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
