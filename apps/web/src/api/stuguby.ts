import type { StugubyPropertyAdoption } from "@climate-twin/contracts";
import type { StugubyDatasetGrant, StugubyGrantAudience, StugubyMember, StugubyMemberState, StugubyRole, StugubyShareGrant, StugubySharedProperty, StugubySummary } from "@climate-twin/stuguby-protocol";
import { request } from "./support/request";
import type { StugubyDetailResponse, StugubyInvitationCreated, StugubyListResponse, StugubyLocalMember, StugubyLocalPublicationCatalog, StugubyRemoteTelemetrySample } from "./support/response-types";

/** Stuguby federation: coordinators, members, invitations, shared Properties, grants and remote telemetry. */
export const stugubyApi = {
  stugubys: () => request<StugubyListResponse>("/stugbys"),
  configureStugubyCoordinator: (publicOrigin: string) => request<{ publicOrigin: string }>("/stugbys/configuration", {
      method: "PUT",
      body: JSON.stringify({ publicOrigin }),
    }),
  stuguby: (id: string) => request<StugubyDetailResponse>(`/stugbys/${encodeURIComponent(id)}`),
  deleteStuguby: (id: string) => request<void>(`/stugbys/${encodeURIComponent(id)}`, { method: "DELETE" }),
  createStuguby: (input: { name: string; description?: string | null }) => request<StugubySummary>("/stugbys", {
      method: "POST",
      body: JSON.stringify(input),
    }),
  joinStuguby: (input: { coordinatorUrl: string; invitationId: string; joinSecret: string }) => request<StugubySummary>("/stugbys/join", {
      method: "POST",
      body: JSON.stringify(input),
    }),
  createStugubyInvitation: (id: string, input: { role: Exclude<StugubyRole, "steward">; localLabel: string; expiresAt?: string }) => request<StugubyInvitationCreated>(
      `/stugbys/${encodeURIComponent(id)}/invitations`,
      { method: "POST", body: JSON.stringify(input) },
    ),
  revokeStugubyInvitation: (id: string, invitationId: string) => request<void>(
      `/stugbys/${encodeURIComponent(id)}/invitations/${encodeURIComponent(invitationId)}`,
      { method: "DELETE" },
    ),
  updateStugubyMember: (id: string, nodeId: string, input: { role: StugubyRole; state: StugubyMemberState }) => request<StugubyMember>(
      `/stugbys/${encodeURIComponent(id)}/members/${encodeURIComponent(nodeId)}`,
      { method: "PATCH", body: JSON.stringify(input) },
    ),
  updateStugubyMemberLabel: (id: string, nodeId: string, localLabel: string | null) => request<StugubyLocalMember>(
      `/stugbys/${encodeURIComponent(id)}/members/${encodeURIComponent(nodeId)}/label`,
      { method: "PATCH", body: JSON.stringify({ localLabel }) },
    ),
  updateStugubyProperty: (id: string, baseRevision: number, property: Pick<StugubySharedProperty,
      "name" | "description" | "location" | "areas" | "equipment" | "notes" | "maintenance" | "editPolicy" | "designatedSuccessorNodeId"
    >) => request<StugubySharedProperty>(`/stugbys/${encodeURIComponent(id)}/property`, {
      method: "PUT",
      body: JSON.stringify({ baseRevision, property }),
    }),
  adoptStugubyProperty: (id: string, localPropertyId?: string) => request<StugubyPropertyAdoption>(
      `/stugbys/${encodeURIComponent(id)}/property/adopt`,
      { method: "POST", body: JSON.stringify(localPropertyId ? { localPropertyId } : {}) },
    ),
  migratePropertyToStuguby: (id: string, sourcePropertyId: string) => request<{
      adoption: StugubyPropertyAdoption;
      migrationSnapshotId: string;
      moved: {
        sourcePropertyId: string;
        targetPropertyId: string;
        houseIds: string[];
        areaIds: string[];
        equipmentIds: string[];
        noteIds: string[];
        maintenanceTaskIds: string[];
      };
      createdGrants: StugubyShareGrant[];
    }>(`/stugbys/${encodeURIComponent(id)}/property/migrate`, {
      method: "POST",
      body: JSON.stringify({ sourcePropertyId, confirmation: "MIGRATE" }),
    }),
  disconnectStugubyProperty: (id: string) => request<StugubyPropertyAdoption>(
      `/stugbys/${encodeURIComponent(id)}/property/disconnect`,
      { method: "POST", body: JSON.stringify({ confirmation: "DISCONNECT" }) },
    ),
  resolveStugubyPropertyConflict: (id: string, commandId: string) => request<void>(
      `/stugbys/${encodeURIComponent(id)}/property-conflicts/${encodeURIComponent(commandId)}/resolve`,
      { method: "POST" },
    ),
  createStugubyGrant: (id: string, input: {
      localHouseId: string;
      audience: StugubyGrantAudience;
      datasets: StugubyDatasetGrant[];
      housePolicy: StugubyShareGrant["housePolicy"];
      expiresAt?: string | null;
    }) => request<StugubyShareGrant>(`/stugbys/${encodeURIComponent(id)}/grants`, {
      method: "POST",
      body: JSON.stringify(input),
    }),
  stugubyPublications: (id: string, houseId: string) => request<StugubyLocalPublicationCatalog>(
      `/stugbys/${encodeURIComponent(id)}/publications/${encodeURIComponent(houseId)}`,
    ),
  updateStugubyGrant: (id: string, grantId: string, input: {
      baseRevision: number;
      audience: StugubyGrantAudience;
      datasets: StugubyDatasetGrant[];
      housePolicy: StugubyShareGrant["housePolicy"];
      expiresAt: string | null;
    }) => request<StugubyShareGrant>(`/stugbys/${encodeURIComponent(id)}/grants/${encodeURIComponent(grantId)}`, {
      method: "PUT",
      body: JSON.stringify(input),
    }),
  revokeStugubyGrant: (id: string, grantId: string) => request<StugubyShareGrant>(
      `/stugbys/${encodeURIComponent(id)}/grants/${encodeURIComponent(grantId)}`,
      { method: "DELETE" },
    ),
  removeInvalidStugubyGrant: (id: string, grantId: string) => request<{ removed: true; grantId: string }>(
      `/stugbys/${encodeURIComponent(id)}/grants/${encodeURIComponent(grantId)}/invalid`,
      { method: "DELETE" },
    ),
  republishStugubyGrant: (id: string, grantId: string) => request<{ queued: boolean }>(
      `/stugbys/${encodeURIComponent(id)}/grants/${encodeURIComponent(grantId)}/republish`,
      { method: "POST" },
    ),
  syncStuguby: (id: string) => request<StugubySummary>(`/stugbys/${encodeURIComponent(id)}/sync`, { method: "POST" }),
  stugubyTelemetry: (id: string, limit = 250) => request<{ samples: StugubyRemoteTelemetrySample[] }>(
      `/stugbys/${encodeURIComponent(id)}/telemetry?limit=${encodeURIComponent(String(limit))}`,
    ),
};
