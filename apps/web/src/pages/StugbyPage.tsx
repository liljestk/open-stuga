import { useCallback, useEffect, useMemo, useRef, useState, type FormEvent } from "react";
import type { House } from "@climate-twin/contracts";
import {
  STUGBY_DATASETS,
  type StugbyDataset,
  type StugbyDatasetGrant,
  type StugbyMember,
  type StugbyRole,
  type StugbyShareGrant,
  type StugbySharedProperty,
  type StugbySummary,
} from "@climate-twin/stugby-protocol";
import { Check, Copy, Database, KeyRound, Link, LoaderCircle, Network, Pencil, Plus, RefreshCw, Settings2, ShieldCheck, Sparkles, Trash2, Users } from "lucide-react";
import {
  api,
  type StugbyDetailResponse,
  type StugbyInvitationCreated,
  type StugbyListResponse,
  type StugbyLocalPublicationCatalog,
  type StugbyRemoteTelemetrySample,
} from "../api";
import { useI18n, type TranslationKey } from "../i18n";
import "./StugbyPage.css";

interface StugbyPageProps {
  houses: Array<Pick<House, "id" | "name" | "propertyId">>;
}

interface DatasetDraft {
  enabled: boolean;
  includeLocalIds: boolean;
  allowReplicaCache: boolean;
  retentionDays: number;
}

type PublicationCatalogState =
  | { status: "idle"; stugbyId: null; houseId: null; data: null; error: null }
  | { status: "loading"; stugbyId: string; houseId: string; data: null; error: null }
  | { status: "ready"; stugbyId: string; houseId: string; data: StugbyLocalPublicationCatalog; error: null }
  | { status: "error"; stugbyId: string; houseId: string; data: null; error: string };

const idlePublicationCatalog = (): PublicationCatalogState => ({
  status: "idle",
  stugbyId: null,
  houseId: null,
  data: null,
  error: null,
});

const datasetLabelKeys: Record<StugbyDataset, TranslationKey> = {
  "home.directory.v1": "stugby.dataset.directory",
  "home.location.v1": "stugby.dataset.location",
  "home.structure.v1": "stugby.dataset.structure",
  "home.floorplan.v1": "stugby.dataset.floorplan",
  "home.sensor-catalog.v1": "stugby.dataset.sensors",
  "home.telemetry.v1": "stugby.dataset.telemetry",
  "home.notes.v1": "stugby.dataset.notes",
  "home.observations.v1": "stugby.dataset.observations",
};

const roleLabelKeys: Record<StugbyRole, TranslationKey> = {
  steward: "stugby.role.steward",
  "property-manager": "stugby.role.propertyManager",
  participant: "stugby.role.participant",
  viewer: "stugby.role.viewer",
};

const memberStateLabelKeys: Record<StugbyMember["state"], TranslationKey> = {
  invited: "stugby.state.invited",
  active: "stugby.state.active",
  suspended: "stugby.state.suspended",
  left: "stugby.state.left",
  revoked: "stugby.state.revoked",
};

function initialDatasetDraft(): Record<StugbyDataset, DatasetDraft> {
  return Object.fromEntries(STUGBY_DATASETS.map((dataset) => [dataset, {
    enabled: ["home.directory.v1", "home.structure.v1", "home.sensor-catalog.v1"].includes(dataset),
    includeLocalIds: false,
    allowReplicaCache: true,
    retentionDays: dataset === "home.telemetry.v1" ? 7 : 30,
  }])) as Record<StugbyDataset, DatasetDraft>;
}

function errorMessage(error: unknown, fallback: string): string {
  return error instanceof Error && error.message.trim() ? error.message : fallback;
}

function formattedTime(value: string | null, never: string, locale: string): string {
  if (!value) return never;
  const date = new Date(value);
  return Number.isFinite(date.getTime()) ? date.toLocaleString(locale) : value;
}

export function localDateTimeInput(value: string | null): string {
  if (!value) return "";
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) return "";
  return new Date(date.getTime() - date.getTimezoneOffset() * 60_000).toISOString().slice(0, 16);
}

function parseArray(value: string, label: string, invalidJson: string, notArray: string): unknown[] {
  let parsed: unknown;
  try { parsed = JSON.parse(value); } catch { throw new Error(invalidJson.replace("{label}", label)); }
  if (!Array.isArray(parsed)) throw new Error(notArray.replace("{label}", label));
  return parsed;
}

