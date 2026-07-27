import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";

import { StrictMode } from "react";

import userEvent from "@testing-library/user-event";

import { beforeEach, describe, expect, it, vi } from "vitest";

import { App } from "./App";

import { I18nProvider } from "./i18n";

import { createDemoState } from "./domain";

import { useClimateData } from "./useClimateData";

import { api } from "./api";

import { ROUTE_READY_TIMEOUT_MS, findPageHeading, mockClimateData, renderApp } from "./AppTestSupport";

vi.mock("./useClimateData", () => ({ useClimateData: vi.fn() }));

beforeEach(() => {
  window.history.replaceState(null, "", "/");
  localStorage.removeItem("stugu-dismissed-tp-link-device-notices");
  mockClimateData();
});

describe("Stugu app", () => {
  it("opens Home from Properties", async () => {
    const user = userEvent.setup();
    window.history.replaceState(null, "", "/properties");
    renderApp();

    expect(await findPageHeading("Properties")).toBeTruthy();
    expect(screen.getAllByRole("main")).toHaveLength(1);
    await user.click(screen.getByRole("button", { name: "Open Pine Estate" }));
    await waitFor(() => expect(window.location.pathname).toBe("/properties/property-pine"));
    await findPageHeading("Pine Estate");
    await user.click(screen.getByRole("link", { name: "Home" }));

    expect(await findPageHeading("Your home, at a glance")).toBeTruthy();
    expect(window.location.pathname).toBe("/properties/property-pine/homes/house-pine");
  });

  it("restores Property and Home context from canonical URLs and browser navigation", async () => {
    const climate = mockClimateData();
    const mainProperty = climate.state.properties[0]!;
    const mainHouse = climate.state.houses[0]!;
    const lakeProperty = { ...mainProperty, id: "property-lake", name: "Lake estate" };
    const lakeHouse = { ...mainHouse, id: "house-lake", propertyId: lakeProperty.id, name: "Lake home" };
    climate.state = {
      ...climate.state,
      properties: [mainProperty, lakeProperty],
      houses: [mainHouse, lakeHouse],
    };
    vi.mocked(useClimateData).mockReturnValue(climate);
    window.history.replaceState(null, "", "/properties/property-lake/homes/house-lake");
    renderApp();

    await findPageHeading("Your home, at a glance");
    expect((screen.getByLabelText("Active property") as HTMLSelectElement).value).toBe(lakeProperty.id);
    expect((screen.getByLabelText("Home shown on this page") as HTMLSelectElement).value).toBe(lakeHouse.id);

    window.history.replaceState(null, "", "/properties/property-pine/homes/house-pine");
    window.dispatchEvent(new PopStateEvent("popstate"));
    await waitFor(() => expect((screen.getByLabelText("Active property") as HTMLSelectElement).value).toBe(mainProperty.id));
    expect((screen.getByLabelText("Home shown on this page") as HTMLSelectElement).value).toBe(mainHouse.id);
  });

  it("replaces a legacy Site URL with its canonical Property and Home path", async () => {
    window.history.replaceState(null, "", "/sites/house-pine/twin");
    renderApp();

    await findPageHeading("Your home, at a glance");
    await waitFor(() => expect(window.location.pathname).toBe("/properties/property-pine/homes/house-pine"));
  });

  it("opens Property-owned Maintenance for a land-only Property", async () => {
    const climate = mockClimateData();
    const landOnly = { ...climate.state.properties[0]!, id: "property-forest", name: "Forest parcel" };
    climate.state = { ...climate.state, properties: [...climate.state.properties, landOnly] };
    vi.mocked(useClimateData).mockReturnValue(climate);
    window.history.replaceState(null, "", "/properties/property-forest/maintenance");
    renderApp();

    expect(await findPageHeading("Maintenance")).toBeTruthy();
    expect((screen.getByLabelText("Active property") as HTMLSelectElement).value).toBe(landOnly.id);
    expect(window.location.pathname).toBe("/properties/property-forest/maintenance");
  });

  it("opens Property-owned Electricity for a land-only Property", async () => {
    const climate = mockClimateData();
    const landOnly = { ...climate.state.properties[0]!, id: "property-forest", name: "Forest parcel" };
    climate.state = { ...climate.state, properties: [...climate.state.properties, landOnly] };
    vi.mocked(useClimateData).mockReturnValue(climate);
    const propertyElectricity = vi.spyOn(api, "propertyElectricity").mockRejectedValue(new Error("No contract configured"));
    window.history.replaceState(null, "", "/properties/property-forest/electricity");
    renderApp();

    expect(await findPageHeading("Electricity")).toBeTruthy();
    expect((screen.getByLabelText("Active property") as HTMLSelectElement).value).toBe(landOnly.id);
    expect(window.location.pathname).toBe("/properties/property-forest/electricity");
    propertyElectricity.mockRestore();
  });

  it("keeps the workspace Overview available when every Property is land-only", async () => {
    const climate = mockClimateData();
    climate.state = {
      ...climate.state,
      houses: [],
      sensors: [],
    };
    vi.mocked(useClimateData).mockReturnValue(climate);
    window.history.replaceState(null, "", "/overview");
    renderApp();

    expect(await findPageHeading("All properties, one calm overview")).toBeTruthy();
    expect(screen.getByRole("heading", { name: climate.state.properties[0]!.name })).toBeTruthy();
    expect(screen.getByText("No homes belong to this property yet.")).toBeTruthy();
  });

  it("keeps the Property Electricity route free of an implicit first-Home scope", async () => {
    const propertyElectricity = vi.spyOn(api, "propertyElectricity").mockRejectedValue(new Error("No contract configured"));
    window.history.replaceState(null, "", "/properties/property-pine/electricity");
    renderApp();

    expect(await findPageHeading("Electricity")).toBeTruthy();
    expect(screen.queryByRole("heading", { name: "Electricity history" })).toBeNull();
    expect(screen.queryByRole("heading", { name: "Connect electricity data" })).toBeNull();
    propertyElectricity.mockRestore();
  });

  it("does not offer electricity source setup for a foreign shared Home", async () => {
    const climate = mockClimateData();
    const home = climate.state.houses[0]!;
    climate.state = {
      ...climate.state,
      houses: climate.state.houses.map((candidate) => candidate.id === home.id ? {
        ...candidate,
        stuguby: {
          stugubyId: "stuguby-remote",
          authorityNodeId: "node-remote",
          publicationId: "publication-remote-home",
          ownership: "shared" as const,
          editPolicy: "read-only" as const,
          syncState: "current" as const,
          authorityEpoch: 1,
          pendingChangeCount: 0,
          conflictCount: 0,
          recoveryState: "not-enabled" as const,
        },
      } : candidate),
      sensors: climate.state.sensors.filter((sensor) => sensor.houseId !== home.id),
    };
    vi.mocked(useClimateData).mockReturnValue(climate);
    window.history.replaceState(null, "", `/properties/${home.propertyId}/homes/${home.id}/electricity`);

    renderApp();

    expect(await findPageHeading("Electricity")).toBeTruthy();
    expect(screen.getByRole("heading", { name: "No electricity data available" })).toBeTruthy();
    expect(screen.queryByRole("heading", { name: "Connect electricity data" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Configure a source" })).toBeNull();
    expect(screen.queryByRole("link", { name: "Set up" })).toBeNull();
  });

  it("keeps the Property workspace available while creating its first Home", async () => {
    const climate = mockClimateData();
    climate.state = {
      ...climate.state,
      houses: [],
      sensors: [],
    };
    vi.mocked(useClimateData).mockReturnValue(climate);
    renderApp();

    expect(await findPageHeading(climate.state.properties[0]!.name)).toBeTruthy();
    await waitFor(() => expect(window.location.pathname).toBe(`/properties/${climate.state.properties[0]!.id}`));
    expect(screen.queryByRole("link", { name: "Home" })).toBeNull();
    expect(screen.getByRole("link", { name: "Properties" })).toBeTruthy();

    fireEvent.change(screen.getByRole("textbox", { name: "Add a home to this property" }), { target: { value: "Lake house" } });
    fireEvent.click(screen.getByRole("button", { name: "Add home" }));

    await waitFor(() => expect(climate.createHouse).toHaveBeenCalledWith(expect.objectContaining({
      name: "Lake house",
      propertyId: climate.state.properties[0]!.id,
    })));
  });

  it("creates a property before the first home when the workspace has none", async () => {
    const climate = mockClimateData();
    climate.state = {
      ...climate.state,
      properties: [],
      houses: [],
      sensors: [],
    };
    climate.bootstrapStatus = "empty";
    const createdProperty = {
      id: "property-lake",
      name: "Lake estate",
      description: null,
      location: null,
      createdAt: "2026-07-01T08:00:00.000Z",
      updatedAt: "2026-07-01T08:00:00.000Z",
    };
    climate.createProperty = vi.fn().mockResolvedValue(createdProperty);
    climate.createHouse = vi.fn().mockResolvedValue({
      ...createDemoState().houses[0]!,
      id: "house-lake",
      name: "Lake home",
      propertyId: createdProperty.id,
    });
    vi.mocked(useClimateData).mockReturnValue(climate);
    renderApp();

    fireEvent.change(screen.getByRole("textbox", { name: /^Property name/ }), { target: { value: createdProperty.name } });
    fireEvent.change(screen.getByRole("textbox", { name: "Home name" }), { target: { value: "Lake home" } });
    fireEvent.click(screen.getByRole("button", { name: "Create home" }));

    await waitFor(() => expect(climate.createHouse).toHaveBeenCalledWith(expect.objectContaining({
      name: "Lake home",
      propertyId: createdProperty.id,
    })));
    expect(climate.createProperty).toHaveBeenCalledWith({ name: createdProperty.name });
    expect(vi.mocked(climate.createProperty).mock.invocationCallOrder[0])
      .toBeLessThan(vi.mocked(climate.createHouse).mock.invocationCallOrder[0]!);
  });

  it("shows first-owner setup before the workspace", () => {
    const climate = mockClimateData();
    climate.bootstrapStatus = "setup-required";
    vi.mocked(useClimateData).mockReturnValue(climate);

    renderApp();

    expect(screen.getByRole("heading", { name: "Create the first owner account" })).toBeTruthy();
    expect(screen.queryByRole("navigation", { name: "Primary navigation" })).toBeNull();
  });

  it("captures an invitation from the fragment and clears it before activation", () => {
    const climate = mockClimateData();
    climate.bootstrapStatus = "login-required";
    vi.mocked(useClimateData).mockReturnValue(climate);
    window.history.replaceState(null, "", "/#invite=abcdefghijklmnopqrstuvwxyz_1234567890ABCDEF");

    render(<StrictMode><I18nProvider><App /></I18nProvider></StrictMode>);

    expect(screen.getByRole("heading", { name: "Activate your account" })).toBeTruthy();
    expect(window.location.hash).toBe("");
  });

  it("keeps a read-only guest with a floorless house inside the navigable property workspace", async () => {
    const user = userEvent.setup();
    const logout = vi.spyOn(api, "logout").mockResolvedValue(undefined);
    const climate = mockClimateData();
    climate.state = {
      ...climate.state,
      houses: climate.state.houses.map((house) => ({ ...house, floors: [] })),
      session: {
        ...climate.state.session,
        principal: { type: "local", email: "guest@example.test" },
        tenant: { id: "local", name: "Local Stugu", role: "guest" },
        availableTenants: [{ id: "local", name: "Local Stugu", role: "guest" }],
        readOnly: true,
      },
    };
    vi.mocked(useClimateData).mockReturnValue(climate);

    renderApp();

    expect(await findPageHeading("Pine Estate")).toBeTruthy();
    expect(screen.getByRole("navigation", { name: "Primary navigation" })).toBeTruthy();
    expect(screen.getAllByText("Guest access").length).toBeGreaterThan(0);
    expect(screen.queryByRole("link", { name: "Home" })).toBeNull();
    await user.click(screen.getByRole("button", { name: "Sign out" }));
    await waitFor(() => expect(logout).toHaveBeenCalledOnce());
    expect(climate.endSession).toHaveBeenCalledOnce();
    logout.mockRestore();
  });

  it("shows a no-access state instead of inventory failure when a guest has no grants", () => {
    const climate = mockClimateData();
    climate.state = {
      ...climate.state,
      properties: [],
      propertyAreas: [],
      houses: [],
      sensors: [],
      session: {
        ...climate.state.session,
        principal: { type: "local", email: "guest@example.test" },
        tenant: { id: "local", name: "Local Stugu", role: "guest" },
        availableTenants: [{ id: "local", name: "Local Stugu", role: "guest" }],
        readOnly: true,
        grants: [],
      },
    };
    vi.mocked(useClimateData).mockReturnValue(climate);

    renderApp();

    expect(screen.getByRole("heading", { name: "No property access" })).toBeTruthy();
    expect(screen.queryByText("The local inventory could not be loaded")).toBeNull();
    expect(screen.queryByRole("button", { name: "Create Home" })).toBeNull();
  });

  it("does not offer Home creation to a guest whose granted Property has no Home", () => {
    const climate = mockClimateData();
    const property = climate.state.properties[0]!;
    climate.state = {
      ...climate.state,
      houses: [],
      sensors: [],
      session: {
        ...climate.state.session,
        principal: { type: "local", email: "guest@example.test" },
        tenant: { id: "local", name: "Local Stugu", role: "guest" },
        availableTenants: [{ id: "local", name: "Local Stugu", role: "guest" }],
        readOnly: true,
        grants: [{ scopeType: "property", scopeId: property.id }],
      },
    };
    vi.mocked(useClimateData).mockReturnValue(climate);

    renderApp();

    expect(screen.getByRole("heading", { name: "Pine Estate" })).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Create Home" })).toBeNull();
  });

  it("does not call the Stuguby administration API for a direct guest route", async () => {
    const climate = mockClimateData();
    climate.state = {
      ...climate.state,
      session: {
        ...climate.state.session,
        principal: { type: "local", email: "guest@example.test" },
        tenant: { id: "local", name: "Local Stugu", role: "guest" },
        availableTenants: [{ id: "local", name: "Local Stugu", role: "guest" }],
        readOnly: true,
        grants: [{ scopeType: "house", scopeId: climate.state.houses[0]!.id }],
      },
    };
    vi.mocked(useClimateData).mockReturnValue(climate);
    const stugubys = vi.spyOn(api, "stugubys");
    window.history.replaceState(null, "", "/stugbys");

    renderApp();

    expect(await findPageHeading("Administrator access required")).toBeTruthy();
    expect(stugubys).not.toHaveBeenCalled();
  });

  it("gives a Home-scoped guest read-only access to that Home's sensor inventory", async () => {
    const climate = mockClimateData();
    const home = climate.state.houses[0]!;
    const sensor = climate.state.sensors.find((candidate) => candidate.houseId === home.id)!;
    climate.state = {
      ...climate.state,
      session: {
        ...climate.state.session,
        principal: { type: "local", email: "guest@example.test" },
        tenant: { id: "local", name: "Local Stugu", role: "guest" },
        availableTenants: [{ id: "local", name: "Local Stugu", role: "guest" }],
        readOnly: true,
        grants: [{ scopeType: "house", scopeId: home.id }],
      },
    };
    vi.mocked(useClimateData).mockReturnValue(climate);
    window.history.replaceState(null, "", `/properties/${home.propertyId}/homes/${home.id}/sensors`);

    renderApp();

    expect(await findPageHeading("Sensors")).toBeTruthy();
    expect(within(document.querySelector<HTMLElement>(".sensor-list-panel")!).getByText(sensor.name)).toBeTruthy();
    expect(screen.getByRole("link", { name: "Sensors" })).toBeTruthy();
    expect(screen.queryByRole("link", { name: "Set up" })).toBeNull();
    expect(screen.queryByRole("button", { name: `Edit ${sensor.name}` })).toBeNull();
    expect(screen.queryByRole("button", { name: `Archive ${sensor.name}` })).toBeNull();
    expect(screen.queryByRole("button", { name: `Delete ${sensor.name}` })).toBeNull();
    expect(screen.getByRole("button", { name: `View data for ${sensor.name}` })).toBeTruthy();
  });

  it("does not load a Property electricity contract for a guest with only a Home grant", async () => {
    const climate = mockClimateData();
    const home = climate.state.houses[0]!;
    climate.state = {
      ...climate.state,
      session: {
        ...climate.state.session,
        principal: { type: "local", email: "guest@example.test" },
        tenant: { id: "local", name: "Local Stugu", role: "guest" },
        availableTenants: [{ id: "local", name: "Local Stugu", role: "guest" }],
        readOnly: true,
        grants: [{ scopeType: "house", scopeId: home.id }],
      },
    };
    vi.mocked(useClimateData).mockReturnValue(climate);
    const propertyElectricity = vi.spyOn(api, "propertyElectricity");
    window.history.replaceState(null, "", `/properties/${home.propertyId}/electricity`);

    renderApp();

    expect(await findPageHeading("Administrator access required")).toBeTruthy();
    expect(screen.queryByRole("link", { name: "Electricity" })).toBeNull();
    expect(propertyElectricity).not.toHaveBeenCalled();
    propertyElectricity.mockRestore();
  });

  it("allows a guest with a direct Property grant to open its electricity contract", async () => {
    const climate = mockClimateData();
    const property = climate.state.properties[0]!;
    climate.state = {
      ...climate.state,
      session: {
        ...climate.state.session,
        principal: { type: "local", email: "guest@example.test" },
        tenant: { id: "local", name: "Local Stugu", role: "guest" },
        availableTenants: [{ id: "local", name: "Local Stugu", role: "guest" }],
        readOnly: true,
        grants: [{ scopeType: "property", scopeId: property.id }],
      },
    };
    vi.mocked(useClimateData).mockReturnValue(climate);
    const propertyElectricity = vi.spyOn(api, "propertyElectricity").mockRejectedValue(new Error("No contract configured"));
    window.history.replaceState(null, "", `/properties/${property.id}/electricity`);

    renderApp();

    expect(await findPageHeading("Electricity")).toBeTruthy();
    expect(screen.getByRole("link", { name: "Electricity" })).toBeTruthy();
    await waitFor(() => expect(propertyElectricity).toHaveBeenCalledWith(property.id));
    propertyElectricity.mockRestore();
  });

  it("locks the local workspace even when server logout cannot be confirmed", async () => {
    const user = userEvent.setup();
    const logout = vi.spyOn(api, "logout").mockRejectedValue(new TypeError("Network unavailable"));
    const climate = mockClimateData();
    climate.state = {
      ...climate.state,
      session: {
        ...climate.state.session,
        principal: { type: "local", email: "owner@example.test" },
        tenant: { id: "local", name: "Local Stugu", role: "owner" },
        availableTenants: [{ id: "local", name: "Local Stugu", role: "owner" }],
        readOnly: false,
      },
    };
    vi.mocked(useClimateData).mockReturnValue(climate);
    renderApp();

    await user.click(screen.getByRole("button", { name: "Sign out" }));

    await waitFor(() => expect(logout).toHaveBeenCalledOnce());
    expect(climate.endSession).toHaveBeenCalledOnce();
    logout.mockRestore();
  });

  it("updates the page title and moves focus only after SPA page changes", async () => {
    const user = userEvent.setup();
    const view = renderApp();
    await findPageHeading("Your home, at a glance");
    const main = view.container.querySelector("#main-content")!;

    expect(document.title).toBe("Home — Stugu");
    expect(document.activeElement).not.toBe(main);

    await user.click(screen.getByRole("link", { name: "Sensors" }));
    await findPageHeading("Sensors");
    await waitFor(() => expect(document.activeElement).toBe(main));
    expect(document.title).toBe("Sensors — Stugu");

    const activeHome = screen.getByRole("combobox", { name: "Home shown on this page" });
    expect(activeHome.closest("main")).toBe(main);
    expect(activeHome.closest("aside")).toBeNull();
    activeHome.focus();
    fireEvent.change(activeHome, { target: { value: (activeHome as HTMLSelectElement).value } });
    await waitFor(() => expect(document.activeElement).toBe(activeHome));
    expect(document.title).toBe("Sensors — Stugu");
  });

  it("renders an accessible mock-backed twin and switches metrics", async () => {
    const user = userEvent.setup();
    renderApp();
    expect(await findPageHeading("Your home, at a glance")).not.toBeNull();
    await user.click(screen.getByRole("button", { name: "Open live home view" }));
    expect(await screen.findByRole(
      "group",
      { name: /Temperature map/i },
      { timeout: 5_000 },
    )).not.toBeNull();
    const metric = screen.getByRole("combobox", { name: "Metric" });
    expect(within(metric).getByRole("option", { name: /Carbon dioxide.*ppm/ })).not.toBeNull();
    await user.selectOptions(metric, "humidity");
    expect((metric as HTMLSelectElement).value).toBe("humidity");
    expect(screen.getByRole("group", { name: /Humidity map/i })).not.toBeNull();
  });

  it("opens the progressive Home Assistant onboarding experience", async () => {
    const user = userEvent.setup();
    renderApp();
    await findPageHeading("Your home, at a glance");
    await user.click(screen.getByRole("link", { name: "Set up" }));
    expect(await findPageHeading("Connect your home")).not.toBeNull();
    expect(screen.getByRole("tab", { name: /Overview/ }).getAttribute("aria-selected")).toBe("true");

    await user.click(screen.getByRole("tab", { name: /Where readings come from/ }));
    const homeAssistantSection = screen.getByRole("heading", { name: "Connect Home Assistant" }).closest("section")!;
    await user.click(within(homeAssistantSection).getByText("Enter an address manually"));
    await user.click(within(homeAssistantSection).getByText("Advanced environment-variable setup"));
    expect(within(homeAssistantSection).getByText(/HA_URL=http:\/\/homeassistant\.local:8123/)).not.toBeNull();
    expect(within(homeAssistantSection).getByRole("button", { name: "Check server connection" })).not.toBeNull();
  });

  it("opens the sensor inventory and guided onboarding workspace", async () => {
    const user = userEvent.setup();
    renderApp();
    await findPageHeading("Your home, at a glance");

    await user.click(screen.getByRole("link", { name: "Sensors" }));

    expect(await findPageHeading("Sensors")).not.toBeNull();
    expect(screen.getByRole("heading", { name: /Sensors in/i })).not.toBeNull();
    expect(screen.getByRole("button", { name: "Add sensor" })).not.toBeNull();
  });
});
