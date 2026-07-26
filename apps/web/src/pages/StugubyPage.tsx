import { useCallback, useEffect, useMemo, useRef, useState, type FormEvent } from "react";
import type { House, Property } from "@climate-twin/contracts";
import {
  STUGBY_DATASETS,
  type StugubyDataset,
  type StugubyDatasetGrant,
  type StugubyMember,
  type StugubyRole,
  type StugubyShareGrant,
  type StugubySharedProperty,
  type StugubySummary,
} from "@climate-twin/stuguby-protocol";
import { AlertTriangle, Check, Copy, Database, KeyRound, Link, LoaderCircle, Network, Pencil, Plus, RefreshCw, Settings2, ShieldCheck, Sparkles, Trash2, Unplug, Users } from "lucide-react";
import {
  api,
  type StugubyDetailResponse,
  type StugubyInvitationCreated,
  type StugubyListResponse,
  type StugubyLocalMember,
  type StugubyLocalPublicationCatalog,
  type StugubyRemoteTelemetrySample,
} from "../api";
import { StugubyMark } from "../components/StugubyMark";
import { useI18n, type TranslationKey } from "../i18n";
import { CloudflareSetupPanel } from "./CloudflareSetupPanel";
import "./StugubyPage.css";

interface StugubyPageProps {
  houses: Array<Pick<House, "id" | "name" | "propertyId" | "stuguby">>;
  properties?: Array<Pick<Property, "id" | "name" | "stuguby">>;
  onInventoryChange?: () => void;
}

interface DatasetDraft {
  enabled: boolean;
  includeLocalIds: boolean;
  allowReplicaCache: boolean;
  retentionDays: number;
}

type PublicationCatalogState =
  | { status: "idle"; stugubyId: null; houseId: null; data: null; error: null }
  | { status: "loading"; stugubyId: string; houseId: string; data: null; error: null }
  | { status: "ready"; stugubyId: string; houseId: string; data: StugubyLocalPublicationCatalog; error: null }
  | { status: "error"; stugubyId: string; houseId: string; data: null; error: string };

const idlePublicationCatalog = (): PublicationCatalogState => ({
  status: "idle",
  stugubyId: null,
  houseId: null,
  data: null,
  error: null,
});

const datasetLabelKeys: Record<StugubyDataset, TranslationKey> = {
  "home.directory.v1": "stuguby.dataset.directory",
  "home.location.v1": "stuguby.dataset.location",
  "home.structure.v1": "stuguby.dataset.structure",
  "home.floorplan.v1": "stuguby.dataset.floorplan",
  "home.sensor-catalog.v1": "stuguby.dataset.sensors",
  "home.telemetry.v1": "stuguby.dataset.telemetry",
  "home.notes.v1": "stuguby.dataset.notes",
  "home.observations.v1": "stuguby.dataset.observations",
  "home.recovery.v1": "stuguby.dataset.recovery",
};

const editableHomeDatasets = new Set<StugubyDataset>([
  "home.directory.v1",
  "home.location.v1",
  "home.structure.v1",
  "home.sensor-catalog.v1",
  "home.notes.v1",
  "home.observations.v1",
]);

const roleLabelKeys: Record<StugubyRole, TranslationKey> = {
  steward: "stuguby.role.steward",
  "property-manager": "stuguby.role.propertyManager",
  participant: "stuguby.role.participant",
  viewer: "stuguby.role.viewer",
};

const memberStateLabelKeys: Record<StugubyMember["state"], TranslationKey> = {
  invited: "stuguby.state.invited",
  active: "stuguby.state.active",
  suspended: "stuguby.state.suspended",
  left: "stuguby.state.left",
  revoked: "stuguby.state.revoked",
};

function initialDatasetDraft(): Record<StugubyDataset, DatasetDraft> {
  return Object.fromEntries(STUGBY_DATASETS.map((dataset) => [dataset, {
    enabled: ["home.directory.v1", "home.structure.v1", "home.sensor-catalog.v1"].includes(dataset),
    includeLocalIds: false,
    allowReplicaCache: true,
    retentionDays: dataset === "home.telemetry.v1" ? 7 : 30,
  }])) as Record<StugubyDataset, DatasetDraft>;
}

function errorMessage(error: unknown, fallback: string): string {
  return error instanceof Error && error.message.trim() ? error.message : fallback;
}

function formattedTime(value: string | null, never: string, locale: string): string {
  if (!value) return never;
  const date = new Date(value);
  return Number.isFinite(date.getTime()) ? date.toLocaleString(locale) : value;
}

function suggestedCoordinatorOrigin(): string {
  try {
    const url = new URL(window.location.origin);
    const loopback = ["localhost", "127.0.0.1", "::1", "[::1]"].includes(url.hostname);
    return url.protocol === "https:" || (url.protocol === "http:" && loopback) ? url.origin : "";
  } catch {
    return "";
  }
}

