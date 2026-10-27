import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  type StugubyMember,
  type StugubyRole,
  type StugubyShareGrant,
  type StugubySharedProperty,
} from "@climate-twin/stuguby-protocol";
import {
  api,
  type StugubyDetailResponse,
  type StugubyInvitationCreated,
  type StugubyListResponse,
  type StugubyRemoteTelemetrySample,
} from "../../api";
import { useI18n } from "../../i18n";
import "../StugubyPage.css";
import { activeGrant, errorMessage, idlePublicationCatalog, initialDatasetDraft, memberStateLabelKeys, roleLabelKeys, suggestedCoordinatorOrigin } from "./support";
import type { PublicationCatalogState, StugubyPageProps } from "./support";

type StugubyActiveScope = Readonly<{
  id: string;
  generation: number;
}>;

export function useStugubyPagePart01(context: { houses: Readonly<StugubyPageProps>["houses"]; properties: Exclude<Readonly<StugubyPageProps>["properties"], undefined>; onInventoryChange: Readonly<StugubyPageProps>["onInventoryChange"] }) {
  const { houses } = context;
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
  const activeScopeRef = useRef<StugubyActiveScope | null>(null);
  const scopeGenerationRef = useRef(0);
  const advanceActiveScope = useCallback((id: string): StugubyActiveScope => {
      const scope = { id, generation: ++scopeGenerationRef.current };
      activeScopeRef.current = scope;
      return scope;
    }, []);
  const captureActiveScope = useCallback((id: string): StugubyActiveScope | null => {
      const scope = activeScopeRef.current;
      return scope?.id === id && selectedIdRef.current === id ? scope : null;
    }, []);
  const isActiveScope = useCallback((scope: StugubyActiveScope | null): scope is StugubyActiveScope => (
      scope !== null && activeScopeRef.current === scope && selectedIdRef.current === scope.id
    ), []);
  useEffect(() => () => {
      activeScopeRef.current = null;
      selectedIdRef.current = "";
      detailRequest.current += 1;
    }, []);
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
      advanceActiveScope(id);
      selectedIdRef.current = id;
      setSelectedId(id);
      setDetail(null);
      resetStugubyScopedUi();
    }, [advanceActiveScope, resetStugubyScopedUi]);
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
  return Object.assign(context, { locale, t, roleLabel, stateLabel, index, setIndex, detail, setDetail, selectedId, setSelectedId, loading, setLoading, busy, setBusy, error, setError, notice, setNotice, detailLoading, setDetailLoading, telemetryError, setTelemetryError, copied, setCopied, cloudflareSetupRequested, setCloudflareSetupRequested, createdInvitation, setCreatedInvitation, telemetrySamples, setTelemetrySamples, createName, setCreateName, createDescription, setCreateDescription, createCoordinatorUrl, setCreateCoordinatorUrl, joinCoordinatorUrl, setJoinCoordinatorUrl, joinUrl, setJoinUrl, joinInvitationId, setJoinInvitationId, joinSecret, setJoinSecret, inviteRole, setInviteRole, inviteLocalLabel, setInviteLocalLabel, inviteExpiresAt, setInviteExpiresAt, publishableHouses, grantHouseId, setGrantHouseId, audienceKind, setAudienceKind, audienceNodes, setAudienceNodes, datasetDraft, setDatasetDraft, telemetryLive, setTelemetryLive, telemetryHistoryHours, setTelemetryHistoryHours, telemetryMetrics, setTelemetryMetrics, telemetrySensors, setTelemetrySensors, telemetryRate, setTelemetryRate, grantExpiresAt, setGrantExpiresAt, houseEditPolicy, setHouseEditPolicy, recoveryMode, setRecoveryMode, houseSuccessorNodeId, setHouseSuccessorNodeId, editingGrantId, setEditingGrantId, publicationCatalog, setPublicationCatalog, catalogRevision, setCatalogRevision, activeLocalGrantHouseIds, unsharedHouses, grantHouseOptions, propertyName, setPropertyName, propertyDescription, setPropertyDescription, propertyLatitude, setPropertyLatitude, propertyLongitude, setPropertyLongitude, propertyLocationLabel, setPropertyLocationLabel, areasJson, setAreasJson, equipmentJson, setEquipmentJson, notesJson, setNotesJson, maintenanceJson, setMaintenanceJson, propertyEditPolicy, setPropertyEditPolicy, propertySuccessorNodeId, setPropertySuccessorNodeId, adoptionPropertyId, setAdoptionPropertyId, migrationPropertyId, setMigrationPropertyId, detailRequest, selectedIdRef, captureActiveScope, isActiveScope, resetGrantDraft, resetStugubyScopedUi, beginSelection, loadDetail });
}
