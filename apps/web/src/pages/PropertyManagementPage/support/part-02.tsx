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
} from "@climate-twin/contracts";
import { api, ApiRequestError, subscribeToTrackingEvents, type HouseGeoreferencePatch } from "../../../api";
import { confirmAction } from "../../../components/ConfirmationProvider";
import { EquipmentQrLabel } from "../../../components/EquipmentQrLabel";
import { StugubyMark } from "../../../components/StugubyMark";
import { formatInTimeZone } from "../../../dateTime";
import type { ClimateState } from "../../../domain";
import { useI18n, type TranslationKey } from "../../../i18n";
import { derivePropertyTrafficLights, type PropertyTrafficLight } from "../../../propertyStatus";
import { useNow } from "../../../useNow";
import "../../PropertyManagementPage.css";
import { MAX_GUEST_ACCESS_GRANTS, guestActivationUrl, normalizeGuestGrants } from "./part-01";
import type { Feedback } from "./part-01";

export function toggledGuestGrants(
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
        : "");
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
    if (!selected || !canRemoveGuests || pending) return;
    if (!await confirmAction(
      t("properties.removeGuestConfirm", { email: selected.email }),
      t("properties.confirmRemoveGuest"),
    )) return;
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
      {workspaceMode && <details className="guest-invite-disclosure"><summary><Plus size={15} aria-hidden="true" /><span>{t("properties.addGuest")}</span></summary><form className="guest-invite-form" onSubmit={(event) => void invite(event)}><label className="field"><span>{t("properties.guestEmail")}</span><input type="email" required value={inviteEmail} onChange={(event) => setInviteEmail(event.target.value)} placeholder={t("properties.guestEmail")} /></label><button className="primary-button" type="submit" disabled={pending || !inviteEmail.trim()}><Plus size={15} />{pending ? t("auth.working") : t("properties.inviteGuest")}</button></form></details>}
      {workspaceMode && activation && <section className="guest-activation-card" aria-labelledby="guest-activation-title" aria-live="polite">
        <div><span><KeyRound size={15} aria-hidden="true" /></span><div><h3 id="guest-activation-title">{t("properties.activationReady")}</h3><p>{t("properties.activationReadyHelp", { email: activation.email })}</p></div><button type="button" className="icon-button small" onClick={() => setActivation(null)} aria-label={t("properties.dismissActivation")}><X size={15} aria-hidden="true" /></button></div>
        <label className="field"><span>{t("properties.activationLink")}</span><div className="guest-activation-copy"><input readOnly value={activation.url} onFocus={(event) => event.currentTarget.select()} /><button type="button" className="secondary-button" onClick={() => void copyActivation()}><Clipboard size={14} aria-hidden="true" />{t("properties.copyActivation")}</button></div></label>
        <small>{t("properties.activationExpires", { time: formatInTimeZone(activation.expiresAt, locale, undefined, { dateStyle: "medium", timeStyle: "short" }) })}</small>
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
        <div className="access-actions"><button type="button" className="primary-button access-save" disabled={pending || draftGrants.length > MAX_GUEST_ACCESS_GRANTS} onClick={() => void save()}><Save size={15} />{pending ? t("common.saving") : t("properties.saveAccess")}</button>{workspaceMode && canRemoveGuests && <button type="button" className="secondary-button danger-text" disabled={pending} onClick={() => void removeGuest()}><Trash2 size={15} aria-hidden="true" />{t("properties.removeGuest")}</button>}</div>
      </>}
      {feedback && <p className={`property-feedback ${feedback.kind}`} role={feedback.kind === "error" ? "alert" : "status"}>{feedback.text}</p>}
    </section>
  </div>;
}
