import type { AreaEquipmentInput, AreaEquipmentPatch, EquipmentAttachmentUploadInput, EquipmentLinkInput, EquipmentLinkPatch, TrackingEndpointEnrollmentInput } from "@climate-twin/contracts";
import { completeCollection, request } from "./support/request";
import { API_BASE } from "./support/client-state";
import { areaEquipmentShape, equipmentAttachmentShape, equipmentLinkShape, equipmentTrackingBindingShape, trackedEquipmentStateShape, trackingCapabilitiesShape, trackingEndpointShape, trackingMapSnapshotShape, trackingProfileManifestShape } from "./support/entity-shapes";
import { noContent, nullable, arrayOf, fields } from "./support/response-shapes";

/** Area equipment, its attachments and links, and equipment tracking. */
export const equipmentApi = {
  areaEquipment: (propertyId?: string) => completeCollection(propertyId
      ? `/area-equipment?propertyId=${encodeURIComponent(propertyId)}`
      : "/area-equipment", { key: "equipment", item: areaEquipmentShape }),
  createAreaEquipment: async (input: AreaEquipmentInput) => (await request("/area-equipment", fields({ equipment: areaEquipmentShape }), {
      method: "POST",
      body: JSON.stringify(input),
    })).equipment,
  updateAreaEquipment: async (id: string, patch: AreaEquipmentPatch) => (await request(`/area-equipment/${encodeURIComponent(id)}`, fields({ equipment: areaEquipmentShape }), {
      method: "PATCH",
      body: JSON.stringify(patch),
    })).equipment,
  deleteAreaEquipment: (id: string) => request(`/area-equipment/${encodeURIComponent(id)}`, noContent, { method: "DELETE" }),
  equipmentAttachments: async (equipmentId: string) => (await request(`/area-equipment/${encodeURIComponent(equipmentId)}/attachments`, fields({ attachments: arrayOf(equipmentAttachmentShape) }))).attachments,
  uploadEquipmentAttachment: async (equipmentId: string, input: EquipmentAttachmentUploadInput) => (await request(`/area-equipment/${encodeURIComponent(equipmentId)}/attachments`, fields({ attachment: equipmentAttachmentShape }), { method: "POST", body: JSON.stringify(input) })).attachment,
  equipmentAttachmentUrl: (equipmentId: string, attachmentId: string) => (
      `${API_BASE}/area-equipment/${encodeURIComponent(equipmentId)}/attachments/${encodeURIComponent(attachmentId)}`
    ),
  deleteEquipmentAttachment: (equipmentId: string, attachmentId: string) => request(
      `/area-equipment/${encodeURIComponent(equipmentId)}/attachments/${encodeURIComponent(attachmentId)}`, noContent,
      { method: "DELETE" },
    ),
  equipmentLinks: async (equipmentId: string) => (await request(`/area-equipment/${encodeURIComponent(equipmentId)}/links`, fields({ links: arrayOf(equipmentLinkShape) }))).links,
  createEquipmentLink: async (equipmentId: string, input: EquipmentLinkInput) => (await request(`/area-equipment/${encodeURIComponent(equipmentId)}/links`, fields({ link: equipmentLinkShape }), { method: "POST", body: JSON.stringify(input) })).link,
  updateEquipmentLink: async (equipmentId: string, linkId: string, patch: EquipmentLinkPatch) => (await request(`/area-equipment/${encodeURIComponent(equipmentId)}/links/${encodeURIComponent(linkId)}`, fields({ link: equipmentLinkShape }), { method: "PATCH", body: JSON.stringify(patch) })).link,
  deleteEquipmentLink: (equipmentId: string, linkId: string) => request(
      `/area-equipment/${encodeURIComponent(equipmentId)}/links/${encodeURIComponent(linkId)}`, noContent,
      { method: "DELETE" },
    ),
  trackedEquipment: async (propertyId: string) => (await request(`/properties/${encodeURIComponent(propertyId)}/tracked-equipment`, fields({ equipment: arrayOf(trackedEquipmentStateShape) }))).equipment,
  trackingCapabilities: () => request("/tracking/capabilities", trackingCapabilitiesShape),
  trackingProfiles: () => request("/tracking/profiles", trackingProfileManifestShape),
  trackingEndpoints: async (propertyId: string) => (await request(`/tracking/endpoints?propertyId=${encodeURIComponent(propertyId)}`, fields({ endpoints: arrayOf(trackingEndpointShape) }))).endpoints,
  enrollTrackingEndpoint: async (input: TrackingEndpointEnrollmentInput) => (await request("/tracking/endpoints", fields({ endpoint: trackingEndpointShape }), { method: "POST", body: JSON.stringify(input) })).endpoint,
  bindTrackingEndpoint: async (
    equipmentId: string,
    endpointId: string,
    observerId?: string,
  ) => (await request(`/area-equipment/${encodeURIComponent(equipmentId)}/tracking-binding`, fields({ binding: equipmentTrackingBindingShape }), {
          method: "POST",
          body: JSON.stringify({ endpointId, ...(observerId ? { observerId } : {}) }),
        })).binding,
  unbindTrackingEndpoint: async (equipmentId: string) => (
      await request(
        `/area-equipment/${encodeURIComponent(equipmentId)}/tracking-binding`, fields({ binding: nullable(equipmentTrackingBindingShape) }),
        { method: "DELETE" },
      )
    ).binding,
  trackingMapSnapshot: (propertyId: string) => request(
      `/properties/${encodeURIComponent(propertyId)}/tracking-map-snapshot`, trackingMapSnapshotShape,
    ),
};
