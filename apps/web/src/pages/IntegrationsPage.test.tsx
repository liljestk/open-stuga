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
  it("queues an eight-interval Tapo canary for a daily export configuration", async () => {
    window.history.replaceState(null, "", "/setup/connections");
    vi.spyOn(api, "discoverIntegrations").mockResolvedValue({ tpLink: [], homeAssistant: [], warnings: [] });
    vi.mocked(api.tpLinkHistoryExportJobs).mockResolvedValue({
      enabled: true,
      automation: { ...historyAutomation, exportIntervalMinutes: 1440 },
      jobs: [],
    });
    vi.mocked(api.tpLinkDevices).mockResolvedValue([{ ...discoveredChild, mappedSensorId: "sensor-hall" }]);
    const createCanary = vi.spyOn(api, "createTpLinkHistoryExportCanary").mockResolvedValue({ job: {} as never });
    const user = userEvent.setup();
    renderPage({ integration: connectedTpLink() });

    const historyPanel = await screen.findByRole("heading", { name: "Automated Tapo history exports" });
    await user.click(historyPanel.closest("details")!.querySelector("summary")!);
    await user.click(await screen.findByRole("button", { name: "Run acceptance canary" }));
    expect(createCanary).toHaveBeenCalledWith(expect.objectContaining({
      sensorId: "sensor-hall",
      metric: "temperature",
      from: expect.any(String),
      to: expect.any(String),
    }));
    const input = createCanary.mock.calls[0]![0];
    expect(Date.parse(input.to) - Date.parse(input.from)).toBe(8 * 24 * 60 * 60_000);
  });

  it("shows automated Tapo history jobs and exposes retry, cancel, and refresh controls", async () => {
    window.history.replaceState(null, "", "/setup/connections");
    vi.spyOn(api, "discoverIntegrations").mockResolvedValue({ tpLink: [], homeAssistant: [], warnings: [] });
    const jobs = [
      {
        id: "failed-job",
        canary: false,
        provider: "appium" as const,
        sensorId: "sensor-hall",
        deviceId: "device-hall",
        deviceName: "Hall sensor",
        timeZone: "Europe/Helsinki",
        metric: "temperature",
        expectedRecipient: "history+failed@example.test",
        from: "2026-07-01T00:00:00.000Z",
        to: "2026-07-02T00:00:00.000Z",
        intervalMinutes: 15,
        status: "needs-attention" as const,
        attemptCount: 2,
        maxAttempts: 3,
        availableAt: "2026-07-02T01:00:00.000Z",
        leaseOwner: null,
        leaseExpiresAt: null,
        heartbeatAt: null,
        submittedAt: null,
        mailboxMessageId: null,
        sourceArtifactSha256: null,
        sourceArtifactBytes: null,
        parserVersion: null,
        sourceSchemaSignature: null,
        stagedSampleCount: 0,
        consumedSampleCount: 0,
        lastError: null,
        attentionReason: "Tapo login requires verification",
        detail: "Tapo login requires verification",
        createdAt: "2026-07-02T00:00:00.000Z",
        updatedAt: "2026-07-02T01:00:00.000Z",
        completedAt: null,
      },
      {
        id: "active-job",
        canary: false,
        provider: "private-cloud" as const,
        sensorId: "sensor-cellar",
        deviceId: "device-cellar",
        deviceName: "Cellar sensor",
        timeZone: "Europe/Helsinki",
        metric: "humidity",
        expectedRecipient: null,
        from: "2026-07-03T00:00:00.000Z",
        to: "2026-07-04T00:00:00.000Z",
        intervalMinutes: 15,
        status: "running" as const,
        attemptCount: 1,
        maxAttempts: 3,
        availableAt: "2026-07-03T00:00:00.000Z",
        leaseOwner: "private-worker",
        leaseExpiresAt: "2026-07-03T00:10:00.000Z",
        heartbeatAt: "2026-07-03T00:01:00.000Z",
        submittedAt: null,
        mailboxMessageId: null,
        sourceArtifactSha256: null,
        sourceArtifactBytes: null,
        parserVersion: null,
        sourceSchemaSignature: null,
        stagedSampleCount: 0,
        consumedSampleCount: 0,
        lastError: null,
        attentionReason: null,
        detail: null,
        createdAt: "2026-07-03T00:00:00.000Z",
        updatedAt: "2026-07-03T00:01:00.000Z",
        completedAt: null,
      },
    ];
    vi.mocked(api.tpLinkHistoryExportJobs).mockResolvedValue({ enabled: true, automation: historyAutomation, jobs });
    const retry = vi.spyOn(api, "retryTpLinkHistoryExportJob").mockResolvedValue(undefined);
    const cancel = vi.spyOn(api, "cancelTpLinkHistoryExportJob").mockResolvedValue(undefined);
    const user = userEvent.setup();
    renderPage({ integration: connectedTpLink() });

    const panel = await screen.findByRole("heading", { name: "Automated Tapo history exports" });
    const section = panel.closest("details")!;
    await user.click(section.querySelector("summary")!);
    expect(within(section).getByText("Needs Attention")).not.toBeNull();
    expect(within(section).getByText("Tapo mobile app")).not.toBeNull();
    expect(within(section).getByText("Hall sensor")).not.toBeNull();
    expect(within(section).getByText("2 / 3")).not.toBeNull();
    expect(within(section).getByText("Tapo login requires verification")).not.toBeNull();

    await user.click(within(section).getByRole("button", { name: "Retry export for Hall sensor" }));
    await waitFor(() => expect(retry).toHaveBeenCalledWith("failed-job"));
    await user.click(within(section).getByRole("button", { name: "Cancel export for Cellar sensor" }));
    await waitFor(() => expect(cancel).toHaveBeenCalledWith("active-job"));
    await user.click(within(section).getByRole("button", { name: "Refresh" }));
    await waitFor(() => expect(api.tpLinkHistoryExportJobs).toHaveBeenCalledTimes(4));
  });

  it("clearly marks automated Tapo history exports as disabled", async () => {
    window.history.replaceState(null, "", "/setup/connections");
    vi.spyOn(api, "discoverIntegrations").mockResolvedValue({ tpLink: [], homeAssistant: [], warnings: [] });
    const user = userEvent.setup();
    renderPage({ integration: connectedTpLink() });

    const historyPanel = await screen.findByRole("heading", { name: "Automated Tapo history exports" });
    await user.click(historyPanel.closest("details")!.querySelector("summary")!);
    expect((await screen.findByText("Automated history exports are disabled on this server.")).getAttribute("aria-disabled")).toBe("true");
    expect((screen.getByRole("button", { name: "Refresh" }) as HTMLButtonElement).disabled).toBe(true);
  });

  it("leads with the existing live TP-Link connection, automatically scans for additions, and keeps replacement setup collapsed", async () => {
    const user = userEvent.setup();
    window.history.replaceState(null, "", "/setup/connections");
    const scan = vi.spyOn(api, "discoverIntegrations").mockResolvedValue({ tpLink: [], homeAssistant: [], warnings: [] });
    renderPage({ integration: connectedTpLink() });

    await act(async () => { await Promise.resolve(); });

    const liveStatus = screen.getByRole("region", { name: "Live TP-Link status" });
    expect(within(liveStatus).getByRole("heading", { name: "TP-Link H200 is connected" })).not.toBeNull();
    expect(within(liveStatus).getByText("Connected")).not.toBeNull();
    const connectionDetails = within(liveStatus).getByText("Connection details").closest("details")!;
    expect(connectionDetails.hasAttribute("open")).toBe(false);
    await user.click(connectionDetails.querySelector("summary")!);
    expect(within(liveStatus).getByText("Live updates")).not.toBeNull();
    expect(liveStatus.textContent).toMatch(/Last poll/i);
    expect(liveStatus.textContent).toMatch(/11:30/);

    const discovered = within(liveStatus).getByText(/^Discovered/i).closest("div");
    const mapped = within(liveStatus).getByText(/^Mapped/i).closest("div");
    const ready = within(liveStatus).getByText(/^Ready/i).closest("div");
    expect(discovered?.textContent).toContain("3");
    expect(mapped?.textContent).toContain("2");
    expect(ready?.textContent).toContain("1");
    await waitFor(() => expect(scan).toHaveBeenCalledWith(house.id));

    const directSection = screen.getByRole("heading", { name: "Connect TP-Link directly" }).closest("section")!;
    const settings = directSection.querySelector<HTMLDetailsElement>(".setup-config-disclosure")!;
    expect(settings.open).toBe(false);
    expect(within(directSection).getByText("Change saved TP-Link connection")).not.toBeNull();
    await user.click(settings.querySelector("summary")!);
    expect(await within(directSection).findByRole("button", { name: "Check direct TP-Link connection" })).not.toBeNull();
  });

  it("does not present a healthy live status when the TP-Link source has failed", () => {
    window.history.replaceState(null, "", "/setup/connections");
    vi.spyOn(api, "discoverIntegrations").mockResolvedValue({ tpLink: [], homeAssistant: [], warnings: [] });
    renderPage({
      integration: connectedTpLink({
        connected: false,
        error: "Timed out getting discovery response",
      }),
      streamConnection: "live",
    });

    const liveStatus = screen.getByRole("region", { name: "Live TP-Link status" });
    expect(within(liveStatus).getByRole("heading", { name: "TP-Link H200 · Not connected" })).not.toBeNull();
    const health = within(liveStatus).getByRole("status");
    expect(health.textContent).toBe("Not connected");
    expect(health.classList.contains("error")).toBe(true);
    expect(within(liveStatus).getByText("Connection details").closest("details")!.hasAttribute("open")).toBe(false);
    expect(within(liveStatus).getByRole("alert").textContent).toMatch(/saved connection needs attention/i);
  });

  it("automatically surfaces standalone electrical devices beside a configured hub", async () => {
    window.history.replaceState(null, "", "/setup/connections");
    const scan = vi.spyOn(api, "discoverIntegrations").mockResolvedValue({
      tpLink: [
        { host: "192.168.68.54", model: "H200", alias: "Hall hub", sourceType: "hub" },
        { host: "192.168.68.57", model: "HS110", alias: "Workshop plug", sourceType: "energy-device" },
      ],
      homeAssistant: [],
      warnings: [],
    });
    renderPage({ integration: connectedTpLink() });

    await waitFor(() => expect(scan).toHaveBeenCalledWith(house.id));
    expect((await screen.findAllByText("Workshop plug")).length).toBeGreaterThan(0);
    expect(screen.getByText(/energy device · HS110 · 192\.168\.68\.57/i)).not.toBeNull();
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
      warnings: ["TP-Link discovery was unavailable. Enter the hub or energy-device address manually."],
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
    expect(await within(directSection).findByText(/Automatic discovery did not provide a supported TP-Link source/)).not.toBeNull();
    expect(screen.getByText("TP-Link discovery was unavailable. Enter the hub or energy-device address manually.")).not.toBeNull();
    expect((within(directSection).getByLabelText("Hub or energy-device address") as HTMLInputElement).value).toBe("");
    expect(directSection.querySelector<HTMLDetailsElement>(".setup-config-disclosure")?.open).toBe(true);

    await user.click(screen.getByRole("tab", { name: /Overview/ }));
    await user.click(screen.getByRole("tab", { name: /Where readings come from/ }));
    expect(scan).toHaveBeenCalledTimes(1);
    await user.click(screen.getByRole("button", { name: "Find devices" }));
    await waitFor(() => expect(scan).toHaveBeenCalledTimes(2));
  });

  it("uses entered credentials to discover and auto-fill a first P110 energy plug", async () => {
    const user = userEvent.setup();
    const scan = vi.spyOn(api, "discoverIntegrations")
      .mockResolvedValueOnce({ tpLink: [], homeAssistant: [], warnings: [] })
      .mockResolvedValueOnce({
        tpLink: [{
          host: "192.168.1.64",
          model: "P110",
          alias: "Laundry plug",
          sourceType: "energy-device",
        }],
        homeAssistant: [],
        warnings: [],
      });
    renderPage();

    await user.click(screen.getByRole("tab", { name: /Where readings come from/ }));
    await user.click(screen.getByRole("button", { name: "Find devices" }));

    const directSection = screen.getByRole("heading", { name: "Connect TP-Link directly" }).closest("section")!;
    await user.type(within(directSection).getByLabelText("TP-Link account email"), "person@example.test");
    await user.type(within(directSection).getByLabelText("TP-Link account password"), "local-secret");
    await user.click(screen.getByRole("button", { name: "Find devices" }));

    await waitFor(() => expect(scan).toHaveBeenLastCalledWith(house.id, {
      username: "person@example.test",
      password: "local-secret",
    }));
    expect((await within(directSection).findAllByText("Laundry plug")).length).toBeGreaterThan(0);
    expect(within(directSection).getByText(/energy device · P110 · 192\.168\.1\.64/i)).not.toBeNull();
    expect((within(directSection).getByLabelText("Hub or energy-device address") as HTMLInputElement).value)
      .toBe("192.168.1.64");
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

    expect(screen.getByRole("tab", { name: /Weather/ }).getAttribute("aria-selected")).toBe("true");
    await user.click(screen.getByRole("tab", { name: /Layout & rooms/ }));
    expect(window.location.pathname).toBe(`${setupBase}/layout`);
    expect(window.location.search).toBe("?source=test");

    window.history.pushState(null, "", `${setupBase}/overview?source=test`);
    window.dispatchEvent(new PopStateEvent("popstate"));
    await waitFor(() => expect(screen.getByRole("tab", { name: /Overview/ }).getAttribute("aria-selected")).toBe("true"));
  });
});
