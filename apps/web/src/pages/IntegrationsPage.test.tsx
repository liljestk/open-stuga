import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { House, IntegrationStatus } from "@climate-twin/contracts";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { api } from "../api";
import { I18nProvider } from "../i18n";
import { IntegrationsPage } from "./IntegrationsPage";

vi.mock("../components/HouseLocationMap", () => ({
  HouseLocationMap: ({ onChange, onSelect, ariaLabel, selectedHouseId, items }: {
    onChange: (houseId: string, location: { latitude: number; longitude: number }) => void;
    onSelect: (houseId: string) => void;
    ariaLabel: string;
    selectedHouseId: string;
    items: Array<{ id: string }>;
  }) => (
    <>
      <button type="button" aria-label={ariaLabel} onClick={() => onChange(selectedHouseId, { latitude: 61.5, longitude: 25.25 })}>Map</button>
      <button type="button" onClick={() => {
        const other = items.find((item) => item.id !== selectedHouseId);
        if (other) onSelect(other.id);
      }}>Select another home from map</button>
    </>
  ),
}));

const integration: IntegrationStatus = {
  homeAssistant: { configured: false, connected: false, lastEventAt: null, mappedEntities: 0, error: null },
  tpLink: { configured: false, connected: false, lastPollAt: null, mappedDevices: 0, discoveredDevices: 0, hubModel: null, error: null },
  webhook: { configured: false, lastDeliveryAt: null, error: null },
  mock: { enabled: true, intervalMs: 2000, mode: "demo", activatedAt: null },
  weather: { policy: "automatic", availableProviders: ["fmi", "open-meteo"], provider: "fmi", configuredHouses: 1, lastSuccessAt: "2026-01-01T20:00:00.000Z", error: null },
};

const house: House = {
  id: "house-coast",
  name: "Coast house",
  timezone: "Europe/Helsinki",
  location: { latitude: 60.17, longitude: 24.94, label: "Helsinki" },
  floors: [],
  createdAt: "2026-01-01T00:00:00.000Z",
  updatedAt: "2026-01-01T00:00:00.000Z",
};

function renderPage(overrides: Partial<React.ComponentProps<typeof IntegrationsPage>> = {}) {
  localStorage.setItem("climate-twin-locale", "en");
  const props: React.ComponentProps<typeof IntegrationsPage> = {
    integration,
    house,
    houses: [house],
    units: "metric",
    onHouse: vi.fn(),
    onHouseUpdate: vi.fn().mockResolvedValue(undefined),
    onGeoreferenceChange: vi.fn().mockResolvedValue(undefined),
    onIntegrationChange: vi.fn(),
    ...overrides,
  };
  return { ...render(<I18nProvider><IntegrationsPage {...props} /></I18nProvider>), props };
}

beforeEach(() => window.history.replaceState(null, "", "/setup/overview"));
afterEach(() => vi.restoreAllMocks());

