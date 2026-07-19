import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { House, IntegrationStatus, TpLinkDiscoveredDevice } from "@climate-twin/contracts";
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
  propertyId: "property-coast",
  name: "Coast house",
  timezone: "Europe/Helsinki",
  location: { latitude: 60.17, longitude: 24.94, label: "Helsinki" },
  floors: [],
  createdAt: "2026-01-01T00:00:00.000Z",
  updatedAt: "2026-01-01T00:00:00.000Z",
};

const discoveredChild: TpLinkDiscoveredDevice = {
  deviceId: "tapo-child-hall",
  model: "T310",
  alias: "Hall sensor",
  status: "online",
  temperature: 21.2,
  humidity: 44,
  battery: 92,
  lastSeenAt: "2026-07-14T12:00:00.000Z",
  mappedSensorId: null,
};

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  const promise = new Promise<T>((next) => { resolve = next; });
  return { promise, resolve };
}

function connectedTpLink(overrides: Partial<IntegrationStatus["tpLink"]> = {}): IntegrationStatus {
  return {
    ...integration,
    tpLink: {
      ...integration.tpLink,
      configured: true,
      connected: true,
      lastPollAt: "2026-07-16T08:30:15.000Z",
      mappedDevices: 2,
      discoveredDevices: 3,
      hubModel: "H200",
      error: null,
      ...overrides,
    },
    mock: { ...integration.mock, enabled: false, mode: "real", activatedAt: "2026-07-16T08:30:00.000Z" },
  };
}

function renderPage(overrides: Partial<React.ComponentProps<typeof IntegrationsPage>> = {}) {
  localStorage.setItem("climate-twin-locale", "en");
  const props: React.ComponentProps<typeof IntegrationsPage> = {
    integration,
    house,
    houses: [house],
    units: "metric",
    streamConnection: "live",
    onHouse: vi.fn(),
    onHouseUpdate: vi.fn().mockResolvedValue(undefined),
    onGeoreferenceChange: vi.fn().mockResolvedValue(undefined),
    onIntegrationChange: vi.fn(),
    ...overrides,
  };
  return { ...render(<I18nProvider><IntegrationsPage {...props} /></I18nProvider>), props };
}

