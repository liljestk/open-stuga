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
import { ConfirmationProvider } from "../components/ConfirmationProvider";

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
  it("shows the local admin grant tree and saves property, house, and area grants", async () => {
    const state = createDemoState();
    state.session = {
      authenticated: true,
      principal: { type: "local", email: "admin@example.test" },
      tenant: { id: "local", name: "Local Stugu", role: "admin" },
      availableTenants: [{ id: "local", name: "Local Stugu", role: "admin" }],
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

    render(<I18nProvider><ConfirmationProvider><PeopleAccessPage state={state} /></ConfirmationProvider></I18nProvider>);

    expect((await screen.findAllByText("guest@example.test")).length).toBeGreaterThan(0);
    expect(screen.queryByRole("checkbox", { name: "Pine Estate" })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: /guest@example\.test/ }));
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

    const removeTrigger = screen.getByRole("button", { name: "Remove guest" });
    removeTrigger.focus();
    fireEvent.click(removeTrigger);
    expect(removeMember).not.toHaveBeenCalled();
    let dialog = screen.getByRole("dialog");
    expect(within(dialog).getByText("Remove guest access for guest@example.test? Their grants to this workspace will be cleared.")).not.toBeNull();
    fireEvent.click(within(dialog).getByRole("button", { name: "Cancel" }));
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(removeTrigger).toHaveFocus();
    fireEvent.click(removeTrigger);
    dialog = screen.getByRole("dialog");
    fireEvent.click(within(dialog).getByRole("button", { name: "Remove guest access" }));
    await waitFor(() => expect(removeMember).toHaveBeenCalledWith("guest@example.test"));
    expect(screen.getByText("Guest access removed.")).not.toBeNull();
  });

  it("enforces the local 100-scope limit while allowing a property grant to compress children", async () => {
    const state = createDemoState();
    state.session = {
      authenticated: true,
      principal: { type: "local", email: "owner@example.test" },
      tenant: { id: "local", name: "Local Stugu", role: "owner" },
      availableTenants: [{ id: "local", name: "Local Stugu", role: "owner" }],
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
    await screen.findByRole("button", { name: /guest@example\.test/ });
    fireEvent.click(screen.getByRole("button", { name: /guest@example\.test/ }));
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
      tenant: { id: "local", name: "Local Stugu", role: "admin" },
      availableTenants: [{ id: "local", name: "Local Stugu", role: "admin" }],
    };
    render(<I18nProvider><PropertyManagementPage state={state} {...callbacks()} /></I18nProvider>);
    expect(screen.getByRole("tab", { name: "Access" })).toBeTruthy();
  });

  it("labels and preserves retained equipment and notes from a hidden Home", async () => {
    const state = createDemoState();
    const hiddenHouse = state.houses[0]!;
    const retainedEquipment: AreaEquipment = {
      ...equipment,
      id: "equipment-hidden-home",
      areaId: null,
      houseId: hiddenHouse.id,
      name: "Retained boiler",
    };
    const retainedNote: PropertyNote = {
      ...note,
      id: "note-hidden-home",
      houseId: hiddenHouse.id,
      areaId: null,
      text: "Retained service history.",
    };
    state.houses = [];
    state.propertyAreas = [];
    state.areaEquipment = [retainedEquipment];
    state.propertyNotes = [retainedNote];
    const handlers = callbacks();
    handlers.onUpdateEquipment.mockResolvedValue(retainedEquipment);

    render(<I18nProvider><PropertyManagementPage state={state} {...handlers} /></I18nProvider>);

    fireEvent.click(screen.getByRole("tab", { name: "Inventory" }));
    fireEvent.click(screen.getByRole("button", { name: "Edit inventory item: Retained boiler" }));
    const equipmentLocation = within(document.querySelector(".inventory-form")!).getAllByRole("combobox")[0] as HTMLSelectElement;
    expect(equipmentLocation.value).toBe(`house:${hiddenHouse.id}`);
    expect(equipmentLocation.selectedOptions[0]?.textContent).toBe("Hidden Home");
    fireEvent.click(screen.getByRole("button", { name: "Save equipment" }));
    await waitFor(() => expect(handlers.onUpdateEquipment).toHaveBeenCalledWith(retainedEquipment.id, expect.objectContaining({
      houseId: hiddenHouse.id,
      areaId: null,
    })));

    fireEvent.click(screen.getByRole("tab", { name: "Notes" }));
    expect(screen.getByText("Hidden Home")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: `Edit: ${retainedNote.text}` }));
    const noteTarget = screen.getByLabelText("Attach to") as HTMLSelectElement;
    expect(noteTarget.value).toBe(`house:${hiddenHouse.id}`);
    expect(noteTarget.selectedOptions[0]?.textContent).toBe("Hidden Home");
    fireEvent.click(screen.getByRole("button", { name: "Save note" }));
    await waitFor(() => expect(handlers.onUpdateNote).toHaveBeenCalledWith(retainedNote.id, expect.objectContaining({
      houseId: hiddenHouse.id,
      areaId: null,
      equipmentId: null,
    })));
  });
});
