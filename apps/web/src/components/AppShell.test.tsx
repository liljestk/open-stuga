import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { I18nProvider } from "../i18n";
import { AppShell } from "./AppShell";

afterEach(() => vi.restoreAllMocks());

describe("AppShell local account controls", () => {
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
    const homePicker = screen.getByLabelText("Home shown on this page") as HTMLSelectElement;
    expect(Array.from(homePicker.options, (option) => option.textContent)).toEqual(["Main home", "Guest home"]);
    expect(screen.queryByRole("option", { name: "Lake home" })).toBeNull();
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
    fireEvent.click(screen.getByRole("button", { name: "Sign out" }));
    await waitFor(() => expect(onLogout).toHaveBeenCalledOnce());
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
