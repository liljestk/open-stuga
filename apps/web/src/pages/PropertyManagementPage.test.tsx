import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type {
  AreaEquipment,
  EquipmentAttachment,
  EquipmentLink,
  MaintenanceTask,
  PropertyArea,
  PropertyMemberLocation,
  PropertyNote,
  TenantMemberSummary,
  TrackingCapabilities,
  TrackingMapSnapshot,
} from "@climate-twin/contracts";
import { api, ApiRequestError } from "../api";
import { createDemoState, DEMO_PROPERTY_ID } from "../domain";
import { I18nProvider } from "../i18n";
import { PeopleAccessPage } from "./PeopleAccessPage";
import { PropertyManagementPage } from "./PropertyManagementPage";
import propertyStyles from "./PropertyManagementPage.css?raw";

vi.mock("../components/PropertyAreaMap", () => ({
  PropertyAreaMap: ({
    ariaLabel,
    members = [],
    propertyLabel,
    areas = [],
    houses = [],
    editableEquipmentId,
    onMoveEquipment,
  }: {
    ariaLabel: string;
    members?: PropertyMemberLocation[];
    propertyLabel?: string;
    areas?: Array<{ id: string; name: string }>;
    houses?: Array<{ id: string; name: string }>;
    editableEquipmentId?: string | null;
    onMoveEquipment?: (id: string, location: { latitude: number; longitude: number }) => void;
  }) => <div role="region" aria-label={ariaLabel}>
    {propertyLabel && <span data-testid="map-property">{propertyLabel}</span>}
    {areas.map((item) => <span data-testid="map-area" key={item.id}>{item.name}</span>)}
    {houses.map((item) => <span data-testid="map-home" key={item.id}>{item.name}</span>)}
    {members.map((member) => <span data-testid="map-member" key={member.id}>{member.memberLabel}</span>)}
    {editableEquipmentId && onMoveEquipment && <button
      type="button"
      onClick={() => onMoveEquipment(editableEquipmentId, { latitude: 60.171, longitude: 24.941 })}
    >
      Place test pin
    </button>}
  </div>,
}));

vi.mock("../components/HouseLocationMap", () => ({
  HouseLocationMap: ({
    ariaLabel,
    onChange,
    selectedHouseId,
  }: {
    ariaLabel: string;
    onChange: (id: string, location: { latitude: number; longitude: number }) => void;
    selectedHouseId: string;
  }) => <div role="region" aria-label={ariaLabel}>
    <button type="button" onClick={() => onChange(selectedHouseId, { latitude: 60.171, longitude: 24.941 })}>
      Place test pin
    </button>
  </div>,
}));

const originalClipboard = navigator.clipboard;

function enabledTrackingCapabilities(): TrackingCapabilities {
  return {
    flags: {
      "tracking.enabled": true,
      "tracking.mobileObserver.enabled": true,
      "tracking.mobileObserver.iosBackground.enabled": true,
      "tracking.mobileObserver.androidBackground.enabled": false,
      "tracking.androidGatewayMode.enabled": false,
      "tracking.liveMap.enabled": true,
      "tracking.movementTrails.enabled": false,
      "tracking.exitAlerts.enabled": false,
      "tracking.rotatingIdentifiers.enabled": true,
      "tracking.userLocationSharing.enabled": true,
      "tracking.experimentalCoordinateInference.enabled": false,
    },
    bleServiceUuid: "F8A57A01-9D58-4C66-8D2D-2026A11E0001",
    protocolVersions: [1],
    maximumObservationBatchSize: 100,
    observerModes: ["passive", "property", "active-property", "find-nearby", "gateway"],
  };
}

function areaNavigation(): HTMLElement {
  const navigation = document.querySelector<HTMLElement>(".property-area-list");
  if (!navigation) throw new Error("Property area navigation was not rendered");
  return navigation;
}

function selectArea(name: RegExp): void {
  fireEvent.click(within(areaNavigation()).getByRole("button", { name }));
}

