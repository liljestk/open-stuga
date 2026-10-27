import { type FormEvent } from "react";
import {
  STUGBY_DATASETS,
  type StugubyDataset,
  type StugubyMember,
  type StugubyRole,
  type StugubyShareGrant,
  type StugubySharedProperty,
} from "@climate-twin/stuguby-protocol";
import {
  api,
  type StugubyLocalMember,
} from "../../api";
import { confirmAction } from "../../components/ConfirmationProvider";
import "../StugubyPage.css";
import { localDateTimeInput, parseArray } from "./support";
import type { DatasetDraft } from "./support";
import { useStugubyPagePart02 } from "./part-02";
type DeferredContext = {
  coordinator: boolean;
};
export function useStugubyPagePart03(context: ReturnType<typeof useStugubyPagePart02>) {
  const deferred = context as typeof context & DeferredContext;
  const { properties, onInventoryChange, t, stateLabel, index, detail, setNotice, setGrantHouseId, setAudienceKind, setAudienceNodes, setDatasetDraft, setTelemetryLive, setTelemetryHistoryHours, setTelemetryMetrics, setTelemetrySensors, setTelemetryRate, setGrantExpiresAt, setHouseEditPolicy, setRecoveryMode, setHouseSuccessorNodeId, setEditingGrantId, propertyName, propertyDescription, propertyLatitude, propertyLongitude, propertyLocationLabel, areasJson, equipmentJson, notesJson, maintenanceJson, propertyEditPolicy, propertySuccessorNodeId, adoptionPropertyId, migrationPropertyId, setMigrationPropertyId, detailRequest, selectedIdRef, captureActiveScope, isActiveScope, beginSelection, loadDetail, load, withBusy } = context;
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
  const updateMember = async (member: StugubyLocalMember, input: { role?: StugubyRole; state?: StugubyMember["state"] }) => {
      if (!detail || detail.stuguby.id !== selectedIdRef.current) return;
      const selected = detail;
      const operationScope = captureActiveScope(selected.stuguby.id);
      if (!operationScope) return;
      const nextState = input.state ?? member.state;
      if (input.state && nextState !== member.state) {
        const confirmed = await confirmAction(t("stuguby.confirmMemberState", { name: memberName(member), state: stateLabel(nextState) }), t("confirmation.change"), false);
        if (!confirmed || !isActiveScope(operationScope)) return;
      }
      if (!isActiveScope(operationScope)) return;
      void withBusy(`member:${member.nodeId}`, async () => {
        if (!isActiveScope(operationScope)) return;
        await api.updateStugubyMember(selected.stuguby.id, member.nodeId, { role: input.role ?? member.role, state: nextState });
        if (!isActiveScope(operationScope)) return;
        setNotice(t("stuguby.changesSaved"));
        await loadDetail(selected.stuguby.id);
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
        if (!deferred.coordinator) await api.syncStuguby(selected.stuguby.id);
        await api.adoptStugubyProperty(
          selected.stuguby.id,
          deferred.coordinator && adoptionPropertyId ? adoptionPropertyId : undefined,
        );
        if (deferred.coordinator) await api.syncStuguby(selected.stuguby.id);
        onInventoryChange?.();
        setNotice(t("stuguby.propertyAdopted"));
        await loadDetail(selected.stuguby.id);
      });
    };
  const migrateLocalProperty = async () => {
      if (!detail || !migrationPropertyId || detail.stuguby.id !== selectedIdRef.current) return;
      const selected = detail;
      const operationScope = captureActiveScope(selected.stuguby.id);
      if (!operationScope) return;
      const source = properties.find((property) => property.id === migrationPropertyId);
      if (!source) return;
      const confirmed = await confirmAction(t("stuguby.confirmPropertyMigration", { name: source.name }), t("confirmation.move"), false);
      if (!confirmed || !isActiveScope(operationScope)) return;
      void withBusy("migrate-property", async () => {
        if (!isActiveScope(operationScope)) return;
        const migrated = await api.migratePropertyToStuguby(selected.stuguby.id, source.id);
        if (!isActiveScope(operationScope)) return;
        await api.syncStuguby(selected.stuguby.id);
        if (!isActiveScope(operationScope)) return;
        onInventoryChange?.();
        setMigrationPropertyId("");
        setNotice(t(migrated.moved.houseIds.length === 1
          ? "stuguby.propertyMigratedOne"
          : "stuguby.propertyMigratedMany", { count: migrated.moved.houseIds.length }));
        await loadDetail(selected.stuguby.id);
      });
    };
  const disconnectProperty = async () => {
      if (!detail || detail.stuguby.id !== selectedIdRef.current) return;
      const selected = detail;
      const operationScope = captureActiveScope(selected.stuguby.id);
      if (!operationScope) return;
      const confirmed = await confirmAction(t("stuguby.confirmPropertyDisconnect"), t("confirmation.disconnect"));
      if (!confirmed || !isActiveScope(operationScope)) return;
      void withBusy("disconnect-property", async () => {
        if (!isActiveScope(operationScope)) return;
        await api.disconnectStugubyProperty(selected.stuguby.id);
        if (!isActiveScope(operationScope)) return;
        onInventoryChange?.();
        setNotice(t("stuguby.propertyDisconnected"));
        await loadDetail(selected.stuguby.id);
      });
    };
  const deleteStuguby = async () => {
      if (!detail || detail.stuguby.id !== selectedIdRef.current) return;
      const selected = detail.stuguby;
      const operationScope = captureActiveScope(selected.id);
      if (!operationScope) return;
      const confirmed = await confirmAction(t("stuguby.confirmDelete", { name: selected.name }), t("confirmation.delete"));
      if (!confirmed || !isActiveScope(operationScope)) return;
      void withBusy("delete", async () => {
        if (!isActiveScope(operationScope)) return;
        await api.deleteStuguby(selected.id);
        if (!isActiveScope(operationScope)) return;
        detailRequest.current += 1;
        beginSelection("");
        await load();
        setNotice(t("stuguby.deleted", { name: selected.name }));
      });
    };
  return Object.assign(context, { editGrant, saveProperty, memberName, updateMember, updateMemberLocalLabel, adoptSharedProperty, migrateLocalProperty, disconnectProperty, deleteStuguby });
}
