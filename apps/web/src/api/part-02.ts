import type { ApiReadSchedulingClass } from "./support/requestScheduler";
import type { AlertRule, EquipmentAttachment, EquipmentAttachmentUploadInput, EquipmentLink, EquipmentLinkInput, EquipmentLinkPatch, EquipmentTrackingBinding, GuestAccessGrant, House, HouseLocation, HousePatch, HouseWeather, OpeningStateObservation, OpeningStateObservationInput, OpeningStateSnapshot, OutdoorTemperatureSample, PropertyNote, PropertyNoteInput, PropertyNotePatch, Sensor, SensorLabelDescriptor, SensorPatch, SensorSnapshot, TenantInvitationCreated, TenantMemberSummary, TenantMembersResponse, TrackedEquipmentState, TrackingCapabilities, TrackingEndpoint, TrackingEndpointEnrollmentInput, TrackingMapSnapshot, TrackingProfileManifest } from "@climate-twin/contracts";
import { withSignal } from "@climate-twin/contracts";
import { API_BASE, completeCollection, list, memberSummary, request, requestV2, updateHouseGeoreference } from "./support";
import type { CreateHouseInput, CreateSensorInput, OutdoorTemperatureHistoryPage } from "./support";



export const apiPart02 = {
  deleteAreaEquipment: (id: string) => request<void>(`/area-equipment/${encodeURIComponent(id)}`, { method: "DELETE" }),
  equipmentAttachments: async (equipmentId: string) => list<EquipmentAttachment>(
      await request<unknown>(`/area-equipment/${encodeURIComponent(equipmentId)}/attachments`),
      "attachments",
    ),
  uploadEquipmentAttachment: async (equipmentId: string, input: EquipmentAttachmentUploadInput) => (await request<{ attachment: EquipmentAttachment }>(`/area-equipment/${encodeURIComponent(equipmentId)}/attachments`, { method: "POST", body: JSON.stringify(input) })).attachment,
  equipmentAttachmentUrl: (equipmentId: string, attachmentId: string) => (
      `${API_BASE}/area-equipment/${encodeURIComponent(equipmentId)}/attachments/${encodeURIComponent(attachmentId)}`
    ),
  deleteEquipmentAttachment: (equipmentId: string, attachmentId: string) => request<void>(
      `/area-equipment/${encodeURIComponent(equipmentId)}/attachments/${encodeURIComponent(attachmentId)}`,
      { method: "DELETE" },
    ),
  equipmentLinks: async (equipmentId: string) => list<EquipmentLink>(
      await request<unknown>(`/area-equipment/${encodeURIComponent(equipmentId)}/links`),
      "links",
    ),
  createEquipmentLink: async (equipmentId: string, input: EquipmentLinkInput) => (await request<{ link: EquipmentLink }>(`/area-equipment/${encodeURIComponent(equipmentId)}/links`, { method: "POST", body: JSON.stringify(input) })).link,
  updateEquipmentLink: async (equipmentId: string, linkId: string, patch: EquipmentLinkPatch) => (await request<{ link: EquipmentLink }>(`/area-equipment/${encodeURIComponent(equipmentId)}/links/${encodeURIComponent(linkId)}`, { method: "PATCH", body: JSON.stringify(patch) })).link,
  deleteEquipmentLink: (equipmentId: string, linkId: string) => request<void>(
      `/area-equipment/${encodeURIComponent(equipmentId)}/links/${encodeURIComponent(linkId)}`,
      { method: "DELETE" },
    ),
  trackedEquipment: async (propertyId: string) => list<TrackedEquipmentState>(
      await request<unknown>(`/properties/${encodeURIComponent(propertyId)}/tracked-equipment`),
      "equipment",
    ),
  trackingCapabilities: () => request<TrackingCapabilities>("/tracking/capabilities"),
  trackingProfiles: () => request<TrackingProfileManifest>("/tracking/profiles"),
  trackingEndpoints: async (propertyId: string) => list<TrackingEndpoint>(
      await request<unknown>(`/tracking/endpoints?propertyId=${encodeURIComponent(propertyId)}`),
      "endpoints",
    ),
  enrollTrackingEndpoint: async (input: TrackingEndpointEnrollmentInput) => (await request<{ endpoint: TrackingEndpoint }>("/tracking/endpoints", { method: "POST", body: JSON.stringify(input) })).endpoint,
  bindTrackingEndpoint: async (
    equipmentId: string,
    endpointId: string,
    observerId?: string,
  ) => (await request<{ binding: EquipmentTrackingBinding }>(`/area-equipment/${encodeURIComponent(equipmentId)}/tracking-binding`, {
          method: "POST",
          body: JSON.stringify({ endpointId, ...(observerId ? { observerId } : {}) }),
        })).binding,
  unbindTrackingEndpoint: async (equipmentId: string) => (
      await request<{ binding: EquipmentTrackingBinding | null }>(
        `/area-equipment/${encodeURIComponent(equipmentId)}/tracking-binding`,
        { method: "DELETE" },
      )
    ).binding,
  trackingMapSnapshot: (propertyId: string) => request<TrackingMapSnapshot>(
      `/properties/${encodeURIComponent(propertyId)}/tracking-map-snapshot`,
    ),
  propertyNotes: (propertyId?: string) => completeCollection<PropertyNote>(propertyId
      ? `/property-notes?propertyId=${encodeURIComponent(propertyId)}`
      : "/property-notes", "notes"),
  createPropertyNote: async (input: PropertyNoteInput) => (await request<{ note: PropertyNote }>("/property-notes", {
      method: "POST",
      body: JSON.stringify(input),
    })).note,
  updatePropertyNote: async (id: string, patch: PropertyNotePatch) => (await request<{ note: PropertyNote }>(`/property-notes/${encodeURIComponent(id)}`, {
      method: "PATCH",
      body: JSON.stringify(patch),
    })).note,
  deletePropertyNote: (id: string) => request<void>(`/property-notes/${encodeURIComponent(id)}`, { method: "DELETE" }),
  tenantMembers: async (): Promise<TenantMembersResponse> => {
      const response = await request<Partial<TenantMembersResponse>>("/tenant/members");
      return {
        members: Array.isArray(response.members) ? response.members.map(memberSummary) : [],
        invitations: Array.isArray(response.invitations) ? response.invitations.map(memberSummary) : [],
      };
    },
  inviteGuest: async (email: string): Promise<TenantInvitationCreated> => {
      const response = await request<TenantInvitationCreated>("/tenant/members", {
        method: "POST",
        body: JSON.stringify({ email, role: "guest" }),
      });
      return { ...response, invitation: memberSummary(response.invitation) };
    },
  updateMemberAccess: async (email: string, grants: GuestAccessGrant[]) => {
      const response = await request<{ member: TenantMemberSummary }>(`/tenant/members/${encodeURIComponent(email)}/access`, {
        method: "PUT",
        body: JSON.stringify({ grants }),
      });
      return memberSummary(response.member);
    },
  removeTenantMember: (email: string) => request<void>(`/tenant/members/${encodeURIComponent(email.trim().toLowerCase())}`, { method: "DELETE" }),
  houses: async () => list<House>(await request<unknown>("/houses"), "houses"),
  createHouse: async (house: CreateHouseInput) => (await request<{ house: House }>("/houses", {
      method: "POST",
      body: JSON.stringify(house),
    })).house,
  updateHouse: async (houseId: string, patch: HousePatch) => (await request<{ house: House }>(`/houses/${encodeURIComponent(houseId)}`, {
      method: "PATCH",
      body: JSON.stringify(patch),
    })).house,
  deleteHouse: (houseId: string) => request<void>(`/houses/${encodeURIComponent(houseId)}`, { method: "DELETE" }),
  openingStates: (houseId: string, at?: string, signal?: AbortSignal) => request<{ snapshot: OpeningStateSnapshot; observations: OpeningStateObservation[] }>(
      `/houses/${encodeURIComponent(houseId)}/opening-states${at ? `?at=${encodeURIComponent(at)}` : ""}`,
      withSignal(signal),
    ),
  openingStateHistory: async (
      houseId: string,
      from: string,
      to: string,
      limit = 10_000,
      signal?: AbortSignal,
    ): Promise<OpeningStateObservation[]> => {
      const query = new URLSearchParams({ from, to, limit: String(limit) });
      const result = await request<{
        snapshot: OpeningStateSnapshot;
        observations: OpeningStateObservation[];
        history?: OpeningStateObservation[];
      }>(`/houses/${encodeURIComponent(houseId)}/opening-states?${query}`, withSignal(signal));
      return result.history ?? [];
    },
  recordOpeningState: async (houseId: string, observation: Omit<OpeningStateObservationInput, "observedAt"> & { observedAt?: string }) => {
      const response = await request<{ observation: OpeningStateObservation }>(`/houses/${encodeURIComponent(houseId)}/opening-states`, { method: "POST", body: JSON.stringify(observation) });
      return response.observation;
    },
  sensors: async (houseId?: string, schedulingClass: ApiReadSchedulingClass = "background") => list<Sensor>(await request<unknown>(
      houseId === undefined ? "/sensors" : `/sensors?houseId=${encodeURIComponent(houseId)}`, { schedulingClass },
    ), "sensors"),
  snapshot: async (houseId: string, schedulingClass: ApiReadSchedulingClass = "background") => list<SensorSnapshot>(await request<unknown>(`/sensors/snapshots?houseId=${encodeURIComponent(houseId)}`, { schedulingClass }), "sensors"),
  updateHouseGeoreference,
  updateHouseLocation: (houseId: string, location: HouseLocation | null) => updateHouseGeoreference(houseId, { location }),
  houseWeather: async (houseId: string, hours = 48, signal?: AbortSignal) => {
      const response = await request<{ weather: HouseWeather }>(
        `/houses/${encodeURIComponent(houseId)}/weather?hours=${hours}`,
        withSignal(signal),
      );
      return response.weather;
    },
  outdoorTemperatureHistory: async (
      houseId: string,
      from: string,
      to: string,
      limit = 20_000,
      signal?: AbortSignal,
    ): Promise<OutdoorTemperatureHistoryPage> => {
      const query = new URLSearchParams({ from, to, limit: String(limit) });
      const result = await requestV2<Partial<Omit<OutdoorTemperatureHistoryPage, "samples">> & {
        samples: OutdoorTemperatureSample[];
      }>(`/houses/${encodeURIComponent(houseId)}/outdoor-temperature/history?${query}`, withSignal(signal));
      return {
        samples: result.samples,
        from: result.from ?? from,
        to: result.to ?? to,
        truncated: result.truncated ?? result.samples.length >= limit,
      };
    },
  updateFloor: (houseId: string, floorId: string, floor: House["floors"][number]) => request<House["floors"][number]>(`/houses/${encodeURIComponent(houseId)}/floors/${encodeURIComponent(floorId)}`, { method: "PUT", body: JSON.stringify(floor) }),
  createSensor: async (sensor: CreateSensorInput) => (await request<{ sensor: Sensor }>("/sensors", {
      method: "POST",
      body: JSON.stringify(sensor),
    })).sensor,
  updateSensor: async (sensorId: string, sensor: SensorPatch) => (await request<{ sensor: Sensor }>(`/sensors/${encodeURIComponent(sensorId)}`, {
      method: "PATCH",
      body: JSON.stringify(sensor),
    })).sensor,
  deleteSensor: (sensorId: string) => request<void>(`/sensors/${encodeURIComponent(sensorId)}`, { method: "DELETE" }),
  sensorLabel: async (sensorId: string) => (await request<{ label: SensorLabelDescriptor }>(`/sensors/${encodeURIComponent(sensorId)}/label`)).label,
  bulkSensorMappings: (houseId: string, mappings: Array<{ sensorId: string; measurementEntityIds: Record<string, string> }>) => request<{ sensors: Sensor[] }>("/setup/bulk-sensor-mappings", {
      method: "POST",
      body: JSON.stringify({ houseId, mappings }),
    }),
  alertRules: async (schedulingClass: ApiReadSchedulingClass = "background") => list<AlertRule>(await request<unknown>("/alert-rules", { schedulingClass }), "rules"),
  createAlertRule: async (rule: Omit<AlertRule, "id">) => (await request<{ rule: AlertRule }>("/alert-rules", { method: "POST", body: JSON.stringify(rule) })).rule,
};
