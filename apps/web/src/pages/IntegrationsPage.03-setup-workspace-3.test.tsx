import { act, fireEvent, screen, waitFor, within } from "@testing-library/react";

import userEvent from "@testing-library/user-event";

import type { House, IntegrationStatus } from "@climate-twin/contracts";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { api } from "../api";
import { confirmAction } from "../components/ConfirmationProvider";

import { I18nProvider } from "../i18n";

import { IntegrationsPage } from "./IntegrationsPage";

import { connectedTpLink, deferred, historyAutomation, house, integration, renderPage } from "./IntegrationsPageTestSupport";

async function openAdvancedWeather(user: ReturnType<typeof userEvent.setup>) {
  const advanced = screen.getByText("Advanced setup").closest("details")!;
  if (!advanced.open) await user.click(within(advanced).getByText("Advanced setup"));
  await user.click(within(advanced).getByRole("button", { name: /Weather/ }));
}

async function openManualWeather(user: ReturnType<typeof userEvent.setup>) {
  const details = document.querySelector<HTMLDetailsElement>(".weather-reference-details")!;
  if (!details.open) await user.click(within(details).getByText("Advanced weather location"));
}

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

vi.mock("../components/ConfirmationProvider", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../components/ConfirmationProvider")>();
  return { ...actual, confirmAction: vi.fn().mockResolvedValue(true) };
});

