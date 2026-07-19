import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { AreaEquipment, MaintenanceTask, PropertyArea, PropertyNote, TenantMemberSummary } from "@climate-twin/contracts";
import { api } from "../api";
import { createDemoState, DEMO_PROPERTY_ID } from "../domain";
import { I18nProvider } from "../i18n";
import { PeopleAccessPage } from "./PeopleAccessPage";
import { PropertyManagementPage } from "./PropertyManagementPage";
import propertyStyles from "./PropertyManagementPage.css?raw";

const originalClipboard = navigator.clipboard;

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
    expect(within(homeList).getByRole("button").getAttribute("draggable")).toBe("true");
    expect(container.querySelector<HTMLDetailsElement>(".property-placement-advanced")?.open).toBe(false);

    selectArea(/North well/);
    const secondaryTools = container.querySelector<HTMLDetailsElement>(".property-secondary-tools")!;
    expect(secondaryTools.open).toBe(false);
    expect(within(secondaryTools).getByText("Area equipment & maintenance")).not.toBeNull();
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
    fireEvent.click(screen.getByRole("button", { name: "Edit layout: Well pump" }));
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
    const notesTab = screen.getByRole("tab", { name: "Notes" });
    expect(mapTab.getAttribute("tabindex")).toBe("0");
    expect(notesTab.getAttribute("tabindex")).toBe("-1");
    mapTab.focus();
    fireEvent.keyDown(mapTab, { key: "ArrowRight" });
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
    expect(screen.getByRole("button", { name: "Edit layout: Well pump" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Delete: Well pump" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Edit layout: Backup generator" })).toBeTruthy();
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
    fireEvent.click(screen.getByRole("button", { name: "Edit layout: Well pump" }));
    fireEvent.change(await screen.findByLabelText(/Installed in area/), { target: { value: secondArea.id } });
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

    selectArea(/North well/);
    fireEvent.click(screen.getByRole("tab", { name: "Map" }));
    fireEvent.click(screen.getByText("Area equipment & maintenance"));
    expect(screen.getByText("Well pump")).not.toBeNull();
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
        activationPath: "/#invite=first_activation_token_abcdefghijklmnopqrstuvwxyz",
        expiresAt: "2026-07-23T08:00:00.000Z",
      })
      .mockResolvedValueOnce({
        invitation: { email: "guest@example.test", role: "guest", grants: [], invitedAt: "2026-07-16T09:00:00.000Z" },
        registrationToken: "second_activation_token_abcdefghijklmnopqrstuvwxyz",
        activationPath: "/#invite=second_activation_token_abcdefghijklmnopqrstuvwxyz",
        expiresAt: "2026-07-23T09:00:00.000Z",
      });
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, "clipboard", { configurable: true, value: { writeText } });

    render(<I18nProvider><PeopleAccessPage state={state} /></I18nProvider>);
    await screen.findByText("No guest accounts have been invited.");

    fireEvent.change(screen.getByLabelText("Guest email address"), { target: { value: "guest@example.test" } });
    fireEvent.click(screen.getByRole("button", { name: "Invite guest" }));
    const activation = await screen.findByLabelText("Activation link") as HTMLInputElement;
    expect(activation.value).toContain("/#invite=first_activation_token_abcdefghijklmnopqrstuvwxyz");
    expect(activation.value).not.toContain("?token=");
    fireEvent.click(screen.getByRole("button", { name: "Copy link" }));
    await waitFor(() => expect(writeText).toHaveBeenCalledWith(activation.value));

    fireEvent.change(screen.getByLabelText("Guest email address"), { target: { value: "guest@example.test" } });
    fireEvent.click(screen.getByRole("button", { name: "Invite guest" }));
    await waitFor(() => expect((screen.getByLabelText("Activation link") as HTMLInputElement).value).toContain("/#invite=second_activation_token_abcdefghijklmnopqrstuvwxyz"));
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
    vi.spyOn(window, "confirm").mockReturnValue(true);

    render(<I18nProvider><PeopleAccessPage state={state} /></I18nProvider>);

    expect((await screen.findAllByText("guest@example.test")).length).toBeGreaterThan(0);
    const propertyGrant = screen.getByRole("checkbox", { name: "Pine Estate" });
    const houseGrant = screen.getByRole("checkbox", { name: "Pine House" });
    const areaGrant = screen.getByRole("checkbox", { name: "North well" });
    expect((propertyGrant as HTMLInputElement).checked).toBe(true);
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
