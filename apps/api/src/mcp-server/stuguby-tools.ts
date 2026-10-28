import type { StugubyRole, StugubySummary } from "@climate-twin/stuguby-protocol";
import { StugubyStore } from "../stuguby/store.js";
import type { McpRuntime } from "./runtime.js";
import { summarizeMcpHouse, summarizeMcpProperty } from "./validation.js";
import { requiredToolString } from "./arguments.js";

export function stugubySide(role: StugubyRole): "host" | "client" {
  return role === "steward" ? "host" : "client";
}

export function activeStugubyGrant(grant: ReturnType<StugubyStore["listGrants"]>[number]): boolean {
  return !grant.revokedAt && (!grant.expiresAt || Date.parse(grant.expiresAt) > Date.now());
}

export function recommendedOverviewGrant(grant: ReturnType<StugubyStore["listGrants"]>[number]): boolean {
  const enabled = grant.datasets.filter((dataset) => dataset.enabled);
  return grant.housePolicy.editPolicy === "read-only"
    && grant.housePolicy.recoveryMode === "none"
    && enabled.length === 3
    && ["home.directory.v1", "home.sensor-catalog.v1", "home.structure.v1"]
      .every((dataset) => enabled.some((candidate) => candidate.dataset === dataset
        && !candidate.includeLocalIds
        && candidate.allowReplicaCache
        && candidate.retentionDays === 30));
}

export function summarizeMcpStuguby(runtime: McpRuntime, summary: StugubySummary): object {
  const { database, stugubyStore } = runtime;
  const adoption = stugubyStore.getPropertyAdoption(summary.id);
  const houses = database.listHouses().filter((house) => house.stuguby?.stugubyId === summary.id);
  const grants = stugubyStore.listGrants(summary.id);
  return {
    id: summary.id,
    name: summary.name,
    descriptionConfigured: summary.description !== null,
    coordinatorUrl: summary.coordinatorUrl,
    side: stugubySide(summary.localRole),
    accessRole: summary.localRole,
    memberState: summary.localMemberState,
    memberCount: summary.memberCount,
    adoptedPropertyId: adoption?.state === "adopted" ? adoption.localPropertyId : null,
    ownedHomeCount: houses.filter((house) => house.stuguby?.ownership === "local").length,
    sharedHomeCount: houses.filter((house) => house.stuguby?.ownership === "shared").length,
    activeGrantCount: grants.filter(activeStugubyGrant).length,
    lastSyncAt: summary.lastSyncAt,
    lastSyncError: summary.lastSyncError,
    updatedAt: summary.updatedAt,
  };
}

export function getMcpStuguby(runtime: McpRuntime, args: Record<string, unknown>): object {
  const { database, stugubyStore } = runtime;
  const stugubyId = requiredToolString(args, "stugubyId");
  const summary = stugubyStore.getStuguby(stugubyId);
  if (!summary) throw new Error(`Unknown Stuguby: ${stugubyId}`);
  const adoption = stugubyStore.getPropertyAdoption(stugubyId);
  const adoptedProperty = adoption ? database.getProperty(adoption.localPropertyId) : null;
  const members = stugubyStore.listMembers(stugubyId);
  const sharedProperty = stugubyStore.getSharedProperty(stugubyId);
  return {
    stuguby: summarizeMcpStuguby(runtime, summary),
    members: members.map((member) => ({
      nodeId: member.nodeId,
      displayName: member.displayName,
      side: stugubySide(member.role),
      accessRole: member.role,
      state: member.state,
      isHost: member.nodeId === summary.coordinatorNodeId,
      joinedAt: member.joinedAt,
      updatedAt: member.updatedAt,
    })),
    property: {
      adoption,
      local: adoptedProperty ? summarizeMcpProperty(adoptedProperty) : null,
      shared: sharedProperty ? {
        revision: sharedProperty.revision,
        editPolicy: sharedProperty.editPolicy,
        locationConfigured: sharedProperty.location !== null,
        areaCount: sharedProperty.areas.length,
        equipmentCount: sharedProperty.equipment.length,
        noteCount: sharedProperty.notes.length,
        maintenanceTaskCount: sharedProperty.maintenance.length,
        updatedAt: sharedProperty.updatedAt,
      } : null,
      conflicts: stugubyStore.listPropertyConflicts(stugubyId).length,
      commands: stugubyStore.propertyCommandCounts(stugubyId),
    },
    homes: database.listHouses()
      .filter((house) => house.stuguby?.stugubyId === stugubyId)
      .map(summarizeMcpHouse),
    grants: stugubyStore.listGrants(stugubyId).map((grant) => ({
      id: grant.id,
      authorityNodeId: grant.authorityNodeId,
      publicationId: grant.publicationId,
      localHouseId: grant.localHouseId ?? null,
      audience: {
        kind: grant.audience.kind,
        recipientCount: grant.audience.kind === "all-members"
          ? Math.max(0, members.filter((member) => member.state === "active").length - 1)
          : grant.audience.nodeIds.length,
      },
      datasets: grant.datasets.filter((dataset) => dataset.enabled).map((dataset) => ({
        dataset: dataset.dataset,
        includeLocalIds: dataset.includeLocalIds,
        allowReplicaCache: dataset.allowReplicaCache,
        retentionDays: dataset.retentionDays,
        ...(dataset.telemetry ? { telemetry: dataset.telemetry } : {}),
      })),
      editPolicy: grant.housePolicy.editPolicy,
      recoveryMode: grant.housePolicy.recoveryMode,
      recommendedReadOnlyOverview: recommendedOverviewGrant(grant),
      active: activeStugubyGrant(grant),
      expiresAt: grant.expiresAt,
      revokedAt: grant.revokedAt,
      updatedAt: grant.updatedAt,
    })),
    homeCommands: stugubyStore.homeCommandCounts(stugubyId),
  };
}
