import type { PropertyAreaInput, PropertyAreaPatch, PropertyCreateInput, PropertyPatch, PropertyNoteInput, PropertyNotePatch } from "@climate-twin/contracts";
import { completeCollection, request } from "./support/request";
import { propertyAreaShape, propertyInventorySnapshotShape, propertyNoteShape, propertyShape } from "./support/entity-shapes";
import { noContent, fields } from "./support/response-shapes";

/** Properties, their areas, inventory and notes. */
export const propertiesApi = {
  properties: () => completeCollection("/properties", { key: "properties", item: propertyShape }),
  createProperty: async (input: PropertyCreateInput) => (await request("/properties", fields({ property: propertyShape }), {
      method: "POST",
      body: JSON.stringify(input),
    })).property,
  updateProperty: async (id: string, patch: PropertyPatch) => (await request(`/properties/${encodeURIComponent(id)}`, fields({ property: propertyShape }), {
      method: "PATCH",
      body: JSON.stringify(patch),
    })).property,
  deleteProperty: (id: string) => request(`/properties/${encodeURIComponent(id)}`, noContent, { method: "DELETE" }),
  propertyAreas: (propertyId?: string) => completeCollection(propertyId
      ? `/property-areas?propertyId=${encodeURIComponent(propertyId)}`
      : "/property-areas", { key: "areas", item: propertyAreaShape }),
  createPropertyArea: async (input: PropertyAreaInput) => (await request("/property-areas", fields({ area: propertyAreaShape }), {
      method: "POST",
      body: JSON.stringify(input),
    })).area,
  updatePropertyArea: async (id: string, patch: PropertyAreaPatch) => (await request(`/property-areas/${encodeURIComponent(id)}`, fields({ area: propertyAreaShape }), {
      method: "PATCH",
      body: JSON.stringify(patch),
    })).area,
  deletePropertyArea: (id: string) => request(`/property-areas/${encodeURIComponent(id)}`, noContent, { method: "DELETE" }),
  propertyInventory: async (propertyId: string) => (await request(`/properties/${encodeURIComponent(propertyId)}/inventory`, fields({ inventory: propertyInventorySnapshotShape }))).inventory,
  propertyNotes: (propertyId?: string) => completeCollection(propertyId
      ? `/property-notes?propertyId=${encodeURIComponent(propertyId)}`
      : "/property-notes", { key: "notes", item: propertyNoteShape }),
  createPropertyNote: async (input: PropertyNoteInput) => (await request("/property-notes", fields({ note: propertyNoteShape }), {
      method: "POST",
      body: JSON.stringify(input),
    })).note,
  updatePropertyNote: async (id: string, patch: PropertyNotePatch) => (await request(`/property-notes/${encodeURIComponent(id)}`, fields({ note: propertyNoteShape }), {
      method: "PATCH",
      body: JSON.stringify(patch),
    })).note,
  deletePropertyNote: (id: string) => request(`/property-notes/${encodeURIComponent(id)}`, noContent, { method: "DELETE" }),
};