describe("Setup workspace", () => {
  it("opens on a side-effect-free overview and keeps operational weather out of every section", async () => {
    const user = userEvent.setup();
    const weatherSpy = vi.spyOn(api, "houseWeather");
    const locationSearchSpy = vi.spyOn(api, "searchLocations");
    renderPage();

    expect(screen.getByRole("tab", { name: /Overview/ }).getAttribute("aria-selected")).toBe("true");
    expect(screen.queryByRole("button", { name: "Map for placing all houses" })).toBeNull();
    expect(screen.queryByRole("table")).toBeNull();
    expect(weatherSpy).not.toHaveBeenCalled();

    await user.click(screen.getByRole("tab", { name: /Weather/ }));
    expect(screen.getByRole("heading", { name: "Weather and system configuration" })).not.toBeNull();
    expect(screen.getAllByText("Europe/Helsinki").length).toBeGreaterThan(0);
    expect(screen.queryByRole("table")).toBeNull();
    expect(screen.queryByText("Current conditions")).toBeNull();
    expect(weatherSpy).not.toHaveBeenCalled();
    expect(locationSearchSpy).not.toHaveBeenCalled();
  });

  it("discovers the LAN once on first opening Connections and keeps an explicit retry", async () => {
    const user = userEvent.setup();
    let finishScan!: (result: Awaited<ReturnType<typeof api.discoverIntegrations>>) => void;
    const firstScan = new Promise<Awaited<ReturnType<typeof api.discoverIntegrations>>>((resolve) => { finishScan = resolve; });
    const emptyResult = { tpLink: [], homeAssistant: [], warnings: [] };
    const scan = vi.spyOn(api, "discoverIntegrations").mockReturnValueOnce(firstScan).mockResolvedValue(emptyResult);
    renderPage();

    expect(scan).not.toHaveBeenCalled();
    await user.click(screen.getByRole("tab", { name: /Connections/ }));
    await waitFor(() => expect(scan).toHaveBeenCalledTimes(1));
    expect(screen.getByRole("button", { name: /Looking for devices/ })).not.toBeNull();
    finishScan(emptyResult);
    expect(await screen.findByRole("button", { name: "Find devices" })).not.toBeNull();

    await user.click(screen.getByRole("tab", { name: /Homes/ }));
    await user.click(screen.getByRole("tab", { name: /Connections/ }));
    expect(scan).toHaveBeenCalledTimes(1);
    await user.click(screen.getByRole("button", { name: "Find devices" }));
    await waitFor(() => expect(scan).toHaveBeenCalledTimes(2));
  });

  it("restores and encodes the active Setup section in the URL", async () => {
    const user = userEvent.setup();
    window.history.replaceState(null, "", "/setup/weather?source=test");
    renderPage();

    expect(screen.getByRole("tab", { name: /Weather/ }).getAttribute("aria-selected")).toBe("true");
    await user.click(screen.getByRole("tab", { name: /Homes/ }));
    expect(window.location.pathname).toBe("/setup/homes");
    expect(window.location.search).toBe("?source=test");

    window.history.pushState(null, "", "/setup/overview?source=test");
    window.dispatchEvent(new PopStateEvent("popstate"));
    await waitFor(() => expect(screen.getByRole("tab", { name: /Overview/ }).getAttribute("aria-selected")).toBe("true"));
  });

  it("uses discovery first, then reveals manual credentials in Connections", async () => {
    const user = userEvent.setup();
    vi.spyOn(api, "discoverIntegrations").mockResolvedValue({
      tpLink: [{ host: "192.168.1.42", model: "H200", alias: "Hall hub" }],
      homeAssistant: [{ name: "Our home", url: "http://homeassistant.local:8123", host: "192.168.1.20", port: 8123, version: "2026.7.1" }],
      warnings: [],
    });
    const realIntegration: IntegrationStatus = {
      ...integration,
      tpLink: { ...integration.tpLink, configured: true },
      mock: { ...integration.mock, enabled: false, mode: "real", activatedAt: "2026-07-14T12:00:00.000Z" },
    };
    const configure = vi.spyOn(api, "configureTpLink").mockResolvedValue({ ok: true, configured: true, integration: realIntegration });
    const rendered = renderPage();

    expect(screen.queryByLabelText("Hub address")).toBeNull();
    await user.click(screen.getByRole("button", { name: "Find devices" }));
    await user.click(await screen.findByRole("button", { name: "Review 2 found" }));
    expect(screen.getByRole("tab", { name: /Connections/ }).getAttribute("aria-selected")).toBe("true");

    const directSection = screen.getByRole("heading", { name: "Poll T310/T315 child sensors locally without running Home Assistant." }).closest("section")!;
    const manualSettings = within(directSection).getByText("Advanced connection settings");
    expect((manualSettings.closest("details") as HTMLDetailsElement).open).toBe(false);
    await user.click(within(directSection).getByRole("radio", { name: /Hall hub/ }));
    await user.click(manualSettings);

    expect((within(directSection).getByLabelText("Hub address") as HTMLInputElement).value).toBe("192.168.1.42");
    await user.type(within(directSection).getByLabelText("TP-Link account email"), "person@example.test");
    const password = within(directSection).getByLabelText("TP-Link account password") as HTMLInputElement;
    expect(password.type).toBe("password");
    await user.type(password, "local-secret");
    await user.click(within(directSection).getByLabelText("Show credential"));
    expect(password.type).toBe("text");
    await user.click(within(directSection).getByRole("button", { name: "Save and connect" }));

    await waitFor(() => expect(configure).toHaveBeenCalledWith({
      host: "192.168.1.42",
      username: "person@example.test",
      password: "local-secret",
    }));
    expect(within(directSection).getByRole("status").textContent).toContain("Credentials saved on this server");
    expect(rendered.props.onIntegrationChange).toHaveBeenCalledWith(realIntegration);
  });

  it("loads map tiles only after explicit consent and supports multiple homes", async () => {
    const user = userEvent.setup();
    const { location: _location, ...houseWithoutLocation } = house;
    const noLocation: House = houseWithoutLocation;
    const secondHouse: House = { ...houseWithoutLocation, id: "house-lake", name: "Lake house" };
    const onGeoreferenceChange = vi.fn().mockResolvedValue(undefined);
    const onHouse = vi.fn();
    renderPage({ house: noLocation, houses: [noLocation, secondHouse], onHouse, onGeoreferenceChange });

    await user.click(screen.getByRole("tab", { name: /Homes/ }));
    expect(screen.getByText("Load the interactive map when you need it")).not.toBeNull();
    expect(screen.queryByRole("button", { name: "Map for placing all houses" })).toBeNull();
    await user.selectOptions(screen.getByRole("combobox", { name: "House" }), secondHouse.id);
    expect((screen.getByRole("combobox", { name: "House" }) as HTMLSelectElement).value).toBe(secondHouse.id);
    expect(onHouse).toHaveBeenCalledWith(secondHouse.id);

    await user.click(screen.getByRole("button", { name: "Load interactive map" }));
    await user.click(screen.getByRole("button", { name: "Map for placing all houses" }));
    await user.click(screen.getByText("Advanced placement and orientation"));
    expect((screen.getByRole("spinbutton", { name: "Latitude" }) as HTMLInputElement).value).toBe("61.5000000");
    expect((screen.getByRole("spinbutton", { name: "Longitude" }) as HTMLInputElement).value).toBe("25.2500000");
    await user.click(screen.getByRole("button", { name: "Save placement" }));

    await waitFor(() => expect(onGeoreferenceChange).toHaveBeenCalledWith(secondHouse.id, {
      mapPlacement: { latitude: 61.5, longitude: 25.25, metersPerPlanUnit: 12 },
    }));
    expect(screen.getByText("House placement and scale saved.")).not.toBeNull();

    await user.click(screen.getByRole("button", { name: "Select another home from map" }));
    expect(onHouse).toHaveBeenLastCalledWith(noLocation.id);
  });

  it("keeps weather references configurable per home without fetching a forecast", async () => {
    const user = userEvent.setup();
    const weatherSpy = vi.spyOn(api, "houseWeather");
    vi.spyOn(api, "searchLocations").mockResolvedValue([{
      id: "5879400",
      name: "Anchorage",
      label: "Anchorage, Alaska, United States",
      latitude: 61.2181,
      longitude: -149.9003,
      timezone: "America/Anchorage",
      countryCode: "US",
      country: "United States",
      region: "Alaska",
      source: "open-meteo-geocoding",
      confidence: "high",
    }]);
    const coordinateDefaults = vi.spyOn(api, "coordinateDefaults").mockResolvedValue({
      timezone: "America/Anchorage",
      source: "open-meteo-coordinate",
    });
    const onGeoreferenceChange = vi.fn().mockResolvedValue(undefined);
    const onHouseUpdate = vi.fn().mockResolvedValue(undefined);
    const placedHouse: House = {
      ...house,
      mapPlacement: { latitude: 62.25, longitude: -149.5, metersPerPlanUnit: 1.2 },
    };
    const worldHouse: House = { ...house, id: "house-world", name: "World house", timezone: "America/Anchorage" };
    renderPage({ house: placedHouse, houses: [placedHouse, worldHouse], onHouseUpdate, onGeoreferenceChange });

    await user.click(screen.getByRole("tab", { name: /Weather/ }));
    expect(screen.getAllByText("Automatic weather").length).toBeGreaterThan(0);
    expect(screen.getByText("Automatic (FMI in Finland, Open-Meteo worldwide)")).not.toBeNull();
    expect(screen.getAllByText("Europe/Helsinki").length).toBeGreaterThan(0);
    expect(screen.queryByRole("table")).toBeNull();
    expect(weatherSpy).not.toHaveBeenCalled();

    await user.click(screen.getByRole("button", { name: "Sync from home placement" }));
    await waitFor(() => expect(onHouseUpdate).toHaveBeenCalledWith(placedHouse.id, {
      location: expect.objectContaining({
        latitude: 62.25,
        longitude: -149.5,
        source: "map-placement",
        confidence: "high",
        userOverridden: false,
      }),
      timezone: "America/Anchorage",
    }));
    expect(coordinateDefaults).toHaveBeenCalledWith(62.25, -149.5);

    await user.clear(screen.getByLabelText("Find this home"));
    await user.type(screen.getByLabelText("Find this home"), "Anchorage");
    await user.click(screen.getByRole("button", { name: "Search" }));
    await user.click(await screen.findByRole("button", { name: "Use this setup" }));
    await waitFor(() => expect(onHouseUpdate).toHaveBeenCalledWith(placedHouse.id, {
      location: expect.objectContaining({ latitude: 61.2181, longitude: -149.9003, label: "Anchorage, Alaska, United States", source: "place-search" }),
      timezone: "America/Anchorage",
    }));

    await user.selectOptions(screen.getByRole("combobox", { name: "House" }), worldHouse.id);
    expect((screen.getByRole("combobox", { name: "House" }) as HTMLSelectElement).value).toBe(worldHouse.id);
    expect(screen.getByText(/Configure the weather reference and system behavior for World house/)).not.toBeNull();
    expect(screen.getAllByText("America/Anchorage").length).toBeGreaterThan(0);
  });

  it("follows global home changes while reporting local Setup selections", async () => {
    const user = userEvent.setup();
    const secondHouse: House = { ...house, id: "house-world", name: "World house", timezone: "America/Anchorage" };
    const onHouse = vi.fn();
    const rendered = renderPage({ houses: [house, secondHouse], onHouse });

    await user.click(screen.getByRole("tab", { name: /Weather/ }));
    await user.selectOptions(screen.getByRole("combobox", { name: "House" }), secondHouse.id);
    expect(onHouse).toHaveBeenCalledWith(secondHouse.id);

    rendered.rerender(
      <I18nProvider>
        <IntegrationsPage {...rendered.props} house={secondHouse} />
      </I18nProvider>,
    );
    await waitFor(() => expect((screen.getByRole("combobox", { name: "House" }) as HTMLSelectElement).value).toBe(secondHouse.id));

    rendered.rerender(
      <I18nProvider>
        <IntegrationsPage {...rendered.props} house={house} />
      </I18nProvider>,
    );
    await waitFor(() => expect((screen.getByRole("combobox", { name: "House" }) as HTMLSelectElement).value).toBe(house.id));
  });

  it("names progress and keeps every Setup tab linked to an existing panel", () => {
    renderPage();

    const progress = screen.getByRole("progressbar", { name: "Setup progress" });
    expect(progress.getAttribute("aria-valuetext")).toMatch(/^\d+ \/ 4$/);
    for (const tab of screen.getAllByRole("tab")) {
      const panelId = tab.getAttribute("aria-controls");
      expect(panelId).toBeTruthy();
      expect(document.getElementById(panelId!)).not.toBeNull();
    }
  });

  it("identifies invalid manual coordinates and timezone with actionable field feedback", async () => {
    const user = userEvent.setup();
    const onHouseUpdate = vi.fn().mockResolvedValue(undefined);
    renderPage({ onHouseUpdate });

    await user.click(screen.getByRole("tab", { name: /Weather/ }));
    await user.click(screen.getByText("Advanced weather location"));
    const latitude = screen.getByRole("spinbutton", { name: "Latitude" });
    const timezone = screen.getByRole("textbox", { name: "Timezone" });
    await user.clear(latitude);
    await user.type(latitude, "100");
    await user.clear(timezone);
    await user.type(timezone, "Invalid/Zone");
    await user.click(screen.getByRole("button", { name: "Save location" }));

    expect(latitude.getAttribute("aria-invalid")).toBe("true");
    expect(latitude.getAttribute("aria-describedby")).toBe("weather-coordinate-error");
    expect(timezone.getAttribute("aria-invalid")).toBe("true");
    expect(timezone.getAttribute("aria-describedby")).toBe("weather-timezone-error");
    expect(screen.getByText(/latitude from −90 to 90/)).not.toBeNull();
    expect(screen.getByText(/valid IANA timezone/)).not.toBeNull();
    expect(onHouseUpdate).not.toHaveBeenCalled();

    await user.clear(latitude);
    await user.type(latitude, "60.17");
    await user.clear(timezone);
    await user.type(timezone, "UTC");
    await user.click(screen.getByRole("button", { name: "Save location" }));
    await waitFor(() => expect(onHouseUpdate).toHaveBeenCalledWith(house.id, expect.objectContaining({ timezone: "UTC" })));
  });

  it("supports keyboard navigation between Setup tabs", async () => {
    const user = userEvent.setup();
    renderPage();
    const overview = screen.getByRole("tab", { name: /Overview/ });
    overview.focus();

    await user.keyboard("{ArrowRight}");
    await waitFor(() => expect(document.activeElement).toBe(screen.getByRole("tab", { name: /Homes/ })));
    expect(screen.getByRole("tab", { name: /Homes/ }).getAttribute("aria-selected")).toBe("true");
    await user.keyboard("{End}");
    await waitFor(() => expect(document.activeElement).toBe(screen.getByRole("tab", { name: /Weather/ })));
  });
});
