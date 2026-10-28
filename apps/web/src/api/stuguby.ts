import type { StugubyDatasetGrant, StugubyGrantAudience, StugubyMemberState, StugubyRole, StugubyShareGrant, StugubySharedProperty } from "@climate-twin/stuguby-protocol";
import { request } from "./support/request";
import { stugubyDetailResponseShape, stugubyInvitationCreatedShape, stugubyListResponseShape, stugubyLocalMemberShape, stugubyLocalPublicationCatalogShape, stugubyMemberShape, stugubyPropertyAdoptionShape, stugubyRemoteTelemetrySampleShape, stugubyShareGrantShape, stugubySharedPropertyShape, stugubySummaryShape } from "./support/entity-shapes";
import { noContent, string, boolean, literal, arrayOf, fields } from "./support/response-shapes";

/** Stuguby federation: coordinators, members, invitations, shared Properties, grants and remote telemetry. */
export const stugubyApi = {
  stugubys: () => request("/stugbys", stugubyListResponseShape),
  configureStugubyCoordinator: (publicOrigin: string) => request("/stugbys/configuration", fields({ publicOrigin: string }), {
      method: "PUT",
      body: JSON.stringify({ publicOrigin }),
    }),
  stuguby: (id: string) => request(`/stugbys/${encodeURIComponent(id)}`, stugubyDetailResponseShape),
  deleteStuguby: (id: string) => request(`/stugbys/${encodeURIComponent(id)}`, noContent, { method: "DELETE" }),
  createStuguby: (input: { name: string; description?: string | null }) => request("/stugbys", stugubySummaryShape, {
      method: "POST",
      body: JSON.stringify(input),
    }),
  joinStuguby: (input: { coordinatorUrl: string; invitationId: string; joinSecret: string }) => request("/stugbys/join", stugubySummaryShape, {
      method: "POST",
      body: JSON.stringify(input),
    }),
  createStugubyInvitation: (id: string, input: { role: Exclude<StugubyRole, "steward">; localLabel: string; expiresAt?: string }) => request(
      `/stugbys/${encodeURIComponent(id)}/invitations`, stugubyInvitationCreatedShape,
      { method: "POST", body: JSON.stringify(input) },
    ),
  revokeStugubyInvitation: (id: string, invitationId: string) => request(
      `/stugbys/${encodeURIComponent(id)}/invitations/${encodeURIComponent(invitationId)}`, noContent,
      { method: "DELETE" },
    ),
  updateStugubyMember: (id: string, nodeId: string, input: { role: StugubyRole; state: StugubyMemberState }) => request(
      `/stugbys/${encodeURIComponent(id)}/members/${encodeURIComponent(nodeId)}`, stugubyMemberShape,
      { method: "PATCH", body: JSON.stringify(input) },
    ),
  updateStugubyMemberLabel: (id: string, nodeId: string, localLabel: string | null) => request(
      `/stugbys/${encodeURIComponent(id)}/members/${encodeURIComponent(nodeId)}/label`, stugubyLocalMemberShape,
      { method: "PATCH", body: JSON.stringify({ localLabel }) },
    ),
  updateStugubyProperty: (id: string, baseRevision: number, property: Pick<StugubySharedProperty,
      "name" | "description" | "location" | "areas" | "equipment" | "notes" | "maintenance" | "editPolicy" | "designatedSuccessorNodeId"
    >) => request(`/stugbys/${encodeURIComponent(id)}/property`, stugubySharedPropertyShape, {
      method: "PUT",
      body: JSON.stringify({ baseRevision, property }),
    }),
  adoptStugubyProperty: (id: string, localPropertyId?: string) => request(
      `/stugbys/${encodeURIComponent(id)}/property/adopt`, stugubyPropertyAdoptionShape,
      { method: "POST", body: JSON.stringify(localPropertyId ? { localPropertyId } : {}) },
    ),
  migratePropertyToStuguby: (id: string, sourcePropertyId: string) => request(`/stugbys/${encodeURIComponent(id)}/property/migrate`, fields({ adoption: stugubyPropertyAdoptionShape, migrationSnapshotId: string, moved: fields({ sourcePropertyId: string, targetPropertyId: string, houseIds: arrayOf(string), areaIds: arrayOf(string), equipmentIds: arrayOf(string), noteIds: arrayOf(string), maintenanceTaskIds: arrayOf(string) }), createdGrants: arrayOf(stugubyShareGrantShape) }), {
      method: "POST",
      body: JSON.stringify({ sourcePropertyId, confirmation: "MIGRATE" }),
    }),
  disconnectStugubyProperty: (id: string) => request(
      `/stugbys/${encodeURIComponent(id)}/property/disconnect`, stugubyPropertyAdoptionShape,
      { method: "POST", body: JSON.stringify({ confirmation: "DISCONNECT" }) },
    ),
  resolveStugubyPropertyConflict: (id: string, commandId: string) => request(
      `/stugbys/${encodeURIComponent(id)}/property-conflicts/${encodeURIComponent(commandId)}/resolve`, noContent,
      { method: "POST" },
    ),
  createStugubyGrant: (id: string, input: {
      localHouseId: string;
      audience: StugubyGrantAudience;
      datasets: StugubyDatasetGrant[];
      housePolicy: StugubyShareGrant["housePolicy"];
      expiresAt?: string | null;
    }) => request(`/stugbys/${encodeURIComponent(id)}/grants`, stugubyShareGrantShape, {
      method: "POST",
      body: JSON.stringify(input),
    }),
  stugubyPublications: (id: string, houseId: string) => request(
      `/stugbys/${encodeURIComponent(id)}/publications/${encodeURIComponent(houseId)}`, stugubyLocalPublicationCatalogShape,
    ),
  updateStugubyGrant: (id: string, grantId: string, input: {
      baseRevision: number;
      audience: StugubyGrantAudience;
      datasets: StugubyDatasetGrant[];
      housePolicy: StugubyShareGrant["housePolicy"];
      expiresAt: string | null;
    }) => request(`/stugbys/${encodeURIComponent(id)}/grants/${encodeURIComponent(grantId)}`, stugubyShareGrantShape, {
      method: "PUT",
      body: JSON.stringify(input),
    }),
  revokeStugubyGrant: (id: string, grantId: string) => request(
      `/stugbys/${encodeURIComponent(id)}/grants/${encodeURIComponent(grantId)}`, stugubyShareGrantShape,
      { method: "DELETE" },
    ),
  removeInvalidStugubyGrant: (id: string, grantId: string) => request(
      `/stugbys/${encodeURIComponent(id)}/grants/${encodeURIComponent(grantId)}/invalid`, fields({ removed: literal(true), grantId: string }),
      { method: "DELETE" },
    ),
  republishStugubyGrant: (id: string, grantId: string) => request(
      `/stugbys/${encodeURIComponent(id)}/grants/${encodeURIComponent(grantId)}/republish`, fields({ queued: boolean }),
      { method: "POST" },
    ),
  syncStuguby: (id: string) => request(`/stugbys/${encodeURIComponent(id)}/sync`, stugubySummaryShape, { method: "POST" }),
  stugubyTelemetry: (id: string, limit = 250) => request(
      `/stugbys/${encodeURIComponent(id)}/telemetry?limit=${encodeURIComponent(String(limit))}`, fields({ samples: arrayOf(stugubyRemoteTelemetrySampleShape) }),
    ),
};