const area: PropertyArea = {
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

const equipment: AreaEquipment = {
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

const note: PropertyNote = {
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

const areaTask: MaintenanceTask = {
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

const equipmentOnlyTask: MaintenanceTask = {
  ...areaTask,
  id: "maintenance-equipment-only",
  areaId: null,
  equipmentId: equipment.id,
  title: "Test pump pressure",
};

const callbacks = () => ({
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

afterEach(() => {
  Object.defineProperty(navigator, "clipboard", { configurable: true, value: originalClipboard });
  vi.restoreAllMocks();
});

describe("PropertyManagementPage", () => {
  it("keeps the property index cards contained and padded", () => {
    expect(propertyStyles).toMatch(/\.property-index-grid\s*\{[^}]*repeat\(auto-fill,/);
    expect(propertyStyles).toMatch(/\.property-index-card\s*\{[^}]*padding:\s*18px/);
    expect(propertyStyles).toMatch(/\.property-index-create\s*\{[^}]*width:\s*min\(100%,\s*680px\)[^}]*padding:\s*18px/);
  });

  it("keeps the map workspace focused on placement and hides secondary tools by default", () => {
    const state = createDemoState();
    state.propertyAreas = [area];
    state.areaEquipment = [equipment];
    const { container } = render(<I18nProvider><PropertyManagementPage state={state} {...callbacks()} /></I18nProvider>);

    expect(screen.getByRole("tab", { name: "Map" })).not.toBeNull();
    expect(screen.queryByText("Experimental layers")).toBeNull();
    const homeList = container.querySelector<HTMLElement>(".property-placement-house-list")!;
    expect(within(homeList).getByRole("button", { name: /Pine House/ }).getAttribute("draggable")).toBe("true");
    expect(container.querySelector<HTMLDetailsElement>(".property-placement-advanced")?.open).toBe(false);

    selectArea(/North well/);
    const secondaryTools = container.querySelector<HTMLDetailsElement>(".property-secondary-tools")!;
    expect(secondaryTools.open).toBe(false);
    expect(within(secondaryTools).getByText("Area equipment & maintenance")).not.toBeNull();
  });

  it("keeps large map item collections searchable and incrementally rendered", () => {
    const state = createDemoState();
    state.propertyAreas = Array.from({ length: 75 }, (_, index): PropertyArea => ({
      ...area,
      id: `fixed-asset-${index}`,
      name: `Fixed asset ${String(index).padStart(3, "0")}`,
      kind: "building",
      location: { latitude: 60.1 + index / 10_000, longitude: 24.1 + index / 10_000 },
      polygon: [],
    }));

    const { container } = render(<I18nProvider><PropertyManagementPage state={state} {...callbacks()} /></I18nProvider>);
    const panel = container.querySelector<HTMLElement>(".property-home-placement")!;
    const list = panel.querySelector<HTMLElement>(".property-map-item-list")!;

    expect(list.querySelectorAll("li")).toHaveLength(30);
    expect(within(panel).getByRole("button", { name: "Show 30 more" })).not.toBeNull();

    fireEvent.change(within(panel).getByLabelText("Search map items"), { target: { value: "Fixed asset 074" } });

    expect(within(panel).getByText("Fixed asset 074")).not.toBeNull();
    expect(list.querySelectorAll("li")).toHaveLength(1);
    expect(within(panel).queryByText("Fixed asset 000")).toBeNull();
  });

  it("shows the Stugby mark only on foreign shared Homes", () => {
    const state = createDemoState();
    const home = state.houses[0]!;
    state.houses = [
      {
        ...home,
        name: "My Home",
        stugby: {
          stugbyId: "stugby-1",
          authorityNodeId: "node-local",
          publicationId: "publication-local-home",
          ownership: "local",
          editPolicy: "editable",
          syncState: "current",
          authorityEpoch: 1,
          pendingChangeCount: 0,
          conflictCount: 0,
          recoveryState: "not-enabled",
        },
      },
      {
        ...home,
        id: "home-shared",
        name: "Foreign Home",
        stugby: {
          stugbyId: "stugby-1",
          authorityNodeId: "node-foreign",
          publicationId: "publication-foreign-home",
          ownership: "shared",
          editPolicy: "read-only",
          syncState: "current",
          authorityEpoch: 1,
          pendingChangeCount: 0,
          conflictCount: 0,
          recoveryState: "not-enabled",
        },
      },
    ];

    const { container } = render(
      <I18nProvider><PropertyManagementPage state={state} {...callbacks()} /></I18nProvider>,
    );
    const sidebarHomes = container.querySelector<HTMLElement>(".property-house-group")!;
    const ownHome = within(sidebarHomes).getByText("My Home").closest("li")!;
    const foreignHome = within(sidebarHomes).getByText("Foreign Home").closest("li")!;
    expect(ownHome.querySelector(".stugby-mark")).toBeNull();
    expect(ownHome.classList.contains("stugby-shared")).toBe(false);
    expect(foreignHome.querySelector(".stugby-mark")).not.toBeNull();
    expect(foreignHome.classList.contains("stugby-shared")).toBe(true);

    const placementHomes = container.querySelector<HTMLElement>(".property-placement-house-list")!;
    expect(within(placementHomes).getByText("My Home").closest("button")?.querySelector(".stugby-mark")).toBeNull();
    expect(within(placementHomes).getByText("Foreign Home").closest("button")?.querySelector(".stugby-mark")).not.toBeNull();
  });

  it("manages the Property inventory without creating a second asset identity", async () => {
    const state = createDemoState();
    state.propertyAreas = [area];
    state.areaEquipment = [{
      ...equipment,
      manufacturer: "Pump Works",
      model: "PW-20",
      serialNumber: "PUMP-001",
    }];
    const handlers = callbacks();
    handlers.onUpdateEquipment.mockResolvedValue({
      ...state.areaEquipment[0]!,
      manufacturer: "Nordic Pumps",
      status: "out-of-service",
    });
    vi.spyOn(api, "trackedAssets").mockResolvedValue([]);

    const { rerender } = render(<I18nProvider><PropertyManagementPage state={state} {...handlers} /></I18nProvider>);
    fireEvent.click(screen.getByRole("tab", { name: "Inventory" }));

    expect(screen.getByRole("heading", { name: "Well pump" })).not.toBeNull();
    expect(screen.getByText("PUMP-001")).not.toBeNull();
    expect(screen.getByRole("button", { name: "Edit inventory item: Well pump" })).not.toBeNull();
    await waitFor(() => expect(api.trackedAssets).toHaveBeenCalledTimes(1));
    rerender(<I18nProvider><PropertyManagementPage
      state={{ ...state, areaEquipment: state.areaEquipment.map((item) => ({ ...item })) }}
      {...handlers}
    /></I18nProvider>);
    expect(api.trackedAssets).toHaveBeenCalledTimes(1);
    fireEvent.click(screen.getByRole("button", { name: "Edit inventory item: Well pump" }));
    fireEvent.change(screen.getByLabelText("Manufacturer"), { target: { value: "Nordic Pumps" } });
    fireEvent.change(screen.getAllByLabelText("Service state")[1]!, {
      target: { value: "out-of-service" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Save equipment" }));

    await waitFor(() => expect(handlers.onUpdateEquipment).toHaveBeenCalledWith(equipment.id, {
      areaId: area.id,
      houseId: null,
      location: null,
      name: equipment.name,
      kind: equipment.kind,
      manufacturer: "Nordic Pumps",
      model: "PW-20",
      serialNumber: "PUMP-001",
      status: "out-of-service",
      notes: equipment.notes,
    }));
  });

  it("keeps optional photos, manuals, and relevant links with an inventory item", async () => {
    const state = createDemoState();
    state.propertyAreas = [area];
    state.areaEquipment = [equipment];
    const photo: EquipmentAttachment = {
      id: "attachment-photo",
      equipmentId: equipment.id,
      kind: "photo",
      name: "Pump front.png",
      mimeType: "image/png",
      size: 1_024,
      createdAt: "2026-07-26T10:00:00.000Z",
    };
    const manual: EquipmentAttachment = {
      ...photo,
      id: "attachment-manual",
      kind: "document",
      name: "Pump manual.pdf",
      mimeType: "application/pdf",
      size: 2_048,
    };
    const link: EquipmentLink = {
      id: "link-support",
      equipmentId: equipment.id,
      label: "Manufacturer support",
      url: "https://example.test/pump",
      createdAt: "2026-07-26T10:00:00.000Z",
      updatedAt: "2026-07-26T10:00:00.000Z",
    };
    vi.spyOn(api, "equipmentAttachments").mockResolvedValue([photo, manual]);
    vi.spyOn(api, "equipmentLinks").mockResolvedValue([link]);
    const upload = vi.spyOn(api, "uploadEquipmentAttachment").mockResolvedValue({
      ...photo,
      id: "attachment-new",
      name: "Pump side.png",
    });
    const createLink = vi.spyOn(api, "createEquipmentLink").mockResolvedValue({
      ...link,
      id: "link-parts",
      label: "Spare parts",
      url: "https://example.test/parts",
    });

    render(<I18nProvider><PropertyManagementPage state={state} {...callbacks()} /></I18nProvider>);
    fireEvent.click(screen.getByRole("tab", { name: "Inventory" }));
    fireEvent.click(screen.getByRole("button", { name: "Equipment label: Well pump" }));

    expect(await screen.findByRole("heading", { name: "Photos, manuals & links" })).not.toBeNull();
    expect(screen.getByRole("img", { name: "Pump front.png" })).not.toBeNull();
    expect(screen.getByRole("link", { name: /Pump manual\.pdf/ })).not.toBeNull();
    expect(screen.getByRole("link", { name: /Manufacturer support/ }).getAttribute("href"))
      .toBe("https://example.test/pump");

    const photoFile = new File([new Uint8Array([1, 2, 3])], "Pump side.png");
    fireEvent.change(screen.getByLabelText("Add photos"), { target: { files: [photoFile] } });
    await waitFor(() => expect(upload).toHaveBeenCalledWith(equipment.id, expect.objectContaining({
      kind: "photo",
      name: "Pump side.png",
      mimeType: "image/png",
      data: expect.stringMatching(/^data:image\/png;base64,/),
    })));

    fireEvent.change(screen.getByLabelText("Link name"), { target: { value: "Spare parts" } });
    fireEvent.change(screen.getByLabelText("Web address"), { target: { value: "https://example.test/parts" } });
    fireEvent.click(screen.getByRole("button", { name: "Add link" }));
    await waitFor(() => expect(createLink).toHaveBeenCalledWith(equipment.id, {
      label: "Spare parts",
      url: "https://example.test/parts",
    }));
    expect(await screen.findByRole("link", { name: /Spare parts/ })).not.toBeNull();
  });

  it("records equipment without an Area and can use a Home plus an optional map pin", async () => {
    const state = createDemoState();
    state.propertyAreas = [];
    state.areaEquipment = [];
    const home = state.houses[0]!;
    const handlers = callbacks();
    handlers.onCreateEquipment.mockResolvedValue({
      ...equipment,
      id: "equipment-tractor",
      areaId: null,
      houseId: home.id,
      location: { latitude: 60.171, longitude: 24.941 },
      name: "Tractor",
      kind: "vehicle",
    });
    vi.spyOn(api, "trackingCapabilities").mockResolvedValue({
      ...enabledTrackingCapabilities(),
      flags: { ...enabledTrackingCapabilities().flags, "tracking.enabled": false },
    });
    vi.spyOn(api, "trackedAssets").mockResolvedValue([]);

    render(<I18nProvider><PropertyManagementPage state={state} {...handlers} /></I18nProvider>);
    fireEvent.click(screen.getByRole("tab", { name: "Inventory" }));
    fireEvent.click(screen.getByRole("button", { name: "Add inventory item" }));
    await waitFor(() => expect(screen.getAllByLabelText(/Expected location/)).toHaveLength(2));
    fireEvent.change(screen.getAllByLabelText(/Expected location/)[1]!, {
      target: { value: `house:${home.id}` },
    });
    fireEvent.change(screen.getByLabelText("Equipment name"), { target: { value: "Tractor" } });
    fireEvent.change(screen.getByLabelText("Equipment type"), { target: { value: "vehicle" } });
    fireEvent.click(screen.getByText("Choose on map"));
    const pinMap = await screen.findByRole("region", { name: "Map for placing Tractor" });
    expect(within(pinMap).getByTestId("map-property").textContent).toBe(state.properties[0]!.name);
    expect(within(pinMap).getByTestId("map-home").textContent).toBe(home.name);
    fireEvent.click(within(pinMap).getByRole("button", { name: "Place test pin" }));
    expect((screen.getByLabelText("Latitude") as HTMLInputElement).value).toBe("60.171");
    expect((screen.getByLabelText("Longitude") as HTMLInputElement).value).toBe("24.941");
    fireEvent.click(screen.getByRole("button", { name: "Add equipment" }));

    await waitFor(() => expect(handlers.onCreateEquipment).toHaveBeenCalledWith(expect.objectContaining({
      propertyId: DEMO_PROPERTY_ID,
      areaId: null,
      houseId: home.id,
      location: { latitude: 60.171, longitude: 24.941 },
      name: "Tractor",
      kind: "vehicle",
    })));
  });

  it("loads consented people only after the Property map is explicitly opened", async () => {
    const state = createDemoState();
    const activeMember: PropertyMemberLocation = {
      id: "member-active",
      propertyId: DEMO_PROPERTY_ID,
      memberLabel: "Alex",
      coordinate: { latitude: 60.175, longitude: 24.935 },
      horizontalAccuracyMeters: 25,
      reducedAccuracy: true,
      capturedAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      sharingUntil: new Date(Date.now() + 60_000).toISOString(),
    };
    const expiredMember: PropertyMemberLocation = {
      ...activeMember,
      id: "member-expired",
      memberLabel: "Expired person",
      sharingUntil: new Date(Date.now() - 1_000).toISOString(),
    };
    const snapshot = {
      propertyId: DEMO_PROPERTY_ID,
      generatedAt: new Date().toISOString(),
      sequence: 3,
      settings: {
        propertyId: DEMO_PROPERTY_ID,
        enabled: true,
        propertyBoundary: [],
        liveNearbySeconds: 30,
        recentlySeenSeconds: 300,
        staleSeconds: 3_600,
        unknownSeconds: 86_400,
        movementThresholdMeters: 10,
        movementMaximumIntervalSeconds: 300,
        minimumMovementConfidence: 0.6,
        exitAlertDebounceSeconds: 120,
        updatedAt: new Date().toISOString(),
      },
      zones: [],
      gateways: [],
      assets: [],
      members: [activeMember, expiredMember],
    } satisfies TrackingMapSnapshot;
    vi.spyOn(api, "trackingCapabilities").mockResolvedValue(enabledTrackingCapabilities());
    const loadSnapshot = vi.spyOn(api, "trackingMapSnapshot").mockResolvedValue(snapshot);

    render(<I18nProvider><PropertyManagementPage state={state} {...callbacks()} /></I18nProvider>);
    await waitFor(() => expect(api.trackingCapabilities).toHaveBeenCalledOnce());
    expect(loadSnapshot).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Load map" }));

    await waitFor(() => expect(loadSnapshot).toHaveBeenCalledWith(DEMO_PROPERTY_ID));
    expect(screen.getAllByText("Alex").length).toBeGreaterThan(0);
    expect(screen.queryByText("Expired person")).toBeNull();
    expect(screen.getByText(/People appear only while they explicitly share/)).not.toBeNull();
  });

  it("stops tracked-equipment polling when tracking is unavailable", async () => {
    vi.useFakeTimers();
    try {
      const state = createDemoState();
      state.propertyAreas = [area];
      state.areaEquipment = [equipment];
      const trackedAssets = vi.spyOn(api, "trackedAssets").mockRejectedValue(
        new ApiRequestError(404, "TRACKING_DISABLED", "Equipment tracking is not enabled"),
      );
      const { unmount } = render(
        <I18nProvider><PropertyManagementPage state={state} {...callbacks()} /></I18nProvider>,
      );
      fireEvent.click(screen.getByRole("tab", { name: "Inventory" }));
      await vi.waitFor(() => expect(trackedAssets).toHaveBeenCalledTimes(1));
      await vi.advanceTimersByTimeAsync(90_000);
      expect(trackedAssets).toHaveBeenCalledTimes(1);
      unmount();
    } finally {
      vi.useRealTimers();
    }
  });

  it("saves a home's map placement from the property map", async () => {
    const state = createDemoState();
    const handlers = callbacks();
    handlers.onSetHouseGeoreference.mockResolvedValue(undefined);
    const ground = state.houses[0]!.floors.find((floor) => floor.type === "ground") ?? state.houses[0]!.floors[0]!;

    render(<I18nProvider><PropertyManagementPage state={state} {...handlers} /></I18nProvider>);
    fireEvent.change(screen.getByLabelText("Latitude"), { target: { value: "61.5" } });
    fireEvent.change(screen.getByLabelText("Longitude"), { target: { value: "25.25" } });
    fireEvent.change(screen.getByLabelText("Actual footprint width (m)"), { target: { value: "12" } });
    fireEvent.change(screen.getByLabelText("Plan-top bearing (0-359 degrees)"), { target: { value: "90" } });
    fireEvent.click(screen.getByRole("button", { name: "Save placement" }));

    await waitFor(() => expect(handlers.onSetHouseGeoreference).toHaveBeenCalledWith(state.houses[0]!.id, {
      mapPlacement: {
        latitude: 61.5,
        longitude: 25.25,
        metersPerPlanUnit: 12 / Math.max(1, ground.width),
        footprintFloorId: ground.id,
      },
      orientationDegrees: 90,
    }));
    expect(screen.getByText("Home placement and scale saved.")).not.toBeNull();
  });

  it("lets keyboard users place a fixed asset with exact coordinates", async () => {
    const state = createDemoState();
    const handlers = callbacks();
    const fixedAsset: PropertyArea = {
      ...area,
      id: "asset-generator",
      name: "Backup generator",
      kind: "other",
      polygon: [],
      location: { latitude: 60.175, longitude: 24.95 },
    };
    handlers.onCreateArea.mockResolvedValue(fixedAsset);

    const { container } = render(<I18nProvider><PropertyManagementPage state={state} {...handlers} /></I18nProvider>);
    fireEvent.click(screen.getByRole("button", { name: "Add fixed asset" }));
    const editor = container.querySelector<HTMLElement>(".area-editor")!;
    fireEvent.change(within(editor).getByLabelText("Asset name"), { target: { value: fixedAsset.name } });
    fireEvent.change(within(editor).getByLabelText("Latitude"), { target: { value: String(fixedAsset.location!.latitude) } });
    fireEvent.change(within(editor).getByLabelText("Longitude"), { target: { value: String(fixedAsset.location!.longitude) } });
    fireEvent.click(within(editor).getByRole("button", { name: "Save fixed asset" }));

    await waitFor(() => expect(handlers.onCreateArea).toHaveBeenCalledWith(expect.objectContaining({
      propertyId: state.properties[0]!.id,
      name: fixedAsset.name,
      polygon: [],
      location: fixedAsset.location,
    })));
  });

  it("plans area and equipment work for a property with no houses", async () => {
    const state = createDemoState();
    state.houses = [];
    state.propertyAreas = [area];
    state.areaEquipment = [equipment];
    state.maintenanceTasks = [];
    const handlers = callbacks();
    handlers.onCreateMaintenanceTask.mockResolvedValue({
      ...areaTask,
      id: "maintenance-land-only",
      houseId: null,
    });

    render(<I18nProvider><PropertyManagementPage state={state} {...handlers} /></I18nProvider>);
    selectArea(/North well/);
    fireEvent.click(screen.getByRole("tab", { name: "Map" }));
    fireEvent.click(screen.getByText("Area equipment & maintenance"));
    fireEvent.change(screen.getByLabelText("Work title"), { target: { value: "Service the well pump" } });
    fireEvent.change(screen.getByLabelText("Equipment (optional)"), { target: { value: equipment.id } });
    fireEvent.click(screen.getByRole("button", { name: "Plan work" }));

    await waitFor(() => expect(handlers.onCreateMaintenanceTask).toHaveBeenCalledWith({
      propertyId: DEMO_PROPERTY_ID,
      houseId: null,
      title: "Service the well pump",
      basis: "scheduled",
      areaId: area.id,
      equipmentId: equipment.id,
    }));
    expect(screen.queryByText(/before planning maintenance/i)).toBeNull();
  });

  it("keeps the scheduling house optional when the property has houses", async () => {
    const state = createDemoState();
    state.propertyAreas = [area];
    const handlers = callbacks();
    handlers.onCreateMaintenanceTask.mockResolvedValue({
      ...areaTask,
      id: "maintenance-with-scheduling-house",
      houseId: state.houses[0]!.id,
      equipmentId: null,
    });

    render(<I18nProvider><PropertyManagementPage state={state} {...handlers} /></I18nProvider>);
    selectArea(/North well/);
    fireEvent.click(screen.getByRole("tab", { name: "Map" }));
    fireEvent.click(screen.getByText("Area equipment & maintenance"));
    const house = screen.getByLabelText(/Home.*Optional/);
    expect((house as HTMLSelectElement).value).toBe("");
    fireEvent.change(house, { target: { value: state.houses[0]!.id } });
    fireEvent.change(screen.getByLabelText("Work title"), { target: { value: "Inspect the well cover" } });
    fireEvent.click(screen.getByRole("button", { name: "Plan work" }));

    await waitFor(() => expect(handlers.onCreateMaintenanceTask).toHaveBeenCalledWith(expect.objectContaining({
      propertyId: DEMO_PROPERTY_ID,
      houseId: state.houses[0]!.id,
      areaId: area.id,
    })));
  });

  it("clears an equipment edit when another area is selected", async () => {
    const state = createDemoState();
    const secondArea: PropertyArea = {
      ...area,
      id: "area-south-field",
      name: "South field",
      kind: "field",
    };
    state.propertyAreas = [area, secondArea];
    state.areaEquipment = [equipment];
    const handlers = callbacks();
    handlers.onCreateEquipment.mockResolvedValue({
      ...equipment,
      id: "equipment-field-pump",
      areaId: secondArea.id,
      name: "Field pump",
    });

    render(<I18nProvider><PropertyManagementPage state={state} {...handlers} /></I18nProvider>);
    selectArea(/North well/);
    fireEvent.click(screen.getByRole("tab", { name: "Map" }));
    fireEvent.click(screen.getByText("Area equipment & maintenance"));
    fireEvent.click(screen.getByRole("button", { name: "Edit inventory item: Well pump" }));
    expect((screen.getByLabelText("Equipment name") as HTMLInputElement).value).toBe("Well pump");

    selectArea(/South field/);
    expect((screen.getByLabelText("Equipment name") as HTMLInputElement).value).toBe("");
    fireEvent.change(screen.getByLabelText("Equipment name"), { target: { value: "Field pump" } });
    fireEvent.change(screen.getByLabelText("Equipment type"), { target: { value: "pump" } });
    fireEvent.click(screen.getByRole("button", { name: "Add equipment" }));

    await waitFor(() => expect(handlers.onCreateEquipment).toHaveBeenCalledWith(expect.objectContaining({
      propertyId: DEMO_PROPERTY_ID,
      areaId: secondArea.id,
      name: "Field pump",
    })));
    expect(handlers.onUpdateEquipment).not.toHaveBeenCalled();
  });

  it("clears note content and target when switching properties", async () => {
    const state = createDemoState();
    const secondProperty = {
      ...state.properties[0]!,
      id: "property-lake",
      name: "Lake estate",
    };
    state.properties = [...state.properties, secondProperty];
    state.propertyAreas = [area];
    state.propertyNotes = [note];
    const handlers = callbacks();
    handlers.onCreateNote.mockResolvedValue({
      ...note,
      id: "note-lake",
      propertyId: secondProperty.id,
      areaId: null,
      text: "Lake property note",
    });

    render(<I18nProvider><PropertyManagementPage state={state} {...handlers} /></I18nProvider>);
    fireEvent.click(screen.getByRole("tab", { name: "Notes" }));
    fireEvent.click(screen.getByRole("button", { name: `Edit layout: ${note.text}` }));
    expect((screen.getByLabelText("Note") as HTMLTextAreaElement).value).toBe(note.text);

    fireEvent.change(screen.getByLabelText("Active property"), { target: { value: secondProperty.id } });
    expect((screen.getByLabelText("Note") as HTMLTextAreaElement).value).toBe("");
    expect((screen.getByLabelText("Attach to") as HTMLSelectElement).value).toBe("property:");
    fireEvent.change(screen.getByLabelText("Note"), { target: { value: "Lake property note" } });
    fireEvent.click(screen.getByRole("button", { name: "Save note" }));

    await waitFor(() => expect(handlers.onCreateNote).toHaveBeenCalledWith({
      propertyId: secondProperty.id,
      kind: "note",
      text: "Lake property note",
      houseId: null,
      areaId: null,
      equipmentId: null,
    }));
    expect(handlers.onUpdateNote).not.toHaveBeenCalled();
  });

  it("uses the active home's property and creates another home with explicit ownership defaults", async () => {
    const state = createDemoState();
    const secondProperty = { ...state.properties[0]!, id: "property-lake", name: "Lake estate" };
    state.properties = [...state.properties, secondProperty];
    const handlers = callbacks();
    handlers.onCreateHouse.mockResolvedValue({
      ...state.houses[0]!, id: "house-lake", name: "Lake home", propertyId: secondProperty.id,
    });

    render(<I18nProvider><PropertyManagementPage state={state} initialPropertyId={secondProperty.id} {...handlers} /></I18nProvider>);

    expect((screen.getByLabelText("Active property") as HTMLSelectElement).value).toBe(secondProperty.id);
    fireEvent.change(screen.getByLabelText("Add a home to this property"), { target: { value: "Lake home" } });
    fireEvent.click(screen.getByRole("button", { name: "Add home" }));

    await waitFor(() => expect(handlers.onCreateHouse).toHaveBeenCalledWith(expect.objectContaining({
      name: "Lake home",
      propertyId: secondProperty.id,
      timezone: expect.any(String),
      floors: [expect.objectContaining({ type: "ground", walls: [], rooms: [], planElements: [] })],
    })));
  });

  it("respects controlled Property selection and exposes keyboard-complete tabs", () => {
    const state = createDemoState();
    const secondProperty = { ...state.properties[0]!, id: "property-lake", name: "Lake estate" };
    state.properties = [...state.properties, secondProperty];
    const onProperty = vi.fn();

    render(<I18nProvider><PropertyManagementPage
      state={state}
      propertyId={secondProperty.id}
      onProperty={onProperty}
      {...callbacks()}
    /></I18nProvider>);

    expect(screen.getByRole("heading", { level: 1, name: secondProperty.name })).toBeTruthy();
    expect(screen.queryByLabelText("Active property")).toBeNull();
    expect(onProperty).not.toHaveBeenCalled();

    const mapTab = screen.getByRole("tab", { name: "Map" });
    const inventoryTab = screen.getByRole("tab", { name: "Inventory" });
    const notesTab = screen.getByRole("tab", { name: "Notes" });
    expect(mapTab.getAttribute("tabindex")).toBe("0");
    expect(notesTab.getAttribute("tabindex")).toBe("-1");
    mapTab.focus();
    fireEvent.keyDown(mapTab, { key: "ArrowRight" });
    expect(inventoryTab.getAttribute("aria-selected")).toBe("true");
    expect(inventoryTab).toBe(document.activeElement);
    fireEvent.keyDown(inventoryTab, { key: "ArrowRight" });
    expect(notesTab.getAttribute("aria-selected")).toBe("true");
    expect(notesTab).toBe(document.activeElement);
    expect(screen.getByRole("tabpanel").getAttribute("aria-labelledby")).toBe(notesTab.id);
  });

  it("keeps a manually selected property when property data refreshes", () => {
    const state = createDemoState();
    const secondProperty = { ...state.properties[0]!, id: "property-lake", name: "Lake estate" };
    state.properties = [...state.properties, secondProperty];
    const handlers = callbacks();
    const view = render(<I18nProvider><PropertyManagementPage
      state={state}
      initialPropertyId={DEMO_PROPERTY_ID}
      {...handlers}
    /></I18nProvider>);

    fireEvent.change(screen.getByLabelText("Active property"), { target: { value: secondProperty.id } });
    expect((screen.getByLabelText("Active property") as HTMLSelectElement).value).toBe(secondProperty.id);

    const refreshedState = {
      ...state,
      properties: state.properties.map((property) => ({ ...property, updatedAt: "2026-07-02T08:00:00.000Z" })),
    };
    view.rerender(<I18nProvider><PropertyManagementPage
      state={refreshedState}
      initialPropertyId={DEMO_PROPERTY_ID}
      {...handlers}
    /></I18nProvider>);

    expect((screen.getByLabelText("Active property") as HTMLSelectElement).value).toBe(secondProperty.id);
  });

  it("loads the map when drawing a new area is requested", async () => {
    const state = createDemoState();
    render(<I18nProvider><PropertyManagementPage state={state} {...callbacks()} /></I18nProvider>);

    expect(screen.getByText("Load the interactive map")).not.toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Add area" }));

    await waitFor(() => expect(screen.queryByText("Load the interactive map")).toBeNull());
    expect(screen.getByRole("button", { name: "Finish drawing" })).not.toBeNull();
  });

  it("does not infer a well's health from an unbound Home connection", () => {
    const state = createDemoState();
    state.alerts = [];
    state.propertyAreas = [area];
    state.areaEquipment = [{
      ...equipment,
      name: "Well Tapo Electric socket connector",
      kind: "smart plug",
      manufacturer: "TP-Link",
      model: "P110",
    }];
    state.integration.tpLink = { ...state.integration.tpLink, configured: true, connected: false };

    render(<I18nProvider><PropertyManagementPage state={state} {...callbacks()} /></I18nProvider>);
    fireEvent.click(screen.getByRole("tab", { name: "Overview" }));

    expect(screen.getByLabelText("Property status")).not.toBeNull();
    expect(screen.getByLabelText(/^Equipment: Check\. No monitored assets are mapped\./)).not.toBeNull();
    expect(screen.getByLabelText(/^Well: Check\. No monitored assets are mapped\./)).not.toBeNull();
    expect(screen.queryByLabelText(/^Infrastructure:/)).toBeNull();
    expect(within(screen.getByLabelText("Property status")).getAllByText(/No monitored assets are mapped\./)).toHaveLength(2);
  });

  it("announces selected areas and identifies equipment and note actions by their target", () => {
    const state = createDemoState();
    const secondArea: PropertyArea = { ...area, id: "area-south-field", name: "South field", kind: "field" };
    const secondEquipment: AreaEquipment = { ...equipment, id: "equipment-generator", name: "Backup generator" };
    const secondNote: PropertyNote = { ...note, id: "note-gate", text: "Gate hinge needs oil." };
    state.propertyAreas = [area, secondArea];
    state.areaEquipment = [equipment, secondEquipment];
    state.propertyNotes = [note, secondNote];

    render(<I18nProvider><PropertyManagementPage state={state} {...callbacks()} /></I18nProvider>);

    const northWell = within(areaNavigation()).getByRole("button", { name: /North well/ });
    const southField = within(areaNavigation()).getByRole("button", { name: /South field/ });
    expect(northWell.getAttribute("aria-pressed")).toBe("false");
    expect(southField.getAttribute("aria-pressed")).toBe("false");
    fireEvent.click(northWell);
    expect(northWell.getAttribute("aria-pressed")).toBe("true");
    expect(southField.getAttribute("aria-pressed")).toBe("false");

    fireEvent.click(screen.getByRole("tab", { name: "Map" }));
    fireEvent.click(screen.getByText("Area equipment & maintenance"));
    expect(screen.getByRole("button", { name: "Edit inventory item: Well pump" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Delete: Well pump" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Edit inventory item: Backup generator" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Delete: Backup generator" })).toBeTruthy();

    fireEvent.click(screen.getByRole("tab", { name: "Notes" }));
    expect(screen.getByRole("button", { name: `Edit layout: ${note.text}` })).toBeTruthy();
    expect(screen.getByRole("button", { name: `Delete: ${note.text}` })).toBeTruthy();
    expect(screen.getByRole("button", { name: `Edit layout: ${secondNote.text}` })).toBeTruthy();
    expect(screen.getByRole("button", { name: `Delete: ${secondNote.text}` })).toBeTruthy();
  });

  it("confirms and moves a home to another property", async () => {
    const state = createDemoState();
    const secondProperty = { ...state.properties[0]!, id: "property-lake", name: "Lake estate" };
    state.properties = [...state.properties, secondProperty];
    const handlers = callbacks();
    handlers.onUpdateHouse.mockResolvedValue({ ...state.houses[0]!, propertyId: secondProperty.id });
    const confirm = vi.spyOn(window, "confirm").mockReturnValue(true);

    render(<I18nProvider><PropertyManagementPage state={state} {...handlers} /></I18nProvider>);
    fireEvent.change(screen.getByLabelText("Move to property"), { target: { value: secondProperty.id } });

    await waitFor(() => expect(handlers.onUpdateHouse).toHaveBeenCalledWith(state.houses[0]!.id, {
      propertyId: secondProperty.id,
    }));
    expect(confirm).toHaveBeenCalledWith(expect.stringContaining(state.houses[0]!.name));
  });

  it("moves an area aggregate to another property", async () => {
    const state = createDemoState();
    const secondProperty = { ...state.properties[0]!, id: "property-lake", name: "Lake estate" };
    state.properties = [...state.properties, secondProperty];
    state.propertyAreas = [area];
    const handlers = callbacks();
    handlers.onUpdateArea.mockResolvedValue({ ...area, propertyId: secondProperty.id });
    vi.spyOn(window, "confirm").mockReturnValue(true);

    render(<I18nProvider><PropertyManagementPage state={state} {...handlers} /></I18nProvider>);
    await waitFor(() => expect((screen.getByLabelText("Active property") as HTMLSelectElement).value).toBe(DEMO_PROPERTY_ID));
    selectArea(/North well/);
    fireEvent.change(await screen.findByLabelText(/Move area to property/), { target: { value: secondProperty.id } });
    fireEvent.click(screen.getByRole("button", { name: "Save area" }));

    await waitFor(() => expect(handlers.onUpdateArea).toHaveBeenCalledWith(area.id, expect.objectContaining({
      propertyId: secondProperty.id,
      name: area.name,
      polygon: area.polygon,
    })));
  });

  it("moves equipment between areas and properties", async () => {
    const state = createDemoState();
    const secondProperty = { ...state.properties[0]!, id: "property-lake", name: "Lake estate" };
    const secondArea: PropertyArea = { ...area, id: "area-lake", propertyId: secondProperty.id, name: "Lake shore" };
    state.properties = [...state.properties, secondProperty];
    state.propertyAreas = [area, secondArea];
    state.areaEquipment = [equipment];
    const handlers = callbacks();
    handlers.onUpdateEquipment.mockResolvedValue({ ...equipment, propertyId: secondProperty.id, areaId: secondArea.id });
    vi.spyOn(window, "confirm").mockReturnValue(true);

    render(<I18nProvider><PropertyManagementPage state={state} {...handlers} /></I18nProvider>);
    await waitFor(() => expect((screen.getByLabelText("Active property") as HTMLSelectElement).value).toBe(DEMO_PROPERTY_ID));
    selectArea(/North well/);
    fireEvent.click(screen.getByRole("tab", { name: "Map" }));
    fireEvent.click(screen.getByText("Area equipment & maintenance"));
    expect(screen.getAllByText("Well pump").length).toBeGreaterThan(0);
    fireEvent.click(screen.getByRole("button", { name: "Edit inventory item: Well pump" }));
    await waitFor(() => expect(screen.getAllByLabelText(/Expected location/)).toHaveLength(2));
    fireEvent.change(screen.getAllByLabelText(/Expected location/)[1]!, { target: { value: `area:${secondArea.id}` } });
    fireEvent.click(screen.getByRole("button", { name: "Save equipment" }));

    await waitFor(() => expect(handlers.onUpdateEquipment).toHaveBeenCalledWith(equipment.id, expect.objectContaining({
      areaId: secondArea.id,
      name: equipment.name,
      kind: equipment.kind,
    })));
  });

  it("keeps guest property, area, equipment, and note views read-only", () => {
    const state = createDemoState();
    state.session = {
      authenticated: true,
      principal: { type: "local", email: "guest@example.test" },
      tenant: { id: "local", name: "Local Stuga", role: "guest" },
      availableTenants: [{ id: "local", name: "Local Stuga", role: "guest" }],
      readOnly: true,
      grants: [{ scopeType: "property", scopeId: DEMO_PROPERTY_ID }],
    };
    state.propertyAreas = [area];
    state.areaEquipment = [equipment];
    state.propertyNotes = [note];
    state.maintenanceTasks = [areaTask, equipmentOnlyTask];
    state.houses = [];
    const handlers = callbacks();

    render(<I18nProvider><PropertyManagementPage state={state} {...handlers} /></I18nProvider>);

    expect(screen.getByText("Guest access")).not.toBeNull();
    expect(screen.queryByRole("button", { name: "Draw area" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Add area" })).toBeNull();
    expect(screen.queryByRole("tab", { name: "Access" })).toBeNull();

    fireEvent.click(screen.getByRole("tab", { name: "Inventory" }));
    expect(screen.getByRole("heading", { name: "Well pump" })).not.toBeNull();
    expect(screen.queryByRole("button", { name: "Add inventory item" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Edit inventory item: Well pump" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Delete: Well pump" })).toBeNull();

    fireEvent.click(screen.getByRole("tab", { name: "Map" }));
    selectArea(/North well/);
    fireEvent.click(screen.getByText("Area equipment & maintenance"));
    expect(screen.getAllByText("Well pump").length).toBeGreaterThan(0);
    expect(screen.getByText("Service well pump")).not.toBeNull();
    expect(screen.getByText("Test pump pressure")).not.toBeNull();
    expect(screen.getByText(/Guest access is read-only/)).not.toBeNull();
    expect(screen.queryByRole("button", { name: "Add equipment" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Plan work" })).toBeNull();

    fireEvent.click(screen.getByRole("tab", { name: "Notes" }));
    expect(screen.getByText("Water sample passed inspection.")).not.toBeNull();
    expect(screen.queryByText("Record property context")).toBeNull();
    expect(handlers.onCreateArea).not.toHaveBeenCalled();
  });

  it("reports note deletion failures instead of leaving an unhandled rejection", async () => {
    const state = createDemoState();
    state.propertyNotes = [note];
    const handlers = callbacks();
    handlers.onDeleteNote.mockRejectedValue(new Error("offline"));
    vi.spyOn(window, "confirm").mockReturnValue(true);

    render(<I18nProvider><PropertyManagementPage state={state} {...handlers} /></I18nProvider>);
    fireEvent.click(screen.getByRole("tab", { name: "Notes" }));
    fireEvent.click(screen.getByRole("button", { name: `Delete: ${note.text}` }));

    await waitFor(() => expect(handlers.onDeleteNote).toHaveBeenCalledWith(note.id));
    expect(await screen.findByText("The note could not be deleted.")).toBeTruthy();
  });

  it("drops a scheduling house that moves outside the selected property", async () => {
    const state = createDemoState();
    state.propertyAreas = [area];
    const handlers = callbacks();
    handlers.onCreateMaintenanceTask.mockResolvedValue({ ...areaTask, houseId: null });
    const view = render(<I18nProvider><PropertyManagementPage state={state} {...handlers} /></I18nProvider>);
    selectArea(/North well/);
    fireEvent.click(screen.getByRole("tab", { name: "Map" }));
    fireEvent.click(screen.getByText("Area equipment & maintenance"));
    fireEvent.change(screen.getByLabelText(/Home.*Optional/), { target: { value: state.houses[0]!.id } });

    const movedState = {
      ...state,
      properties: [...state.properties, { ...state.properties[0]!, id: "property-other", name: "Other estate" }],
      houses: state.houses.map((house) => ({ ...house, propertyId: "property-other" })),
    };
    view.rerender(<I18nProvider><PropertyManagementPage state={movedState} {...handlers} /></I18nProvider>);
    fireEvent.change(screen.getByLabelText("Work title"), { target: { value: "Inspect boundary" } });
    fireEvent.click(screen.getByRole("button", { name: "Plan work" }));

    await waitFor(() => expect(handlers.onCreateMaintenanceTask).toHaveBeenCalledWith(expect.objectContaining({
      propertyId: DEMO_PROPERTY_ID,
      houseId: null,
    })));
  });

  it("shows, copies, and rotates the one-time Guest activation link", async () => {
    const state = createDemoState();
    state.session = {
      authenticated: true,
      principal: { type: "local", email: "owner@example.test" },
      tenant: { id: "local", name: "Local Stuga", role: "owner" },
      availableTenants: [{ id: "local", name: "Local Stuga", role: "owner" }],
      readOnly: false,
      grants: [],
    };
    vi.spyOn(api, "tenantMembers").mockResolvedValue({ members: [], invitations: [] });
    const inviteGuest = vi.spyOn(api, "inviteGuest")
      .mockResolvedValueOnce({
        invitation: { email: "guest@example.test", role: "guest", grants: [], invitedAt: "2026-07-16T08:00:00.000Z" },
        registrationToken: "first_activation_token_abcdefghijklmnopqrstuvwxyz",
        activationPath: "/invite-bootstrap#invite=first_activation_token_abcdefghijklmnopqrstuvwxyz",
        expiresAt: "2026-07-23T08:00:00.000Z",
      })
      .mockResolvedValueOnce({
        invitation: { email: "guest@example.test", role: "guest", grants: [], invitedAt: "2026-07-16T09:00:00.000Z" },
        registrationToken: "second_activation_token_abcdefghijklmnopqrstuvwxyz",
        activationPath: "/invite-bootstrap#invite=second_activation_token_abcdefghijklmnopqrstuvwxyz",
        expiresAt: "2026-07-23T09:00:00.000Z",
      });
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, "clipboard", { configurable: true, value: { writeText } });

    render(<I18nProvider><PeopleAccessPage state={state} /></I18nProvider>);
    await screen.findByText("No guest accounts have been invited.");

    fireEvent.change(screen.getByLabelText("Guest email address"), { target: { value: "guest@example.test" } });
    fireEvent.click(screen.getByRole("button", { name: "Invite guest" }));
    const activation = await screen.findByLabelText("Activation link") as HTMLInputElement;
    expect(activation.value).toContain("/invite-bootstrap#invite=first_activation_token_abcdefghijklmnopqrstuvwxyz");
    expect(activation.value).not.toContain("?token=");
    fireEvent.click(screen.getByRole("button", { name: "Copy link" }));
    await waitFor(() => expect(writeText).toHaveBeenCalledWith(activation.value));

    fireEvent.change(screen.getByLabelText("Guest email address"), { target: { value: "guest@example.test" } });
    fireEvent.click(screen.getByRole("button", { name: "Invite guest" }));
    await waitFor(() => expect((screen.getByLabelText("Activation link") as HTMLInputElement).value).toContain("/invite-bootstrap#invite=second_activation_token_abcdefghijklmnopqrstuvwxyz"));
    expect(inviteGuest).toHaveBeenCalledTimes(2);
  });

  it("shows the local admin grant tree and saves property, house, and area grants", async () => {
    const state = createDemoState();
    state.session = {
      authenticated: true,
      principal: { type: "local", email: "admin@example.test" },
      tenant: { id: "local", name: "Local Stuga", role: "admin" },
      availableTenants: [{ id: "local", name: "Local Stuga", role: "admin" }],
      readOnly: false,
      grants: [],
    };
    state.propertyAreas = [area];
    const guest: TenantMemberSummary = {
      email: "guest@example.test",
      role: "guest",
      joinedAt: "2026-07-01T08:00:00.000Z",
      grants: [
        { scopeType: "property", scopeId: DEMO_PROPERTY_ID },
        { scopeType: "house", scopeId: "house-pine" },
        { scopeType: "area", scopeId: area.id },
      ],
    };
    vi.spyOn(api, "tenantMembers").mockResolvedValue({ members: [guest], invitations: [] });
    const updateAccess = vi.spyOn(api, "updateMemberAccess").mockImplementation(async (_email, grants) => ({ email: guest.email, role: "guest", grants }));
    const removeMember = vi.spyOn(api, "removeTenantMember").mockResolvedValue(undefined);

    render(<I18nProvider><PeopleAccessPage state={state} /></I18nProvider>);

    expect((await screen.findAllByText("guest@example.test")).length).toBeGreaterThan(0);
    const propertyGrant = screen.getByRole("checkbox", { name: "Pine Estate" });
    const houseGrant = screen.getByRole("checkbox", { name: "Pine House" });
    const areaGrant = screen.getByRole("checkbox", { name: "North well" });
    await waitFor(() => expect((propertyGrant as HTMLInputElement).checked).toBe(true));
    expect((houseGrant as HTMLInputElement).checked).toBe(true);
    expect((areaGrant as HTMLInputElement).checked).toBe(true);
    expect((houseGrant as HTMLInputElement).disabled).toBe(true);
    expect((areaGrant as HTMLInputElement).disabled).toBe(true);

    fireEvent.click(propertyGrant);
    expect((houseGrant as HTMLInputElement).checked).toBe(false);
    expect((areaGrant as HTMLInputElement).checked).toBe(false);
    expect((houseGrant as HTMLInputElement).disabled).toBe(false);
    expect((areaGrant as HTMLInputElement).disabled).toBe(false);
    fireEvent.click(houseGrant);
    fireEvent.click(areaGrant);
    fireEvent.click(screen.getByRole("button", { name: "Save access" }));
    await waitFor(() => expect(updateAccess).toHaveBeenCalledWith("guest@example.test", [
      { scopeType: "house", scopeId: "house-pine" },
      { scopeType: "area", scopeId: area.id },
    ]));
    expect(screen.getByText("Active guest")).not.toBeNull();

    fireEvent.click(screen.getByRole("button", { name: "Remove guest" }));
    expect(removeMember).not.toHaveBeenCalled();
    expect(screen.getByText("Remove guest access for guest@example.test? Their grants to this workspace will be cleared.")).not.toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    expect(screen.queryByRole("button", { name: "Confirm removal" })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Remove guest" }));
    fireEvent.click(screen.getByRole("button", { name: "Confirm removal" }));
    await waitFor(() => expect(removeMember).toHaveBeenCalledWith("guest@example.test"));
    expect(screen.getByText("Guest access removed.")).not.toBeNull();
  });

  it("enforces the local 100-scope limit while allowing a property grant to compress children", async () => {
    const state = createDemoState();
    state.session = {
      authenticated: true,
      principal: { type: "local", email: "owner@example.test" },
      tenant: { id: "local", name: "Local Stuga", role: "owner" },
      availableTenants: [{ id: "local", name: "Local Stuga", role: "owner" }],
      readOnly: false,
      grants: [],
    };
    state.propertyAreas = Array.from({ length: 101 }, (_, index): PropertyArea => ({
      ...area,
      id: `area-${index}`,
      name: `Area ${index}`,
    }));
    const guest: TenantMemberSummary = {
      email: "guest@example.test",
      role: "guest",
      grants: state.propertyAreas.slice(0, 100).map((candidate) => ({ scopeType: "area" as const, scopeId: candidate.id })),
    };
    vi.spyOn(api, "tenantMembers").mockResolvedValue({ members: [guest], invitations: [] });
    const updateAccess = vi.spyOn(api, "updateMemberAccess").mockImplementation(async (_email, grants) => ({
      email: guest.email,
      role: "guest",
      grants,
    }));

    render(<I18nProvider><PeopleAccessPage state={state} /></I18nProvider>);
    await screen.findByText("Selected access scopes: 100 of 100.");

    expect((screen.getByRole("checkbox", { name: "Area 100" }) as HTMLInputElement).disabled).toBe(true);
    fireEvent.click(screen.getByRole("checkbox", { name: "Pine Estate" }));
    expect(screen.getByText("Selected access scopes: 1 of 100.")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Save access" }));

    await waitFor(() => expect(updateAccess).toHaveBeenCalledWith("guest@example.test", [
      { scopeType: "property", scopeId: DEMO_PROPERTY_ID },
    ]));
  });

  it("exposes guest administration in a local admin session", () => {
    const state = createDemoState();
    state.session = {
      ...state.session,
      principal: { type: "local", email: null },
      tenant: { id: "local", name: "Local Stuga", role: "admin" },
      availableTenants: [{ id: "local", name: "Local Stuga", role: "admin" }],
    };
    render(<I18nProvider><PropertyManagementPage state={state} {...callbacks()} /></I18nProvider>);
    expect(screen.getByRole("tab", { name: "Access" })).toBeTruthy();
  });
});
