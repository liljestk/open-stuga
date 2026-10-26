import type {
  AppSession,
  AreaEquipment,
  AreaEquipmentInput,
  AreaEquipmentPatch,
  HomeElectricityPricePoint,
  HomeEnergyCost,
  HomeEnergySummary,
  HostSystemHealth,
  LocalInvitationRegistrationInput,
  LocalLoginInput,
  LocalOwnerSetupInput,
  Property,
  PropertyArea,
  PropertyAreaInput,
  PropertyAreaPatch,
  PropertyCreateInput,
  PropertyPatch,
  PropertyElectricityConfig,
  PropertyElectricityConfigInput,
  PropertyElectricityPricePoint,
  PropertyInventorySnapshot,
} from "@climate-twin/contracts";
import type {
  StugubyDatasetGrant,
  StugubyGrantAudience,
  StugubyMember,
  StugubyMemberState,
  StugubyRole,
  StugubyShareGrant,
  StugubySharedProperty,
  StugubySummary,
} from "@climate-twin/stuguby-protocol";
import { publishAuthEpoch } from "../authEpoch";
import { ApiRequestError, apiClientState, completeAuthentication, completeCollection, entity, rememberSession, request } from "./support";
import type { CloudflareSetupStartInput, CloudflareSetupStartResult, CloudflareSetupStatus, StugubyDetailResponse, StugubyInvitationCreated, StugubyListResponse, StugubyLocalMember, StugubyLocalPublicationCatalog, StugubyPropertyAdoption, StugubyRemoteTelemetrySample, SystemUpdateOperationInput, SystemUpdateSettings, SystemUpdateStatus } from "./support";
import type { SystemStorageSettings, SystemStorageStatus } from "./support";
import { withSignal } from "./support/signal";

export interface LocalMcpRuntimeStatus {
  state: "stopped" | "starting" | "running" | "stopping" | "error";
  endpointPath: "/api/v1/mcp";
  pid: number | null;
  startedAt: string | null;
  toolCount: number | null;
  serverVersion: string | null;
  errorCode: "build_missing" | "start_failed" | "unexpected_exit" | "stop_failed" | null;
}

export interface LocalMcpRuntimeStartResult extends LocalMcpRuntimeStatus {
  accessToken: string | null;
}