export function StugbyPage({ houses }: Readonly<StugbyPageProps>) {
  const { locale, t } = useI18n();
  const roleLabel = (role: StugbyRole) => t(roleLabelKeys[role]);
  const stateLabel = (state: StugbyMember["state"]) => t(memberStateLabelKeys[state]);
  const [index, setIndex] = useState<StugbyListResponse | null>(null);
  const [detail, setDetail] = useState<StugbyDetailResponse | null>(null);
  const [selectedId, setSelectedId] = useState("");
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [detailLoading, setDetailLoading] = useState(false);
  const [telemetryError, setTelemetryError] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const [createdInvitation, setCreatedInvitation] = useState<StugbyInvitationCreated | null>(null);
  const [telemetrySamples, setTelemetrySamples] = useState<StugbyRemoteTelemetrySample[]>([]);

  const [createName, setCreateName] = useState(() => t("stugby.defaultName"));
  const [createDescription, setCreateDescription] = useState("");
  const [joinCoordinatorUrl, setJoinCoordinatorUrl] = useState(() => window.location.origin);
  const [joinUrl, setJoinUrl] = useState("");
  const [joinInvitationId, setJoinInvitationId] = useState("");
  const [joinSecret, setJoinSecret] = useState("");
  const [inviteRole, setInviteRole] = useState<Exclude<StugbyRole, "steward">>("participant");
  const [inviteExpiresAt, setInviteExpiresAt] = useState("");

  const [grantHouseId, setGrantHouseId] = useState(() => houses[0]?.id ?? "");
  const [audienceKind, setAudienceKind] = useState<"all-members" | "members">("all-members");
  const [audienceNodes, setAudienceNodes] = useState<string[]>([]);
  const [datasetDraft, setDatasetDraft] = useState(initialDatasetDraft);
  const [telemetryLive, setTelemetryLive] = useState(true);
  const [telemetryHistoryHours, setTelemetryHistoryHours] = useState("24");
  const [telemetryMetrics, setTelemetryMetrics] = useState("temperature, humidity");
  const [telemetrySensors, setTelemetrySensors] = useState("");
  const [telemetryRate, setTelemetryRate] = useState("5000");
  const [grantExpiresAt, setGrantExpiresAt] = useState("");
  const [editingGrantId, setEditingGrantId] = useState<string | null>(null);
  const [publicationCatalog, setPublicationCatalog] = useState<PublicationCatalogState>(idlePublicationCatalog);
  const [catalogRevision, setCatalogRevision] = useState(0);

  const [propertyName, setPropertyName] = useState("");
  const [propertyDescription, setPropertyDescription] = useState("");
  const [propertyLatitude, setPropertyLatitude] = useState("");
  const [propertyLongitude, setPropertyLongitude] = useState("");
  const [propertyLocationLabel, setPropertyLocationLabel] = useState("");
  const [areasJson, setAreasJson] = useState("[]");
  const [equipmentJson, setEquipmentJson] = useState("[]");
  const [notesJson, setNotesJson] = useState("[]");
  const [maintenanceJson, setMaintenanceJson] = useState("[]");

  const detailRequest = useRef(0);
  const selectedIdRef = useRef("");

  const resetGrantDraft = useCallback(() => {
    setGrantHouseId(houses[0]?.id ?? "");
    setAudienceKind("all-members");
    setAudienceNodes([]);
    setDatasetDraft(initialDatasetDraft());
    setTelemetryLive(true);
    setTelemetryHistoryHours("24");
    setTelemetryMetrics("temperature, humidity");
    setTelemetrySensors("");
    setTelemetryRate("5000");
    setGrantExpiresAt("");
    setEditingGrantId(null);
    setPublicationCatalog(idlePublicationCatalog());
    setCatalogRevision((current) => current + 1);
  }, [houses]);

  const resetStugbyScopedUi = useCallback(() => {
    resetGrantDraft();
    setCreatedInvitation(null);
    setCopied(false);
    setInviteRole("participant");
    setInviteExpiresAt("");
    setTelemetrySamples([]);
    setTelemetryError(null);
    setNotice(null);
  }, [resetGrantDraft]);

  const beginSelection = useCallback((id: string) => {
    selectedIdRef.current = id;
    setSelectedId(id);
    setDetail(null);
    resetStugbyScopedUi();
  }, [resetStugbyScopedUi]);

  const loadDetail = useCallback(async (id: string) => {
    const request = ++detailRequest.current;
    setDetailLoading(true);
    setTelemetryError(null);
    try {
      const loaded = await api.stugby(id);
      if (request !== detailRequest.current || selectedIdRef.current !== id) return loaded;
      setDetail(loaded);
      try {
        const samples = (await api.stugbyTelemetry(id)).samples;
        if (request === detailRequest.current && selectedIdRef.current === id) setTelemetrySamples(samples);
      } catch (nextError) {
        if (request === detailRequest.current && selectedIdRef.current === id) {
          setTelemetrySamples([]);
          setTelemetryError(errorMessage(nextError, t("stugby.telemetryLoadError")));
        }
      }
      return loaded;
    } finally {
      if (request === detailRequest.current && selectedIdRef.current === id) setDetailLoading(false);
    }
  }, [t]);

  const load = useCallback(async (preferredId?: string) => {
    setError(null);
    try {
      const loaded = await api.stugbys();
      setIndex(loaded);
      const id = preferredId || selectedIdRef.current || loaded.stugbys[0]?.id || "";
      if (id !== selectedIdRef.current) beginSelection(id);
      if (id) await loadDetail(id);
      else {
        detailRequest.current += 1;
        beginSelection("");
        setDetailLoading(false);
      }
    } catch (nextError) {
      setError(errorMessage(nextError, t("stugby.operationFailed")));
      if (!index) {
        detailRequest.current += 1;
        setDetail(null);
        setDetailLoading(false);
      }
    } finally {
      setLoading(false);
    }
  }, [beginSelection, index, loadDetail, t]);

  useEffect(() => { void load(); }, []); // Initial owner-controlled load only.

  useEffect(() => {
    const property = detail?.sharedProperty;
    if (!property) return;
    setPropertyName(property.name);
    setPropertyDescription(property.description ?? "");
    setPropertyLatitude(property.location ? String(property.location.latitude) : "");
    setPropertyLongitude(property.location ? String(property.location.longitude) : "");
    setPropertyLocationLabel(property.location?.label ?? "");
    setAreasJson(JSON.stringify(property.areas, null, 2));
    setEquipmentJson(JSON.stringify(property.equipment, null, 2));
    setNotesJson(JSON.stringify(property.notes, null, 2));
    setMaintenanceJson(JSON.stringify(property.maintenance, null, 2));
  }, [detail?.sharedProperty]);

  useEffect(() => {
    if (!joinUrl.trim()) return;
    try {
      const parsed = new URL(joinUrl);
      const [invitationId, secret] = parsed.hash.slice(1).split(".", 2);
      if (invitationId && secret) {
        setJoinCoordinatorUrl(`${parsed.protocol}//${parsed.host}`);
        setJoinInvitationId(decodeURIComponent(invitationId));
        setJoinSecret(secret);
      }
    } catch { /* The three explicit fields remain available. */ }
  }, [joinUrl]);

  useEffect(() => {
    let active = true;
    if (!detail || !grantHouseId || detail.stugby.localMemberState !== "active" || detail.stugby.localRole === "viewer") {
      setPublicationCatalog(idlePublicationCatalog());
      return () => { active = false; };
    }
    const stugbyId = detail.stugby.id;
    const houseId = grantHouseId;
    setPublicationCatalog({ status: "loading", stugbyId, houseId, data: null, error: null });
    void api.stugbyPublications(detail.stugby.id, grantHouseId)
      .then((catalog) => {
        if (active) setPublicationCatalog({ status: "ready", stugbyId, houseId, data: catalog, error: null });
      })
      .catch((nextError: unknown) => {
        if (active) setPublicationCatalog({
          status: "error",
          stugbyId,
          houseId,
          data: null,
          error: errorMessage(nextError, t("stugby.sensorCatalogError")),
        });
      });
    return () => { active = false; };
  }, [catalogRevision, detail?.stugby.id, detail?.stugby.localMemberState, detail?.stugby.localRole, grantHouseId, t]);

  const withBusy = async (key: string, operation: () => Promise<void>): Promise<void> => {
    setBusy(key);
    setError(null);
    setNotice(null);
    try { await operation(); } catch (nextError) { setError(errorMessage(nextError, t("stugby.operationFailed"))); }
    finally { setBusy(null); }
  };

  const createStugby = (event: FormEvent) => {
    event.preventDefault();
    void withBusy("create", async () => {
      const created = await api.createStugby({ name: createName, description: createDescription || null });
      setCreateName(t("stugby.defaultName"));
      setCreateDescription("");
      resetStugbyScopedUi();
      await load(created.id);
    });
  };

  const joinStugby = (event: FormEvent) => {
    event.preventDefault();
    void withBusy("join", async () => {
      const joined = await api.joinStugby({ coordinatorUrl: joinCoordinatorUrl, invitationId: joinInvitationId, joinSecret });
      setJoinUrl(""); setJoinInvitationId(""); setJoinSecret("");
      resetStugbyScopedUi();
      await load(joined.id);
    });
  };

  const activeRemoteMembers = useMemo(() => detail?.members.filter((member) => (
    member.state === "active" && member.nodeId !== index?.identity.nodeId
  )) ?? [], [detail?.members, index?.identity.nodeId]);

  const saveGrant = (event: FormEvent) => {
    event.preventDefault();
    if (!detail || detail.stugby.id !== selectedIdRef.current) return;
    if (audienceKind === "members" && audienceNodes.length === 0) {
      setError(t("stugby.audienceRequired"));
      return;
    }
    const telemetryEnabled = datasetDraft["home.telemetry.v1"].enabled;
    const catalogMatches = publicationCatalog.status === "ready"
      && publicationCatalog.stugbyId === detail.stugby.id
      && publicationCatalog.houseId === grantHouseId;
    if (telemetryEnabled && !catalogMatches) {
      setError(t("stugby.sensorCatalogRequired"));
      return;
    }
    if (datasetDraft["home.location.v1"].enabled && !window.confirm(t("stugby.confirmLocationShare"))) return;
    const selectedDetail = detail;
    void withBusy("grant", async () => {
      const datasets: StugbyDatasetGrant[] = STUGBY_DATASETS.map((dataset) => {
        const draft = datasetDraft[dataset];
        const base: StugbyDatasetGrant = {
          dataset,
          enabled: draft.enabled,
          includeLocalIds: draft.includeLocalIds,
          allowReplicaCache: draft.allowReplicaCache,
          retentionDays: draft.retentionDays,
        };
        if (dataset !== "home.telemetry.v1" || !draft.enabled) return base;
        const hours = Number(telemetryHistoryHours);
        const rate = Number(telemetryRate);
        return {
          ...base,
          telemetry: {
            sensorPublicationIds: telemetrySensors.split(",").map((sensor) => sensor.trim()).filter(Boolean),
            metricIds: telemetryMetrics.split(",").map((metric) => metric.trim()).filter(Boolean),
            historyFrom: Number.isFinite(hours) && hours > 0 ? new Date(Date.now() - hours * 3_600_000).toISOString() : null,
            live: telemetryLive,
            maxSamplesPerHour: Number.isSafeInteger(rate) && rate > 0 ? rate : 5_000,
          },
        };
      }).filter((dataset) => dataset.enabled);
      const audience = { kind: audienceKind, nodeIds: audienceKind === "members" ? audienceNodes : [] } as const;
      const expiresAt = grantExpiresAt ? new Date(grantExpiresAt).toISOString() : null;
      const existing = editingGrantId ? selectedDetail.grants.find((grant) => grant.id === editingGrantId) : null;
      if (editingGrantId && !existing) throw new Error(t("stugby.grantScopeChanged"));
      if (existing) await api.updateStugbyGrant(selectedDetail.stugby.id, existing.id, { baseRevision: existing.revision, audience, datasets, expiresAt });
      else await api.createStugbyGrant(selectedDetail.stugby.id, { localHouseId: grantHouseId, audience, datasets, expiresAt });
      setNotice(t("stugby.changesSaved"));
      resetGrantDraft();
      await loadDetail(selectedDetail.stugby.id);
    });
  };

  const editGrant = (grant: StugbyShareGrant) => {
    const drafts = Object.fromEntries(STUGBY_DATASETS.map((dataset) => {
      const configured = grant.datasets.find((item) => item.dataset === dataset);
      return [dataset, configured ? {
        enabled: configured.enabled,
        includeLocalIds: configured.includeLocalIds,
        allowReplicaCache: configured.allowReplicaCache,
        retentionDays: configured.retentionDays,
      } : { enabled: false, includeLocalIds: false, allowReplicaCache: true, retentionDays: dataset === "home.telemetry.v1" ? 7 : 30 }];
    })) as Record<StugbyDataset, DatasetDraft>;
    const telemetry = grant.datasets.find((item) => item.dataset === "home.telemetry.v1")?.telemetry;
    setEditingGrantId(grant.id);
    if (grant.localHouseId) setGrantHouseId(grant.localHouseId);
    setAudienceKind(grant.audience.kind);
    setAudienceNodes(grant.audience.nodeIds);
    setDatasetDraft(drafts);
    setTelemetryLive(telemetry?.live ?? false);
    setTelemetryMetrics(telemetry?.metricIds.join(", ") ?? "");
    setTelemetrySensors(telemetry?.sensorPublicationIds.join(", ") ?? "");
    setTelemetryRate(String(telemetry?.maxSamplesPerHour ?? 5_000));
    setTelemetryHistoryHours(telemetry?.historyFrom ? String(Math.max(0, Math.round((Date.now() - Date.parse(telemetry.historyFrom)) / 3_600_000))) : "0");
    setGrantExpiresAt(localDateTimeInput(grant.expiresAt));
  };

  const saveProperty = (event: FormEvent) => {
    event.preventDefault();
    if (!detail?.sharedProperty) return;
    const selected = detail;
    const baseRevision = detail.sharedProperty.revision;
    void withBusy("property", async () => {
      const latitudeText = propertyLatitude.trim();
      const longitudeText = propertyLongitude.trim();
      if (Boolean(latitudeText) !== Boolean(longitudeText)) throw new Error(t("stugby.coordinatesTogether"));
      const hasLocation = Boolean(latitudeText && longitudeText);
      const latitude = hasLocation ? Number(latitudeText) : 0;
      const longitude = hasLocation ? Number(longitudeText) : 0;
      if (hasLocation && (!Number.isFinite(latitude) || !Number.isFinite(longitude)
        || latitude < -90 || latitude > 90 || longitude < -180 || longitude > 180)) {
        throw new Error(t("stugby.invalidCoordinates"));
      }
      const property: Pick<StugbySharedProperty, "name" | "description" | "location" | "areas" | "equipment" | "notes" | "maintenance"> = {
        name: propertyName,
        description: propertyDescription || null,
        location: hasLocation ? { latitude, longitude, ...(propertyLocationLabel.trim() ? { label: propertyLocationLabel.trim() } : {}) } : null,
        areas: parseArray(areasJson, t("stugby.areas"), t("stugby.invalidJson"), t("stugby.jsonArrayRequired")) as StugbySharedProperty["areas"],
        equipment: parseArray(equipmentJson, t("stugby.equipment"), t("stugby.invalidJson"), t("stugby.jsonArrayRequired")) as StugbySharedProperty["equipment"],
        notes: parseArray(notesJson, t("stugby.notes"), t("stugby.invalidJson"), t("stugby.jsonArrayRequired")) as StugbySharedProperty["notes"],
        maintenance: parseArray(maintenanceJson, t("stugby.maintenance"), t("stugby.invalidJson"), t("stugby.jsonArrayRequired")) as StugbySharedProperty["maintenance"],
      };
      await api.updateStugbyProperty(selected.stugby.id, baseRevision, property);
      setNotice(t("stugby.changesSaved"));
      await loadDetail(selected.stugby.id);
    });
  };

  const updateMember = (member: StugbyMember, input: { role?: StugbyRole; state?: StugbyMember["state"] }) => {
    if (!detail || detail.stugby.id !== selectedIdRef.current) return;
    const nextState = input.state ?? member.state;
    if (input.state && nextState !== member.state
      && !window.confirm(t("stugby.confirmMemberState", { name: member.displayName, state: stateLabel(nextState) }))) return;
    void withBusy(`member:${member.nodeId}`, async () => {
      await api.updateStugbyMember(detail.stugby.id, member.nodeId, { role: input.role ?? member.role, state: nextState });
      setNotice(t("stugby.changesSaved"));
      await loadDetail(detail.stugby.id);
    });
  };

  if (loading) return <output className="page-loading"><LoaderCircle className="spin" size={20} aria-hidden="true" />{t("common.loading")}</output>;

  const currentDetail = detail?.stugby.id === selectedId ? detail : null;
  const coordinator = currentDetail?.stugby.localMemberState === "active" && currentDetail.stugby.localRole === "steward";
  const propertyWriter = currentDetail?.stugby.localMemberState === "active"
    && ["steward", "property-manager"].includes(currentDetail.stugby.localRole);
  const canPublish = currentDetail?.stugby.localMemberState === "active" && currentDetail.stugby.localRole !== "viewer";
  const cannotPublishMessage = currentDetail?.stugby.localMemberState !== "active"
    ? t("stugby.inactiveCannotPublish", { state: currentDetail ? stateLabel(currentDetail.stugby.localMemberState) : "" })
    : t("stugby.viewerCannotPublish");
  const matchingCatalog = currentDetail && publicationCatalog.status === "ready"
    && publicationCatalog.stugbyId === currentDetail.stugby.id
    && publicationCatalog.houseId === grantHouseId
    ? publicationCatalog.data
    : null;
  const catalogMatches = matchingCatalog !== null;
  const connectionSetup = <div className="stugby-onboarding-grid">
    <form className="stugby-card stugby-setup-card" onSubmit={createStugby}>
      <div className="stugby-card-title"><Network size={19} aria-hidden="true" /><div><h2>{t("stugby.createTitle")}</h2><p>{t("stugby.createBody")}</p></div></div>
      <label className="field"><span>{t("stugby.name")}</span><input required maxLength={200} value={createName} onChange={(event) => setCreateName(event.target.value)} /></label>
      {!index?.publicOrigin && <p className="stugby-capability-note">{t("stugby.httpsHelp")}</p>}
      <details className="stugby-subdetails">
        <summary>{t("nav.advanced")}</summary>
        <div className="stugby-subdetails-body">
          <label className="field"><span>{t("stugby.descriptionField")}</span><textarea value={createDescription} onChange={(event) => setCreateDescription(event.target.value)} /></label>
          <label className="field"><span>{t("stugby.coordinatorUrl")}</span><input readOnly type="url" value={index?.publicOrigin ?? ""} placeholder={t("stugby.httpsHelp")} /></label>
        </div>
      </details>
      <button className="primary-button" disabled={busy !== null || !index?.publicOrigin}>{busy === "create" ? <LoaderCircle className="spin" size={16} /> : <Network size={16} />}{t("stugby.create")}</button>
    </form>

    <form className="stugby-card stugby-setup-card" onSubmit={joinStugby}>
      <div className="stugby-card-title"><Link size={19} aria-hidden="true" /><div><h2>{t("stugby.joinTitle")}</h2><p>{t("stugby.joinBody")}</p></div></div>
      <label className="field"><span>{t("stugby.invitationLink")}</span><input type="url" value={joinUrl} onChange={(event) => setJoinUrl(event.target.value)} placeholder={t("stugby.invitationPlaceholder")} /><small>{t("stugby.invitationHelp")}</small></label>
      <details className="stugby-subdetails">
        <summary>{t("stugby.manualJoin")}</summary>
        <div className="stugby-subdetails-body">
          <label className="field"><span>{t("stugby.coordinatorUrl")}</span><input required type="url" value={joinCoordinatorUrl} onChange={(event) => setJoinCoordinatorUrl(event.target.value)} /></label>
          <label className="field"><span>{t("stugby.invitationId")}</span><input required value={joinInvitationId} onChange={(event) => setJoinInvitationId(event.target.value)} /></label>
          <label className="field"><span>{t("stugby.joinSecret")}</span><input required type="password" autoComplete="off" value={joinSecret} onChange={(event) => setJoinSecret(event.target.value)} /></label>
        </div>
      </details>
      <button className="primary-button" disabled={busy !== null || !joinCoordinatorUrl || !joinInvitationId || !joinSecret}>{busy === "join" ? <LoaderCircle className="spin" size={16} /> : <Link size={16} />}{t("stugby.joinWithoutSharing")}</button>
    </form>
  </div>;

  return <div className="stugby-page">
    <header className="stugby-page-header">
      <div><span className="eyebrow">{t("stugby.eyebrow")}</span><h1>{t("nav.stugbys")}</h1><p>{t("stugby.description")}</p></div>
      <Network size={30} aria-hidden="true" />
    </header>

    <section className="stugby-boundary" aria-labelledby="stugby-boundary-title">
      <ShieldCheck size={24} aria-hidden="true" />
      <div><h2 id="stugby-boundary-title">{t("stugby.boundaryTitle")}</h2><p>{t("stugby.boundaryBody")}</p></div>
    </section>

    {error && <p className="inline-error stugby-error" role="alert">{error}</p>}
    {notice && <p className="stugby-notice" role="status">{notice}</p>}

    {!index ? <section className="stugby-card stugby-load-failure" aria-labelledby="stugby-load-failure-title">
      <Database size={22} aria-hidden="true" />
      <div><h2 id="stugby-load-failure-title">{t("stugby.loadFailedTitle")}</h2><p>{t("stugby.loadFailedBody")}</p></div>
      <button type="button" className="primary-button" disabled={busy !== null} onClick={() => void withBusy("retry", async () => { await load(); })}>
        <RefreshCw size={16} aria-hidden="true" />{t("stugby.retry")}
      </button>
    </section> : <>
      {index.stugbys.length === 0 ? connectionSetup : <details className="stugby-card stugby-collapsible stugby-connect-panel">
        <summary><Plus size={18} aria-hidden="true" /><span><strong>{t("stugby.connectAnother")}</strong><small>{t("stugby.connectAnotherBody")}</small></span></summary>
        <div className="stugby-collapsible-body">{connectionSetup}</div>
      </details>}

    {index.stugbys.length > 0 && <>
      <nav className="stugby-selector" aria-label={t("nav.stugbys")}>
        {index.stugbys.map((stugby) => <button
          key={stugby.id}
          type="button"
          className={selectedId === stugby.id ? "active" : ""}
          aria-current={selectedId === stugby.id ? "true" : undefined}
          disabled={busy !== null || detailLoading}
          onClick={() => {
            if (stugby.id === selectedId && currentDetail) return;
            beginSelection(stugby.id);
            void withBusy("select", async () => { await loadDetail(stugby.id); });
          }}
        ><strong>{stugby.name}</strong><span>{roleLabel(stugby.localRole)} · {t(stugby.memberCount === 1 ? "stugby.nodeCountOne" : "stugby.nodeCountMany", { count: stugby.memberCount })}</span></button>)}
      </nav>

      {detailLoading && <output className="stugby-detail-loading"><LoaderCircle className="spin" size={18} aria-hidden="true" />{t("stugby.loadingSelection")}</output>}
      {detail && detail.stugby.id === selectedId && <div className="stugby-detail">
        <section className="stugby-card stugby-summary-card">
          <div><span className={`status-dot ${detail.stugby.lastSyncError ? "error" : ""}`} aria-hidden="true" /> <strong>{stateLabel(detail.stugby.localMemberState)}</strong></div>
          <dl><div><dt>{t("stugby.localRole")}</dt><dd>{roleLabel(detail.stugby.localRole)}</dd></div><div><dt>{t("stugby.syncAutomatic")}</dt><dd>{formattedTime(detail.stugby.lastSyncAt, t("stugby.never"), locale)}</dd></div></dl>
          <details className="stugby-summary-actions">
            <summary>{t("nav.advanced")}</summary>
            <div><small>{t("stugby.coordinator")}</small><code>{detail.stugby.coordinatorUrl}</code><button type="button" className="secondary-button" disabled={busy !== null || detail.stugby.localMemberState === "left" || detail.stugby.localMemberState === "revoked"} onClick={() => void withBusy("sync", async () => { await api.syncStugby(detail.stugby.id); await load(detail.stugby.id); })}><RefreshCw aria-hidden="true" className={busy === "sync" ? "spin" : ""} size={16} />{t("stugby.syncNow")}</button></div>
          </details>
          {detail.stugby.lastSyncError && <p className="inline-error stugby-summary-error" role="alert">{detail.stugby.lastSyncError}</p>}
        </section>

        <section className="stugby-card">
          <div className="stugby-card-title"><Users size={19} aria-hidden="true" /><div><h2>{t("stugby.participants")}</h2><p>{t("stugby.nodeRolesBody")}</p></div></div>
          <div className="stugby-member-list">{detail.members.map((member) => <div className="stugby-member" key={member.nodeId}>
            <div><strong>{member.displayName}</strong><small>{member.keyFingerprint.slice(0, 12)}… · {stateLabel(member.state)}</small></div>
            {coordinator && member.role !== "steward" ? <><select aria-label={`${t("stugby.localRole")}: ${member.displayName}`} value={member.role} disabled={busy !== null} onChange={(event) => updateMember(member, { role: event.target.value as StugbyRole })}><option value="property-manager">{t("stugby.role.propertyManager")}</option><option value="participant">{t("stugby.role.participant")}</option><option value="viewer">{t("stugby.role.viewer")}</option></select><select aria-label={`${t("stugby.memberState")}: ${member.displayName}`} value={member.state} disabled={busy !== null} onChange={(event) => updateMember(member, { state: event.target.value as StugbyMember["state"] })}><option value="active">{t("stugby.state.active")}</option><option value="suspended">{t("stugby.state.suspended")}</option><option value="left">{t("stugby.state.left")}</option><option value="revoked">{t("stugby.state.revoked")}</option></select></> : <span className="role-pill">{roleLabel(member.role)}</span>}
          </div>)}</div>
          {coordinator && <form className="stugby-invite-form" onSubmit={(event) => {
            event.preventDefault(); void withBusy("invite", async () => {
              setCreatedInvitation(await api.createStugbyInvitation(detail.stugby.id, {
                role: inviteRole,
                ...(inviteExpiresAt ? { expiresAt: new Date(inviteExpiresAt).toISOString() } : {}),
              }));
              setInviteExpiresAt("");
              await loadDetail(detail.stugby.id);
            });
          }}>
            <div className="stugby-quick-action">
              <div><strong>{t("stugby.createInvitation")}</strong><small>{inviteRole === "participant" && !inviteExpiresAt ? t("stugby.invitationDefaults") : `${roleLabel(inviteRole)} · ${inviteExpiresAt || t("stugby.never")}`}</small></div>
              <button className="primary-button" disabled={busy !== null}>{busy === "invite" ? <LoaderCircle className="spin" size={16} /> : <KeyRound size={16} />}{t("stugby.createInvitation")}</button>
            </div>
            <details className="stugby-subdetails">
              <summary>{t("stugby.invitationOptions")}</summary>
              <div className="stugby-form-grid stugby-subdetails-body"><label className="field"><span>{t("stugby.newRole")}</span><select value={inviteRole} onChange={(event) => setInviteRole(event.target.value as typeof inviteRole)}><option value="participant">{t("stugby.role.participant")}</option><option value="property-manager">{t("stugby.role.propertyManager")}</option><option value="viewer">{t("stugby.role.viewer")}</option></select></label><label className="field"><span>{t("stugby.invitationExpiry")}</span><input type="datetime-local" value={inviteExpiresAt} onChange={(event) => setInviteExpiresAt(event.target.value)} /></label></div>
            </details>
          </form>}
          {createdInvitation?.stugbyId === detail.stugby.id && <div className="stugby-invitation" role="status"><strong>{t("stugby.invitationOnce")}</strong><code>{createdInvitation.joinUrl}</code><button type="button" className="secondary-button" onClick={() => void (async () => {
            try {
              if (!navigator.clipboard?.writeText) throw new Error("Clipboard unavailable");
              await navigator.clipboard.writeText(createdInvitation.joinUrl);
              setCopied(true);
              window.setTimeout(() => setCopied(false), 1500);
            } catch {
              setError(t("stugby.copyFailed"));
            }
          })()}>{copied ? <Check size={16} aria-hidden="true" /> : <Copy size={16} aria-hidden="true" />}{t(copied ? "stugby.copied" : "stugby.copy")}</button></div>}
          {coordinator && <details className="stugby-subdetails"><summary>{t("stugby.invitations")} ({detail.invitations.length})</summary><div className="stugby-existing-grants stugby-subdetails-body">{detail.invitations.length === 0 ? <p>{t("stugby.noInvitations")}</p> : detail.invitations.map((invitation) => {
            const active = !invitation.usedAt && !invitation.revokedAt && Date.parse(invitation.expiresAt) > Date.now();
            const status = invitation.usedAt ? t("stugby.invitationUsed") : invitation.revokedAt ? t("stugby.invitationRevoked") : active ? t("stugby.invitationActive") : t("stugby.invitationExpired");
            return <article key={invitation.id}><div className="stugby-record-copy"><strong>{roleLabel(invitation.role)}</strong><span>{status} · {formattedTime(invitation.expiresAt, t("stugby.never"), locale)}</span><small>{invitation.id}</small></div>{active && <div className="stugby-record-actions"><button type="button" className="danger-button" disabled={busy !== null} onClick={() => {
              if (!window.confirm(t("stugby.confirmRevokeInvitation", { id: invitation.id.slice(0, 12) }))) return;
              void withBusy(`invitation:${invitation.id}`, async () => { await api.revokeStugbyInvitation(detail.stugby.id, invitation.id); setNotice(t("stugby.changesSaved")); await loadDetail(detail.stugby.id); });
            }}><Trash2 size={15} aria-hidden="true" />{t("stugby.revokeInvitation")}</button></div>}</article>;
          })}</div></details>}
        </section>

        <details className="stugby-card stugby-collapsible stugby-property-editor">
          <summary><Database size={19} aria-hidden="true" /><span><strong>{t("stugby.sharedProperty")}</strong><small>{t("stugby.sharedPropertyBody")}</small></span></summary>
          <form className="stugby-collapsible-body" onSubmit={saveProperty}>
          {!detail.sharedProperty ? <p>{t("stugby.noSharedProperty")}</p> : <>
            {!propertyWriter && <p className="stugby-capability-note">{detail.stugby.localMemberState !== "active" ? t("stugby.inactiveCannotEdit", { state: stateLabel(detail.stugby.localMemberState) }) : t("stugby.roleCannotEdit")}</p>}
            <div className="stugby-form-grid"><label className="field"><span>{t("stugby.name")}</span><input required value={propertyName} disabled={!propertyWriter} onChange={(event) => setPropertyName(event.target.value)} /></label><label className="field"><span>{t("stugby.descriptionField")}</span><input value={propertyDescription} disabled={!propertyWriter} onChange={(event) => setPropertyDescription(event.target.value)} /></label><label className="field"><span>{t("stugby.latitude")}</span><input type="number" min="-90" max="90" step="any" value={propertyLatitude} disabled={!propertyWriter} onChange={(event) => setPropertyLatitude(event.target.value)} /></label><label className="field"><span>{t("stugby.longitude")}</span><input type="number" min="-180" max="180" step="any" value={propertyLongitude} disabled={!propertyWriter} onChange={(event) => setPropertyLongitude(event.target.value)} /></label><label className="field"><span>{t("stugby.locationLabel")}</span><input value={propertyLocationLabel} disabled={!propertyWriter} onChange={(event) => setPropertyLocationLabel(event.target.value)} /></label></div>
            <details className="stugby-subdetails">
              <summary>{t("nav.advanced")}</summary>
              <div className="stugby-subdetails-body"><p className="stugby-json-help">{t("stugby.jsonHelp")}</p>
                <div className="stugby-json-grid"><label className="field"><span>{t("stugby.areas")}</span><textarea value={areasJson} disabled={!propertyWriter} onChange={(event) => setAreasJson(event.target.value)} /></label><label className="field"><span>{t("stugby.equipment")}</span><textarea value={equipmentJson} disabled={!propertyWriter} onChange={(event) => setEquipmentJson(event.target.value)} /></label><label className="field"><span>{t("stugby.notes")}</span><textarea value={notesJson} disabled={!propertyWriter} onChange={(event) => setNotesJson(event.target.value)} /></label><label className="field"><span>{t("stugby.maintenance")}</span><textarea value={maintenanceJson} disabled={!propertyWriter} onChange={(event) => setMaintenanceJson(event.target.value)} /></label></div>
              </div>
            </details>
            {propertyWriter && <button className="primary-button" disabled={busy !== null}>{busy === "property" ? <LoaderCircle className="spin" size={16} /> : <Check size={16} />}{t("stugby.saveRevision", { revision: detail.sharedProperty.revision + 1 })}</button>}
          </>}
          </form>
        </details>

        <section className="stugby-card stugby-grants">
          <div className="stugby-card-title"><ShieldCheck size={19} aria-hidden="true" /><div><h2>{t("stugby.grantsTitle")}</h2><p>{t("stugby.grantsBody")}</p></div></div>
          {canPublish ? <form onSubmit={saveGrant}>
            <div className="stugby-form-grid"><label className="field"><span>{t("stugby.localHome")}</span><select required disabled={editingGrantId !== null} value={grantHouseId} onChange={(event) => { setGrantHouseId(event.target.value); setTelemetrySensors(""); }}><option value="" disabled>{t("stugby.chooseHome")}</option>{houses.map((house) => <option key={house.id} value={house.id}>{house.name}</option>)}</select></label><label className="field"><span>{t("stugby.audience")}</span><select value={audienceKind} onChange={(event) => { setAudienceKind(event.target.value as typeof audienceKind); setAudienceNodes([]); }}><option value="all-members">{t("stugby.audienceAll")}</option><option value="members">{t("stugby.audienceSelected")}</option></select></label></div>
            {audienceKind === "members" && <fieldset className="stugby-audience"><legend>{t("stugby.recipients")}</legend>{activeRemoteMembers.length === 0 ? <p>{t("stugby.noEligibleRecipients")}</p> : activeRemoteMembers.map((member) => <label key={member.nodeId}><input type="checkbox" checked={audienceNodes.includes(member.nodeId)} onChange={(event) => setAudienceNodes((current) => event.target.checked ? [...current, member.nodeId] : current.filter((id) => id !== member.nodeId))} />{member.displayName} ({roleLabel(member.role)})</label>)}{activeRemoteMembers.length > 0 && audienceNodes.length === 0 && <p className="stugby-capability-note">{t("stugby.audienceRequired")}</p>}</fieldset>}
            {!editingGrantId && <div className="stugby-recommended-profile"><Sparkles size={20} aria-hidden="true" /><div><strong>{t("stugby.recommendedProfile")}</strong><p>{t("stugby.recommendedProfileBody")}</p></div></div>}
            <details key={editingGrantId ?? "new-grant"} className="stugby-subdetails stugby-sharing-options" open={editingGrantId !== null ? true : undefined}>
              <summary>{t("stugby.customizeSharing")}</summary>
              <div className="stugby-subdetails-body">
              <label className="field stugby-expiry-field"><span>{t("stugby.expiresAt")}</span><input type="datetime-local" value={grantExpiresAt} onChange={(event) => setGrantExpiresAt(event.target.value)} /></label>
              <div className="stugby-dataset-table" role="group" aria-label={t("stugby.sharedDatasets")}>
              <div className="stugby-dataset-heading"><span>{t("stugby.dataset")}</span><span>{t("stugby.localIds")}</span><span>{t("stugby.cache")}</span><span>{t("stugby.days")}</span></div>
              {STUGBY_DATASETS.map((dataset) => {
                const draft = datasetDraft[dataset];
                const label = t(datasetLabelKeys[dataset]);
                return <div className={`stugby-dataset-row ${dataset === "home.location.v1" ? "sensitive" : ""}`} key={dataset}>
                  <label><input type="checkbox" checked={draft.enabled} onChange={(event) => setDatasetDraft((current) => ({ ...current, [dataset]: { ...current[dataset], enabled: event.target.checked } }))} /><span><strong>{label}</strong><small>{dataset}</small></span></label>
                  <label className="stugby-dataset-option"><span>{t("stugby.localIds")}</span><input aria-label={`${t("stugby.localIds")}: ${label}`} type="checkbox" disabled={!draft.enabled} checked={draft.includeLocalIds} onChange={(event) => setDatasetDraft((current) => ({ ...current, [dataset]: { ...current[dataset], includeLocalIds: event.target.checked } }))} /></label>
                  <label className="stugby-dataset-option"><span>{t("stugby.cache")}</span><input aria-label={`${t("stugby.cache")}: ${label}`} type="checkbox" disabled={!draft.enabled} checked={draft.allowReplicaCache} onChange={(event) => setDatasetDraft((current) => ({ ...current, [dataset]: { ...current[dataset], allowReplicaCache: event.target.checked } }))} /></label>
                  <label className="stugby-dataset-option"><span>{t("stugby.days")}</span><input aria-label={`${t("stugby.days")}: ${label}`} type="number" min="0" max="3650" disabled={!draft.enabled} value={draft.retentionDays} onChange={(event) => setDatasetDraft((current) => ({ ...current, [dataset]: { ...current[dataset], retentionDays: Number(event.target.value) } }))} /></label>
                </div>;
              })}
              </div>
            {datasetDraft["home.location.v1"].enabled && <p className="stugby-sensitive-warning">{t("stugby.locationWarning")}</p>}
            {datasetDraft["home.telemetry.v1"].enabled && <><div className="stugby-telemetry-options"><label><input type="checkbox" checked={telemetryLive} onChange={(event) => setTelemetryLive(event.target.checked)} />{t("stugby.telemetryLive")}</label><label className="field"><span>{t("stugby.historyHours")}</span><input type="number" min="0" value={telemetryHistoryHours} onChange={(event) => setTelemetryHistoryHours(event.target.value)} /></label><label className="field"><span>{t("stugby.metrics")}</span><input value={telemetryMetrics} onChange={(event) => setTelemetryMetrics(event.target.value)} /></label><label className="field"><span>{t("stugby.maximumSamples")}</span><input type="number" min="1" max="1000000" value={telemetryRate} onChange={(event) => setTelemetryRate(event.target.value)} /></label></div>{publicationCatalog.status === "loading" && publicationCatalog.houseId === grantHouseId && <p role="status">{t("stugby.sensorCatalogLoading")}</p>}{publicationCatalog.status === "error" && publicationCatalog.houseId === grantHouseId && <div className="stugby-catalog-error" role="alert"><p>{publicationCatalog.error}</p><button type="button" className="secondary-button" onClick={() => setCatalogRevision((current) => current + 1)}>{t("stugby.retry")}</button></div>}{matchingCatalog && <fieldset className="stugby-audience"><legend>{t("stugby.sensorScope")}</legend><label><input type="checkbox" checked={!telemetrySensors} onChange={() => setTelemetrySensors("")} />{t("stugby.allSensors")}</label>{matchingCatalog.sensors.map((sensor) => { const selected = telemetrySensors.split(",").map((item) => item.trim()).filter(Boolean); return <label key={sensor.sensorPublicationId}><input type="checkbox" checked={selected.includes(sensor.sensorPublicationId)} onChange={(event) => setTelemetrySensors(event.target.checked ? [...selected, sensor.sensorPublicationId].join(",") : selected.filter((id) => id !== sensor.sensorPublicationId).join(","))} />{sensor.name}<small>{sensor.metricIds.join(", ") || t("stugby.noMetrics")}</small></label>; })}</fieldset>}</>}
              </div>
            </details>
            <div className="stugby-grant-submit"><button className="primary-button" disabled={busy !== null || !grantHouseId || (audienceKind === "members" && audienceNodes.length === 0) || (datasetDraft["home.telemetry.v1"].enabled && !catalogMatches)}>{busy === "grant" ? <LoaderCircle aria-hidden="true" className="spin" size={16} /> : <ShieldCheck aria-hidden="true" size={16} />}{t(editingGrantId ? "stugby.updateGrant" : "stugby.startSharing")}</button>{editingGrantId && <button type="button" className="secondary-button" onClick={resetGrantDraft}>{t("stugby.cancelEdit")}</button>}</div>
          </form> : <p>{cannotPublishMessage}</p>}
          <div className="stugby-existing-grants">{detail.grants.length === 0 ? <p>{t("stugby.noGrants")}</p> : detail.grants.map((grant) => <article key={grant.id}><div className="stugby-record-copy"><strong>{grant.publicationId.slice(0, 12)}…</strong><span>{t("stugby.grantSummary", { authority: t(grant.authorityNodeId === index.identity.nodeId ? "stugby.localAuthority" : "stugby.remoteAuthority"), epoch: grant.epoch, state: t(grant.revokedAt ? "stugby.state.revoked" : "stugby.state.active") })}</span><small>{grant.datasets.filter((dataset) => dataset.enabled).map((dataset) => t(datasetLabelKeys[dataset.dataset])).join(" · ")}</small></div>{grant.authorityNodeId === index.identity.nodeId && !grant.revokedAt && <div className="stugby-record-actions"><button type="button" className="secondary-button" disabled={busy !== null} onClick={() => editGrant(grant)}><Pencil size={15} aria-hidden="true" />{t("stugby.editGrant")}</button><button type="button" className="secondary-button" disabled={busy !== null} onClick={() => void withBusy(`republish:${grant.id}`, async () => { await api.republishStugbyGrant(detail.stugby.id, grant.id); setNotice(t("stugby.republishQueued")); })}><RefreshCw size={15} aria-hidden="true" />{t("stugby.republish")}</button><button type="button" className="danger-button" disabled={busy !== null} onClick={() => { if (window.confirm(t("stugby.confirmRevoke"))) void withBusy(`revoke:${grant.id}`, async () => { await api.revokeStugbyGrant(detail.stugby.id, grant.id); setNotice(t("stugby.changesSaved")); await loadDetail(detail.stugby.id); }); }}><Trash2 size={15} aria-hidden="true" />{t("stugby.revoke")}</button></div>}</article>)}</div>
        </section>

        <details className="stugby-card stugby-collapsible">
          <summary><Database size={19} aria-hidden="true" /><span><strong>{t("stugby.remoteTitle")}</strong><small>{t("stugby.remoteBody")}</small></span></summary>
          <div className="stugby-collapsible-body">
          {detail.remoteResources.length === 0 ? <p>{t("stugby.noRemote")}</p> : <div className="stugby-resource-list">{detail.remoteResources.map((resource) => {
            const resourceLabel = t(datasetLabelKeys[resource.schema]);
            return <details key={`${resource.authorityNodeId}:${resource.schema}:${resource.resourceId}`}><summary><span><strong>{resourceLabel}</strong><small>{t("stugby.resourceSummary", { authority: `${resource.authorityNodeId.slice(0, 12)}…`, revision: resource.revision })} · {t("stugby.receivedAt", { time: formattedTime(resource.receivedAt, t("stugby.never"), locale) })}</small></span><span className={resource.stale ? "stale" : "fresh"}>{t(resource.stale ? "stugby.stale" : "stugby.current")}</span></summary><pre tabIndex={0} role="region" aria-label={resourceLabel}>{JSON.stringify(resource.payload, null, 2)}</pre></details>;
          })}</div>}
          <div className="stugby-telemetry-preview"><h3>{t("stugby.telemetryPreview")}</h3>{telemetryError ? <p className="inline-error" role="alert">{telemetryError}</p> : telemetrySamples.length === 0 ? <p>{t("stugby.noTelemetry")}</p> : <p>{t("stugby.telemetryPreviewBody", { count: telemetrySamples.length })}</p>}{telemetrySamples.length > 0 && <details><summary>{t("stugby.showTelemetry")}</summary><pre tabIndex={0} role="region" aria-label={t("stugby.telemetryPreview")}>{JSON.stringify(telemetrySamples, null, 2)}</pre></details>}</div>
          </div>
        </details>

        <details className="stugby-card stugby-collapsible">
          <summary><Settings2 size={19} aria-hidden="true" /><span><strong>{t("stugby.operations")}</strong><small>{t("stugby.operationsBody")}</small></span></summary>
          <div className="stugby-collapsible-body">
          <h3>{t("stugby.deletionReceipts")}</h3>
          {detail.deletionReceipts.length === 0 ? <p>{t("stugby.noDeletionReceipts")}</p> : <div className="stugby-resource-list">{detail.deletionReceipts.map((receipt) => <div className="stugby-operation" key={`${receipt.nodeId}:${receipt.grantId}:${receipt.grantEpoch}`}><strong>{t("stugby.receiptSummary", { grant: receipt.grantId.slice(0, 12), epoch: receipt.grantEpoch })}</strong><small>{receipt.nodeId.slice(0, 12)}… · {formattedTime(receipt.deletedAt, t("stugby.never"), locale)}</small></div>)}</div>}
          <h3>{t("stugby.audit")}</h3>
          {detail.audit.length === 0 ? <p>{t("stugby.noAuditEvents")}</p> : <div className="stugby-resource-list">{detail.audit.slice(0, 25).map((entry) => <div className="stugby-operation" key={entry.id}><strong>{entry.eventType}</strong><small>{formattedTime(entry.createdAt, t("stugby.never"), locale)} · {entry.subjectId ?? "—"}</small></div>)}</div>}
          </div>
        </details>
      </div>}
    </>}
    </>}
  </div>;
}
