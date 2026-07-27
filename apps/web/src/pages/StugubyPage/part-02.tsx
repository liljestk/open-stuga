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
} from "../../api";
import { StugubyMark } from "../../components/StugubyMark";
import { useI18n, type TranslationKey } from "../../i18n";
import { CloudflareSetupPanel } from "../CloudflareSetupPanel";
import "../StugubyPage.css";
import { MemberIdentity, activeGrant, datasetLabelKeys, editableHomeDatasets, errorMessage, formattedTime, grantHomeName, idlePublicationCatalog, initialDatasetDraft, localDateTimeInput, loopbackOrigin, memberStateLabelKeys, parseArray, roleLabelKeys, suggestedCoordinatorOrigin } from "./support";
import type { DatasetDraft, PublicationCatalogState, StugubyPageProps } from "./support";
import { useStugubyPagePart01 } from "./part-01";
export function useStugubyPagePart02(context: ReturnType<typeof useStugubyPagePart01>) {
  const { houses, properties, onInventoryChange, locale, t, roleLabel, stateLabel, index, setIndex, detail, setDetail, selectedId, setSelectedId, loading, setLoading, busy, setBusy, error, setError, notice, setNotice, detailLoading, setDetailLoading, telemetryError, setTelemetryError, copied, setCopied, cloudflareSetupRequested, setCloudflareSetupRequested, createdInvitation, setCreatedInvitation, telemetrySamples, setTelemetrySamples, createName, setCreateName, createDescription, setCreateDescription, createCoordinatorUrl, setCreateCoordinatorUrl, joinCoordinatorUrl, setJoinCoordinatorUrl, joinUrl, setJoinUrl, joinInvitationId, setJoinInvitationId, joinSecret, setJoinSecret, inviteRole, setInviteRole, inviteLocalLabel, setInviteLocalLabel, inviteExpiresAt, setInviteExpiresAt, publishableHouses, grantHouseId, setGrantHouseId, audienceKind, setAudienceKind, audienceNodes, setAudienceNodes, datasetDraft, setDatasetDraft, telemetryLive, setTelemetryLive, telemetryHistoryHours, setTelemetryHistoryHours, telemetryMetrics, setTelemetryMetrics, telemetrySensors, setTelemetrySensors, telemetryRate, setTelemetryRate, grantExpiresAt, setGrantExpiresAt, houseEditPolicy, setHouseEditPolicy, recoveryMode, setRecoveryMode, houseSuccessorNodeId, setHouseSuccessorNodeId, editingGrantId, setEditingGrantId, publicationCatalog, setPublicationCatalog, catalogRevision, setCatalogRevision, activeLocalGrantHouseIds, unsharedHouses, grantHouseOptions, propertyName, setPropertyName, propertyDescription, setPropertyDescription, propertyLatitude, setPropertyLatitude, propertyLongitude, setPropertyLongitude, propertyLocationLabel, setPropertyLocationLabel, areasJson, setAreasJson, equipmentJson, setEquipmentJson, notesJson, setNotesJson, maintenanceJson, setMaintenanceJson, propertyEditPolicy, setPropertyEditPolicy, propertySuccessorNodeId, setPropertySuccessorNodeId, adoptionPropertyId, setAdoptionPropertyId, migrationPropertyId, setMigrationPropertyId, detailRequest, selectedIdRef, resetGrantDraft, resetStugubyScopedUi, beginSelection, loadDetail } = context;
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
  useEffect(() => { void load(); }, []);
  // Initial owner-controlled load only.

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
  return Object.assign(context, { load, withBusy, createStuguby, joinStuguby, activeRemoteMembers, selectRecoveryMode, selectHouseEditPolicy, saveGrant });
}
