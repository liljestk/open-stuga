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

import { area, areaNavigation, areaTask, callbacks, enabledTrackingCapabilities, equipment, equipmentOnlyTask, note, originalClipboard, selectArea } from "./PropertyManagementPageTestSupport";

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

  it("shows the Stuguby mark only on foreign shared Homes", () => {
    const state = createDemoState();
    const home = state.houses[0]!;
    state.houses = [
      {
        ...home,
        name: "My Home",
        stuguby: {
          stugubyId: "stuguby-1",
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
        stuguby: {
          stugubyId: "stuguby-1",
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
    expect(ownHome.querySelector(".stuguby-mark")).toBeNull();
    expect(ownHome.classList.contains("stuguby-shared")).toBe(false);
    expect(foreignHome.querySelector(".stuguby-mark")).not.toBeNull();
    expect(foreignHome.classList.contains("stuguby-shared")).toBe(true);

    const placementHomes = container.querySelector<HTMLElement>(".property-placement-house-list")!;
    expect(within(placementHomes).getByText("My Home").closest("button")?.querySelector(".stuguby-mark")).toBeNull();
    expect(within(placementHomes).getByText("Foreign Home").closest("button")?.querySelector(".stuguby-mark")).not.toBeNull();
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
    vi.spyOn(api, "trackedEquipment").mockResolvedValue([]);

    const { rerender } = render(<I18nProvider><PropertyManagementPage state={state} {...handlers} /></I18nProvider>);
    fireEvent.click(screen.getByRole("tab", { name: "Inventory" }));

    expect(screen.getByRole("heading", { name: "Well pump" })).not.toBeNull();
    expect(screen.getByText("PUMP-001")).not.toBeNull();
    expect(screen.getByRole("button", { name: "Edit inventory item: Well pump" })).not.toBeNull();
    await waitFor(() => expect(api.trackedEquipment).toHaveBeenCalledTimes(1));
    rerender(<I18nProvider><PropertyManagementPage
      state={{ ...state, areaEquipment: state.areaEquipment.map((item) => ({ ...item })) }}
      {...handlers}
    /></I18nProvider>);
    expect(api.trackedEquipment).toHaveBeenCalledTimes(1);
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
    vi.spyOn(api, "trackedEquipment").mockResolvedValue([]);

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
      dataMode: "demo",
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
        observationRetentionDays: 30,
        rollupRetentionDays: 180,
        estimateRetentionDays: 365,
        updatedAt: new Date().toISOString(),
      },
      zones: [],
      gateways: [],
      equipment: [],
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
      const trackedEquipment = vi.spyOn(api, "trackedEquipment").mockRejectedValue(
        new ApiRequestError(404, "TRACKING_DISABLED", "Equipment tracking is not enabled"),
      );
      const { unmount } = render(
        <I18nProvider><PropertyManagementPage state={state} {...callbacks()} /></I18nProvider>,
      );
      fireEvent.click(screen.getByRole("tab", { name: "Inventory" }));
      await vi.waitFor(() => expect(trackedEquipment).toHaveBeenCalledTimes(1));
      await vi.advanceTimersByTimeAsync(90_000);
      expect(trackedEquipment).toHaveBeenCalledTimes(1);
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
    expect(await screen.findByText("Home placement and scale saved.")).not.toBeNull();
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
});
