import type { Property, PropertyArea, PropertyAreaInput, PropertyAreaPatch, PropertyCreateInput, PropertyInventorySnapshot, PropertyPatch, PropertyNote, PropertyNoteInput, PropertyNotePatch } from "@climate-twin/contracts";
import { completeCollection, request } from "./support/request";

/** Properties, their areas, inventory and notes. */
export const propertiesApi = {
  properties: () => completeCollection<Property>("/properties", "properties"),
  createProperty: async (input: PropertyCreateInput) => (await request<{ property: Property }>("/properties", {
      method: "POST",
      body: JSON.stringify(input),
    })).property,
  updateProperty: async (id: string, patch: PropertyPatch) => (await request<{ property: Property }>(`/properties/${encodeURIComponent(id)}`, {
      method: "PATCH",
      body: JSON.stringify(patch),
    })).property,
  deleteProperty: (id: string) => request<void>(`/properties/${encodeURIComponent(id)}`, { method: "DELETE" }),
  propertyAreas: (propertyId?: string) => completeCollection<PropertyArea>(propertyId
      ? `/property-areas?propertyId=${encodeURIComponent(propertyId)}`
      : "/property-areas", "areas"),
  createPropertyArea: async (input: PropertyAreaInput) => (await request<{ area: PropertyArea }>("/property-areas", {
      method: "POST",
      body: JSON.stringify(input),
    })).area,
  updatePropertyArea: async (id: string, patch: PropertyAreaPatch) => (await request<{ area: PropertyArea }>(`/property-areas/${encodeURIComponent(id)}`, {
      method: "PATCH",
      body: JSON.stringify(patch),
    })).area,
  deletePropertyArea: (id: string) => request<void>(`/property-areas/${encodeURIComponent(id)}`, { method: "DELETE" }),
  propertyInventory: async (propertyId: string) => (await request<{ inventory: PropertyInventorySnapshot }>(`/properties/${encodeURIComponent(propertyId)}/inventory`)).inventory,
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
};
