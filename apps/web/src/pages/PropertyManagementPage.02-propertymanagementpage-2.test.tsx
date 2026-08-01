import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

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
import { confirmAction } from "../components/ConfirmationProvider";

import { createDemoState, DEMO_PROPERTY_ID } from "../domain";

import { I18nProvider } from "../i18n";

import { PeopleAccessPage } from "./PeopleAccessPage";

import { PropertyManagementPage } from "./PropertyManagementPage";

import propertyStyles from "./PropertyManagementPage.css?raw";

import { area, areaNavigation, areaTask, callbacks, enabledTrackingCapabilities, equipment, equipmentOnlyTask, note, originalClipboard, selectArea } from "./PropertyManagementPageTestSupport";

vi.mock("../components/ConfirmationProvider", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../components/ConfirmationProvider")>();
  return { ...actual, confirmAction: vi.fn().mockResolvedValue(true) };
});

beforeEach(() => vi.mocked(confirmAction).mockReset().mockResolvedValue(true));

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
    fireEvent.click(screen.getByRole("button", { name: `Edit: ${note.text}` }));
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

  it("shows a direct first-Home form for a Property with no Homes and preserves explicit ownership defaults", async () => {
    const state = createDemoState();
    const secondProperty = { ...state.properties[0]!, id: "property-lake", name: "Lake estate" };
    state.properties = [...state.properties, secondProperty];
    const handlers = callbacks();
    handlers.onCreateHouse.mockResolvedValue({
      ...state.houses[0]!, id: "house-lake", name: "Lake home", propertyId: secondProperty.id,
    });

    render(<I18nProvider><PropertyManagementPage state={state} initialPropertyId={secondProperty.id} {...handlers} /></I18nProvider>);

    expect((screen.getByLabelText("Active property") as HTMLSelectElement).value).toBe(secondProperty.id);
    expect(screen.queryByText("Add home", { selector: "summary strong" })).toBeNull();
    const firstHomeName = screen.getByLabelText("Home name");
    expect(firstHomeName.closest(".property-overview-first-home")).not.toBeNull();
    fireEvent.change(firstHomeName, { target: { value: "Lake home" } });
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

  it("opens the map workspace when Add area is requested from the overview", async () => {
    const state = createDemoState();
    const onTab = vi.fn();
    render(<I18nProvider><PropertyManagementPage
      state={state}
      initialTab="overview"
      onTab={onTab}
      {...callbacks()}
    /></I18nProvider>);

    expect(screen.getByRole("tab", { name: "Overview" }).getAttribute("aria-selected")).toBe("true");
    fireEvent.click(screen.getByRole("button", { name: "Add area" }));

    await waitFor(() => expect(screen.getByRole("tab", { name: "Map" }).getAttribute("aria-selected")).toBe("true"));
    expect(onTab).toHaveBeenCalledWith("map");
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

  it("keeps the Property overview calm and puts configuration behind one disclosure", () => {
    const state = createDemoState();
    const home = state.houses[0]!;
    const openHome = vi.fn();
    const { container } = render(<I18nProvider><PropertyManagementPage
      state={state}
      initialTab="overview"
      onOpenHouse={openHome}
      {...callbacks()}
    /></I18nProvider>);

    const overview = screen.getByRole("tabpanel", { name: "Overview" });
    expect(within(overview).getByRole("heading", { name: "At a glance" })).not.toBeNull();
    fireEvent.click(within(overview).getByRole("button", { name: `Open ${home.name}` }));
    expect(openHome).toHaveBeenCalledWith(home.id);
    expect(container.querySelector(".property-sidebar")).toBeNull();
    expect(container.querySelector(".property-overview-actions")).toBeNull();
    expect(container.querySelector<HTMLDetailsElement>(".property-overview-status")?.open).toBe(false);

    const manage = screen.getByText("Manage property", { selector: "summary strong" }).closest("details")!;
    expect(manage.open).toBe(false);
    fireEvent.click(manage.querySelector("summary")!);
    expect(manage.open).toBe(true);
    expect(within(manage).getByRole("button", { name: "Edit property" })).not.toBeNull();
    expect(within(manage).getByRole("button", { name: "Add area" })).not.toBeNull();
    expect(within(manage).getByText("Add home", { selector: "summary strong" })).not.toBeNull();
    expect(within(manage).getByText("Add property", { selector: "summary strong" })).not.toBeNull();
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
    expect(screen.getByRole("button", { name: `Edit: ${note.text}` })).toBeTruthy();
    expect(screen.getByRole("button", { name: `Delete: ${note.text}` })).toBeTruthy();
    expect(screen.getByRole("button", { name: `Edit: ${secondNote.text}` })).toBeTruthy();
    expect(screen.getByRole("button", { name: `Delete: ${secondNote.text}` })).toBeTruthy();
  });

  it("confirms and moves a home to another property", async () => {
    const state = createDemoState();
    const secondProperty = { ...state.properties[0]!, id: "property-lake", name: "Lake estate" };
    state.properties = [...state.properties, secondProperty];
    const handlers = callbacks();
    handlers.onUpdateHouse.mockResolvedValue({ ...state.houses[0]!, propertyId: secondProperty.id });
    render(<I18nProvider><PropertyManagementPage state={state} {...handlers} /></I18nProvider>);
    fireEvent.change(screen.getByLabelText("Move to property"), { target: { value: secondProperty.id } });

    await waitFor(() => expect(handlers.onUpdateHouse).toHaveBeenCalledWith(state.houses[0]!.id, {
      propertyId: secondProperty.id,
    }));
    expect(confirmAction).toHaveBeenCalledWith(expect.stringContaining(state.houses[0]!.name), "Move", false);
  });

  it("moves an area aggregate to another property", async () => {
    const state = createDemoState();
    const secondProperty = { ...state.properties[0]!, id: "property-lake", name: "Lake estate" };
    state.properties = [...state.properties, secondProperty];
    state.propertyAreas = [area];
    const handlers = callbacks();
    handlers.onUpdateArea.mockResolvedValue({ ...area, propertyId: secondProperty.id });
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
      tenant: { id: "local", name: "Local Stugu", role: "guest" },
      availableTenants: [{ id: "local", name: "Local Stugu", role: "guest" }],
      readOnly: true,
      grants: [{ scopeType: "property", scopeId: DEMO_PROPERTY_ID }],
    };
    state.propertyAreas = [area];
    state.areaEquipment = [equipment];
    state.propertyNotes = [note];
    state.maintenanceTasks = [areaTask, equipmentOnlyTask];
    state.houses = [];
    const handlers = callbacks();

    render(<I18nProvider><PropertyManagementPage state={state} initialTab="access" {...handlers} /></I18nProvider>);

    expect(screen.getByText("Guest access")).not.toBeNull();
    expect(screen.getByRole("tab", { name: "Overview" }).getAttribute("aria-selected")).toBe("true");
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
      tenant: { id: "local", name: "Local Stugu", role: "owner" },
      availableTenants: [{ id: "local", name: "Local Stugu", role: "owner" }],
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

    fireEvent.click(screen.getByText("Add a guest"));
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
});
