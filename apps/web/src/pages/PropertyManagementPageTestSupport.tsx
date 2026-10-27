import { fireEvent, within } from "@testing-library/react";

import { vi } from "vitest";

import type {
  AreaEquipment,
  MaintenanceTask,
  PropertyArea,
  PropertyNote,
  TrackingCapabilities,
} from "@climate-twin/contracts";

import { DEMO_PROPERTY_ID } from "../domain";

export const originalClipboard = navigator.clipboard;

export function enabledTrackingCapabilities(): TrackingCapabilities {
  return {
    schemaVersion: "2026-07-01",
    profileSchemaVersion: "2026-07-01",
    flags: {
      "tracking.enabled": true,
      "tracking.mobileObserver.enabled": true,
      "tracking.mobileObserver.iosBackground.enabled": true,
      "tracking.mobileObserver.androidBackground.enabled": false,
      "tracking.androidGatewayMode.enabled": false,
      "tracking.liveMap.enabled": true,
      "tracking.movementTrails.enabled": false,
      "tracking.exitAlerts.enabled": false,
      "tracking.userLocationSharing.enabled": true,
    },
    maximumObservationBatchSize: 100,
    maximumRollupBatchSize: 100,
    observerTypes: ["esp32-gateway", "linux-gateway", "android-gateway", "android-phone", "ios-phone"],
  };
}

export function areaNavigation(): HTMLElement {
  const navigation = document.querySelector<HTMLElement>(".property-area-list");
  if (!navigation) throw new Error("Property area navigation was not rendered");
  return navigation;
}

export function selectArea(name: RegExp): void {
  fireEvent.click(within(areaNavigation()).getByRole("button", { name }));
}

export const area: PropertyArea = {
  id: "area-well",
  propertyId: DEMO_PROPERTY_ID,
  name: "North well",
  kind: "well",
  description: "Potable water well",
  polygon: [
    { latitude: 60.1, longitude: 24.1 },
    { latitude: 60.1, longitude: 24.2 },
    { latitude: 60.2, longitude: 24.2 },
  ],
  createdAt: "2026-07-01T08:00:00.000Z",
  updatedAt: "2026-07-01T08:00:00.000Z",
};

export const equipment: AreaEquipment = {
  id: "equipment-pump",
  propertyId: DEMO_PROPERTY_ID,
  areaId: area.id,
  name: "Well pump",
  kind: "pump",
  manufacturer: null,
  model: null,
  serialNumber: null,
  status: "active",
  notes: "Inspect each spring",
  createdAt: "2026-07-01T08:00:00.000Z",
  updatedAt: "2026-07-01T08:00:00.000Z",
};

export const note: PropertyNote = {
  id: "note-well",
  propertyId: DEMO_PROPERTY_ID,
  houseId: null,
  areaId: area.id,
  equipmentId: null,
  kind: "inspection",
  text: "Water sample passed inspection.",
  createdAt: "2026-07-01T08:00:00.000Z",
  updatedAt: "2026-07-01T08:00:00.000Z",
};

export const areaTask: MaintenanceTask = {
  id: "maintenance-well-pump",
  propertyId: DEMO_PROPERTY_ID,
  houseId: "house-hidden-from-guest",
  floorId: null,
  areaId: area.id,
  equipmentId: equipment.id,
  title: "Service well pump",
  description: "Check the pressure vessel.",
  basis: "scheduled",
  basisDetail: null,
  priority: "normal",
  plannedFor: "2026-08-01",
  dueBy: null,
  observationIds: [],
  status: "planned",
  completionNote: null,
  completedAt: null,
  verificationNote: null,
  verifiedAt: null,
  revision: 1,
  createdAt: "2026-07-01T08:00:00.000Z",
  updatedAt: "2026-07-01T08:00:00.000Z",
};

export const equipmentOnlyTask: MaintenanceTask = {
  ...areaTask,
  id: "maintenance-equipment-only",
  areaId: null,
  equipmentId: equipment.id,
  title: "Test pump pressure",
};

export const callbacks = () => ({
  onCreateProperty: vi.fn(),
  onUpdateProperty: vi.fn(),
  onDeleteProperty: vi.fn(),
  onCreateHouse: vi.fn(),
  onUpdateHouse: vi.fn(),
  onCreateArea: vi.fn(),
  onUpdateArea: vi.fn(),
  onDeleteArea: vi.fn(),
  onCreateEquipment: vi.fn(),
  onUpdateEquipment: vi.fn(),
  onDeleteEquipment: vi.fn(),
  onCreateNote: vi.fn(),
  onUpdateNote: vi.fn(),
  onDeleteNote: vi.fn(),
  onCreateMaintenanceTask: vi.fn(),
  onSetHouseGeoreference: vi.fn(),
});
