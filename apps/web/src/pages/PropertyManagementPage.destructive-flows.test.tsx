import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type {
  EquipmentAttachment,
  EquipmentLink,
  PropertyArea,
  TrackedEquipmentState,
  TrackingEndpoint,
} from "@climate-twin/contracts";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { api } from "../api";
import { ConfirmationProvider } from "../components/ConfirmationProvider";
import { createDemoState, DEMO_PROPERTY_ID } from "../domain";
import { I18nProvider } from "../i18n";
import { PropertyManagementPage } from "./PropertyManagementPage";
import {
  area,
  callbacks,
  enabledTrackingCapabilities,
  equipment,
  selectArea,
} from "./PropertyManagementPageTestSupport";

vi.mock("../components/PropertyAreaMap", () => ({
  PropertyAreaMap: ({ ariaLabel }: { ariaLabel: string }) => <div role="region" aria-label={ariaLabel} />,
}));

vi.mock("../components/HouseLocationMap", () => ({
  HouseLocationMap: ({ ariaLabel }: { ariaLabel: string }) => <div role="region" aria-label={ariaLabel} />,
}));

function renderProperty(
  state: ReturnType<typeof createDemoState>,
  handlers = callbacks(),
  overrides: Partial<React.ComponentProps<typeof PropertyManagementPage>> = {},
) {
  const props: React.ComponentProps<typeof PropertyManagementPage> = {
    state,
    ...handlers,
    ...overrides,
  };
  render(<I18nProvider><ConfirmationProvider>
    <PropertyManagementPage {...props} />
  </ConfirmationProvider></I18nProvider>);
  return { handlers, props };
}

