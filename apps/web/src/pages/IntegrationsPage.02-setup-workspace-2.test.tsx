import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";

import userEvent from "@testing-library/user-event";

import type { House, IntegrationStatus, TpLinkDiscoveredDevice } from "@climate-twin/contracts";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { api } from "../api";

import { I18nProvider } from "../i18n";

import { IntegrationsPage } from "./IntegrationsPage";

import { connectedTpLink, deferred, discoveredChild, historyAutomation, house, integration, renderPage } from "./IntegrationsPageTestSupport";

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

beforeEach(() => {
  window.history.replaceState(null, "", "/setup/overview");
  vi.spyOn(window, "confirm").mockReturnValue(true);
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
    vi.spyOn(api, "integrations").mockResolvedValue({
      ...realIntegration,
      tpLink: { ...realIntegration.tpLink, connected: true, discoveredDevices: 1, hubModel: "H200" },
    });
    const refreshTpLinkDevices = vi.fn().mockResolvedValue([discoveredChild]);
    const rendered = renderPage({ onRefreshTpLinkDevices: refreshTpLinkDevices });

    expect(screen.queryByLabelText("Hub or energy-device address")).toBeNull();
    await user.click(screen.getByRole("button", { name: "Find devices" }));
    expect(await screen.findByText("Connection options found: 2.")).not.toBeNull();
    expect(screen.getByRole("tab", { name: /Where readings come from/ }).getAttribute("aria-selected")).toBe("true");
    expect(screen.queryByRole("button", { name: "Review 2 found" })).toBeNull();

    const directSection = screen.getByRole("heading", { name: "Connect TP-Link directly" }).closest("section")!;
    const discoveredSettings = directSection.querySelector<HTMLDetailsElement>(".setup-config-disclosure")!;
    expect(discoveredSettings.open).toBe(true);
    expect(discoveredSettings.querySelector("summary")?.textContent).toContain("Hall hub");
    expect(within(directSection).queryByText("Enter an address manually")).toBeNull();

    expect((within(directSection).getByLabelText("Hub or energy-device address") as HTMLInputElement).value).toBe("192.168.1.42");
    await user.type(within(directSection).getByLabelText("TP-Link account email"), "person@example.test");
    const password = within(directSection).getByLabelText("TP-Link account password") as HTMLInputElement;
    expect(password.type).toBe("password");
    await user.type(password, "local-secret");
    await user.click(within(directSection).getByLabelText("Show credential"));
    expect(password.type).toBe("text");
    await user.click(within(directSection).getByRole("button", { name: "Check direct TP-Link connection" }));
    expect(await within(directSection).findByText("The server is polling the TP-Link hub or energy device directly.")).not.toBeNull();
    await user.click(within(directSection).getByRole("button", { name: "Save and connect" }));

    await waitFor(() => expect(configure).toHaveBeenCalledWith({
      houseId: "house-coast",
      host: "192.168.1.42",
      username: "person@example.test",
      password: "local-secret",
    }));
    expect(within(directSection).getByText(/Credentials saved on this server/)).not.toBeNull();
    expect(await within(directSection).findByText("Paired sensors found: 1.")).not.toBeNull();
    expect(refreshTpLinkDevices).toHaveBeenCalledOnce();
    expect(rendered.props.onIntegrationChange).toHaveBeenCalledWith(realIntegration);
  });

  it("does not overwrite a manual address entered while discovery is in flight", async () => {
    const user = userEvent.setup();
    const scan = deferred<Awaited<ReturnType<typeof api.discoverIntegrations>>>();
    vi.spyOn(api, "discoverIntegrations").mockReturnValue(scan.promise);
    renderPage();

    await user.click(screen.getByRole("tab", { name: /Where readings come from/ }));
    const directSection = screen.getByRole("heading", { name: "Connect TP-Link directly" }).closest("section")!;
    await user.click(directSection.querySelector("summary")!);
    await user.click(screen.getByRole("button", { name: "Find devices" }));
    const host = within(directSection).getByLabelText("Hub or energy-device address") as HTMLInputElement;
    await user.type(host, "192.168.1.99");

    await act(async () => {
      scan.resolve({
        tpLink: [{ host: "192.168.1.56", model: "H200", alias: "Hall hub" }],
        homeAssistant: [],
        warnings: [],
      });
      await scan.promise;
    });

    expect(host.value).toBe("192.168.1.99");
  });

  it("adds a different discovered source without overwriting the sole existing connection", async () => {
    const user = userEvent.setup();
    const configured = connectedTpLink({
      connected: false,
      error: "Unable to reach 192.168.1.42",
      connections: [{
        id: "legacy",
        houseId: house.id,
        configured: true,
        connected: false,
        lastPollAt: null,
        mappedDevices: 0,
        discoveredDevices: 0,
        hubModel: "H200",
        error: "Unable to reach 192.168.1.42",
      }],
    });
    vi.spyOn(api, "discoverIntegrations").mockResolvedValue({
      tpLink: [{ host: "192.168.1.56", model: "H200", alias: "Hall hub" }],
      homeAssistant: [],
      warnings: [],
    });
    const configure = vi.spyOn(api, "configureTpLink").mockResolvedValue({
      ok: true,
      configured: true,
      integration: configured,
    });
    vi.spyOn(api, "integrations").mockResolvedValue(configured);
    renderPage({ integration: configured, onRefreshTpLinkDevices: vi.fn().mockResolvedValue([]) });

    await user.click(screen.getByRole("tab", { name: /Where readings come from/ }));
    await user.click(screen.getByRole("button", { name: "Find additional systems" }));
    const directSection = screen.getByRole("heading", { name: "Connect TP-Link directly" }).closest("section")!;
    expect((await within(directSection).findByLabelText("Hub or energy-device address") as HTMLInputElement).value).toBe("192.168.1.56");
    await user.type(within(directSection).getByLabelText("TP-Link account email"), "person@example.test");
    await user.type(within(directSection).getByLabelText("TP-Link account password"), "local-secret");
    await user.click(within(directSection).getByRole("button", { name: "Check direct TP-Link connection" }));
    expect(await within(directSection).findByText("The server is polling the TP-Link hub or energy device directly.")).not.toBeNull();
    await user.click(within(directSection).getByRole("button", { name: "Save and connect" }));

    await waitFor(() => expect(configure).toHaveBeenCalledWith({
      houseId: house.id,
      host: "192.168.1.56",
      username: "person@example.test",
      password: "local-secret",
    }));
  });

  it("invalidates a successful connection check when its credential draft changes in flight", async () => {
    const user = userEvent.setup();
    vi.spyOn(api, "discoverIntegrations").mockResolvedValue({ tpLink: [], homeAssistant: [], warnings: [] });
    const check = deferred<{ ok: boolean; message: string }>();
    vi.spyOn(api, "testHomeAssistantDraft").mockReturnValueOnce(check.promise);
    const configure = vi.spyOn(api, "configureHomeAssistant");
    renderPage();

    await user.click(screen.getByRole("tab", { name: /Where readings come from/ }));
    const section = screen.getByRole("heading", { name: "Connect Home Assistant" }).closest("section")!;
    await user.click(section.querySelector("summary")!);
    await user.type(within(section).getByLabelText("Home Assistant URL"), "http://homeassistant.local:8123");
    const token = within(section).getByLabelText("Long-lived access token");
    await user.type(token, "first-token");
    await user.click(within(section).getByRole("button", { name: "Check server connection" }));
    await user.clear(token);
    await user.type(token, "changed-token");

    await act(async () => { check.resolve({ ok: true, message: "Connected" }); await check.promise; });
    expect(within(section).queryByText(/accepted the saved URL and token/i)).toBeNull();
    await user.click(within(section).getByRole("button", { name: "Save and connect" }));
    expect(within(section).getByRole("alert").textContent).toMatch(/check these unsaved credentials/i);
    expect(configure).not.toHaveBeenCalled();
  });

  it("waits through a bounded H200 child-discovery window and offers clear next actions", async () => {
    vi.useFakeTimers();
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
    vi.spyOn(api, "discoverIntegrations").mockResolvedValue({
      tpLink: [{ host: "192.168.1.42", model: "H200", alias: "Hall hub" }],
      homeAssistant: [],
      warnings: [],
    });
    vi.spyOn(api, "configureTpLink").mockResolvedValue({ ok: true, configured: true, integration: connectedWithoutChildren });
    vi.spyOn(api, "integrations").mockResolvedValue(connectedWithoutChildren);
    const refreshTpLinkDevices = vi.fn().mockResolvedValue([]);
    const onOpenSensors = vi.fn();
    const rendered = renderPage({ onRefreshTpLinkDevices: refreshTpLinkDevices, onOpenSensors });

    fireEvent.click(screen.getByRole("tab", { name: /Where readings come from/ }));
    fireEvent.click(screen.getByRole("button", { name: "Find devices" }));
    await act(async () => { await Promise.resolve(); await Promise.resolve(); });
    const directSection = screen.getByRole("heading", { name: "Connect TP-Link directly" }).closest("section")!;
    expect((within(directSection).getByRole("radio", { name: /Hall hub/ }) as HTMLInputElement).checked).toBe(true);
    expect(directSection.querySelector<HTMLDetailsElement>(".setup-config-disclosure")!.open).toBe(true);
    await act(async () => { await vi.advanceTimersByTimeAsync(0); });
    fireEvent.change(within(directSection).getByLabelText("TP-Link account email"), { target: { value: "person@example.test" } });
    fireEvent.change(within(directSection).getByLabelText("TP-Link account password"), { target: { value: "local-secret" } });
    fireEvent.click(within(directSection).getByRole("button", { name: "Check direct TP-Link connection" }));
    await act(async () => { await Promise.resolve(); await Promise.resolve(); });
    fireEvent.click(within(directSection).getByRole("button", { name: "Save and connect" }));
    await act(async () => { await Promise.resolve(); await Promise.resolve(); });
    rendered.rerender(<I18nProvider><IntegrationsPage {...rendered.props} integration={connectedWithoutChildren} /></I18nProvider>);

    const liveStatus = screen.getByRole("region", { name: "Live TP-Link status" });
    expect(within(liveStatus).getByText("Waiting for H200 to report paired sensors…")).not.toBeNull();
    expect(within(liveStatus).getByRole("progressbar", { name: "Child-device check 1 of 7" })).not.toBeNull();

    await act(async () => { await vi.advanceTimersByTimeAsync(30_000); });

    expect(refreshTpLinkDevices).toHaveBeenCalledTimes(7);
    expect(within(liveStatus).getByText("No paired sensors appeared yet.")).not.toBeNull();
    expect(within(liveStatus).getByRole("button", { name: "Check again" })).not.toBeNull();
    fireEvent.click(within(liveStatus).getByRole("button", { name: "Open Sensors" }));
    expect(onOpenSensors).toHaveBeenCalledOnce();
  });

  it("keeps post-save child polling alive while the configured hub is still connecting", async () => {
    vi.useFakeTimers();
    const connectingWithoutChildren = connectedTpLink({
      connected: false,
      lastPollAt: null,
      mappedDevices: 0,
      discoveredDevices: 0,
      hubModel: null,
    });
    const connectedWithoutChildren: IntegrationStatus = {
      ...connectingWithoutChildren,
      tpLink: { ...connectingWithoutChildren.tpLink, connected: true, hubModel: "H200" },
    };
    vi.spyOn(api, "discoverIntegrations").mockResolvedValue({
      tpLink: [{ host: "192.168.1.42", model: "H200", alias: "Hall hub" }],
      homeAssistant: [],
      warnings: [],
    });
    vi.spyOn(api, "configureTpLink").mockResolvedValue({ ok: true, configured: true, integration: connectingWithoutChildren });
    const firstStatus = deferred<IntegrationStatus>();
    const status = vi.spyOn(api, "integrations")
      .mockReturnValueOnce(firstStatus.promise)
      .mockResolvedValue(connectedWithoutChildren);
    const refreshTpLinkDevices = vi.fn()
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([discoveredChild]);
    let rendered!: ReturnType<typeof renderPage>;
    const onIntegrationChange = vi.fn((next: IntegrationStatus) => {
      rendered.rerender(<I18nProvider><IntegrationsPage {...rendered.props} integration={next} /></I18nProvider>);
    });
    rendered = renderPage({ onIntegrationChange, onRefreshTpLinkDevices: refreshTpLinkDevices });

    fireEvent.click(screen.getByRole("tab", { name: /Where readings come from/ }));
    fireEvent.click(screen.getByRole("button", { name: "Find devices" }));
    await act(async () => { await Promise.resolve(); await Promise.resolve(); });
    const directSection = screen.getByRole("heading", { name: "Connect TP-Link directly" }).closest("section")!;
    expect((within(directSection).getByRole("radio", { name: /Hall hub/ }) as HTMLInputElement).checked).toBe(true);
    expect(directSection.querySelector<HTMLDetailsElement>(".setup-config-disclosure")!.open).toBe(true);
    await act(async () => { await vi.advanceTimersByTimeAsync(0); });
    fireEvent.change(within(directSection).getByLabelText("TP-Link account email"), { target: { value: "person@example.test" } });
    fireEvent.change(within(directSection).getByLabelText("TP-Link account password"), { target: { value: "local-secret" } });
    fireEvent.click(within(directSection).getByRole("button", { name: "Check direct TP-Link connection" }));
    await act(async () => { await Promise.resolve(); await Promise.resolve(); });
    fireEvent.click(within(directSection).getByRole("button", { name: "Save and connect" }));
    await act(async () => { await Promise.resolve(); await Promise.resolve(); });

    expect(refreshTpLinkDevices).toHaveBeenCalledTimes(1);
    expect(status).toHaveBeenCalledTimes(1);
    expect(screen.getByText("Waiting for H200 to report paired sensors…")).not.toBeNull();

    await act(async () => {
      firstStatus.resolve(connectedWithoutChildren);
      await Promise.resolve();
      await Promise.resolve();
    });
    await act(async () => { await vi.advanceTimersByTimeAsync(5_000); });

    expect(refreshTpLinkDevices).toHaveBeenCalledTimes(2);
    expect(status).toHaveBeenCalledTimes(2);
    expect(screen.getByText("Paired sensors found: 1.")).not.toBeNull();
  });

  it("automatically checks an already-configured connected hub with no discovered children", async () => {
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
    vi.spyOn(api, "integrations").mockResolvedValue(connectedWithoutChildren);
    const refreshTpLinkDevices = vi.fn().mockResolvedValue([]);
    renderPage({ integration: connectedWithoutChildren, onRefreshTpLinkDevices: refreshTpLinkDevices });

    await act(async () => { await Promise.resolve(); await Promise.resolve(); });
    const liveStatus = screen.getByRole("region", { name: "Live TP-Link status" });
    expect(within(liveStatus).getByText("Waiting for H200 to report paired sensors…")).not.toBeNull();

    await act(async () => { await vi.advanceTimersByTimeAsync(30_000); });

    expect(refreshTpLinkDevices).toHaveBeenCalledTimes(7);
    expect(within(liveStatus).getByText("No paired sensors appeared yet.")).not.toBeNull();
    fireEvent.click(within(liveStatus).getByRole("button", { name: "Check again" }));
    await act(async () => { await Promise.resolve(); });
    expect(refreshTpLinkDevices).toHaveBeenCalledTimes(8);
  });

  it("reports a child-inventory failure even when integration status remains reachable", async () => {
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
    };
    vi.spyOn(api, "discoverIntegrations").mockResolvedValue({ tpLink: [], homeAssistant: [], warnings: [] });
    vi.spyOn(api, "integrations").mockResolvedValue(connectedWithoutChildren);
    const refreshTpLinkDevices = vi.fn().mockRejectedValue(new Error("Inventory unavailable"));
    renderPage({ integration: connectedWithoutChildren, onRefreshTpLinkDevices: refreshTpLinkDevices });

    await act(async () => { await Promise.resolve(); await Promise.resolve(); });
    await act(async () => { await vi.advanceTimersByTimeAsync(30_000); });

    const liveStatus = screen.getByRole("region", { name: "Live TP-Link status" });
    expect(refreshTpLinkDevices).toHaveBeenCalledTimes(7);
    expect(within(liveStatus).getByText("Stugu could not check the hub's paired sensors.")).not.toBeNull();
  });

  it("stops child-inventory polling after leaving Connections", async () => {
    vi.useFakeTimers();
    window.history.replaceState(null, "", "/setup/connections");
    const connectedWithoutChildren = connectedTpLink({ discoveredDevices: 0 });
    vi.spyOn(api, "discoverIntegrations").mockResolvedValue({ tpLink: [], homeAssistant: [], warnings: [] });
    const status = vi.spyOn(api, "integrations").mockResolvedValue(connectedWithoutChildren);
    const refreshTpLinkDevices = vi.fn().mockResolvedValue([]);
    renderPage({ integration: connectedWithoutChildren, onRefreshTpLinkDevices: refreshTpLinkDevices });

    await act(async () => { await Promise.resolve(); await Promise.resolve(); });
    expect(refreshTpLinkDevices).toHaveBeenCalledTimes(1);
    expect(status).toHaveBeenCalledTimes(1);

    fireEvent.click(screen.getByRole("tab", { name: /Overview/ }));
    await act(async () => { await vi.advanceTimersByTimeAsync(30_000); });

    expect(refreshTpLinkDevices).toHaveBeenCalledTimes(1);
    expect(status).toHaveBeenCalledTimes(1);
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

    await user.click(screen.getByRole("button", { name: "Change" }));
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
    expect(screen.getByText(/Configure the weather reference and system behavior for World house/)).not.toBeNull();
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

    await user.click(screen.getByRole("tab", { name: /Weather/ }));
    await user.click(screen.getByRole("button", { name: "Sync from home placement" }));
    await waitFor(() => expect(api.coordinateDefaults).toHaveBeenCalledWith(62.25, -149.5));
    await user.selectOptions(screen.getByRole("combobox", { name: "Home" }), secondHouse.id);
    await user.click(screen.getByText("Advanced weather location"));
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

    await user.click(screen.getByRole("tab", { name: /Weather/ }));
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
    expect(progress.getAttribute("aria-valuetext")).toMatch(/^\d+ \/ 4$/);
    for (const tab of screen.getAllByRole("tab")) {
      const panelId = tab.getAttribute("aria-controls");
      expect(panelId).toBeTruthy();
      expect(document.getElementById(panelId!)).not.toBeNull();
    }
  });
});