beforeEach(() => {
  window.history.replaceState(null, "", "/setup/overview");
  vi.spyOn(window, "confirm").mockReturnValue(true);
  vi.spyOn(api, "testTpLinkDraft").mockResolvedValue({ ok: true, message: "Connected" });
  vi.spyOn(api, "testHomeAssistantDraft").mockResolvedValue({ ok: true, message: "Connected" });
});
afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("Setup workspace", () => {
  it("leads with the existing live TP-Link connection and keeps replacement setup collapsed", async () => {
    const user = userEvent.setup();
    window.history.replaceState(null, "", "/setup/connections");
    const scan = vi.spyOn(api, "discoverIntegrations").mockResolvedValue({ tpLink: [], homeAssistant: [], warnings: [] });
    renderPage({ integration: connectedTpLink() });

    await act(async () => { await Promise.resolve(); });

    const liveStatus = screen.getByRole("region", { name: "Live TP-Link status" });
    expect(within(liveStatus).getByRole("heading", { name: "TP-Link H200 is connected" })).not.toBeNull();
    expect(within(liveStatus).getByText("Live updates")).not.toBeNull();
    const connectionDetails = within(liveStatus).getByText("Connection details").closest("details")!;
    expect(connectionDetails.hasAttribute("open")).toBe(false);
    await user.click(connectionDetails.querySelector("summary")!);
    expect(liveStatus.textContent).toMatch(/Last poll/i);
    expect(liveStatus.textContent).toMatch(/11:30/);

    const discovered = within(liveStatus).getByText(/^Discovered/i).closest("div");
    const mapped = within(liveStatus).getByText(/^Mapped/i).closest("div");
    const ready = within(liveStatus).getByText(/^Ready/i).closest("div");
    expect(discovered?.textContent).toContain("3");
    expect(mapped?.textContent).toContain("2");
    expect(ready?.textContent).toContain("1");
    expect(scan).not.toHaveBeenCalled();

    const directSection = screen.getByRole("heading", { name: "Connect TP-Link directly" }).closest("section")!;
    const settings = directSection.querySelector<HTMLDetailsElement>(".setup-config-disclosure")!;
    expect(settings.open).toBe(false);
    expect(within(directSection).getByText("Change saved TP-Link connection")).not.toBeNull();
    await user.click(settings.querySelector("summary")!);
    expect(await within(directSection).findByRole("button", { name: "Check direct TP-Link connection" })).not.toBeNull();
  });

  it("applies live TP-Link poll and inventory updates immediately on rerender", () => {
    window.history.replaceState(null, "", "/setup/connections");
    vi.spyOn(api, "discoverIntegrations").mockResolvedValue({ tpLink: [], homeAssistant: [], warnings: [] });
    const rendered = renderPage({ integration: connectedTpLink() });

    let liveStatus = screen.getByRole("region", { name: "Live TP-Link status" });
    expect(liveStatus.textContent).toMatch(/11:30/);
    expect(within(liveStatus).getByText(/^Ready/i).closest("div")?.textContent).toContain("1");

    const updated = connectedTpLink({
      lastPollAt: "2026-07-16T08:31:25.000Z",
      discoveredDevices: 5,
      mappedDevices: 2,
    });
    rendered.rerender(<I18nProvider><IntegrationsPage {...rendered.props} integration={updated} /></I18nProvider>);

    liveStatus = screen.getByRole("region", { name: "Live TP-Link status" });
    expect(liveStatus.textContent).toMatch(/11:31/);
    expect(within(liveStatus).getByText(/^Discovered/i).closest("div")?.textContent).toContain("5");
    expect(within(liveStatus).getByText(/^Mapped/i).closest("div")?.textContent).toContain("2");
    expect(within(liveStatus).getByText(/^Ready/i).closest("div")?.textContent).toContain("3");
  });

  it("distinguishes a reconnecting event stream from the healthy TP-Link poller", () => {
    window.history.replaceState(null, "", "/setup/connections");
    vi.spyOn(api, "discoverIntegrations").mockResolvedValue({ tpLink: [], homeAssistant: [], warnings: [] });
    renderPage({ integration: connectedTpLink(), streamConnection: "reconnecting" });

    const liveStatus = screen.getByRole("region", { name: "Live TP-Link status" });
    expect(within(liveStatus).getByRole("heading", { name: "TP-Link H200 is connected" })).not.toBeNull();
    expect(liveStatus.textContent).toMatch(/reconnect/i);
    expect(within(liveStatus).queryByText(/TP-Link (?:is )?disconnected/i)).toBeNull();
  });

  it("presents a poll issue as a warning without hiding the healthy connection", () => {
    window.history.replaceState(null, "", "/setup/connections");
    vi.spyOn(api, "discoverIntegrations").mockResolvedValue({ tpLink: [], homeAssistant: [], warnings: [] });
    renderPage({ integration: connectedTpLink({ error: "Hall sensor is temporarily offline" }) });

    const liveStatus = screen.getByRole("region", { name: "Live TP-Link status" });
    expect(within(liveStatus).getByRole("heading", { name: "TP-Link H200 is connected" })).not.toBeNull();
    expect(liveStatus.textContent).toMatch(/warning|attention/i);
    expect(within(liveStatus).getByText("Hall sensor is temporarily offline")).not.toBeNull();
    expect(within(liveStatus).queryByText(/TP-Link (?:is )?disconnected/i)).toBeNull();
  });

  it("opens on a side-effect-free overview and keeps operational weather out of every section", async () => {
    const user = userEvent.setup();
    const weatherSpy = vi.spyOn(api, "houseWeather");
    const locationSearchSpy = vi.spyOn(api, "searchLocations");
    renderPage();

    expect(screen.getByRole("tab", { name: /Overview/ }).getAttribute("aria-selected")).toBe("true");
    expect(screen.queryByRole("button", { name: "Map for placing all homes" })).toBeNull();
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

  it("only discovers the LAN after an explicit Find devices click and keeps an explicit retry", async () => {
    const user = userEvent.setup();
    let finishScan!: (result: Awaited<ReturnType<typeof api.discoverIntegrations>>) => void;
    const firstScan = new Promise<Awaited<ReturnType<typeof api.discoverIntegrations>>>((resolve) => { finishScan = resolve; });
    const noTpLinkResult = {
      tpLink: [],
      homeAssistant: [{ name: "Our home", url: "http://homeassistant.local:8123", host: "192.168.1.20", port: 8123, version: null }],
      warnings: ["TP-Link discovery was unavailable. Enter the hub address manually."],
    };
    const scan = vi.spyOn(api, "discoverIntegrations").mockReturnValueOnce(firstScan).mockResolvedValue(noTpLinkResult);
    renderPage();

    expect(scan).not.toHaveBeenCalled();
    await user.click(screen.getByRole("tab", { name: /Where readings come from/ }));
    expect(scan).not.toHaveBeenCalled();
    await user.click(screen.getByRole("button", { name: "Find devices" }));
    await waitFor(() => expect(scan).toHaveBeenCalledTimes(1));
    expect(screen.getByRole("button", { name: /Looking for devices/ })).not.toBeNull();
    finishScan(noTpLinkResult);
    expect(await screen.findByRole("button", { name: "Find devices" })).not.toBeNull();
    expect(screen.getByText("Connection options found: 1.")).not.toBeNull();
    const directSection = screen.getByRole("heading", { name: "Connect TP-Link directly" }).closest("section")!;
    expect(await within(directSection).findByText(/Automatic discovery did not provide a TP-Link hub/)).not.toBeNull();
    expect(screen.getByText("TP-Link discovery was unavailable. Enter the hub address manually.")).not.toBeNull();
    expect((within(directSection).getByLabelText("Hub or energy-device address") as HTMLInputElement).value).toBe("");
    expect(directSection.querySelector<HTMLDetailsElement>(".setup-config-disclosure")?.open).toBe(true);

    await user.click(screen.getByRole("tab", { name: /Overview/ }));
    await user.click(screen.getByRole("tab", { name: /Where readings come from/ }));
    expect(scan).toHaveBeenCalledTimes(1);
    await user.click(screen.getByRole("button", { name: "Find devices" }));
    await waitFor(() => expect(scan).toHaveBeenCalledTimes(2));
  });

  it("discards a discovery result from the previously selected Home", async () => {
    const user = userEvent.setup();
    const pending = deferred<Awaited<ReturnType<typeof api.discoverIntegrations>>>();
    const scan = vi.spyOn(api, "discoverIntegrations").mockReturnValue(pending.promise);
    const secondHouse: House = { ...house, id: "house-lake", name: "Lake home" };
    const rendered = renderPage({ houses: [house, secondHouse] });

    await user.click(screen.getByRole("tab", { name: /Where readings come from/ }));
    await user.click(screen.getByRole("button", { name: "Find devices" }));
    await waitFor(() => expect(scan).toHaveBeenCalledWith(house.id));
    rendered.rerender(<I18nProvider><IntegrationsPage {...rendered.props} house={secondHouse} houses={[house, secondHouse]} /></I18nProvider>);
    pending.resolve({
      tpLink: [{ host: "192.168.1.42", model: "H200", alias: "Old Home hub" }],
      homeAssistant: [],
      warnings: [],
    });
    await act(async () => { await pending.promise; await Promise.resolve(); });

    expect(screen.getByText("New connections for Lake home")).not.toBeNull();
    expect(screen.queryByText("Old Home hub")).toBeNull();
    expect(screen.queryByText("Connection options found: 1.")).toBeNull();
    expect(screen.getByRole("button", { name: "Find devices" })).not.toBeNull();
  });

  it("manages cross-Property Home assignments and disconnects only the selected logical connection", async () => {
    const user = userEvent.setup();
    window.history.replaceState(null, "", "/setup/connections");
    const lakeHouse: House = { ...house, id: "house-lake", propertyId: "property-lake", name: "Lake home" };
    const managedIntegration: IntegrationStatus = {
      ...integration,
      homeAssistant: {
        ...integration.homeAssistant,
        configured: true,
        connections: [
          { houseId: house.id, configured: true, connected: true, lastEventAt: null, mappedEntities: 2, error: null },
          { houseId: lakeHouse.id, configured: true, connected: true, lastEventAt: null, mappedEntities: 1, error: null },
        ],
      },
      tpLink: {
        ...integration.tpLink,
        configured: true,
        connections: [
          { id: "hub-coast", houseId: house.id, configured: true, connected: true, lastPollAt: "2026-07-17T08:00:00.000Z", mappedDevices: 1, discoveredDevices: 1, hubModel: "H200", error: null },
          { id: "hub-lake", houseId: lakeHouse.id, configured: true, connected: true, lastPollAt: "2026-07-17T08:00:00.000Z", mappedDevices: 0, discoveredDevices: 1, hubModel: "H200", error: null },
        ],
      },
    };
    const afterDisconnect: IntegrationStatus = {
      ...managedIntegration,
      tpLink: { ...managedIntegration.tpLink, connections: managedIntegration.tpLink.connections!.filter((item) => item.id !== "hub-lake") },
    };
    const disconnectTpLink = vi.fn().mockResolvedValue({ ok: true, detachedSensorIds: [], integration: afterDisconnect });
    const rendered = renderPage({
      integration: managedIntegration,
      connectionHouses: [house, lakeHouse],
      onDisconnectTpLink: disconnectTpLink,
    });

    const homePicker = screen.getByRole("combobox", { name: "Add new connections to" });
    expect(within(homePicker).getByRole("option", { name: "Lake home" })).not.toBeNull();
    await user.selectOptions(homePicker, lakeHouse.id);
    expect(rendered.props.onHouse).toHaveBeenCalledWith(lakeHouse.id);
    expect(screen.getByText("New connections for Lake home")).not.toBeNull();

    const assignmentManager = screen.getByText("Saved connection assignments").closest("details")!;
    expect(assignmentManager.hasAttribute("open")).toBe(false);
    await user.click(within(assignmentManager).getByText("Saved connection assignments"));
    expect(assignmentManager.hasAttribute("open")).toBe(true);
    await user.click(within(assignmentManager).getByRole("button", { name: "Disconnect TP-Link from Lake home" }));
    await waitFor(() => expect(disconnectTpLink).toHaveBeenCalledWith("hub-lake"));
    expect(rendered.props.onIntegrationChange).toHaveBeenCalledWith(afterDisconnect);
    expect(screen.getByText("The Home assignment was disconnected.")).not.toBeNull();
  });

  it("moves a saved hub to another Home from its assignment row without asking for credentials again", async () => {
    const user = userEvent.setup();
    window.history.replaceState(null, "", "/setup/connections");
    const lakeHouse: House = { ...house, id: "house-lake", propertyId: "property-lake", name: "Lake home" };
    const managedIntegration: IntegrationStatus = {
      ...integration,
      tpLink: {
        ...integration.tpLink,
        configured: true,
        connections: [{
          id: "hub-coast", houseId: house.id, configured: true, connected: true,
          lastPollAt: "2026-07-17T08:00:00.000Z", mappedDevices: 1, discoveredDevices: 1,
          hubModel: "H200", error: null,
        }],
      },
    };
    const afterMove: IntegrationStatus = {
      ...managedIntegration,
      tpLink: {
        ...managedIntegration.tpLink,
        connections: [{ ...managedIntegration.tpLink.connections![0]!, houseId: lakeHouse.id, connected: false }],
      },
    };
    const moveTpLink = vi.fn().mockResolvedValue({
      ok: true,
      fromHouseId: house.id,
      houseId: lakeHouse.id,
      detachedSensorIds: ["sensor-hall"],
      integration: afterMove,
    });
    const rendered = renderPage({
      integration: managedIntegration,
      connectionHouses: [house, lakeHouse],
      onMoveTpLink: moveTpLink,
    });

    const assignmentManager = screen.getByText("Saved connection assignments").closest("details")!;
    const assignedHome = within(assignmentManager).getByRole("combobox", { name: "Assigned home for TP-Link H200" });
    await user.selectOptions(assignedHome, lakeHouse.id);
    await user.click(within(assignmentManager).getByRole("button", { name: "Move TP-Link to Lake home" }));

    await waitFor(() => expect(moveTpLink).toHaveBeenCalledWith("hub-coast", lakeHouse.id));
    expect(window.confirm).toHaveBeenCalledWith(expect.stringContaining("Move TP-Link from Coast house to Lake home?"));
    expect(rendered.props.onIntegrationChange).toHaveBeenCalledWith(afterMove);
    expect(screen.getByText("Connection moved to Lake home. Direct sensor bindings removed from the previous Home: 1.")).not.toBeNull();
  });

  it("opens the manual TP-Link fallback when network discovery fails", async () => {
    const user = userEvent.setup();
    vi.spyOn(api, "discoverIntegrations").mockRejectedValue(new Error("Discovery helper unavailable"));
    renderPage();

    await user.click(screen.getByRole("tab", { name: /Where readings come from/ }));
    await user.click(screen.getByRole("button", { name: "Find devices" }));
    const directSection = screen.getByRole("heading", { name: "Connect TP-Link directly" }).closest("section")!;
    expect(await within(directSection).findByText(/Automatic discovery did not provide a TP-Link hub/)).not.toBeNull();
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

    expect(screen.getByRole("tab", { name: /Weather/ }).getAttribute("aria-selected")).toBe("true");
    await user.click(screen.getByRole("tab", { name: /Layout & rooms/ }));
    expect(window.location.pathname).toBe(`${setupBase}/layout`);
    expect(window.location.search).toBe("?source=test");

    window.history.pushState(null, "", `${setupBase}/overview?source=test`);
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
    const manualSettings = within(directSection).getByText("Enter an address manually");
    expect((manualSettings.closest("details") as HTMLDetailsElement).open).toBe(false);
    await user.click(within(directSection).getByRole("radio", { name: /Hall hub/ }));
    const discoveredSettings = directSection.querySelector<HTMLDetailsElement>(".setup-config-disclosure")!;
    expect(discoveredSettings.querySelector("summary")?.textContent).toContain("Hall hub");
    expect(within(directSection).queryByText("Enter an address manually")).toBeNull();
    await user.click(discoveredSettings.querySelector("summary")!);

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
    fireEvent.click(within(directSection).getByRole("radio", { name: /Hall hub/ }));
    await act(async () => {
      fireEvent.click(directSection.querySelector("summary")!);
      await Promise.resolve();
    });
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
    fireEvent.click(within(directSection).getByRole("radio", { name: /Hall hub/ }));
    await act(async () => {
      fireEvent.click(directSection.querySelector("summary")!);
      await Promise.resolve();
    });
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
    expect(within(liveStatus).getByText("Stuga could not check the hub's paired sensors.")).not.toBeNull();
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

    expect(screen.getByRole("progressbar", { name: "Setup progress" }).getAttribute("aria-valuenow")).toBe("3");
    expect(screen.getByRole("heading", { level: 2, name: "Map and place sensors" })).not.toBeNull();
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
    await waitFor(() => expect(document.activeElement).toBe(screen.getByRole("tab", { name: /Layout & rooms/ })));
    expect(screen.getByRole("tab", { name: /Layout & rooms/ }).getAttribute("aria-selected")).toBe("true");
    await user.keyboard("{End}");
    await waitFor(() => expect(document.activeElement).toBe(screen.getByRole("tab", { name: /Automations/ })));
  });
});