beforeEach(() => {
  window.history.replaceState(null, "", "/setup/overview");
  vi.mocked(confirmAction).mockReset().mockResolvedValue(true);
  vi.spyOn(api, "testTpLinkDraft").mockResolvedValue({ ok: true, message: "Connected" });
  vi.spyOn(api, "testHomeAssistantDraft").mockResolvedValue({ ok: true, message: "Connected" });
  vi.spyOn(api, "tpLinkHistoryExportJobs").mockResolvedValue({ enabled: false, automation: historyAutomation, jobs: [] });
  vi.spyOn(api, "tpLinkDevices").mockResolvedValue([]);
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("Setup workspace", () => {
  it("derives distinct completion states and presents one recommended action", async () => {
    const user = userEvent.setup();
    const onOpenSensors = vi.fn();
    const almostComplete: IntegrationStatus = {
      ...integration,
      tpLink: {
        ...integration.tpLink,
        configured: true,
        connected: true,
        discoveredDevices: 2,
        mappedDevices: 0,
      },
    };
    const rendered = renderPage({ integration: almostComplete, onOpenSensors });

    expect(screen.getByRole("progressbar", { name: "Setup progress" }).getAttribute("aria-valuenow")).toBe("2");
    expect(screen.getByRole("heading", { level: 2, name: "Review the readings" })).not.toBeNull();
    const checklist = screen.getByText("Review setup checklist").closest("details")!;
    expect(checklist.hasAttribute("open")).toBe(false);
    await user.click(screen.getByRole("button", { name: "Add sensor" }));
    expect(onOpenSensors).toHaveBeenCalledOnce();

    const complete = { ...almostComplete, tpLink: { ...almostComplete.tpLink, mappedDevices: 2 } };
    rendered.rerender(<I18nProvider><IntegrationsPage {...rendered.props} integration={complete} /></I18nProvider>);
    expect(screen.getByRole("heading", { name: "Setup complete" })).not.toBeNull();
    expect(screen.queryByRole("button", { name: "Add sensor" })).toBeNull();
    expect(screen.getByText("Sensor data is connected and mapped.")).not.toBeNull();
  });

  it.each([
    ["an empty search", { tpLink: [], homeAssistant: [], warnings: [] }],
    ["a failed search", new Error("Network search unavailable")],
  ])("retries the recommended device search after %s", async (_label, outcome) => {
    const user = userEvent.setup();
    vi.spyOn(api, "latestIntegrationDiscovery").mockResolvedValue(null);
    const scan = vi.spyOn(api, "discoverIntegrations");
    if (outcome instanceof Error) scan.mockRejectedValue(outcome);
    else scan.mockResolvedValue(outcome);
    renderPage();

    await user.click(screen.getByRole("button", { name: "Find devices" }));
    await waitFor(() => expect(scan).toHaveBeenCalledTimes(1));
    await screen.findByRole("button", { name: "Find devices" });

    await user.click(screen.getByRole("tab", { name: /Overview/ }));
    await user.click(screen.getByRole("button", { name: "Find devices" }));
    await waitFor(() => expect(scan).toHaveBeenCalledTimes(2));
  });

  it("keeps specialist setup available without putting it in the primary path", async () => {
    const user = userEvent.setup();
    renderPage();

    expect(screen.getAllByRole("tab")).toHaveLength(3);
    const advanced = screen.getByText("Advanced setup").closest("details")!;
    expect(advanced.hasAttribute("open")).toBe(false);
    expect(screen.getByRole("link", { name: "Go to Home" }).getAttribute("href")).toContain(`/homes/${house.id}`);

    await user.click(screen.getByText("Advanced setup"));
    expect(screen.getByRole("button", { name: /Weather/ })).not.toBeNull();
    expect(screen.getByRole("button", { name: /Sensor mapping/ })).not.toBeNull();
    expect(screen.getByRole("button", { name: /Automations/ })).not.toBeNull();
  });

  it("identifies invalid manual coordinates and timezone with actionable field feedback", async () => {
    const user = userEvent.setup();
    const onHouseUpdate = vi.fn().mockResolvedValue(undefined);
    renderPage({ onHouseUpdate });

    await openAdvancedWeather(user);
    await openManualWeather(user);
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
    await waitFor(() => expect(document.activeElement).toBe(screen.getByRole("tab", { name: /Layout & rooms/ })));
    expect(screen.getByRole("tab", { name: /Layout & rooms/ }).getAttribute("aria-selected")).toBe("true");
    await user.keyboard("{End}");
    await waitFor(() => expect(document.activeElement).toBe(screen.getByRole("tab", { name: /Where readings come from/ })));
  });

  it("uses pushed status for an already-configured hub without a duplicate waiting state", async () => {
    vi.useFakeTimers();
    window.history.replaceState(null, "", "/setup/connections");
    const connectedWithoutChildren: IntegrationStatus = {
      ...integration,
      tpLink: {
        ...integration.tpLink,
        configured: true,
        connected: true,
        discoveredDevices: 0,
        hubModel: "H200",
      },
      mock: { ...integration.mock, enabled: false, mode: "real", activatedAt: "2026-07-14T12:00:00.000Z" },
    };
    vi.spyOn(api, "discoverIntegrations").mockResolvedValue({ tpLink: [], homeAssistant: [], warnings: [] });
    const status = vi.spyOn(api, "integrations").mockResolvedValue(connectedWithoutChildren);
    const refreshTpLinkDevices = vi.fn().mockResolvedValue([]);
    const rendered = renderPage({ integration: connectedWithoutChildren, onRefreshTpLinkDevices: refreshTpLinkDevices });

    await act(async () => { await Promise.resolve(); await Promise.resolve(); });
    const setupStatus = screen.getByRole("region", { name: "TP-Link setup status" });
    expect(within(setupStatus).queryByText("Waiting for H200 to report paired sensors…")).toBeNull();

    await act(async () => { await vi.advanceTimersByTimeAsync(30_000); });

    expect(refreshTpLinkDevices).not.toHaveBeenCalled();
    expect(status).not.toHaveBeenCalled();
    rendered.rerender(<I18nProvider><IntegrationsPage
      {...rendered.props}
      integration={{
        ...connectedWithoutChildren,
        tpLink: { ...connectedWithoutChildren.tpLink, discoveredDevices: 2 },
      }}
    /></I18nProvider>);
    expect(within(setupStatus).getByText("TP-Link devices to set up: 2")).not.toBeNull();
  });

  it("reports a server-pushed hub failure without retry polling", async () => {
    vi.useFakeTimers();
    window.history.replaceState(null, "", "/setup/connections");
    const connectedWithoutChildren: IntegrationStatus = {
      ...integration,
      tpLink: {
        ...integration.tpLink,
        configured: true,
        connected: false,
        discoveredDevices: 0,
        hubModel: "H200",
        error: "Inventory unavailable",
      },
    };
    vi.spyOn(api, "discoverIntegrations").mockResolvedValue({ tpLink: [], homeAssistant: [], warnings: [] });
    const status = vi.spyOn(api, "integrations").mockResolvedValue(connectedWithoutChildren);
    const refreshTpLinkDevices = vi.fn().mockRejectedValue(new Error("Inventory unavailable"));
    renderPage({ integration: connectedWithoutChildren, onRefreshTpLinkDevices: refreshTpLinkDevices });

    await act(async () => { await Promise.resolve(); await Promise.resolve(); });
    await act(async () => { await vi.advanceTimersByTimeAsync(30_000); });

    const setupStatus = screen.getByRole("region", { name: "TP-Link setup status" });
    expect(refreshTpLinkDevices).not.toHaveBeenCalled();
    expect(status).not.toHaveBeenCalled();
    expect(within(setupStatus).getByText("The saved connection needs attention")).not.toBeNull();
    expect(within(setupStatus).getByText("Inventory unavailable")).not.toBeNull();
  });

  it("does not start child-inventory polling when entering or leaving Connections", async () => {
    vi.useFakeTimers();
    window.history.replaceState(null, "", "/setup/connections");
    const connectedWithoutChildren = connectedTpLink({ discoveredDevices: 0 });
    vi.spyOn(api, "discoverIntegrations").mockResolvedValue({ tpLink: [], homeAssistant: [], warnings: [] });
    const status = vi.spyOn(api, "integrations").mockResolvedValue(connectedWithoutChildren);
    const refreshTpLinkDevices = vi.fn().mockResolvedValue([]);
    renderPage({ integration: connectedWithoutChildren, onRefreshTpLinkDevices: refreshTpLinkDevices });

    await act(async () => { await Promise.resolve(); await Promise.resolve(); });
    expect(refreshTpLinkDevices).not.toHaveBeenCalled();
    expect(status).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole("tab", { name: /Overview/ }));
    await act(async () => { await vi.advanceTimersByTimeAsync(30_000); });

    expect(refreshTpLinkDevices).not.toHaveBeenCalled();
    expect(status).not.toHaveBeenCalled();
  });

  it("keeps home placement in the Property workspace instead of Setup", () => {
    renderPage();
    expect(screen.queryByRole("tab", { name: /Homes/ })).toBeNull();
    expect(screen.queryByRole("button", { name: "Save placement" })).toBeNull();
    expect(screen.getByRole("tab", { name: /Layout & rooms/ })).not.toBeNull();
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

    await openAdvancedWeather(user);
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
        userOverridden: true,
      }),
      timezone: "America/Anchorage",
    }));
    expect(coordinateDefaults).toHaveBeenCalledWith(62.25, -149.5);

    await user.click(screen.getByRole("button", { name: "Change weather location" }));
    await user.clear(screen.getByLabelText("Find this home"));
    await user.type(screen.getByLabelText("Find this home"), "Anchorage");
    await user.click(screen.getByRole("button", { name: "Search" }));
    await user.click(await screen.findByRole("button", { name: "Use this setup" }));
    await waitFor(() => expect(onHouseUpdate).toHaveBeenCalledWith(placedHouse.id, {
      location: expect.objectContaining({ latitude: 61.2181, longitude: -149.9003, label: "Anchorage, Alaska, United States", source: "place-search" }),
      timezone: "America/Anchorage",
    }));

    await user.selectOptions(screen.getByRole("combobox", { name: "Home" }), worldHouse.id);
    expect((screen.getByRole("combobox", { name: "Home" }) as HTMLSelectElement).value).toBe(worldHouse.id);
    expect(screen.getAllByText(/Override the Property weather location/).length).toBeGreaterThan(0);
    expect(screen.getAllByText("America/Anchorage").length).toBeGreaterThan(0);
  });

  it("keeps coordinate defaults from an old home out of the newly selected home form", async () => {
    const user = userEvent.setup();
    const firstHouse: House = {
      ...house,
      mapPlacement: { latitude: 62.25, longitude: -149.5, metersPerPlanUnit: 1.2 },
    };
    const secondHouse: House = {
      ...house,
      id: "house-world",
      name: "World house",
      timezone: "America/Anchorage",
      location: { latitude: 61.2181, longitude: -149.9003, label: "Anchorage" },
    };
    const defaults = deferred<Awaited<ReturnType<typeof api.coordinateDefaults>>>();
    vi.spyOn(api, "coordinateDefaults").mockReturnValue(defaults.promise);
    const onHouseUpdate = vi.fn().mockResolvedValue(undefined);
    renderPage({ house: firstHouse, houses: [firstHouse, secondHouse], onHouseUpdate });

    await openAdvancedWeather(user);
    await user.click(screen.getByRole("button", { name: "Sync from home placement" }));
    await waitFor(() => expect(api.coordinateDefaults).toHaveBeenCalledWith(62.25, -149.5));
    await user.selectOptions(screen.getByRole("combobox", { name: "Home" }), secondHouse.id);
    await openManualWeather(user);
    expect((screen.getByRole("spinbutton", { name: "Latitude" }) as HTMLInputElement).value).toBe("61.2181");

    await act(async () => {
      defaults.resolve({ timezone: "Pacific/Honolulu", source: "open-meteo-coordinate" });
      await defaults.promise;
      await Promise.resolve();
    });

    expect(onHouseUpdate).toHaveBeenCalledWith(firstHouse.id, expect.objectContaining({ timezone: "Pacific/Honolulu" }));
    expect((screen.getByRole("spinbutton", { name: "Latitude" }) as HTMLInputElement).value).toBe("61.2181");
    expect((screen.getByRole("textbox", { name: "Timezone" }) as HTMLInputElement).value).toBe("America/Anchorage");
    expect(screen.queryByText("Home location saved. Weather data is updating.")).toBeNull();
  });

  it("follows global home changes while reporting local Setup selections", async () => {
    const user = userEvent.setup();
    const secondHouse: House = { ...house, id: "house-world", name: "World house", timezone: "America/Anchorage" };
    const onHouse = vi.fn();
    const rendered = renderPage({ houses: [house, secondHouse], onHouse });

    await openAdvancedWeather(user);
    await user.selectOptions(screen.getByRole("combobox", { name: "Home" }), secondHouse.id);
    expect(onHouse).toHaveBeenCalledWith(secondHouse.id);

    rendered.rerender(
      <I18nProvider>
        <IntegrationsPage {...rendered.props} house={secondHouse} />
      </I18nProvider>,
    );
    await waitFor(() => expect((screen.getByRole("combobox", { name: "Home" }) as HTMLSelectElement).value).toBe(secondHouse.id));

    rendered.rerender(
      <I18nProvider>
        <IntegrationsPage {...rendered.props} house={house} />
      </I18nProvider>,
    );
    await waitFor(() => expect((screen.getByRole("combobox", { name: "Home" }) as HTMLSelectElement).value).toBe(house.id));
  });

  it("names progress and keeps every Setup tab linked to an existing panel", () => {
    renderPage();

    const progress = screen.getByRole("progressbar", { name: "Setup progress" });
    expect(progress.getAttribute("aria-valuetext")).toMatch(/^\d+ \/ 3$/);
    for (const tab of screen.getAllByRole("tab")) {
      const panelId = tab.getAttribute("aria-controls");
      expect(panelId).toBeTruthy();
      expect(document.getElementById(panelId!)).not.toBeNull();
    }
  });

  it("opens the manual TP-Link fallback when network discovery fails", async () => {
    const user = userEvent.setup();
    vi.spyOn(api, "discoverIntegrations").mockRejectedValue(new Error("Discovery helper unavailable"));
    renderPage();

    await user.click(screen.getByRole("tab", { name: /Where readings come from/ }));
    await user.click(screen.getByRole("button", { name: "Find devices" }));
    const directSection = screen.getByRole("heading", { name: "Connect TP-Link directly" }).closest("section")!;
    expect(await within(directSection).findByText(/Automatic discovery did not provide a supported TP-Link source/)).not.toBeNull();
    expect(screen.getByText("Device search could not finish.")).not.toBeNull();
    expect(within(directSection).getByLabelText("Hub or energy-device address")).not.toBeNull();
    expect(directSection.querySelector<HTMLDetailsElement>(".setup-config-disclosure")?.open).toBe(true);
    expect(screen.queryByText("Discovery helper unavailable")).toBeNull();

    await user.click(within(directSection).getByText("Enter an address manually"));
    await waitFor(() => expect(directSection.querySelector<HTMLDetailsElement>(".setup-config-disclosure")?.open).toBe(false));
  });

  it("reports a completed scan with no results instead of silently resetting", async () => {
    const user = userEvent.setup();
    vi.spyOn(api, "discoverIntegrations").mockResolvedValue({ tpLink: [], homeAssistant: [], warnings: [] });
    renderPage();

    await user.click(screen.getByRole("tab", { name: /Where readings come from/ }));
    await user.click(screen.getByRole("button", { name: "Find devices" }));

    expect(await screen.findByText("Search finished — no systems found.")).not.toBeNull();
    expect(screen.getByText(/Nothing was found automatically/)).not.toBeNull();
    expect(screen.getByRole("button", { name: "Find devices" })).not.toBeNull();
  });

  it("restores and encodes the active Setup section in the URL", async () => {
    const user = userEvent.setup();
    const setupBase = "/properties/property-pine/homes/house-pine/setup";
    window.history.replaceState(null, "", `${setupBase}/weather?source=test`);
    renderPage();

    expect(screen.getByRole("button", { name: /Weather/ }).getAttribute("aria-current")).toBe("page");
    await user.click(screen.getByRole("tab", { name: /Layout & rooms/ }));
    expect(window.location.pathname).toBe(`${setupBase}/layout`);
    expect(window.location.search).toBe("?source=test");

    window.history.pushState(null, "", `${setupBase}/overview?source=test`);
    window.dispatchEvent(new PopStateEvent("popstate"));
    await waitFor(() => expect(screen.getByRole("tab", { name: /Overview/ }).getAttribute("aria-selected")).toBe("true"));
  });
});