beforeEach(() => {
  localStorage.setItem("climate-twin-locale", "en");
  vi.spyOn(api, "trackingCapabilities").mockResolvedValue(enabledTrackingCapabilities());
  vi.spyOn(api, "trackedEquipment").mockResolvedValue([]);
  vi.spyOn(api, "trackingEndpoints").mockResolvedValue([]);
  vi.spyOn(api, "equipmentAttachments").mockResolvedValue([]);
  vi.spyOn(api, "equipmentLinks").mockResolvedValue([]);
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("Property destructive flows", () => {
  it("keeps an empty Property after cancellation, then deletes that exact Property", async () => {
    const user = userEvent.setup();
    const state = createDemoState();
    const emptyProperty = {
      ...state.properties[0]!,
      id: "property-empty-annex",
      name: "Empty annex",
      description: null,
    };
    state.properties = [...state.properties, emptyProperty];
    const { handlers } = renderProperty(state, callbacks(), {
      initialPropertyId: emptyProperty.id,
    });
    await screen.findByRole("heading", { name: emptyProperty.name, level: 1 });
    const trigger = screen.getByRole("button", { name: "Delete empty property" });

    await user.click(trigger);
    let dialog = screen.getByRole("dialog");
    expect(dialog).toHaveTextContent("Delete Empty annex? This cannot be undone.");
    await user.click(within(dialog).getByRole("button", { name: "Cancel" }));
    expect(handlers.onDeleteProperty).not.toHaveBeenCalled();
    expect(trigger).toHaveFocus();

    await user.click(trigger);
    dialog = screen.getByRole("dialog");
    await user.click(within(dialog).getByRole("button", { name: "Delete" }));
    await waitFor(() => expect(handlers.onDeleteProperty).toHaveBeenCalledWith(emptyProperty.id));
  });

  it("deletes a named Area only after its boundary-loss warning is confirmed", async () => {
    const user = userEvent.setup();
    const state = createDemoState();
    state.propertyAreas = [area];
    state.areaEquipment = [];
    state.propertyNotes = [];
    state.maintenanceTasks = [];
    const { handlers } = renderProperty(state);
    selectArea(/North well/);
    const editor = screen.getByRole("heading", { name: "North well", level: 2 }).closest("section")!;

    await user.click(within(editor).getByRole("button", { name: "Delete" }));
    const dialog = screen.getByRole("dialog");
    expect(dialog).toHaveTextContent("Delete North well? Its saved boundary and links cannot be restored.");
    await user.click(within(dialog).getByRole("button", { name: "Delete" }));

    await waitFor(() => expect(handlers.onDeleteArea).toHaveBeenCalledWith(area.id));
    expect(screen.getByText("Area deleted.")).not.toBeNull();
  });

  it("deletes only the selected equipment and warns about linked records", async () => {
    const user = userEvent.setup();
    const state = createDemoState();
    state.propertyAreas = [area];
    state.areaEquipment = [equipment];
    const { handlers } = renderProperty(state, callbacks(), { initialTab: "inventory" });

    await user.click(screen.getByRole("button", { name: "Delete: Well pump" }));
    const dialog = screen.getByRole("dialog");
    expect(dialog).toHaveTextContent(
      "Delete Well pump? Notes and maintenance links to this equipment may be affected.",
    );
    await user.click(within(dialog).getByRole("button", { name: "Delete" }));

    await waitFor(() => expect(handlers.onDeleteEquipment).toHaveBeenCalledWith(equipment.id));
    expect(screen.getByText("Equipment deleted.")).not.toBeNull();
  });

  it("removes one attachment and one link without deleting the inventory item", async () => {
    const user = userEvent.setup();
    const state = createDemoState();
    state.propertyAreas = [area];
    state.areaEquipment = [equipment];
    const photo: EquipmentAttachment = {
      id: "attachment-pump-front",
      equipmentId: equipment.id,
      kind: "photo",
      name: "Pump front.png",
      mimeType: "image/png",
      size: 1_024,
      createdAt: "2026-07-31T10:00:00.000Z",
    };
    const link: EquipmentLink = {
      id: "link-pump-manual",
      equipmentId: equipment.id,
      label: "Pump manual",
      url: "https://example.test/pump-manual",
      createdAt: "2026-07-31T10:00:00.000Z",
      updatedAt: "2026-07-31T10:00:00.000Z",
    };
    vi.mocked(api.equipmentAttachments).mockResolvedValue([photo]);
    vi.mocked(api.equipmentLinks).mockResolvedValue([link]);
    const deleteAttachment = vi.spyOn(api, "deleteEquipmentAttachment").mockResolvedValue(undefined);
    const deleteLink = vi.spyOn(api, "deleteEquipmentLink").mockResolvedValue(undefined);
    const { handlers } = renderProperty(state, callbacks(), { initialTab: "inventory" });
    await user.click(screen.getByRole("button", { name: "Equipment label: Well pump" }));
    await screen.findByRole("img", { name: photo.name });

    await user.click(screen.getByRole("button", { name: `Delete: ${photo.name}` }));
    let dialog = screen.getByRole("dialog");
    expect(dialog).toHaveTextContent(`Remove ${photo.name} from this inventory item?`);
    await user.click(within(dialog).getByRole("button", { name: "Delete" }));
    await waitFor(() => expect(deleteAttachment).toHaveBeenCalledWith(equipment.id, photo.id));
    expect(screen.queryByRole("img", { name: photo.name })).toBeNull();

    await user.click(screen.getByRole("button", { name: `Delete: ${link.label}` }));
    dialog = screen.getByRole("dialog");
    expect(dialog).toHaveTextContent(`Remove the link ${link.label}?`);
    await user.click(within(dialog).getByRole("button", { name: "Delete" }));
    await waitFor(() => expect(deleteLink).toHaveBeenCalledWith(equipment.id, link.id));
    expect(screen.queryByRole("link", { name: /Pump manual/ })).toBeNull();
    expect(handlers.onDeleteEquipment).not.toHaveBeenCalled();
    expect(screen.getByRole("heading", { name: "Well pump", level: 2 })).not.toBeNull();
  });

  it("removes a Home map placement while preserving its weather reference", async () => {
    const user = userEvent.setup();
    const state = createDemoState();
    const home = state.houses[0]!;
    const ground = home.floors.find((floor) => floor.type === "ground") ?? home.floors[0]!;
    home.mapPlacement = {
      latitude: 60.17,
      longitude: 24.94,
      metersPerPlanUnit: 0.5,
      footprintFloorId: ground.id,
    };
    home.orientationDegrees = 45;
    const { handlers } = renderProperty(state);

    await user.click(screen.getByRole("button", { name: "Remove placement" }));
    const dialog = screen.getByRole("dialog");
    expect(dialog).toHaveTextContent(
      `Remove the map placement for ${home.name}? Its weather location will be kept.`,
    );
    await user.click(within(dialog).getByRole("button", { name: "Remove" }));

    await waitFor(() => expect(handlers.onSetHouseGeoreference).toHaveBeenCalledWith(home.id, {
      mapPlacement: null,
      orientationDegrees: null,
    }));
    expect(screen.getByText("Home placement removed. Its weather reference was kept.")).not.toBeNull();
  });

  it("removes a fixed asset from the map while retaining its record", async () => {
    const user = userEvent.setup();
    const state = createDemoState();
    const fixedAsset: PropertyArea = {
      ...area,
      id: "asset-backup-generator",
      name: "Backup generator",
      kind: "other",
      polygon: [],
      location: { latitude: 60.175, longitude: 24.95 },
    };
    state.propertyAreas = [fixedAsset];
    state.areaEquipment = [];
    const saved = { ...fixedAsset, location: undefined };
    const handlers = callbacks();
    handlers.onUpdateArea.mockResolvedValue(saved);
    renderProperty(state, handlers);
    await user.click(screen.getByRole("button", { name: /Backup generator.*Fixed assets/ }));

    await user.click(screen.getByRole("button", { name: "Remove placement" }));
    const dialog = screen.getByRole("dialog");
    expect(dialog).toHaveTextContent("Remove Backup generator from the map? The asset record will be kept.");
    await user.click(within(dialog).getByRole("button", { name: "Remove" }));

    await waitFor(() => expect(handlers.onUpdateArea).toHaveBeenCalledWith(fixedAsset.id, { location: null }));
    expect(screen.getByText("Fixed asset position removed.")).not.toBeNull();
    expect(screen.getAllByText(fixedAsset.name).length).toBeGreaterThan(0);
  });

  it("unbinds a named tracking endpoint only from the selected equipment", async () => {
    const user = userEvent.setup();
    const state = createDemoState();
    state.session = {
      ...state.session,
      authenticated: true,
      principal: { type: "local", email: "admin@example.test" },
      tenant: { ...state.session.tenant, id: "local", name: "Local Stugu", role: "admin" },
    };
    state.propertyAreas = [area];
    state.areaEquipment = [equipment];
    const endpoint: TrackingEndpoint = {
      id: "endpoint-pump-tag",
      tenantId: "local",
      propertyId: DEMO_PROPERTY_ID,
      profileId: "property-beacon",
      profileVersion: "1",
      identityNamespaceVersion: 1,
      identityReference: "pump-tag-01",
      identityScope: "PROPERTY",
      identityStrength: "PAIRED_RESOLVABLE",
      observerScopeId: null,
      trackabilityTier: "PROPERTY_BEACON",
      displayName: "Pump tracker",
      manufacturer: "Stugu",
      model: "Tag 1",
      firmwareVersion: "1.0.0",
      claimStatus: "CLAIMED",
      proofKind: "PHYSICAL_ACCESS",
      proofVerifiedAt: "2026-07-31T09:00:00.000Z",
      lastSeenAt: "2026-07-31T10:00:00.000Z",
      telemetry: { batteryPercent: 88 },
      createdAt: "2026-07-31T09:00:00.000Z",
      updatedAt: "2026-07-31T10:00:00.000Z",
    };
    const tracked: TrackedEquipmentState = {
      equipment,
      endpoint,
      binding: {
        id: "binding-pump-tag",
        propertyId: DEMO_PROPERTY_ID,
        equipmentId: equipment.id,
        endpointId: endpoint.id,
        observerId: null,
        validFrom: "2026-07-31T09:00:00.000Z",
        validTo: null,
        boundBy: "admin@example.test",
      },
      position: null,
    };
    vi.mocked(api.trackedEquipment).mockResolvedValue([tracked]);
    vi.mocked(api.trackingEndpoints).mockResolvedValue([endpoint]);
    const unbind = vi.spyOn(api, "unbindTrackingEndpoint").mockResolvedValue(null);
    renderProperty(state, callbacks(), { initialTab: "inventory" });
    await waitFor(() => expect(api.trackedEquipment).toHaveBeenCalledWith(DEMO_PROPERTY_ID));
    await user.click(screen.getByRole("button", { name: "Equipment label: Well pump" }));
    await screen.findByText(endpoint.displayName);

    await user.click(screen.getByRole("button", { name: "Unbind endpoint" }));
    const dialog = screen.getByRole("dialog");
    expect(dialog).toHaveTextContent(
      "Unbind Pump tracker from Well pump? Live tracking stops, but both records remain.",
    );
    expect(within(dialog).getByRole("button", { name: "Unbind endpoint" })).toHaveClass("danger-button");
    await user.click(within(dialog).getByRole("button", { name: "Unbind endpoint" }));

    await waitFor(() => expect(unbind).toHaveBeenCalledWith(equipment.id));
    expect(screen.getByText("Tracking endpoint unbound.")).not.toBeNull();
    expect(screen.getByRole("heading", { name: "Well pump", level: 2 })).not.toBeNull();
  });
});
