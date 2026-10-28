import type { AreaEquipment, AreaEquipmentInput, AreaEquipmentPatch, EquipmentAttachment, EquipmentAttachmentUploadInput, EquipmentLink, EquipmentLinkInput, EquipmentLinkPatch, EquipmentTrackingBinding, TrackedEquipmentState, TrackingCapabilities, TrackingEndpoint, TrackingEndpointEnrollmentInput, TrackingMapSnapshot, TrackingProfileManifest } from "@climate-twin/contracts";
import { completeCollection, request, list } from "./support/request";
import { API_BASE } from "./support/client-state";

/** Area equipment, its attachments and links, and equipment tracking. */
export const equipmentApi = {
  areaEquipment: (propertyId?: string) => completeCollection<AreaEquipment>(propertyId
      ? `/area-equipment?propertyId=${encodeURIComponent(propertyId)}`
      : "/area-equipment", "equipment"),
  createAreaEquipment: async (input: AreaEquipmentInput) => (await request<{ equipment: AreaEquipment }>("/area-equipment", {
      method: "POST",
      body: JSON.stringify(input),
    })).equipment,
  updateAreaEquipment: async (id: string, patch: AreaEquipmentPatch) => (await request<{ equipment: AreaEquipment }>(`/area-equipment/${encodeURIComponent(id)}`, {
      method: "PATCH",
      body: JSON.stringify(patch),
    })).equipment,
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
};
