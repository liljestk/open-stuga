import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { I18nProvider } from "../i18n";
import { AppShell } from "./AppShell";

afterEach(() => {
  vi.restoreAllMocks();
  window.history.replaceState({}, "", "/");
});

describe("AppShell local account controls", () => {
  it("shows API & MCP only when the principal can use developer tools", () => {
    const props = {
      page: "overview" as const,
      onPage: vi.fn(),
      connection: "live" as const,
      units: "metric" as const,
      onUnits: vi.fn(),
      lastUpdated: null,
      dataMode: "real" as const,
    };
    const view = render(<I18nProvider><AppShell {...props}><div>Overview</div></AppShell></I18nProvider>);
    expect(screen.queryByRole("link", { name: "API & MCP" })).toBeNull();

    view.rerender(<I18nProvider><AppShell {...props} canUseDeveloperTools><div>Overview</div></AppShell></I18nProvider>);
    expect(screen.getByRole("link", { name: "API & MCP" }).getAttribute("href")).toBe("/developer");
  });

  it("keeps the Property workspace reachable before a Home exists", () => {
    render(
      <I18nProvider>
        <AppShell
          page="properties"
          onPage={vi.fn()}
          connection="offline"
          units="metric"
          onUnits={vi.fn()}
          lastUpdated={null}
          dataMode="real"
        >
          <div>Property content</div>
        </AppShell>
      </I18nProvider>,
    );

    const properties = screen.getByRole("link", { name: "Properties" });
    expect(properties.getAttribute("href")).toBe("/properties");
  });

  it("does not imply Property scope on the workspace-wide Stugubys page", () => {
    render(
      <I18nProvider>
        <AppShell
          page="stugubys"
          canManagePeople
          onPage={vi.fn()}
          connection="live"
          units="metric"
          onUnits={vi.fn()}
          lastUpdated={null}
          dataMode="real"
          properties={[{ id: "property-main", name: "Main estate" }]}
          propertyId="property-main"
          onProperty={vi.fn()}
          houses={[{ id: "home-main", propertyId: "property-main", name: "Main home", timezone: "Europe/Helsinki" }]}
          houseId="home-main"
        >
          <div>Stuguby content</div>
        </AppShell>
      </I18nProvider>,
    );

    const stugubysLink = screen.getByRole("link", { name: "Stugubys" });
    expect(stugubysLink.getAttribute("href")).toBe("/stugbys");
    expect(stugubysLink.closest("details")?.querySelector("summary")?.textContent).toContain("Advanced");
    const workspaceGroup = screen.getByText("Workspace").closest("details");
    expect(workspaceGroup?.querySelectorAll(".nav-button")).toHaveLength(3);
    expect(screen.queryByLabelText("Active property")).toBeNull();
  });

  it("keeps Setup visibly scoped and filters the Home picker to the active Property", () => {
    render(
      <I18nProvider>
        <AppShell
          page="integrations"
          onPage={vi.fn()}
          connection="live"
          units="metric"
          onUnits={vi.fn()}
          lastUpdated={null}
          dataMode="real"
          properties={[{ id: "property-main", name: "Main estate" }, { id: "property-lake", name: "Lake estate" }]}
          propertyId="property-main"
          onProperty={vi.fn()}
          houses={[
            { id: "home-main", propertyId: "property-main", name: "Main home", timezone: "Europe/Helsinki" },
            { id: "home-guest", propertyId: "property-main", name: "Guest home", timezone: "Europe/Helsinki" },
            { id: "home-lake", propertyId: "property-lake", name: "Lake home", timezone: "Europe/Helsinki" },
          ]}
          houseId="home-main"
          onHouse={vi.fn()}
        >
          <div>Setup content</div>
        </AppShell>
      </I18nProvider>,
    );

    expect(screen.getByRole("link", { name: "Set up" }).getAttribute("href"))
      .toBe("/properties/property-main/homes/home-main/setup");
    expect(screen.getByRole("link", { name: "Activity" }).getAttribute("href"))
      .toBe("/properties/property-main/homes/home-main/activity");
    expect(screen.getByRole("link", { name: "Outdoor" }).getAttribute("href"))
      .toBe("/properties/property-main/homes/home-main/outdoor");
    expect(screen.getByRole("link", { name: "Electricity use" }).getAttribute("href"))
      .toBe("/properties/property-main/homes/home-main/electricity");
    expect(screen.getByRole("link", { name: "Data & analytics" }).getAttribute("href"))
      .toBe("/properties/property-main/homes/home-main/analytics");
    const homePicker = screen.getByLabelText("Home shown on this page") as HTMLSelectElement;
    expect(Array.from(homePicker.options, (option) => option.textContent)).toEqual(["Main home", "Guest home"]);
    expect(screen.queryByRole("option", { name: "Lake home" })).toBeNull();
    expect(screen.getByLabelText("Home · Main home · Own").textContent).toContain("Own");
  });

  it("labels a shared Home as remote outside the picker", () => {
    const { container } = render(
      <I18nProvider>
        <AppShell
          page="twin"
          onPage={vi.fn()}
          connection="live"
          units="metric"
          onUnits={vi.fn()}
          lastUpdated={null}
          dataMode="real"
          properties={[{ id: "property-main", name: "Host Property" }]}
          propertyId="property-main"
          onProperty={vi.fn()}
          houses={[{
            id: "home-shared",
            propertyId: "property-main",
            name: "Client Home",
            timezone: "Europe/Helsinki",
            stuguby: {
              stugubyId: "stuguby-1",
              authorityNodeId: "node-client",
              publicationId: "publication-client-home",
              ownership: "shared",
              editPolicy: "read-only",
              syncState: "current",
              authorityEpoch: 1,
              pendingChangeCount: 0,
              conflictCount: 0,
              recoveryState: "not-enabled",
            },
          }]}
          houseId="home-shared"
          onHouse={vi.fn()}
        >
          <div>Shared Home content</div>
        </AppShell>
      </I18nProvider>,
    );

    expect(screen.queryByLabelText("Home shown on this page")).toBeNull();
    expect(screen.getByLabelText("Home · Client Home · Remote").textContent).toContain("Remote");
    expect(container.querySelector(".sidebar-nav-group .stuguby-mark")).toBeTruthy();
    expect(container.querySelector(".page-home-switcher")).toBeNull();
  });

  it("does not mark an owned Stuguby Home as remote", () => {
    const { container } = render(
      <I18nProvider>
        <AppShell
          page="twin"
          onPage={vi.fn()}
          connection="live"
          units="metric"
          onUnits={vi.fn()}
          lastUpdated={null}
          dataMode="real"
          properties={[{ id: "property-main", name: "Host Property" }]}
          propertyId="property-main"
          onProperty={vi.fn()}
          houses={[{
            id: "home-owned",
            propertyId: "property-main",
            name: "My Home",
            timezone: "Europe/Helsinki",
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
          }]}
          houseId="home-owned"
          onHouse={vi.fn()}
        >
          <div>Owned Home content</div>
        </AppShell>
      </I18nProvider>,
    );

    expect(screen.getByLabelText("Home · My Home · Own").textContent).toContain("Own");
    expect(container.querySelector(".page-home-switcher-group .stuguby-mark")).toBeNull();
    expect(container.querySelector(".sidebar-nav-group .stuguby-mark")).toBeNull();
    expect(container.querySelector(".page-home-switcher")).toBeNull();
  });

  it("lets a read-only Guest sign out without exposing a workspace switcher", async () => {
    const onLogout = vi.fn().mockResolvedValue(undefined);
    render(
      <I18nProvider>
        <AppShell
          page="properties"
          onPage={vi.fn()}
          connection="offline"
          units="metric"
          onUnits={vi.fn()}
          lastUpdated={null}
          dataMode="real"
          readOnly
          principalEmail="guest@example.test"
          onLogout={onLogout}
        >
          <main>Workspace content</main>
        </AppShell>
      </I18nProvider>,
    );

    expect(screen.queryByRole("combobox", { name: "Workspace" })).toBeNull();
    fireEvent.click(screen.getByText("Account & preferences").closest("summary")!);
    fireEvent.click(screen.getByRole("button", { name: "Sign out" }));
    await waitFor(() => expect(onLogout).toHaveBeenCalledOnce());
  });

  it("keeps only the current navigation scope expanded by default", async () => {
    window.history.replaceState({}, "", "/properties/property-main/homes/home-main");
    const props = {
      onPage: vi.fn(),
      connection: "live" as const,
      units: "metric" as const,
      onUnits: vi.fn(),
      lastUpdated: null,
      dataMode: "real" as const,
      properties: [{ id: "property-main", name: "Main estate" }],
      propertyId: "property-main",
      houses: [{ id: "home-main", propertyId: "property-main", name: "Main home", timezone: "Europe/Helsinki" }],
      houseId: "home-main",
    };
    const view = render(
      <I18nProvider><AppShell {...props} page="twin"><div>Home</div></AppShell></I18nProvider>,
    );

    const workspaceGroup = screen.getByText("Workspace").closest("details")!;
    const propertyGroup = screen.getByText(/Property .* Main estate/).closest("details")!;
    const homeGroup = screen.getByText(/Home .* Main home/).closest("details")!;
    expect(workspaceGroup.open).toBe(false);
    expect(propertyGroup.open).toBe(false);
    expect(homeGroup.open).toBe(true);

    window.history.replaceState({}, "", "/properties/property-main/maintenance");
    view.rerender(
      <I18nProvider><AppShell {...props} page="maintenance"><div>Maintenance</div></AppShell></I18nProvider>,
    );
    await waitFor(() => {
      expect(propertyGroup.open).toBe(true);
      expect(homeGroup.open).toBe(false);
    });
  });

  it.each(["map", "inventory", "notes", "access"])("keeps Property navigation current on the %s subtab", (subtab) => {
    window.history.replaceState({}, "", `/properties/property-main/${subtab}`);
    render(
      <I18nProvider>
        <AppShell
          page="properties"
          onPage={vi.fn()}
          connection="live"
          units="metric"
          onUnits={vi.fn()}
          lastUpdated={null}
          dataMode="real"
          properties={[{ id: "property-main", name: "Main estate" }]}
          propertyId="property-main"
          houses={[]}
        >
          <div>Property content</div>
        </AppShell>
      </I18nProvider>,
    );

    expect(screen.getByRole("link", { name: "Property" })).toHaveAttribute("aria-current", "page");
    expect(screen.getByRole("link", { name: "Properties" })).not.toHaveAttribute("aria-current");
  });

  it("keeps Home sensors visible to a read-only guest while hiding setup and an ungranted Property contract", () => {
    render(
      <I18nProvider>
        <AppShell
          page="sensors"
          onPage={vi.fn()}
          connection="live"
          units="metric"
          onUnits={vi.fn()}
          lastUpdated={null}
          dataMode="real"
          readOnly
          propertyElectricityAvailable={false}
          properties={[{ id: "property-main", name: "Main estate" }]}
          propertyId="property-main"
          houses={[{ id: "home-main", propertyId: "property-main", name: "Main home", timezone: "Europe/Helsinki" }]}
          houseId="home-main"
        >
          <div>Sensor inventory</div>
        </AppShell>
      </I18nProvider>,
    );

    expect(screen.getByRole("link", { name: "Sensors" }).getAttribute("href"))
      .toBe("/properties/property-main/homes/home-main/sensors");
    expect(screen.queryByRole("link", { name: "Set up" })).toBeNull();
    expect(screen.queryByRole("link", { name: "Electricity" })).toBeNull();
  });

  it("shows Property electricity to a guest with an explicit Property grant", () => {
    render(
      <I18nProvider>
        <AppShell
          page="properties"
          onPage={vi.fn()}
          connection="live"
          units="metric"
          onUnits={vi.fn()}
          lastUpdated={null}
          dataMode="real"
          readOnly
          propertyElectricityAvailable
          properties={[{ id: "property-main", name: "Main estate" }]}
          propertyId="property-main"
        >
          <div>Property content</div>
        </AppShell>
      </I18nProvider>,
    );

    expect(screen.getByRole("link", { name: "Electricity" }).getAttribute("href"))
      .toBe("/properties/property-main/electricity");
  });

  it("stays usable when navigation preferences cannot be read or written", () => {
    vi.spyOn(Storage.prototype, "getItem").mockImplementation((key) => {
      if (key === "climate-twin-navigation") throw new DOMException("Storage blocked", "SecurityError");
      return null;
    });
    vi.spyOn(Storage.prototype, "setItem").mockImplementation((key) => {
      if (key === "climate-twin-navigation") throw new DOMException("Storage blocked", "SecurityError");
    });

    render(
      <I18nProvider>
        <AppShell
          page="properties"
          onPage={vi.fn()}
          connection="offline"
          units="metric"
          onUnits={vi.fn()}
          lastUpdated={null}
          dataMode="real"
        >
          <main>Workspace content</main>
        </AppShell>
      </I18nProvider>,
    );

    fireEvent.click(screen.getByRole("button", { name: "Hide navigation" }));
    expect(screen.getByRole("button", { name: "Show navigation" })).toBeTruthy();
  });
});