function loopbackOrigin(value: string | null | undefined): boolean {
  if (!value) return false;
  try {
    return ["localhost", "127.0.0.1", "::1", "[::1]"].includes(new URL(value).hostname);
  } catch {
    return false;
  }
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

function grantHomeName(
  grant: StugubyShareGrant,
  houses: StugubyPageProps["houses"],
  remoteResources: StugubyDetailResponse["remoteResources"],
): string | null {
  const localHouse = grant.localHouseId ? houses.find((house) => house.id === grant.localHouseId) : null;
  if (localHouse?.name.trim()) return localHouse.name;

  const projectedHouse = houses.find((house) => (
    house.stuguby?.stugubyId === grant.stugubyId
    && house.stuguby.authorityNodeId === grant.authorityNodeId
    && house.stuguby.publicationId === grant.publicationId
  ));
  if (projectedHouse?.name.trim()) return projectedHouse.name;

  const directory = remoteResources.find((resource) => (
    resource.authorityNodeId === grant.authorityNodeId
    && resource.publicationId === grant.publicationId
    && resource.schema === "home.directory.v1"
  ));
  const name = directory?.payload && !Array.isArray(directory.payload) && typeof directory.payload === "object"
    ? directory.payload.name
    : null;
  return typeof name === "string" && name.trim() ? name : null;
}

function MemberIdentity({
  member,
  isLocal,
  disabled,
  youLabel,
  privateLabel,
  privateLabelPlaceholder,
  metadata,
  onSave,
}: Readonly<{
  member: StugubyLocalMember;
  isLocal: boolean;
  disabled: boolean;
  youLabel: string;
  privateLabel: string;
  privateLabelPlaceholder: string;
  metadata: string;
  onSave: (value: string | null) => void;
}>) {
  const storedLabel = member.localLabel ?? "";
  const [draft, setDraft] = useState(storedLabel);
  useEffect(() => setDraft(storedLabel), [storedLabel]);
  const save = () => {
    const normalized = draft.trim();
    if (normalized !== storedLabel) onSave(normalized || null);
  };
  return <div className="stuguby-member-identity">
    {isLocal ? <strong>{youLabel}</strong> : <label className="stuguby-member-local-label">
      <span>{privateLabel}</span>
      <input
        value={draft}
        maxLength={200}
        placeholder={privateLabelPlaceholder}
        disabled={disabled}
        onChange={(event) => setDraft(event.target.value)}
        onBlur={save}
        onKeyDown={(event) => {
          if (event.key === "Enter") {
            event.preventDefault();
            event.currentTarget.blur();
          } else if (event.key === "Escape") {
            setDraft(storedLabel);
            event.currentTarget.blur();
          }
        }}
      />
    </label>}
    <small>{metadata}</small>
  </div>;
}

function activeGrant(grant: StugubyShareGrant, now = Date.now()): boolean {
  if (grant.revokedAt) return false;
  if (!grant.expiresAt) return true;
  const expiresAt = Date.parse(grant.expiresAt);
  return !Number.isFinite(expiresAt) || expiresAt > now;
}

export function StugubyPage({ houses, properties = [], onInventoryChange }: Readonly<StugubyPageProps>) {
  const { locale, t } = useI18n();
  const roleLabel = (role: StugubyRole) => t(roleLabelKeys[role]);
  const stateLabel = (state: StugubyMember["state"]) => t(memberStateLabelKeys[state]);
  const [index, setIndex] = useState<StugubyListResponse | null>(null);
  const [detail, setDetail] = useState<StugubyDetailResponse | null>(null);
  const [selectedId, setSelectedId] = useState("");
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [detailLoading, setDetailLoading] = useState(false);
  const [telemetryError, setTelemetryError] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const [cloudflareSetupRequested, setCloudflareSetupRequested] = useState(false);
  const [createdInvitation, setCreatedInvitation] = useState<StugubyInvitationCreated | null>(null);
  const [telemetrySamples, setTelemetrySamples] = useState<StugubyRemoteTelemetrySample[]>([]);

  const [createName, setCreateName] = useState(() => t("stuguby.defaultName"));
  const [createDescription, setCreateDescription] = useState("");
  const [createCoordinatorUrl, setCreateCoordinatorUrl] = useState(suggestedCoordinatorOrigin);
  const [joinCoordinatorUrl, setJoinCoordinatorUrl] = useState(() => window.location.origin);
  const [joinUrl, setJoinUrl] = useState("");
  const [joinInvitationId, setJoinInvitationId] = useState("");
  const [joinSecret, setJoinSecret] = useState("");
  const [inviteRole, setInviteRole] = useState<Exclude<StugubyRole, "steward">>("participant");
  const [inviteLocalLabel, setInviteLocalLabel] = useState("");
  const [inviteExpiresAt, setInviteExpiresAt] = useState("");

  const publishableHouses = useMemo(() => houses.filter((house) => !house.stuguby || house.stuguby.ownership === "local"), [houses]);
  const [grantHouseId, setGrantHouseId] = useState(() => publishableHouses[0]?.id ?? "");
  const [audienceKind, setAudienceKind] = useState<"all-members" | "members">("all-members");
  const [audienceNodes, setAudienceNodes] = useState<string[]>([]);
  const [datasetDraft, setDatasetDraft] = useState(initialDatasetDraft);
  const [telemetryLive, setTelemetryLive] = useState(true);
  const [telemetryHistoryHours, setTelemetryHistoryHours] = useState("24");
  const [telemetryMetrics, setTelemetryMetrics] = useState("temperature, humidity");
  const [telemetrySensors, setTelemetrySensors] = useState("");
  const [telemetryRate, setTelemetryRate] = useState("5000");
  const [grantExpiresAt, setGrantExpiresAt] = useState("");
  const [houseEditPolicy, setHouseEditPolicy] = useState<StugubyShareGrant["housePolicy"]["editPolicy"]>("read-only");
  const [recoveryMode, setRecoveryMode] = useState<StugubyShareGrant["housePolicy"]["recoveryMode"]>("none");
  const [houseSuccessorNodeId, setHouseSuccessorNodeId] = useState("");
  const [editingGrantId, setEditingGrantId] = useState<string | null>(null);
  const [publicationCatalog, setPublicationCatalog] = useState<PublicationCatalogState>(idlePublicationCatalog);
  const [catalogRevision, setCatalogRevision] = useState(0);
  const activeLocalGrantHouseIds = useMemo(() => new Set(
    detail?.grants
      .filter((grant) => grant.authorityNodeId === index?.identity.nodeId && grant.localHouseId && activeGrant(grant))
      .map((grant) => grant.localHouseId!)
      ?? [],
  ), [detail?.grants, index?.identity.nodeId]);
  const unsharedHouses = useMemo(
    () => publishableHouses.filter((house) => !activeLocalGrantHouseIds.has(house.id)),
    [activeLocalGrantHouseIds, publishableHouses],
  );
  const grantHouseOptions = useMemo(() => {
    if (!editingGrantId) return unsharedHouses;
    const editedHouseId = detail?.grants.find((grant) => grant.id === editingGrantId)?.localHouseId;
    return publishableHouses.filter((house) => house.id === editedHouseId);
  }, [detail?.grants, editingGrantId, publishableHouses, unsharedHouses]);

  const [propertyName, setPropertyName] = useState("");
  const [propertyDescription, setPropertyDescription] = useState("");
  const [propertyLatitude, setPropertyLatitude] = useState("");
  const [propertyLongitude, setPropertyLongitude] = useState("");
  const [propertyLocationLabel, setPropertyLocationLabel] = useState("");
  const [areasJson, setAreasJson] = useState("[]");
  const [equipmentJson, setEquipmentJson] = useState("[]");
  const [notesJson, setNotesJson] = useState("[]");
  const [maintenanceJson, setMaintenanceJson] = useState("[]");
  const [propertyEditPolicy, setPropertyEditPolicy] = useState<StugubySharedProperty["editPolicy"]>("collaborative");
  const [propertySuccessorNodeId, setPropertySuccessorNodeId] = useState("");
  const [adoptionPropertyId, setAdoptionPropertyId] = useState("");
  const [migrationPropertyId, setMigrationPropertyId] = useState("");

  const detailRequest = useRef(0);
  const selectedIdRef = useRef("");

  const resetGrantDraft = useCallback(() => {
    setGrantHouseId(unsharedHouses[0]?.id ?? "");
    setAudienceKind("all-members");
    setAudienceNodes([]);
    setDatasetDraft(initialDatasetDraft());
    setTelemetryLive(true);
    setTelemetryHistoryHours("24");
    setTelemetryMetrics("temperature, humidity");
    setTelemetrySensors("");
    setTelemetryRate("5000");
    setGrantExpiresAt("");
    setHouseEditPolicy("read-only");
    setRecoveryMode("none");
    setHouseSuccessorNodeId("");
    setEditingGrantId(null);
    setPublicationCatalog(idlePublicationCatalog());
    setCatalogRevision((current) => current + 1);
  }, [unsharedHouses]);

  const resetStugubyScopedUi = useCallback(() => {
    resetGrantDraft();
    setCreatedInvitation(null);
    setCopied(false);
    setInviteRole("participant");
    setInviteLocalLabel("");
    setInviteExpiresAt("");
    setTelemetrySamples([]);
    setTelemetryError(null);
    setNotice(null);
  }, [resetGrantDraft]);

  const beginSelection = useCallback((id: string) => {
    selectedIdRef.current = id;
    setSelectedId(id);
    setDetail(null);
    resetStugubyScopedUi();
  }, [resetStugubyScopedUi]);

  const loadDetail = useCallback(async (id: string) => {
    const request = ++detailRequest.current;
    setDetailLoading(true);
    setTelemetryError(null);
    try {
      const loaded = await api.stuguby(id);
      if (request !== detailRequest.current || selectedIdRef.current !== id) return loaded;
      setDetail(loaded);
      try {
        const samples = (await api.stugubyTelemetry(id)).samples;
        if (request === detailRequest.current && selectedIdRef.current === id) setTelemetrySamples(samples);
      } catch (nextError) {
        if (request === detailRequest.current && selectedIdRef.current === id) {
          setTelemetrySamples([]);
          setTelemetryError(errorMessage(nextError, t("stuguby.telemetryLoadError")));
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
      const loaded = await api.stugubys();
      setIndex(loaded);
      if (!loaded.publicOrigin && loaded.suggestedPublicOrigin) {
        setCreateCoordinatorUrl(loaded.suggestedPublicOrigin);
      }
      const id = preferredId || selectedIdRef.current || loaded.stugubys[0]?.id || "";
      if (id !== selectedIdRef.current) beginSelection(id);
      if (id) await loadDetail(id);
      else {
        detailRequest.current += 1;
        beginSelection("");
        setDetailLoading(false);
      }
    } catch (nextError) {
      setError(errorMessage(nextError, t("stuguby.operationFailed")));
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
    setPropertyEditPolicy(property.editPolicy);
    setPropertySuccessorNodeId(property.designatedSuccessorNodeId ?? "");
  }, [detail?.sharedProperty]);

  useEffect(() => {
    const available = properties.filter((property) => !property.stuguby || property.stuguby.syncState === "detached");
    const migrationAvailable = available.filter((property) => property.id !== detail?.propertyAdoption?.localPropertyId);
    setAdoptionPropertyId((current) => available.some((property) => property.id === current)
      ? current
      : available[0]?.id ?? "");
    setMigrationPropertyId((current) => migrationAvailable.some((property) => property.id === current)
      ? current
      : migrationAvailable[0]?.id ?? "");
  }, [detail?.propertyAdoption?.localPropertyId, properties]);

  useEffect(() => {
    if (editingGrantId || unsharedHouses.some((house) => house.id === grantHouseId)) return;
    setGrantHouseId(unsharedHouses[0]?.id ?? "");
    setTelemetrySensors("");
  }, [editingGrantId, grantHouseId, unsharedHouses]);

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
    if (!detail || !grantHouseId || !grantHouseOptions.some((house) => house.id === grantHouseId)
      || detail.stuguby.localMemberState !== "active" || detail.stuguby.localRole === "viewer") {
      setPublicationCatalog(idlePublicationCatalog());
      return () => { active = false; };
    }
    const stugubyId = detail.stuguby.id;
    const houseId = grantHouseId;
    setPublicationCatalog({ status: "loading", stugubyId, houseId, data: null, error: null });
    void api.stugubyPublications(detail.stuguby.id, grantHouseId)
      .then((catalog) => {
        if (active) setPublicationCatalog({ status: "ready", stugubyId, houseId, data: catalog, error: null });
      })
      .catch((nextError: unknown) => {
        if (active) setPublicationCatalog({
          status: "error",
          stugubyId,
          houseId,
          data: null,
          error: errorMessage(nextError, t("stuguby.sensorCatalogError")),
        });
      });
    return () => { active = false; };
  }, [catalogRevision, detail?.stuguby.id, detail?.stuguby.localMemberState, detail?.stuguby.localRole, grantHouseId, grantHouseOptions, t]);

  const withBusy = async (key: string, operation: () => Promise<void>): Promise<void> => {
    setBusy(key);
    setError(null);
    setNotice(null);
    try { await operation(); } catch (nextError) { setError(errorMessage(nextError, t("stuguby.operationFailed"))); }
    finally { setBusy(null); }
  };

  const createStuguby = (event: FormEvent) => {
    event.preventDefault();
    void withBusy("create", async () => {
      if (!index?.publicOrigin) {
        const configured = await api.configureStugubyCoordinator(createCoordinatorUrl);
        setIndex((current) => current ? { ...current, publicOrigin: configured.publicOrigin } : current);
      }
      const created = await api.createStuguby({ name: createName, description: createDescription || null });
      setCreateName(t("stuguby.defaultName"));
      setCreateDescription("");
      resetStugubyScopedUi();
      await load(created.id);
    });
  };

  const joinStuguby = (event: FormEvent) => {
    event.preventDefault();
    void withBusy("join", async () => {
      const joined = await api.joinStuguby({ coordinatorUrl: joinCoordinatorUrl, invitationId: joinInvitationId, joinSecret });
      setJoinUrl(""); setJoinInvitationId(""); setJoinSecret("");
      resetStugubyScopedUi();
      await load(joined.id);
    });
  };

  const activeRemoteMembers = useMemo(() => detail?.members.filter((member) => (
    member.state === "active" && member.nodeId !== index?.identity.nodeId
  )) ?? [], [detail?.members, index?.identity.nodeId]);

  const selectRecoveryMode = (mode: StugubyShareGrant["housePolicy"]["recoveryMode"]) => {
    setRecoveryMode(mode);
    if (mode !== "full") {
      setHouseSuccessorNodeId("");
      return;
    }
    const successor = houseSuccessorNodeId || activeRemoteMembers[0]?.nodeId || "";
    setHouseSuccessorNodeId(successor);
    setAudienceKind("members");
    setAudienceNodes(successor ? [successor] : []);
    setTelemetryLive(true);
    setTelemetryRate("1000000");
    setDatasetDraft(Object.fromEntries(STUGBY_DATASETS.map((dataset) => [dataset, {
      enabled: true,
      includeLocalIds: false,
      allowReplicaCache: true,
      retentionDays: 3650,
    }])) as Record<StugubyDataset, DatasetDraft>);
  };

  const selectHouseEditPolicy = (policy: StugubyShareGrant["housePolicy"]["editPolicy"]) => {
    setHouseEditPolicy(policy);
    if (policy !== "editable") return;
    setDatasetDraft((current) => Object.fromEntries(STUGBY_DATASETS.map((dataset) => {
      const draft = current[dataset];
      return [dataset, editableHomeDatasets.has(dataset)
        ? { ...draft, enabled: true, allowReplicaCache: true, retentionDays: Math.max(1, draft.retentionDays) }
        : draft];
    })) as Record<StugubyDataset, DatasetDraft>);
  };

  const saveGrant = (event: FormEvent) => {
    event.preventDefault();
    if (!detail || detail.stuguby.id !== selectedIdRef.current) return;
    if (!editingGrantId && detail.grants.some((grant) => (
      grant.authorityNodeId === index?.identity.nodeId
      && grant.localHouseId === grantHouseId
      && activeGrant(grant)
    ))) {
      setError(t("stuguby.homeAlreadyShared"));
      return;
    }
    if (recoveryMode === "full" && !houseSuccessorNodeId) {
      setError(t("stuguby.recoverySuccessorRequired"));
      return;
    }
    const effectiveAudienceKind = recoveryMode === "full" ? "members" : audienceKind;
    const effectiveAudienceNodes = recoveryMode === "full" ? [houseSuccessorNodeId] : audienceNodes;
    if (effectiveAudienceKind === "members" && effectiveAudienceNodes.length === 0) {
      setError(t("stuguby.audienceRequired"));
      return;
    }
    const telemetryEnabled = datasetDraft["home.telemetry.v1"].enabled;
    const catalogMatches = publicationCatalog.status === "ready"
      && publicationCatalog.stugubyId === detail.stuguby.id
      && publicationCatalog.houseId === grantHouseId;
    if (telemetryEnabled && !catalogMatches) {
      setError(t("stuguby.sensorCatalogRequired"));
      return;
    }
    if (datasetDraft["home.location.v1"].enabled && !window.confirm(t("stuguby.confirmLocationShare"))) return;
    const selectedDetail = detail;
    void withBusy("grant", async () => {
      const datasets: StugubyDatasetGrant[] = STUGBY_DATASETS.map((dataset) => {
        const draft = datasetDraft[dataset];
        const base: StugubyDatasetGrant = {
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
            sensorPublicationIds: recoveryMode === "full" ? [] : telemetrySensors.split(",").map((sensor) => sensor.trim()).filter(Boolean),
            metricIds: recoveryMode === "full" ? [] : telemetryMetrics.split(",").map((metric) => metric.trim()).filter(Boolean),
            historyFrom: recoveryMode === "full"
              ? "1970-01-01T00:00:00.000Z"
              : Number.isFinite(hours) && hours > 0 ? new Date(Date.now() - hours * 3_600_000).toISOString() : null,
            live: telemetryLive,
            maxSamplesPerHour: Number.isSafeInteger(rate) && rate > 0 ? rate : 5_000,
          },
        };
      }).filter((dataset) => dataset.enabled);
      const audience = { kind: effectiveAudienceKind, nodeIds: effectiveAudienceKind === "members" ? effectiveAudienceNodes : [] } as const;
      const housePolicy: StugubyShareGrant["housePolicy"] = {
        editPolicy: houseEditPolicy,
        recoveryMode,
        designatedSuccessorNodeId: recoveryMode === "full" ? houseSuccessorNodeId : null,
      };
      const expiresAt = grantExpiresAt ? new Date(grantExpiresAt).toISOString() : null;
      const existing = editingGrantId ? selectedDetail.grants.find((grant) => grant.id === editingGrantId) : null;
      if (editingGrantId && !existing) throw new Error(t("stuguby.grantScopeChanged"));
      if (existing) await api.updateStugubyGrant(selectedDetail.stuguby.id, existing.id, { baseRevision: existing.revision, audience, datasets, housePolicy, expiresAt });
      else await api.createStugubyGrant(selectedDetail.stuguby.id, { localHouseId: grantHouseId, audience, datasets, housePolicy, expiresAt });
      await api.syncStuguby(selectedDetail.stuguby.id);
      onInventoryChange?.();
      setNotice(t("stuguby.changesSaved"));
      resetGrantDraft();
      await loadDetail(selectedDetail.stuguby.id);
    });
  };

  const editGrant = (grant: StugubyShareGrant) => {
    const drafts = Object.fromEntries(STUGBY_DATASETS.map((dataset) => {
      const configured = grant.datasets.find((item) => item.dataset === dataset);
      return [dataset, configured ? {
        enabled: configured.enabled,
        includeLocalIds: configured.includeLocalIds,
        allowReplicaCache: configured.allowReplicaCache,
        retentionDays: configured.retentionDays,
      } : { enabled: false, includeLocalIds: false, allowReplicaCache: true, retentionDays: dataset === "home.telemetry.v1" ? 7 : 30 }];
    })) as Record<StugubyDataset, DatasetDraft>;
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
    setHouseEditPolicy(grant.housePolicy.editPolicy);
    setRecoveryMode(grant.housePolicy.recoveryMode);
    setHouseSuccessorNodeId(grant.housePolicy.designatedSuccessorNodeId ?? "");
  };

  const saveProperty = (event: FormEvent) => {
    event.preventDefault();
    if (!detail?.sharedProperty) return;
    const selected = detail;
    const baseRevision = detail.sharedProperty.revision;
    void withBusy("property", async () => {
      const latitudeText = propertyLatitude.trim();
      const longitudeText = propertyLongitude.trim();
      if (Boolean(latitudeText) !== Boolean(longitudeText)) throw new Error(t("stuguby.coordinatesTogether"));
      const hasLocation = Boolean(latitudeText && longitudeText);
      const latitude = hasLocation ? Number(latitudeText) : 0;
      const longitude = hasLocation ? Number(longitudeText) : 0;
      if (hasLocation && (!Number.isFinite(latitude) || !Number.isFinite(longitude)
        || latitude < -90 || latitude > 90 || longitude < -180 || longitude > 180)) {
        throw new Error(t("stuguby.invalidCoordinates"));
      }
      const property: Pick<StugubySharedProperty, "name" | "description" | "location" | "areas" | "equipment" | "notes" | "maintenance" | "editPolicy" | "designatedSuccessorNodeId"> = {
        name: propertyName,
        description: propertyDescription || null,
        location: hasLocation ? { latitude, longitude, ...(propertyLocationLabel.trim() ? { label: propertyLocationLabel.trim() } : {}) } : null,
        areas: parseArray(areasJson, t("stuguby.areas"), t("stuguby.invalidJson"), t("stuguby.jsonArrayRequired")) as StugubySharedProperty["areas"],
        equipment: parseArray(equipmentJson, t("stuguby.equipment"), t("stuguby.invalidJson"), t("stuguby.jsonArrayRequired")) as StugubySharedProperty["equipment"],
        notes: parseArray(notesJson, t("stuguby.notes"), t("stuguby.invalidJson"), t("stuguby.jsonArrayRequired")) as StugubySharedProperty["notes"],
        maintenance: parseArray(maintenanceJson, t("stuguby.maintenance"), t("stuguby.invalidJson"), t("stuguby.jsonArrayRequired")) as StugubySharedProperty["maintenance"],
        editPolicy: propertyEditPolicy,
        designatedSuccessorNodeId: propertySuccessorNodeId || null,
      };
      await api.updateStugubyProperty(selected.stuguby.id, baseRevision, property);
      setNotice(t("stuguby.changesSaved"));
      await loadDetail(selected.stuguby.id);
    });
  };

  const memberName = (member: StugubyLocalMember) => member.nodeId === index?.identity.nodeId
    ? t("stuguby.you")
    : member.localLabel?.trim() || member.displayName;

  const updateMember = (member: StugubyLocalMember, input: { role?: StugubyRole; state?: StugubyMember["state"] }) => {
    if (!detail || detail.stuguby.id !== selectedIdRef.current) return;
    const nextState = input.state ?? member.state;
    if (input.state && nextState !== member.state
      && !window.confirm(t("stuguby.confirmMemberState", { name: memberName(member), state: stateLabel(nextState) }))) return;
    void withBusy(`member:${member.nodeId}`, async () => {
      await api.updateStugubyMember(detail.stuguby.id, member.nodeId, { role: input.role ?? member.role, state: nextState });
      setNotice(t("stuguby.changesSaved"));
      await loadDetail(detail.stuguby.id);
    });
  };

  const updateMemberLocalLabel = (member: StugubyLocalMember, localLabel: string | null) => {
    if (!detail || detail.stuguby.id !== selectedIdRef.current) return;
    void withBusy(`member-label:${member.nodeId}`, async () => {
      await api.updateStugubyMemberLabel(detail.stuguby.id, member.nodeId, localLabel);
      setNotice(t("stuguby.memberLabelSaved"));
      await loadDetail(detail.stuguby.id);
    });
  };

  const adoptSharedProperty = () => {
    if (!detail || detail.stuguby.id !== selectedIdRef.current) return;
    const selected = detail;
    void withBusy("adopt-property", async () => {
      if (!coordinator) await api.syncStuguby(selected.stuguby.id);
      await api.adoptStugubyProperty(
        selected.stuguby.id,
        coordinator && adoptionPropertyId ? adoptionPropertyId : undefined,
      );
      if (coordinator) await api.syncStuguby(selected.stuguby.id);
      onInventoryChange?.();
      setNotice(t("stuguby.propertyAdopted"));
      await loadDetail(selected.stuguby.id);
    });
  };

  const migrateLocalProperty = () => {
    if (!detail || !migrationPropertyId || detail.stuguby.id !== selectedIdRef.current) return;
    const source = properties.find((property) => property.id === migrationPropertyId);
    if (!source || !window.confirm(t("stuguby.confirmPropertyMigration", { name: source.name }))) return;
    const selected = detail;
    void withBusy("migrate-property", async () => {
      const migrated = await api.migratePropertyToStuguby(selected.stuguby.id, source.id);
      await api.syncStuguby(selected.stuguby.id);
      onInventoryChange?.();
      setMigrationPropertyId("");
      setNotice(t(migrated.moved.houseIds.length === 1
        ? "stuguby.propertyMigratedOne"
        : "stuguby.propertyMigratedMany", { count: migrated.moved.houseIds.length }));
      await loadDetail(selected.stuguby.id);
    });
  };

  const disconnectProperty = () => {
    if (!detail || detail.stuguby.id !== selectedIdRef.current
      || !window.confirm(t("stuguby.confirmPropertyDisconnect"))) return;
    const selected = detail;
    void withBusy("disconnect-property", async () => {
      await api.disconnectStugubyProperty(selected.stuguby.id);
      onInventoryChange?.();
      setNotice(t("stuguby.propertyDisconnected"));
      await loadDetail(selected.stuguby.id);
    });
  };

  const deleteStuguby = () => {
    if (!detail || detail.stuguby.id !== selectedIdRef.current) return;
    const selected = detail.stuguby;
    if (!window.confirm(t("stuguby.confirmDelete", { name: selected.name }))) return;
    void withBusy("delete", async () => {
      await api.deleteStuguby(selected.id);
      detailRequest.current += 1;
      beginSelection("");
      await load();
      setNotice(t("stuguby.deleted", { name: selected.name }));
    });
  };

  if (loading) return <output className="page-loading"><LoaderCircle className="spin" size={20} aria-hidden="true" />{t("common.loading")}</output>;

  const currentDetail = detail?.stuguby.id === selectedId ? detail : null;
  const coordinator = currentDetail?.stuguby.localMemberState === "active" && currentDetail.stuguby.localRole === "steward";
  const unsharedProperties = properties.filter((property) => !property.stuguby || property.stuguby.syncState === "detached");
  const migrationProperties = unsharedProperties.filter((property) => property.id !== currentDetail?.propertyAdoption?.localPropertyId);
  const deletionBlocked = Boolean(currentDetail && (
    currentDetail.propertyAdoption?.state === "adopted"
    ||
    (!coordinator && !["left", "revoked"].includes(currentDetail.stuguby.localMemberState))
    || (coordinator && currentDetail.members.some((member) => (
      member.nodeId !== index?.identity.nodeId && !["left", "revoked"].includes(member.state)
    )))
    || currentDetail.grants.some((grant) => !grant.revokedAt)
  ));
  const coordinatorInvitationReady = Boolean(
    coordinator && index?.publicOrigin && currentDetail.stuguby.coordinatorUrl === index.publicOrigin,
  );
  const propertyWriter = currentDetail?.stuguby.localMemberState === "active"
    && ["steward", "property-manager"].includes(currentDetail.stuguby.localRole);
  const canPublish = currentDetail?.stuguby.localMemberState === "active" && currentDetail.stuguby.localRole !== "viewer";
  const cannotPublishMessage = currentDetail?.stuguby.localMemberState !== "active"
    ? t("stuguby.inactiveCannotPublish", { state: currentDetail ? stateLabel(currentDetail.stuguby.localMemberState) : "" })
    : t("stuguby.viewerCannotPublish");
  const matchingCatalog = currentDetail && publicationCatalog.status === "ready"
    && publicationCatalog.stugubyId === currentDetail.stuguby.id
    && publicationCatalog.houseId === grantHouseId
    ? publicationCatalog.data
    : null;
  const catalogMatches = matchingCatalog !== null;
  const activeGrantCounts = new Map<string, number>();
  for (const grant of currentDetail?.grants ?? []) {
    if (grant.authorityNodeId !== index?.identity.nodeId || !grant.localHouseId || !activeGrant(grant)) continue;
    activeGrantCounts.set(grant.localHouseId, (activeGrantCounts.get(grant.localHouseId) ?? 0) + 1);
  }
  const duplicatedLocalHouseIds = new Set(
    [...activeGrantCounts].filter(([, count]) => count > 1).map(([houseId]) => houseId),
  );
  const duplicatedHomeNames = publishableHouses
    .filter((house) => duplicatedLocalHouseIds.has(house.id))
    .map((house) => house.name);
  const coordinatorSetupRequired = !index?.publicOrigin && index?.publicOriginConfigurable === false;
  const localCoordinator = loopbackOrigin(index?.publicOrigin);
  const showCloudflareSetup = coordinatorSetupRequired || (localCoordinator && cloudflareSetupRequested);
  const setupAddress = index?.suggestedPublicOrigin || createCoordinatorUrl;
  const createPanel = showCloudflareSetup
    ? <section className="stuguby-card stuguby-setup-card" aria-labelledby="stuguby-create-title">
      <div className="stuguby-card-title"><Network size={19} aria-hidden="true" /><div><h2 id="stuguby-create-title">{t("stuguby.createTitle")}</h2><p>{t("stuguby.createBody")}</p></div></div>
      <CloudflareSetupPanel
        suggestedOrigin={setupAddress}
        onComplete={async () => {
          await load();
          setNotice(t("cloudflareSetup.completeNotice"));
          setCloudflareSetupRequested(false);
        }}
      />
      {!coordinatorSetupRequired && <button type="button" className="secondary-button" onClick={() => setCloudflareSetupRequested(false)}>
        {t("cloudflareSetup.useLocal")}
      </button>}
    </section>
    : <form className="stuguby-card stuguby-setup-card" onSubmit={createStuguby}>
      <div className="stuguby-card-title"><Network size={19} aria-hidden="true" /><div><h2 id="stuguby-create-title">{t("stuguby.createTitle")}</h2><p>{t("stuguby.createBody")}</p></div></div>
      {localCoordinator && <div className="stuguby-setup-required" role="note">
        <ShieldCheck size={20} aria-hidden="true" />
        <div>
          <strong>{t("cloudflareSetup.offerTitle")}</strong>
          <p>{t("cloudflareSetup.offerBody")}</p>
          <button type="button" className="secondary-button" onClick={() => setCloudflareSetupRequested(true)}>
            {t("cloudflareSetup.choose")}
          </button>
        </div>
      </div>}
      <label className="field"><span>{t("stuguby.name")}</span><input required maxLength={200} value={createName} onChange={(event) => setCreateName(event.target.value)} /></label>
      {!index?.publicOrigin && <label className="field"><span>{t("stuguby.coordinatorUrl")}</span><input required type="url" spellCheck={false} value={createCoordinatorUrl} placeholder={t("stuguby.coordinatorPlaceholder")} onChange={(event) => setCreateCoordinatorUrl(event.target.value)} /><small>{createCoordinatorUrl.trim() ? t("stuguby.addressReady", { origin: createCoordinatorUrl }) : t("stuguby.httpsHelp")}</small></label>}
      <details className="stuguby-subdetails">
        <summary>{t("nav.advanced")}</summary>
        <div className="stuguby-subdetails-body">
          <label className="field"><span>{t("stuguby.descriptionField")}</span><textarea value={createDescription} onChange={(event) => setCreateDescription(event.target.value)} /></label>
          {index?.publicOrigin && <label className="field"><span>{t("stuguby.coordinatorUrl")}</span><input readOnly type="url" value={index.publicOrigin} /></label>}
        </div>
      </details>
      <button className="primary-button" disabled={busy !== null || !index || (!index.publicOrigin && !createCoordinatorUrl.trim())}>{busy === "create" ? <LoaderCircle className="spin" size={16} /> : <Network size={16} />}{t("stuguby.create")}</button>
    </form>;
  const connectionSetup = <div className="stuguby-onboarding-grid">
    {createPanel}

    <form className="stuguby-card stuguby-setup-card" onSubmit={joinStuguby}>
      <div className="stuguby-card-title"><Link size={19} aria-hidden="true" /><div><h2>{t("stuguby.joinTitle")}</h2><p>{t("stuguby.joinBody")}</p></div></div>
      <label className="field"><span>{t("stuguby.invitationLink")}</span><input type="url" value={joinUrl} onChange={(event) => setJoinUrl(event.target.value)} placeholder={t("stuguby.invitationPlaceholder")} /><small>{t("stuguby.invitationHelp")}</small></label>
      <details className="stuguby-subdetails">
        <summary>{t("stuguby.manualJoin")}</summary>
        <div className="stuguby-subdetails-body">
          <label className="field"><span>{t("stuguby.coordinatorUrl")}</span><input required type="url" value={joinCoordinatorUrl} onChange={(event) => setJoinCoordinatorUrl(event.target.value)} /></label>
          <label className="field"><span>{t("stuguby.invitationId")}</span><input required value={joinInvitationId} onChange={(event) => setJoinInvitationId(event.target.value)} /></label>
          <label className="field"><span>{t("stuguby.joinSecret")}</span><input required type="password" autoComplete="off" value={joinSecret} onChange={(event) => setJoinSecret(event.target.value)} /></label>
        </div>
      </details>
      <button className="primary-button" disabled={busy !== null || !joinCoordinatorUrl || !joinInvitationId || !joinSecret}>{busy === "join" ? <LoaderCircle className="spin" size={16} /> : <Link size={16} />}{t("stuguby.joinWithoutSharing")}</button>
    </form>
  </div>;

  return <div className="stuguby-page">
    <header className="stuguby-page-header">
      <div><span className="eyebrow">{t("stuguby.eyebrow")}</span><h1>{t("nav.stugubys")}</h1><p>{t("stuguby.description")}</p></div>
      <StugubyMark />
    </header>

    <section className="stuguby-boundary" aria-labelledby="stuguby-boundary-title">
      <ShieldCheck size={24} aria-hidden="true" />
      <div><h2 id="stuguby-boundary-title">{t("stuguby.boundaryTitle")}</h2><p>{t("stuguby.boundaryBody")}</p></div>
    </section>

    {error && <p className="inline-error stuguby-error" role="alert">{error}</p>}
    {notice && <p className="stuguby-notice" role="status">{notice}</p>}

    {!index ? <section className="stuguby-card stuguby-load-failure" aria-labelledby="stuguby-load-failure-title">
      <Database size={22} aria-hidden="true" />
      <div><h2 id="stuguby-load-failure-title">{t("stuguby.loadFailedTitle")}</h2><p>{t("stuguby.loadFailedBody")}</p></div>
      <button type="button" className="primary-button" disabled={busy !== null} onClick={() => void withBusy("retry", async () => { await load(); })}>
        <RefreshCw size={16} aria-hidden="true" />{t("stuguby.retry")}
      </button>
    </section> : <>
      {index.stugubys.length === 0 ? connectionSetup : <details className="stuguby-card stuguby-collapsible stuguby-connect-panel">
        <summary><Plus size={18} aria-hidden="true" /><span><strong>{t("stuguby.connectAnother")}</strong><small>{t("stuguby.connectAnotherBody")}</small></span></summary>
        <div className="stuguby-collapsible-body">{connectionSetup}</div>
      </details>}

    {index.stugubys.length > 0 && <>
      <nav className="stuguby-selector" aria-label={t("nav.stugubys")}>
        {index.stugubys.map((stuguby) => <button
          key={stuguby.id}
          type="button"
          className={selectedId === stuguby.id ? "active" : ""}
          aria-current={selectedId === stuguby.id ? "true" : undefined}
          disabled={busy !== null || detailLoading}
          onClick={() => {
            if (stuguby.id === selectedId && currentDetail) return;
            beginSelection(stuguby.id);
            void withBusy("select", async () => { await loadDetail(stuguby.id); });
          }}
        ><strong>{stuguby.name}</strong><span>{roleLabel(stuguby.localRole)} · {t(stuguby.memberCount === 1 ? "stuguby.nodeCountOne" : "stuguby.nodeCountMany", { count: stuguby.memberCount })}</span></button>)}
      </nav>

      {detailLoading && <output className="stuguby-detail-loading"><LoaderCircle className="spin" size={18} aria-hidden="true" />{t("stuguby.loadingSelection")}</output>}
      {detail && detail.stuguby.id === selectedId && <div className="stuguby-detail">
        <section className="stuguby-card stuguby-summary-card">
          <div><span className={`status-dot ${detail.stuguby.lastSyncError ? "error" : ""}`} aria-hidden="true" /> <strong>{stateLabel(detail.stuguby.localMemberState)}</strong></div>
          <dl><div><dt>{t("stuguby.localRole")}</dt><dd>{roleLabel(detail.stuguby.localRole)}</dd></div><div><dt>{t("stuguby.syncAutomatic")}</dt><dd>{formattedTime(detail.stuguby.lastSyncAt, t("stuguby.never"), locale)}</dd></div></dl>
          <details className="stuguby-summary-actions">
            <summary>{t("nav.advanced")}</summary>
            <div>
              <small>{t("stuguby.coordinator")}</small>
              <code>{detail.stuguby.coordinatorUrl}</code>
              <button type="button" className="secondary-button" disabled={busy !== null || detail.stuguby.localMemberState === "left" || detail.stuguby.localMemberState === "revoked"} onClick={() => void withBusy("sync", async () => { await api.syncStuguby(detail.stuguby.id); onInventoryChange?.(); await load(detail.stuguby.id); })}><RefreshCw aria-hidden="true" className={busy === "sync" ? "spin" : ""} size={16} />{t("stuguby.syncNow")}</button>
              <div className="stuguby-delete-action">
                <strong>{t("stuguby.delete")}</strong>
                <small>{t(deletionBlocked ? "stuguby.deleteBlocked" : "stuguby.deleteHelp")}</small>
                <button type="button" className="danger-button" disabled={busy !== null || deletionBlocked} onClick={deleteStuguby}>{busy === "delete" ? <LoaderCircle aria-hidden="true" className="spin" size={16} /> : <Trash2 aria-hidden="true" size={16} />}{t("stuguby.delete")}</button>
              </div>
            </div>
          </details>
          {detail.stuguby.lastSyncError && <p className="inline-error stuguby-summary-error" role="alert">{detail.stuguby.lastSyncError}</p>}
        </section>

        <section className="stuguby-card">
          <div className="stuguby-card-title"><Users size={19} aria-hidden="true" /><div><h2>{t("stuguby.participants")}</h2><p>{t("stuguby.nodeRolesBody")}</p></div></div>
          <div className="stuguby-member-list">{detail.members.map((member) => {
            const isLocal = member.nodeId === index.identity.nodeId;
            const name = memberName(member);
            return <div className="stuguby-member" key={member.nodeId}>
              <MemberIdentity
                member={member}
                isLocal={isLocal}
                disabled={busy !== null}
                youLabel={t("stuguby.you")}
                privateLabel={t("stuguby.privateMemberLabel")}
                privateLabelPlaceholder={t("stuguby.privateMemberLabelPlaceholder")}
                metadata={`${member.displayName} · ${member.keyFingerprint.slice(0, 12)}… · ${stateLabel(member.state)}`}
                onSave={(value) => updateMemberLocalLabel(member, value)}
              />
              <div className="stuguby-member-controls">
                {coordinator && member.role !== "steward" ? <><select aria-label={`${t("stuguby.localRole")}: ${name}`} value={member.role} disabled={busy !== null} onChange={(event) => updateMember(member, { role: event.target.value as StugubyRole })}><option value="property-manager">{t("stuguby.role.propertyManager")}</option><option value="participant">{t("stuguby.role.participant")}</option><option value="viewer">{t("stuguby.role.viewer")}</option></select><select aria-label={`${t("stuguby.memberState")}: ${name}`} value={member.state} disabled={busy !== null} onChange={(event) => updateMember(member, { state: event.target.value as StugubyMember["state"] })}><option value="active">{t("stuguby.state.active")}</option><option value="suspended">{t("stuguby.state.suspended")}</option><option value="left">{t("stuguby.state.left")}</option><option value="revoked">{t("stuguby.state.revoked")}</option></select></> : <span className="role-pill">{roleLabel(member.role)}</span>}
              </div>
            </div>;
          })}</div>
          {coordinator && !coordinatorInvitationReady && <p className="stuguby-capability-note" role="note">{t("stuguby.invitationUnavailable")}</p>}
          {coordinator && <form className="stuguby-invite-form" onSubmit={(event) => {
            event.preventDefault();
            if (!coordinatorInvitationReady) return;
            void withBusy("invite", async () => {
              setCreatedInvitation(await api.createStugubyInvitation(detail.stuguby.id, {
                role: inviteRole,
                localLabel: inviteLocalLabel.trim(),
                ...(inviteExpiresAt ? { expiresAt: new Date(inviteExpiresAt).toISOString() } : {}),
              }));
              setInviteLocalLabel("");
              setInviteExpiresAt("");
              await loadDetail(detail.stuguby.id);
            });
          }}>
            <div className="stuguby-quick-action">
              <div><strong>{t("stuguby.createInvitation")}</strong><small>{inviteRole === "participant" && !inviteExpiresAt ? t("stuguby.invitationDefaults") : `${roleLabel(inviteRole)} · ${inviteExpiresAt || t("stuguby.never")}`}</small></div>
              <div className="field stuguby-invite-local-label"><label htmlFor="stuguby-invite-local-label">{t("stuguby.inviteeLabel")}</label><input id="stuguby-invite-local-label" required maxLength={200} aria-describedby="stuguby-invite-local-label-help" value={inviteLocalLabel} placeholder={t("stuguby.inviteeLabelPlaceholder")} onChange={(event) => setInviteLocalLabel(event.target.value)} /><small id="stuguby-invite-local-label-help">{t("stuguby.inviteeLabelHelp")}</small></div>
              <button className="primary-button" disabled={busy !== null || !coordinatorInvitationReady || !inviteLocalLabel.trim()}>{busy === "invite" ? <LoaderCircle className="spin" size={16} /> : <KeyRound size={16} />}{t("stuguby.createInvitation")}</button>
            </div>
            <details className="stuguby-subdetails">
              <summary>{t("stuguby.invitationOptions")}</summary>
              <div className="stuguby-form-grid stuguby-subdetails-body"><label className="field"><span>{t("stuguby.newRole")}</span><select value={inviteRole} onChange={(event) => setInviteRole(event.target.value as typeof inviteRole)}><option value="participant">{t("stuguby.role.participant")}</option><option value="property-manager">{t("stuguby.role.propertyManager")}</option><option value="viewer">{t("stuguby.role.viewer")}</option></select></label><label className="field"><span>{t("stuguby.invitationExpiry")}</span><input type="datetime-local" value={inviteExpiresAt} onChange={(event) => setInviteExpiresAt(event.target.value)} /></label></div>
            </details>
          </form>}
          {createdInvitation?.stugubyId === detail.stuguby.id && <div className="stuguby-invitation" role="status"><strong>{t("stuguby.invitationOnce")}</strong><code>{createdInvitation.joinUrl}</code><button type="button" className="secondary-button" onClick={() => void (async () => {
            try {
              if (!navigator.clipboard?.writeText) throw new Error("Clipboard unavailable");
              await navigator.clipboard.writeText(createdInvitation.joinUrl);
              setCopied(true);
              window.setTimeout(() => setCopied(false), 1500);
            } catch {
              setError(t("stuguby.copyFailed"));
            }
          })()}>{copied ? <Check size={16} aria-hidden="true" /> : <Copy size={16} aria-hidden="true" />}{t(copied ? "stuguby.copied" : "stuguby.copy")}</button></div>}
          {coordinator && <details className="stuguby-subdetails"><summary>{t("stuguby.invitations")} ({detail.invitations.length})</summary><div className="stuguby-existing-grants stuguby-subdetails-body">{detail.invitations.length === 0 ? <p>{t("stuguby.noInvitations")}</p> : detail.invitations.map((invitation) => {
            const active = !invitation.usedAt && !invitation.revokedAt && Date.parse(invitation.expiresAt) > Date.now();
            const status = invitation.usedAt ? t("stuguby.invitationUsed") : invitation.revokedAt ? t("stuguby.invitationRevoked") : active ? t("stuguby.invitationActive") : t("stuguby.invitationExpired");
            return <article key={invitation.id}><div className="stuguby-record-copy"><strong>{invitation.localLabel || roleLabel(invitation.role)}</strong><span>{roleLabel(invitation.role)} · {status} · {formattedTime(invitation.expiresAt, t("stuguby.never"), locale)}</span><small>{invitation.id}</small></div>{active && <div className="stuguby-record-actions"><button type="button" className="danger-button" disabled={busy !== null} onClick={() => {
              if (!window.confirm(t("stuguby.confirmRevokeInvitation", { id: invitation.id.slice(0, 12) }))) return;
              void withBusy(`invitation:${invitation.id}`, async () => { await api.revokeStugubyInvitation(detail.stuguby.id, invitation.id); setNotice(t("stuguby.changesSaved")); await loadDetail(detail.stuguby.id); });
            }}><Trash2 size={15} aria-hidden="true" />{t("stuguby.revokeInvitation")}</button></div>}</article>;
          })}</div></details>}
        </section>

        <section className="stuguby-card stuguby-property-connection">
          <div className="stuguby-card-title"><StugubyMark className="small" /><div><h2>{t("stuguby.propertyConnection")}</h2><p>{t("stuguby.propertyConnectionBody")}</p></div></div>
          {!detail.propertyAdoption ? <div className="stuguby-adoption-action">
            {coordinator && unsharedProperties.length > 0 && <label className="field"><span>{t("stuguby.coordinatorProperty")}</span><select value={adoptionPropertyId} onChange={(event) => setAdoptionPropertyId(event.target.value)}>{unsharedProperties.map((candidate) => <option key={candidate.id} value={candidate.id}>{candidate.name}</option>)}</select><small>{t("stuguby.coordinatorPropertyHelp")}</small></label>}
            <button type="button" className="primary-button" disabled={busy !== null || !detail.sharedProperty} onClick={adoptSharedProperty}>{busy === "adopt-property" ? <LoaderCircle className="spin" size={16} /> : <StugubyMark className="small" />}{coordinator && adoptionPropertyId ? t("stuguby.connectProperty") : t("stuguby.adoptProperty")}</button>
          </div> : <>
            <div className="stuguby-property-state">
              <span data-state={detail.propertyAdoption.state}>{detail.propertyAdoption.state === "adopted" ? t("stuguby.propertyConnected") : t("stuguby.propertyLocal")}</span>
              <strong>{properties.find((candidate) => candidate.id === detail.propertyAdoption?.localPropertyId)?.name ?? detail.sharedProperty?.name ?? detail.propertyAdoption.localPropertyId}</strong>
              {detail.propertyCommandCounts.pending > 0 && <small>{t("stuguby.pendingPropertyChanges", { count: detail.propertyCommandCounts.pending })}</small>}
              {detail.homeCommandCounts.pending > 0 && <small>{t("stuguby.pendingHomeChanges", { count: detail.homeCommandCounts.pending })}</small>}
              {detail.homeCommandCounts.conflicts > 0 && <small>{t("stuguby.homeConflicts", { count: detail.homeCommandCounts.conflicts })}</small>}
            </div>
            {detail.propertyConflicts.length > 0 && <section className="stuguby-conflicts" aria-labelledby="stuguby-conflicts-title">
              <div><AlertTriangle size={18} aria-hidden="true" /><div><h3 id="stuguby-conflicts-title">{t("stuguby.conflictsTitle")}</h3><p>{t("stuguby.conflictsBody")}</p></div></div>
              {detail.propertyConflicts.map((conflict) => <article key={conflict.commandId}><div><strong>{t("stuguby.conflictItem", { item: conflict.entityId, fields: conflict.fields.join(", ") })}</strong><small>{conflict.message}</small></div><button type="button" className="secondary-button" disabled={busy !== null} onClick={() => void withBusy(`conflict:${conflict.commandId}`, async () => { await api.resolveStugubyPropertyConflict(detail.stuguby.id, conflict.commandId); setNotice(t("stuguby.conflictAcknowledged")); await loadDetail(detail.stuguby.id); })}>{t("stuguby.acknowledgeConflict")}</button></article>)}
            </section>}
            {canPublish && !coordinator && detail.propertyAdoption.state === "adopted" && <details className="stuguby-subdetails">
              <summary>{t("stuguby.localPropertyMigration")}</summary>
              <div className="stuguby-subdetails-body stuguby-migration">
                <p>{t("stuguby.localPropertyMigrationBody")}</p>
                {migrationProperties.length > 0 ? <><label className="field"><span>{t("stuguby.propertyToMove")}</span><select value={migrationPropertyId} onChange={(event) => setMigrationPropertyId(event.target.value)}>{migrationProperties.map((candidate) => <option key={candidate.id} value={candidate.id}>{candidate.name}</option>)}</select></label><button type="button" className="danger-button" disabled={busy !== null || !migrationPropertyId} onClick={migrateLocalProperty}>{busy === "migrate-property" ? <LoaderCircle className="spin" size={16} /> : <Database size={16} />}{t("stuguby.moveIntoSharedProperty")}</button></> : <p>{t("stuguby.noLocalPropertyToMove")}</p>}
              </div>
            </details>}
            {detail.propertyAdoption.state === "adopted" && <details className="stuguby-subdetails stuguby-disconnect">
              <summary>{t("stuguby.permanentDisconnect")}</summary>
              <div className="stuguby-subdetails-body"><p>{t("stuguby.permanentDisconnectBody")}</p><button type="button" className="danger-button" disabled={busy !== null} onClick={disconnectProperty}>{busy === "disconnect-property" ? <LoaderCircle className="spin" size={16} /> : <Unplug size={16} />}{t("stuguby.disconnectAndKeepLocal")}</button></div>
            </details>}
          </>}
        </section>

        <details className="stuguby-card stuguby-collapsible stuguby-property-editor">
          <summary><Database size={19} aria-hidden="true" /><span><strong>{t("stuguby.sharedProperty")}</strong><small>{t("stuguby.sharedPropertyBody")}</small></span></summary>
          <form className="stuguby-collapsible-body" onSubmit={saveProperty}>
          {!detail.sharedProperty ? <p>{t("stuguby.noSharedProperty")}</p> : <>
            {!propertyWriter && <p className="stuguby-capability-note">{detail.stuguby.localMemberState !== "active" ? t("stuguby.inactiveCannotEdit", { state: stateLabel(detail.stuguby.localMemberState) }) : t("stuguby.roleCannotEdit")}</p>}
            <div className="stuguby-form-grid"><label className="field"><span>{t("stuguby.name")}</span><input required value={propertyName} disabled={!propertyWriter} onChange={(event) => setPropertyName(event.target.value)} /></label><label className="field"><span>{t("stuguby.descriptionField")}</span><input value={propertyDescription} disabled={!propertyWriter} onChange={(event) => setPropertyDescription(event.target.value)} /></label><label className="field"><span>{t("stuguby.latitude")}</span><input type="number" min="-90" max="90" step="any" value={propertyLatitude} disabled={!propertyWriter} onChange={(event) => setPropertyLatitude(event.target.value)} /></label><label className="field"><span>{t("stuguby.longitude")}</span><input type="number" min="-180" max="180" step="any" value={propertyLongitude} disabled={!propertyWriter} onChange={(event) => setPropertyLongitude(event.target.value)} /></label><label className="field"><span>{t("stuguby.locationLabel")}</span><input value={propertyLocationLabel} disabled={!propertyWriter} onChange={(event) => setPropertyLocationLabel(event.target.value)} /></label></div>
            <section className="stuguby-policy-panel">
              <div><strong>{t("stuguby.propertyEditing")}</strong><p>{t("stuguby.propertyEditingBody")}</p></div>
              <label className="field"><span>{t("stuguby.editPermission")}</span><select value={propertyEditPolicy} disabled={!coordinator} onChange={(event) => setPropertyEditPolicy(event.target.value as StugubySharedProperty["editPolicy"])}><option value="collaborative">{t("stuguby.propertyCollaborative")}</option><option value="read-only">{t("stuguby.readOnly")}</option></select></label>
              <label className="field"><span>{t("stuguby.designatedPropertySuccessor")}</span><select value={propertySuccessorNodeId} disabled={!coordinator} onChange={(event) => setPropertySuccessorNodeId(event.target.value)}><option value="">{t("stuguby.noSuccessor")}</option>{activeRemoteMembers.map((member) => <option key={member.nodeId} value={member.nodeId}>{member.displayName}</option>)}</select><small>{t("stuguby.designatedPropertySuccessorHelp")}</small></label>
            </section>
            <details className="stuguby-subdetails">
              <summary>{t("nav.advanced")}</summary>
              <div className="stuguby-subdetails-body"><p className="stuguby-json-help">{t("stuguby.jsonHelp")}</p>
                <div className="stuguby-json-grid"><label className="field"><span>{t("stuguby.areas")}</span><textarea value={areasJson} disabled={!propertyWriter} onChange={(event) => setAreasJson(event.target.value)} /></label><label className="field"><span>{t("stuguby.equipment")}</span><textarea value={equipmentJson} disabled={!propertyWriter} onChange={(event) => setEquipmentJson(event.target.value)} /></label><label className="field"><span>{t("stuguby.notes")}</span><textarea value={notesJson} disabled={!propertyWriter} onChange={(event) => setNotesJson(event.target.value)} /></label><label className="field"><span>{t("stuguby.maintenance")}</span><textarea value={maintenanceJson} disabled={!propertyWriter} onChange={(event) => setMaintenanceJson(event.target.value)} /></label></div>
              </div>
            </details>
            {propertyWriter && <button className="primary-button" disabled={busy !== null}>{busy === "property" ? <LoaderCircle className="spin" size={16} /> : <Check size={16} />}{t("stuguby.saveRevision", { revision: detail.sharedProperty.revision + 1 })}</button>}
          </>}
          </form>
        </details>

        <section className="stuguby-card stuguby-grants">
          <div className="stuguby-card-title"><ShieldCheck size={19} aria-hidden="true" /><div><h2>{t("stuguby.grantsTitle")}</h2><p>{t("stuguby.grantsBody")}</p></div></div>
          {canPublish ? grantHouseOptions.length > 0 ? <form onSubmit={saveGrant}>
            <div className="stuguby-form-grid"><label className="field"><span>{t("stuguby.localHome")}</span><select required disabled={editingGrantId !== null} value={grantHouseId} onChange={(event) => { setGrantHouseId(event.target.value); setTelemetrySensors(""); }}><option value="" disabled>{t("stuguby.chooseHome")}</option>{grantHouseOptions.map((house) => <option key={house.id} value={house.id}>{house.name}</option>)}</select></label><label className="field"><span>{t("stuguby.audience")}</span><select value={audienceKind} disabled={recoveryMode === "full"} onChange={(event) => { setAudienceKind(event.target.value as typeof audienceKind); setAudienceNodes([]); }}><option value="all-members">{t("stuguby.audienceAll")}</option><option value="members">{t("stuguby.audienceSelected")}</option></select></label></div>
            {audienceKind === "members" && <fieldset className="stuguby-audience"><legend>{t("stuguby.recipients")}</legend>{activeRemoteMembers.length === 0 ? <p>{t("stuguby.noEligibleRecipients")}</p> : activeRemoteMembers.map((member) => <label key={member.nodeId}><input type="checkbox" disabled={recoveryMode === "full"} checked={audienceNodes.includes(member.nodeId)} onChange={(event) => setAudienceNodes((current) => event.target.checked ? [...current, member.nodeId] : current.filter((id) => id !== member.nodeId))} />{member.displayName} ({roleLabel(member.role)})</label>)}{activeRemoteMembers.length > 0 && audienceNodes.length === 0 && <p className="stuguby-capability-note">{t("stuguby.audienceRequired")}</p>}</fieldset>}
            <section className="stuguby-policy-panel stuguby-home-policy">
              <div><strong>{t("stuguby.homePermission")}</strong><p>{t("stuguby.homePermissionBody")}</p></div>
              <label className="field"><span>{t("stuguby.editPermission")}</span><select value={houseEditPolicy} onChange={(event) => selectHouseEditPolicy(event.target.value as typeof houseEditPolicy)}><option value="read-only">{t("stuguby.readOnlyDefault")}</option><option value="editable" disabled={!coordinator}>{t("stuguby.allowEdits")}</option></select></label>
              <label className="field"><span>{t("stuguby.recoveryCopy")}</span><select value={recoveryMode} onChange={(event) => selectRecoveryMode(event.target.value as typeof recoveryMode)}><option value="none">{t("stuguby.noRecoveryCopy")}</option><option value="full">{t("stuguby.fullRecoveryCopy")}</option></select><small>{t("stuguby.recoveryCopyHelp")}</small></label>
              {recoveryMode === "full" && <label className="field"><span>{t("stuguby.designatedSuccessor")}</span><select required value={houseSuccessorNodeId} onChange={(event) => { setHouseSuccessorNodeId(event.target.value); setAudienceKind("members"); setAudienceNodes(event.target.value ? [event.target.value] : []); }}><option value="" disabled>{t("stuguby.chooseSuccessor")}</option>{activeRemoteMembers.map((member) => <option key={member.nodeId} value={member.nodeId}>{member.displayName}</option>)}</select><small>{t("stuguby.fullRecoveryBoundary")}</small></label>}
            </section>
            {!editingGrantId && <div className="stuguby-recommended-profile"><Sparkles size={20} aria-hidden="true" /><div><strong>{t("stuguby.recommendedProfile")}</strong><p>{t("stuguby.recommendedProfileBody")}</p></div></div>}
            <details key={editingGrantId ?? "new-grant"} className="stuguby-subdetails stuguby-sharing-options" open={editingGrantId !== null ? true : undefined}>
              <summary>{t("stuguby.customizeSharing")}</summary>
              <div className="stuguby-subdetails-body">
              <label className="field stuguby-expiry-field"><span>{t("stuguby.expiresAt")}</span><input type="datetime-local" value={grantExpiresAt} onChange={(event) => setGrantExpiresAt(event.target.value)} /></label>
              <div className="stuguby-dataset-table" role="group" aria-label={t("stuguby.sharedDatasets")}>
              <div className="stuguby-dataset-heading"><span>{t("stuguby.dataset")}</span><span>{t("stuguby.localIds")}</span><span>{t("stuguby.cache")}</span><span>{t("stuguby.days")}</span></div>
              {STUGBY_DATASETS.map((dataset) => {
                const draft = datasetDraft[dataset];
                const label = t(datasetLabelKeys[dataset]);
                return <div className={`stuguby-dataset-row ${dataset === "home.location.v1" ? "sensitive" : ""}`} key={dataset}>
                  <label><input type="checkbox" disabled={recoveryMode === "full" || (houseEditPolicy === "editable" && editableHomeDatasets.has(dataset))} checked={draft.enabled} onChange={(event) => setDatasetDraft((current) => ({ ...current, [dataset]: { ...current[dataset], enabled: event.target.checked } }))} /><span><strong>{label}</strong><small>{dataset}</small></span></label>
                  <label className="stuguby-dataset-option"><span>{t("stuguby.localIds")}</span><input aria-label={`${t("stuguby.localIds")}: ${label}`} type="checkbox" disabled={!draft.enabled || recoveryMode === "full"} checked={draft.includeLocalIds} onChange={(event) => setDatasetDraft((current) => ({ ...current, [dataset]: { ...current[dataset], includeLocalIds: event.target.checked } }))} /></label>
                  <label className="stuguby-dataset-option"><span>{t("stuguby.cache")}</span><input aria-label={`${t("stuguby.cache")}: ${label}`} type="checkbox" disabled={!draft.enabled || recoveryMode === "full" || (houseEditPolicy === "editable" && editableHomeDatasets.has(dataset))} checked={draft.allowReplicaCache} onChange={(event) => setDatasetDraft((current) => ({ ...current, [dataset]: { ...current[dataset], allowReplicaCache: event.target.checked } }))} /></label>
                  <label className="stuguby-dataset-option"><span>{t("stuguby.days")}</span><input aria-label={`${t("stuguby.days")}: ${label}`} type="number" min="0" max="3650" disabled={!draft.enabled || recoveryMode === "full" || (houseEditPolicy === "editable" && editableHomeDatasets.has(dataset))} value={draft.retentionDays} onChange={(event) => setDatasetDraft((current) => ({ ...current, [dataset]: { ...current[dataset], retentionDays: Number(event.target.value) } }))} /></label>
                </div>;
              })}
              </div>
            {datasetDraft["home.location.v1"].enabled && <p className="stuguby-sensitive-warning">{t("stuguby.locationWarning")}</p>}
            {datasetDraft["home.telemetry.v1"].enabled && <><div className="stuguby-telemetry-options"><label><input type="checkbox" disabled={recoveryMode === "full"} checked={telemetryLive} onChange={(event) => setTelemetryLive(event.target.checked)} />{t("stuguby.telemetryLive")}</label><label className="field"><span>{recoveryMode === "full" ? t("stuguby.allHistory") : t("stuguby.historyHours")}</span><input type="number" min="0" disabled={recoveryMode === "full"} value={telemetryHistoryHours} onChange={(event) => setTelemetryHistoryHours(event.target.value)} /></label><label className="field"><span>{t("stuguby.metrics")}</span><input disabled={recoveryMode === "full"} value={telemetryMetrics} onChange={(event) => setTelemetryMetrics(event.target.value)} /></label><label className="field"><span>{t("stuguby.maximumSamples")}</span><input type="number" min="1" max="1000000" disabled={recoveryMode === "full"} value={telemetryRate} onChange={(event) => setTelemetryRate(event.target.value)} /></label></div>{publicationCatalog.status === "loading" && publicationCatalog.houseId === grantHouseId && <p role="status">{t("stuguby.sensorCatalogLoading")}</p>}{publicationCatalog.status === "error" && publicationCatalog.houseId === grantHouseId && <div className="stuguby-catalog-error" role="alert"><p>{publicationCatalog.error}</p><button type="button" className="secondary-button" onClick={() => setCatalogRevision((current) => current + 1)}>{t("stuguby.retry")}</button></div>}{matchingCatalog && <fieldset className="stuguby-audience"><legend>{t("stuguby.sensorScope")}</legend><label><input type="checkbox" disabled={recoveryMode === "full"} checked={!telemetrySensors} onChange={() => setTelemetrySensors("")} />{t("stuguby.allSensors")}</label>{matchingCatalog.sensors.map((sensor) => { const selected = telemetrySensors.split(",").map((item) => item.trim()).filter(Boolean); return <label key={sensor.sensorPublicationId}><input type="checkbox" disabled={recoveryMode === "full"} checked={selected.includes(sensor.sensorPublicationId)} onChange={(event) => setTelemetrySensors(event.target.checked ? [...selected, sensor.sensorPublicationId].join(",") : selected.filter((id) => id !== sensor.sensorPublicationId).join(","))} />{sensor.name}<small>{sensor.metricIds.join(", ") || t("stuguby.noMetrics")}</small></label>; })}</fieldset>}</>}
              </div>
            </details>
            <div className="stuguby-grant-submit"><button className="primary-button" disabled={busy !== null || !grantHouseId || (recoveryMode === "full" ? !houseSuccessorNodeId : audienceKind === "members" && audienceNodes.length === 0) || (datasetDraft["home.telemetry.v1"].enabled && !catalogMatches)}>{busy === "grant" ? <LoaderCircle aria-hidden="true" className="spin" size={16} /> : <ShieldCheck aria-hidden="true" size={16} />}{t(editingGrantId ? "stuguby.updateGrant" : "stuguby.startSharing")}</button>{editingGrantId && <button type="button" className="secondary-button" onClick={resetGrantDraft}>{t("stuguby.cancelEdit")}</button>}</div>
          </form> : <p className="stuguby-capability-note">{t(publishableHouses.length === 0 ? "stuguby.noLocalHomesToShare" : "stuguby.allHomesAlreadyShared")}</p> : <p>{cannotPublishMessage}</p>}
          {duplicatedHomeNames.length > 0 && <p className="stuguby-duplicate-warning" role="note">{t("stuguby.duplicateHomeShares", { homes: duplicatedHomeNames.join(", ") })}</p>}
          <div className="stuguby-existing-grants">{detail.grants.length === 0 ? <p>{t("stuguby.noGrants")}</p> : detail.grants.map((grant) => {
            const homeName = grantHomeName(grant, houses, detail.remoteResources);
            const isActive = activeGrant(grant);
            const duplicate = Boolean(grant.localHouseId && duplicatedLocalHouseIds.has(grant.localHouseId) && isActive);
            const stateKey = grant.revokedAt ? "stuguby.state.revoked" : isActive ? "stuguby.state.active" : "stuguby.state.expired";
            const audienceKey = grant.audience.kind === "all-members"
              ? "stuguby.grantAudienceAll"
              : grant.audience.nodeIds.length === 1 ? "stuguby.grantAudienceSelectedOne" : "stuguby.grantAudienceSelectedMany";
            return <article className={duplicate ? "has-duplicate" : undefined} key={grant.id}>
              <div className="stuguby-record-copy">
                <strong>{homeName ?? `${grant.publicationId.slice(0, 12)}…`}</strong>
                {duplicate && <small className="stuguby-duplicate-label">{t("stuguby.duplicateActiveShare")}</small>}
                <span>{t("stuguby.grantSummary", { authority: t(grant.authorityNodeId === index.identity.nodeId ? "stuguby.localAuthority" : "stuguby.remoteAuthority"), epoch: grant.epoch, state: t(stateKey) })}</span>
                <small>{t(audienceKey, { count: grant.audience.nodeIds.length })}</small>
                <small>{t(grant.housePolicy.editPolicy === "read-only" ? "stuguby.sharedHomeReadOnly" : "stuguby.sharedHomeEditable")}{grant.housePolicy.recoveryMode === "full" ? ` · ${t("stuguby.fullRecoveryEnabled")}` : ""}</small>
                <small>{grant.datasets.filter((dataset) => dataset.enabled).map((dataset) => t(datasetLabelKeys[dataset.dataset])).join(" · ")}</small>
              </div>
              {grant.authorityNodeId === index.identity.nodeId && isActive && <div className="stuguby-record-actions">
                <button type="button" className="secondary-button" disabled={busy !== null} onClick={() => editGrant(grant)}><Pencil size={15} aria-hidden="true" />{t("stuguby.editGrant")}</button>
                <button type="button" className="secondary-button" disabled={busy !== null} onClick={() => void withBusy(`republish:${grant.id}`, async () => { await api.republishStugubyGrant(detail.stuguby.id, grant.id); setNotice(t("stuguby.republishQueued")); })}><RefreshCw size={15} aria-hidden="true" />{t("stuguby.republish")}</button>
                <button type="button" className="danger-button" disabled={busy !== null} onClick={() => { if (window.confirm(t("stuguby.confirmRevoke"))) void withBusy(`revoke:${grant.id}`, async () => { await api.revokeStugubyGrant(detail.stuguby.id, grant.id); setNotice(t("stuguby.changesSaved")); await loadDetail(detail.stuguby.id); }); }}><Trash2 size={15} aria-hidden="true" />{t("stuguby.revoke")}</button>
              </div>}
            </article>;
          })}</div>
        </section>

        <details className="stuguby-card stuguby-collapsible">
          <summary><Database size={19} aria-hidden="true" /><span><strong>{t("stuguby.remoteTitle")}</strong><small>{t("stuguby.remoteBody")}</small></span></summary>
          <div className="stuguby-collapsible-body">
          {detail.remoteResources.length === 0 ? <p>{t("stuguby.noRemote")}</p> : <div className="stuguby-resource-list">{detail.remoteResources.map((resource) => {
            const resourceLabel = t(datasetLabelKeys[resource.schema]);
            return <details key={`${resource.authorityNodeId}:${resource.schema}:${resource.resourceId}`}><summary><span><strong>{resourceLabel}</strong><small>{t("stuguby.resourceSummary", { authority: `${resource.authorityNodeId.slice(0, 12)}…`, revision: resource.revision })} · {t("stuguby.receivedAt", { time: formattedTime(resource.receivedAt, t("stuguby.never"), locale) })}</small></span><span className={resource.stale ? "stale" : "fresh"}>{t(resource.stale ? "stuguby.stale" : "stuguby.current")}</span></summary><pre tabIndex={0} role="region" aria-label={resourceLabel}>{JSON.stringify(resource.payload, null, 2)}</pre></details>;
          })}</div>}
          <div className="stuguby-telemetry-preview"><h3>{t("stuguby.telemetryPreview")}</h3>{telemetryError ? <p className="inline-error" role="alert">{telemetryError}</p> : telemetrySamples.length === 0 ? <p>{t("stuguby.noTelemetry")}</p> : <p>{t("stuguby.telemetryPreviewBody", { count: telemetrySamples.length })}</p>}{telemetrySamples.length > 0 && <details><summary>{t("stuguby.showTelemetry")}</summary><pre tabIndex={0} role="region" aria-label={t("stuguby.telemetryPreview")}>{JSON.stringify(telemetrySamples, null, 2)}</pre></details>}</div>
          </div>
        </details>

        <details className="stuguby-card stuguby-collapsible">
          <summary><Settings2 size={19} aria-hidden="true" /><span><strong>{t("stuguby.operations")}</strong><small>{t("stuguby.operationsBody")}</small></span></summary>
          <div className="stuguby-collapsible-body">
          <h3>{t("stuguby.deletionReceipts")}</h3>
          {detail.deletionReceipts.length === 0 ? <p>{t("stuguby.noDeletionReceipts")}</p> : <div className="stuguby-resource-list">{detail.deletionReceipts.map((receipt) => <div className="stuguby-operation" key={`${receipt.nodeId}:${receipt.grantId}:${receipt.grantEpoch}`}><strong>{t("stuguby.receiptSummary", { grant: receipt.grantId.slice(0, 12), epoch: receipt.grantEpoch })}</strong><small>{receipt.nodeId.slice(0, 12)}… · {formattedTime(receipt.deletedAt, t("stuguby.never"), locale)}</small></div>)}</div>}
          <h3>{t("stuguby.audit")}</h3>
          {detail.audit.length === 0 ? <p>{t("stuguby.noAuditEvents")}</p> : <div className="stuguby-resource-list">{detail.audit.slice(0, 25).map((entry) => <div className="stuguby-operation" key={entry.id}><strong>{entry.eventType}</strong><small>{formattedTime(entry.createdAt, t("stuguby.never"), locale)} · {entry.subjectId ?? "—"}</small></div>)}</div>}
          </div>
        </details>
      </div>}
    </>}
    </>}
  </div>;
}
