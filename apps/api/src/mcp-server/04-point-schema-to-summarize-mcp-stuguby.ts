import type { StugubyRole, StugubySummary } from "@climate-twin/stuguby-protocol";
import { StugubyStore } from "../stuguby/store.js";
import { database, stugubyStore } from "./01-config-to-get-house-weather.js";

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

export function summarizeMcpStuguby(summary: StugubySummary): object {
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
