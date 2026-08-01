import { act, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { api } from "../api";
import { createDemoState, DEMO_PROPERTY_ID } from "../domain";
import { I18nProvider } from "../i18n";
import { PropertyManagementPage } from "./PropertyManagementPage";
import { area, callbacks, enabledTrackingCapabilities, equipment } from "./PropertyManagementPageTestSupport";

vi.mock("../components/PropertyAreaMap", () => ({
  PropertyAreaMap: ({ ariaLabel, selectedAssetId, selectedEquipmentId }: {
    ariaLabel: string;
    selectedAssetId?: string | null;
    selectedEquipmentId?: string | null;
  }) => (
    <div
      role="region"
      aria-label={ariaLabel}
      data-selected-asset-id={selectedAssetId ?? ""}
      data-selected-equipment-id={selectedEquipmentId ?? ""}
    />
  ),
}));

vi.mock("../components/HouseLocationMap", () => ({
  HouseLocationMap: ({ ariaLabel }: { ariaLabel: string }) => <div role="region" aria-label={ariaLabel} />,
}));

function renderProperty(initialTab: "map" | "inventory" = "map") {
  const state = createDemoState();
  state.propertyAreas = [area];
  state.areaEquipment = [equipment];
  const onTab = vi.fn((section: string) => {
    window.history.pushState(null, "", `/properties/${DEMO_PROPERTY_ID}/${section}`);
  });
  render(<I18nProvider><PropertyManagementPage
    state={state}
    initialTab={initialTab}
    onTab={onTab}
    {...callbacks()}
  /></I18nProvider>);
  return { onTab };
}

beforeEach(() => {
  localStorage.setItem("climate-twin-locale", "en");
  window.history.replaceState(null, "", `/properties/${DEMO_PROPERTY_ID}/map`);
  vi.spyOn(api, "trackingCapabilities").mockResolvedValue(enabledTrackingCapabilities());
  vi.spyOn(api, "trackedEquipment").mockResolvedValue([]);
  vi.spyOn(api, "trackingEndpoints").mockResolvedValue([]);
  vi.spyOn(api, "equipmentAttachments").mockResolvedValue([]);
  vi.spyOn(api, "equipmentLinks").mockResolvedValue([]);
});

afterEach(() => vi.restoreAllMocks());

describe("Property URL-backed map and inventory state", () => {
  it("replaces filter and layer churn instead of adding Back-button stops", async () => {
    const user = userEvent.setup();
    const pushState = vi.spyOn(window.history, "pushState");
    const replaceState = vi.spyOn(window.history, "replaceState");
    renderProperty();
    pushState.mockClear();
    replaceState.mockClear();

    const itemType = screen.getByRole("combobox", { name: "Item type" });
    const layers = screen.getByRole("group", { name: "Map layers" });
    const equipmentLayer = within(layers).getByRole("checkbox", { name: /Equipment/ });
    await user.selectOptions(itemType, "asset");
    await user.selectOptions(itemType, "equipment");
    await user.click(equipmentLayer);
    await user.click(equipmentLayer);

    expect(pushState).not.toHaveBeenCalled();
    expect(replaceState).toHaveBeenCalledTimes(4);

    await user.click(screen.getByRole("tab", { name: "Inventory" }));
    pushState.mockClear();
    replaceState.mockClear();
    const inventoryControls = document.querySelector<HTMLElement>(".inventory-controls")!;
    const status = within(inventoryControls).getByRole("combobox", { name: "Service state" });
    const location = within(inventoryControls).getByRole("combobox", { name: "Expected location" });
    await user.selectOptions(status, "active");
    await user.selectOptions(status, "retired");
    await user.selectOptions(location, `area:${area.id}`);
    await user.selectOptions(location, "unassigned");

    expect(pushState).not.toHaveBeenCalled();
    expect(replaceState).toHaveBeenCalledTimes(4);
    expect(new URLSearchParams(window.location.search).get("inventory-status")).toBe("retired");
    expect(new URLSearchParams(window.location.search).get("inventory-location")).toBe("unassigned");
  });

  it("highlights a map-deep-linked equipment item and carries it into inventory", async () => {
    const user = userEvent.setup();
    window.history.replaceState(null, "", `/properties/${DEMO_PROPERTY_ID}/map?map-item=equipment:${equipment.id}`);
    renderProperty();

    await user.click(screen.getByRole("button", { name: "Load map" }));
    expect(await screen.findByRole("region")).toHaveAttribute(
      "data-selected-equipment-id",
      equipment.id,
    );
    await user.click(within(document.querySelector(".property-map-equipment-selection") as HTMLElement)
      .getByRole("button", { name: "Inventory" }));

    expect(window.location.pathname).toBe(`/properties/${DEMO_PROPERTY_ID}/inventory`);
    expect(new URLSearchParams(window.location.search).get("inventory-item")).toBe(equipment.id);
    expect(document.querySelector(".inventory-detail")).toHaveTextContent("Well pump");
  });

  it("restores filters and selected evidence, preserves them across tabs, and handles popstate", async () => {
    const user = userEvent.setup();
    const params = new URLSearchParams({
      keep: "yes",
      "map-search": "pump",
      "map-type": "equipment",
      "map-layers": "equipment",
      "map-item": `equipment:${equipment.id}`,
      "inventory-search": "well",
      "inventory-status": "active",
      "inventory-location": `area:${area.id}`,
      "inventory-item": equipment.id,
    });
    window.history.replaceState(null, "", `/properties/${DEMO_PROPERTY_ID}/map?${params}`);
    const { onTab } = renderProperty();

    expect(screen.getByRole("searchbox", { name: "Search map items" })).toHaveValue("pump");
    expect(screen.getByRole("combobox", { name: "Item type" })).toHaveValue("equipment");
    const layers = screen.getByRole("group", { name: "Map layers" });
    expect(within(layers).getByRole("checkbox", { name: /Equipment/ })).toBeChecked();
    expect(within(layers).getByRole("checkbox", { name: /Homes/ })).not.toBeChecked();
    expect(document.querySelector(".property-map-equipment-selection")).toHaveTextContent("Well pump");

    const mapTab = screen.getByRole("tab", { name: "Map" });
    const inventoryTab = screen.getByRole("tab", { name: "Inventory" });
    expect(document.getElementById(mapTab.getAttribute("aria-controls")!)).not.toBeNull();
    expect(document.getElementById(inventoryTab.getAttribute("aria-controls")!)).not.toBeNull();
    await user.click(inventoryTab);
    expect(window.location.pathname).toBe(`/properties/${DEMO_PROPERTY_ID}/inventory`);
    expect(new URLSearchParams(window.location.search).get("map-type")).toBe("equipment");
    expect(new URLSearchParams(window.location.search).get("keep")).toBe("yes");
    const inventoryControls = document.querySelector<HTMLElement>(".inventory-controls")!;
    expect(within(inventoryControls).getByRole("searchbox", { name: "Search inventory" })).toHaveValue("well");
    expect(within(inventoryControls).getByRole("combobox", { name: "Service state" })).toHaveValue("active");
    expect(within(inventoryControls).getByRole("combobox", { name: "Expected location" })).toHaveValue(`area:${area.id}`);
    expect(document.querySelector(".inventory-detail")).toHaveTextContent("Well pump");
    expect(document.getElementById(mapTab.getAttribute("aria-controls")!)).not.toBeNull();
    expect(document.getElementById(inventoryTab.getAttribute("aria-controls")!)).not.toBeNull();

    const historyLength = window.history.length;
    await user.click(inventoryTab);
    expect(onTab).toHaveBeenCalledTimes(1);
    expect(window.history.length).toBe(historyLength);

    act(() => {
      window.history.pushState(null, "", `/properties/${DEMO_PROPERTY_ID}/inventory?keep=yes&inventory-status=retired`);
      window.dispatchEvent(new PopStateEvent("popstate"));
    });
    await waitFor(() => expect(within(inventoryControls).getByRole("combobox", { name: "Service state" })).toHaveValue("retired"));
    expect(document.querySelector(".inventory-detail")).toBeNull();
  });

  it("drops invalid and default params without touching unrelated state", async () => {
    window.history.replaceState(null, "", `/properties/${DEMO_PROPERTY_ID}/inventory?keep=yes&map-type=invalid&map-layers=invalid&map-item=equipment:missing&inventory-status=invalid&inventory-location=area:missing&inventory-item=missing`);
    renderProperty("inventory");

    await waitFor(() => expect(window.location.search).toBe("?keep=yes"));
    const inventoryControls = document.querySelector<HTMLElement>(".inventory-controls")!;
    expect(within(inventoryControls).getByRole("combobox", { name: "Service state" })).toHaveValue("all");
    expect(within(inventoryControls).getByRole("combobox", { name: "Expected location" })).toHaveValue("all");
  });

  it("keeps a new fixed-asset draft selected when its URL scope is recomputed", async () => {
    const user = userEvent.setup();
    const state = createDemoState();
    state.propertyAreas = [area];
    state.areaEquipment = [equipment];
    const handlers = callbacks();
    const view = render(<I18nProvider><PropertyManagementPage
      state={state}
      initialTab="map"
      {...handlers}
    /></I18nProvider>);

    await user.click(screen.getByRole("button", { name: "Add fixed asset" }));
    expect(await screen.findByRole("region")).toHaveAttribute("data-selected-asset-id", "__new-fixed-asset__");
    expect(new URLSearchParams(window.location.search).get("map-item")).toBe("none");

    const updatedState = { ...state, propertyAreas: [...state.propertyAreas] };
    view.rerender(<I18nProvider><PropertyManagementPage
      state={updatedState}
      initialTab="map"
      {...handlers}
    /></I18nProvider>);

    expect(screen.getByRole("region")).toHaveAttribute("data-selected-asset-id", "__new-fixed-asset__");
    expect(screen.getByRole("button", { name: "Save fixed asset" })).toBeDisabled();
  });
});
