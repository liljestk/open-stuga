import type { AreaEquipmentStatus } from "@climate-twin/contracts";

import type { InventoryLocationFilter, MapItemFilter, MapItemKind, MapItemSelection, MapLayerVisibility } from "./support";

const MAP_ITEM_KINDS: MapItemKind[] = ["home", "asset", "equipment", "person"];
const INVENTORY_STATUSES: AreaEquipmentStatus[] = ["active", "out-of-service", "retired"];

export const DEFAULT_MAP_LAYERS: MapLayerVisibility = {
  home: true,
  asset: true,
  equipment: true,
  person: true,
};

export interface PropertyFilterUrlState {
  structureSearch: string;
  mapSearch: string;
  mapType: MapItemFilter;
  mapLayers: MapLayerVisibility;
  mapItem: MapItemSelection;
  inventorySearch: string;
  inventoryStatus: "all" | AreaEquipmentStatus;
  inventoryLocation: InventoryLocationFilter;
  inventoryItem: string | null;
}

interface PropertyFilterScope {
  houseIds: ReadonlySet<string>;
  areaIds: ReadonlySet<string>;
  assetIds: ReadonlySet<string>;
  equipmentIds: ReadonlySet<string>;
  defaultMapItem: MapItemSelection;
}

function mapLayersFromParam(value: string | null): MapLayerVisibility {
  if (value === null) return { ...DEFAULT_MAP_LAYERS };
  if (value === "none") return { home: false, asset: false, equipment: false, person: false };
  const requested = value.split(",");
  if (!requested.length || requested.some((kind) => !MAP_ITEM_KINDS.includes(kind as MapItemKind))) {
    return { ...DEFAULT_MAP_LAYERS };
  }
  const visible = new Set(requested as MapItemKind[]);
  return Object.fromEntries(MAP_ITEM_KINDS.map((kind) => [kind, visible.has(kind)])) as MapLayerVisibility;
}

function inventoryLocationFromParam(value: string | null, scope: PropertyFilterScope): InventoryLocationFilter {
  if (value === "pinned" || value === "unassigned") return value;
  if (value?.startsWith("house:") && scope.houseIds.has(value.slice("house:".length))) {
    return value as InventoryLocationFilter;
  }
  if (value?.startsWith("area:") && scope.areaIds.has(value.slice("area:".length))) {
    return value as InventoryLocationFilter;
  }
  return "all";
}

function mapItemFromParam(value: string | null, scope: PropertyFilterScope): MapItemSelection {
  if (!value) return scope.defaultMapItem;
  if (value === "none") return null;
  const separator = value.indexOf(":");
  if (separator < 1) return scope.defaultMapItem;
  const kind = value.slice(0, separator);
  const id = value.slice(separator + 1);
  if (kind === "home" && scope.houseIds.has(id)) return { kind, id };
  if (kind === "asset" && scope.assetIds.has(id)) return { kind, id };
  if (kind === "equipment" && scope.equipmentIds.has(id)) return { kind, id };
  return scope.defaultMapItem;
}

function mapItemParam(selection: MapItemSelection, defaultSelection: MapItemSelection): string {
  if (!selection) return defaultSelection ? "none" : "";
  if (defaultSelection?.kind === selection.kind && defaultSelection.id === selection.id) return "";
  return `${selection.kind}:${selection.id}`;
}

export function propertyFilterStateFromLocation(
  scope: PropertyFilterScope,
  search = typeof window === "undefined" ? "" : window.location.search,
): PropertyFilterUrlState {
  const params = new URLSearchParams(search);
  const requestedMapType = params.get("map-type");
  const requestedStatus = params.get("inventory-status");
  const requestedInventoryItem = params.get("inventory-item");
  return {
    structureSearch: params.get("structure-search") ?? "",
    mapSearch: params.get("map-search") ?? "",
    mapType: requestedMapType && MAP_ITEM_KINDS.includes(requestedMapType as MapItemKind)
      ? requestedMapType as MapItemFilter
      : "all",
    mapLayers: mapLayersFromParam(params.get("map-layers")),
    mapItem: mapItemFromParam(params.get("map-item"), scope),
    inventorySearch: params.get("inventory-search") ?? "",
    inventoryStatus: requestedStatus && INVENTORY_STATUSES.includes(requestedStatus as AreaEquipmentStatus)
      ? requestedStatus as AreaEquipmentStatus
      : "all",
    inventoryLocation: inventoryLocationFromParam(params.get("inventory-location"), scope),
    inventoryItem: requestedInventoryItem && scope.equipmentIds.has(requestedInventoryItem)
      ? requestedInventoryItem
      : null,
  };
}

function setOrDelete(params: URLSearchParams, key: string, value: string, defaultValue = ""): void {
  if (value === defaultValue) params.delete(key);
  else params.set(key, value);
}

export function writePropertyFilterStateToLocation(
  state: PropertyFilterUrlState,
  mode: "push" | "replace",
  defaultMapItem: MapItemSelection = null,
): void {
  if (typeof window === "undefined") return;
  const url = new URL(window.location.href);
  setOrDelete(url.searchParams, "structure-search", state.structureSearch);
  setOrDelete(url.searchParams, "map-search", state.mapSearch);
  setOrDelete(url.searchParams, "map-type", state.mapType, "all");
  const visibleLayers = MAP_ITEM_KINDS.filter((kind) => state.mapLayers[kind]);
  const layerValue = visibleLayers.length === MAP_ITEM_KINDS.length
    ? ""
    : visibleLayers.length === 0 ? "none" : visibleLayers.join(",");
  setOrDelete(url.searchParams, "map-layers", layerValue);
  setOrDelete(url.searchParams, "map-item", mapItemParam(state.mapItem, defaultMapItem));
  setOrDelete(url.searchParams, "inventory-search", state.inventorySearch);
  setOrDelete(url.searchParams, "inventory-status", state.inventoryStatus, "all");
  setOrDelete(url.searchParams, "inventory-location", state.inventoryLocation, "all");
  setOrDelete(url.searchParams, "inventory-item", state.inventoryItem ?? "");
  const next = `${url.pathname}${url.search}${url.hash}`;
  const current = `${window.location.pathname}${window.location.search}${window.location.hash}`;
  if (next !== current) window.history[`${mode}State`](window.history.state, "", next);
}