export const apiPart01 = {
  session: async () => rememberSession(await request<AppSession>("/session")),
  hostSystemHealth: () => request<HostSystemHealth>("/system/health"),
  localMcpRuntimeStatus: () => request<LocalMcpRuntimeStatus>("/system/mcp-runtime"),
  startLocalMcpRuntime: () => request<LocalMcpRuntimeStartResult>("/system/mcp-runtime/start", { method: "POST" }),
  stopLocalMcpRuntime: () => request<LocalMcpRuntimeStatus>("/system/mcp-runtime/stop", { method: "POST" }),
  systemUpdateStatus: () => request<SystemUpdateStatus>("/system/updates"),
  checkSystemUpdates: () => request<SystemUpdateStatus>("/system/updates/check", { method: "POST" }),
  updateSystemUpdateSettings: (settings: SystemUpdateSettings) => request<SystemUpdateStatus>("/system/updates/settings", {
      method: "PATCH",
      body: JSON.stringify(settings),
    }),
  installLatestSystemUpdate: () => request<SystemUpdateStatus>("/system/updates/install", { method: "POST" }),
  operateSystemUpdate: (input: SystemUpdateOperationInput) => request<SystemUpdateStatus>("/system/updates/operations", {
      method: "POST",
      body: JSON.stringify(input),
    }),
  systemStorageStatus: (signal?: AbortSignal) => request<SystemStorageStatus>(
      "/system/storage",
      withSignal(signal),
    ),
  updateSystemStorage: (input: {
    settings: SystemStorageSettings;
    expectedRevision: string;
    confirmation: "APPLY_STORAGE" | "MOVE_STORAGE";
  }) => request<SystemStorageStatus>("/system/storage", {
      method: "PUT",
      body: JSON.stringify(input),
    }),
  cloudflareSetupStatus: () => request<CloudflareSetupStatus>("/cloudflare/setup"),
  startCloudflareSetup: (input: CloudflareSetupStartInput) => request<CloudflareSetupStartResult>("/cloudflare/setup/start", {
      method: "POST",
      body: JSON.stringify(input),
    }),
  setupOwner: (input: LocalOwnerSetupInput, bootstrapSecret?: string | null) => completeAuthentication(request<AppSession>("/auth/setup", {
      method: "POST",
      ...(bootstrapSecret ? { headers: { "X-Stugu-Bootstrap-Secret": bootstrapSecret } } : {}),
      body: JSON.stringify(input),
    })),
  login: (input: LocalLoginInput) => completeAuthentication(request<AppSession>("/auth/login", {
      method: "POST",
      body: JSON.stringify(input),
    })),
  registerInvitation: (input: LocalInvitationRegistrationInput) => completeAuthentication(request<AppSession>("/auth/register", {
      method: "POST",
      body: JSON.stringify(input),
    })),
  logout: async () => {
      let completed = false;
      try {
        await request<void>("/auth/logout", { method: "POST" });
        completed = true;
      } catch (error) {
        if (!(error instanceof ApiRequestError) || error.status !== 401) throw error;
        completed = true;
      } finally {
        apiClientState.csrfToken = null;
      }
      if (completed) publishAuthEpoch();
    },
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
  properties: () => completeCollection<Property>("/properties", ["properties", "data"]),
  createProperty: async (input: PropertyCreateInput) => entity<Property>(await request<Property | { property: Property }>("/properties", {
      method: "POST",
      body: JSON.stringify(input),
    }), "property"),
  updateProperty: async (id: string, patch: PropertyPatch) => entity<Property>(await request<Property | { property: Property }>(`/properties/${encodeURIComponent(id)}`, {
      method: "PATCH",
      body: JSON.stringify(patch),
    }), "property"),
  deleteProperty: (id: string) => request<void>(`/properties/${encodeURIComponent(id)}`, { method: "DELETE" }),
  propertyElectricity: (propertyId: string, signal?: AbortSignal) => request<{
      config: PropertyElectricityConfig;
      current: PropertyElectricityPricePoint | null;
      prices: PropertyElectricityPricePoint[];
    }>(`/properties/${encodeURIComponent(propertyId)}/electricity`, withSignal(signal)),
  houseElectricityPrice: (houseId: string, from?: string, to?: string, signal?: AbortSignal) => request<{
      current: HomeElectricityPricePoint | null;
      prices?: HomeElectricityPricePoint[];
    }>(`/houses/${encodeURIComponent(houseId)}/electricity-price${from || to ? `?${new URLSearchParams({ ...(from ? { from } : {}), ...(to ? { to } : {}) })}` : ""}`, withSignal(signal)),
  houseEnergyCost: async (houseId: string, sensorId: string, from: string, to: string, signal?: AbortSignal) => entity<HomeEnergyCost>(await request<HomeEnergyCost | { cost: HomeEnergyCost }>(
      `/houses/${encodeURIComponent(houseId)}/energy-cost?${new URLSearchParams({ sensorId, from, to })}`,
      withSignal(signal),
    ), "cost"),
  houseEnergySummary: async (houseId: string, from: string, to: string, signal?: AbortSignal) => entity<HomeEnergySummary>(await request<HomeEnergySummary | { summary: HomeEnergySummary }>(
      `/houses/${encodeURIComponent(houseId)}/energy-summary?${new URLSearchParams({ from, to })}`,
      withSignal(signal),
    ), "summary"),
  configurePropertyElectricity: (propertyId: string, configuration: PropertyElectricityConfigInput) => request<{ config: PropertyElectricityConfig }>(
      `/properties/${encodeURIComponent(propertyId)}/electricity/config`,
      { method: "PUT", body: JSON.stringify(configuration) },
    ),
  refreshPropertyElectricity: (propertyId: string) => request<{
      config: PropertyElectricityConfig;
      current: PropertyElectricityPricePoint | null;
      prices: PropertyElectricityPricePoint[];
    }>(`/properties/${encodeURIComponent(propertyId)}/electricity/refresh`, { method: "POST" }),
  propertyAreas: (propertyId?: string) => completeCollection<PropertyArea>(propertyId
      ? `/property-areas?propertyId=${encodeURIComponent(propertyId)}`
      : "/property-areas", ["areas", "propertyAreas", "data"]),
  createPropertyArea: async (input: PropertyAreaInput) => entity<PropertyArea>(await request<PropertyArea | { area: PropertyArea }>("/property-areas", {
      method: "POST",
      body: JSON.stringify(input),
    }), "area"),
  updatePropertyArea: async (id: string, patch: PropertyAreaPatch) => entity<PropertyArea>(await request<PropertyArea | { area: PropertyArea }>(`/property-areas/${encodeURIComponent(id)}`, {
      method: "PATCH",
      body: JSON.stringify(patch),
    }), "area"),
  deletePropertyArea: (id: string) => request<void>(`/property-areas/${encodeURIComponent(id)}`, { method: "DELETE" }),
  propertyInventory: async (propertyId: string) => entity<PropertyInventorySnapshot>(
      await request<PropertyInventorySnapshot | { inventory: PropertyInventorySnapshot }>(
        `/properties/${encodeURIComponent(propertyId)}/inventory`,
      ),
      "inventory",
    ),
  areaEquipment: (propertyId?: string) => completeCollection<AreaEquipment>(propertyId
      ? `/area-equipment?propertyId=${encodeURIComponent(propertyId)}`
      : "/area-equipment", ["equipment", "areaEquipment", "data"]),
  createAreaEquipment: async (input: AreaEquipmentInput) => entity<AreaEquipment>(await request<AreaEquipment | { equipment: AreaEquipment }>("/area-equipment", {
      method: "POST",
      body: JSON.stringify(input),
    }), "equipment"),
  updateAreaEquipment: async (id: string, patch: AreaEquipmentPatch) => entity<AreaEquipment>(await request<AreaEquipment | { equipment: AreaEquipment }>(`/area-equipment/${encodeURIComponent(id)}`, {
      method: "PATCH",
      body: JSON.stringify(patch),
    }), "equipment"),
};
