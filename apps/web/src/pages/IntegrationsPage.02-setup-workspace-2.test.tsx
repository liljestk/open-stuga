import { act, fireEvent, screen, waitFor, within } from "@testing-library/react";

import userEvent from "@testing-library/user-event";

import type { IntegrationStatus } from "@climate-twin/contracts";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { api } from "../api";
import { confirmAction } from "../components/ConfirmationProvider";

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
  it("uses discovery first, then reveals manual credentials in Connections", async () => {
    const user = userEvent.setup();
    vi.spyOn(api, "discoverIntegrations").mockResolvedValue({
      tpLink: [{ host: "192.168.1.42", model: "H200", alias: "Hall hub", sourceType: "hub", deviceId: null }],
      homeAssistant: [{ name: "Our home", url: "http://homeassistant.local:8123", host: "192.168.1.20", port: 8123, version: "2026.7.1" }],
      warnings: [],
    });
    const realIntegration: IntegrationStatus = {
      ...integration,
      tpLink: {
        ...integration.tpLink,
        configured: true,
        connections: [{
          id: "hall-hub",
          houseId: house.id,
          configured: true,
          connected: false,
          lastPollAt: null,
          mappedDevices: 0,
          discoveredDevices: 0,
          hubModel: "H200",
          error: null,
          host: "192.168.1.42",
          sourceType: "hub",
          sourceModel: "H200",
          sourceAlias: "Hall hub",
        }],
      },
      mock: { ...integration.mock, enabled: false, mode: "real", activatedAt: "2026-07-14T12:00:00.000Z" },
    };
    const configure = vi.spyOn(api, "configureTpLink").mockResolvedValue({
      ok: true,
      configured: true,
      created: true,
      connectionId: "hall-hub",
      houseId: house.id,
      integration: realIntegration,
    });
    const integrationWithChild: IntegrationStatus = {
      ...realIntegration,
      tpLink: {
        ...realIntegration.tpLink,
        connected: true,
        discoveredDevices: 1,
        hubModel: "H200",
        ...(realIntegration.tpLink.connections ? {
          connections: realIntegration.tpLink.connections.map((connection) => ({
            ...connection,
            discoveredDevices: 1,
          })),
        } : {}),
      },
    };
    vi.spyOn(api, "integrations").mockResolvedValue(integrationWithChild);
    const refreshTpLinkDevices = vi.fn().mockResolvedValue([discoveredChild]);
    const rendered = renderPage({ onRefreshTpLinkDevices: refreshTpLinkDevices });

    expect(screen.queryByLabelText("Hub or energy-device address")).toBeNull();
    await user.click(screen.getByRole("button", { name: "Find devices" }));
    expect(await screen.findByText("Connections ready to add: 2.")).not.toBeNull();
    expect(screen.getByText(/Nothing is saved until you choose Save and connect/)).not.toBeNull();
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
    await user.click(within(directSection).getByRole("button", { name: "Save and connect" }));

    await waitFor(() => expect(configure).toHaveBeenCalledWith({
      houseId: "house-coast",
      host: "192.168.1.42",
      username: "person@example.test",
      password: "local-secret",
    }));
    expect(api.testTpLinkDraft).not.toHaveBeenCalled();
    expect(discoveredSettings.open).toBe(false);
    expect(discoveredSettings.querySelector("form")).toBeNull();
    expect(within(directSection).getByText(/Hall hub was added to Coast house/)).not.toBeNull();
    rendered.rerender(<I18nProvider><IntegrationsPage {...rendered.props} integration={integrationWithChild} /></I18nProvider>);
    const sourceManager = screen.getByRole("heading", { name: "Where readings come from" }).closest("section")!;
    expect(within(sourceManager).getByText("Hall hub")).not.toBeNull();
    expect(within(sourceManager).getByText("Reconnecting")).not.toBeNull();
    expect(await screen.findByText("TP-Link devices to set up: 1")).not.toBeNull();
    expect(refreshTpLinkDevices).toHaveBeenCalledOnce();
    expect(rendered.props.onIntegrationChange).toHaveBeenCalledWith(realIntegration);
  });

  it("does not report a device as added until the saved connection can be read back", async () => {
    const user = userEvent.setup();
    vi.spyOn(api, "discoverIntegrations").mockResolvedValue({
      tpLink: [{ host: "192.168.1.41", model: "P110", alias: "Laundry plug", sourceType: "energy-device", deviceId: null }],
      homeAssistant: [],
      warnings: [],
    });
    vi.spyOn(api, "configureTpLink").mockResolvedValue({
      ok: true,
      configured: true,
      created: true,
      connectionId: "missing-p110",
      houseId: house.id,
      integration,
    });
    vi.spyOn(api, "integrations").mockResolvedValue(integration);
    renderPage();

    await user.click(screen.getByRole("button", { name: "Find devices" }));
    const directSection = screen.getByRole("heading", { name: "Connect TP-Link directly" }).closest("section")!;
    await user.type(within(directSection).getByLabelText("TP-Link account email"), "person@example.test");
    await user.type(within(directSection).getByLabelText("TP-Link account password"), "local-secret");
    await user.click(within(directSection).getByRole("button", { name: "Save and connect" }));

    expect((await within(directSection).findByRole("alert")).textContent).toMatch(/could not confirm the saved connection/i);
    expect(directSection.querySelector<HTMLDetailsElement>(".setup-config-disclosure")!.open).toBe(true);
    expect(within(directSection).queryByText(/Laundry plug was added/)).toBeNull();
  });

  it("continues a newly added energy device into its placement flow", async () => {
    const user = userEvent.setup();
    const placementIntegration = connectedTpLink({
      connections: [{
        id: "laundry-p110",
        houseId: house.id,
        configured: true,
        connected: false,
        lastPollAt: null,
        mappedDevices: 0,
        discoveredDevices: 0,
        hubModel: null,
        error: null,
        host: "192.168.1.41",
        sourceType: "energy-device",
        sourceModel: "P110",
        sourceAlias: "Laundry plug",
      }],
    });
    vi.spyOn(api, "discoverIntegrations").mockResolvedValue({
      tpLink: [{
        host: "192.168.1.41",
        model: "P110",
        alias: "Laundry plug",
        sourceType: "energy-device",
        deviceId: "p110-laundry",
      }],
      homeAssistant: [],
      warnings: [],
    });
    vi.spyOn(api, "configureTpLink").mockResolvedValue({
      ok: true,
      configured: true,
      created: true,
      connectionId: "laundry-p110",
      houseId: house.id,
      deviceId: "p110-laundry",
      sourceType: "energy-device",
      sourceModel: "P110",
      sourceAlias: "Laundry plug",
      integration: placementIntegration,
    });
    const onOpenSensors = vi.fn();
    const onRefreshTpLinkDevices = vi.fn().mockResolvedValue([]);
    renderPage({ onOpenSensors, onRefreshTpLinkDevices });

    await user.click(screen.getByRole("button", { name: "Find devices" }));
    const directSection = screen.getByRole("heading", { name: "Connect TP-Link directly" }).closest("section")!;
    await user.type(within(directSection).getByLabelText("TP-Link account email"), "person@example.test");
    await user.type(within(directSection).getByLabelText("TP-Link account password"), "local-secret");
    await user.click(within(directSection).getByRole("button", { name: "Save and connect" }));

    await waitFor(() => expect(onOpenSensors).toHaveBeenCalledWith({
      deviceId: "p110-laundry",
      connectionId: "laundry-p110",
      model: "P110",
      alias: "Laundry plug",
      deviceType: "energy",
    }));
    expect(onRefreshTpLinkDevices).toHaveBeenCalledWith(house.id);
  });

  it("reports an existing source without claiming that a duplicate was added", async () => {
    const user = userEvent.setup();
    const sourceIntegration = connectedTpLink({
      connections: [{
        id: "saved-p110",
        houseId: house.id,
        configured: true,
        connected: true,
        lastPollAt: "2026-07-27T18:00:00.000Z",
        mappedDevices: 1,
        discoveredDevices: 1,
        hubModel: null,
        error: null,
        host: "192.168.1.41",
        sourceType: "energy-device",
        sourceModel: "P110",
        sourceAlias: "Laundry plug",
      }],
    });
    vi.spyOn(api, "discoverIntegrations").mockResolvedValue({
      tpLink: [{ host: "192.168.1.41", model: "P110", alias: "Laundry plug", sourceType: "energy-device", deviceId: null }],
      homeAssistant: [],
      warnings: [],
    });
    vi.spyOn(api, "configureTpLink").mockResolvedValue({
      ok: true,
      configured: true,
      created: false,
      connectionId: "saved-p110",
      houseId: house.id,
      integration: sourceIntegration,
    });
    renderPage({ integration: sourceIntegration });

    await user.click(screen.getByRole("tab", { name: /Where readings come from/ }));
    await user.click(screen.getByRole("button", { name: "Find additional systems" }));
    const directSection = screen.getByRole("heading", { name: "Connect TP-Link directly" }).closest("section")!;
    await user.type(within(directSection).getByLabelText("TP-Link account email"), "person@example.test");
    await user.type(within(directSection).getByLabelText("TP-Link account password"), "local-secret");
    await user.click(within(directSection).getByRole("button", { name: "Save and connect" }));

    expect(await within(directSection).findByText(/Laundry plug was already saved for Coast house/)).not.toBeNull();
    expect(within(directSection).getByText(/no duplicate was created/)).not.toBeNull();
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
        tpLink: [{ host: "192.168.1.56", model: "H200", alias: "Hall hub", sourceType: "hub", deviceId: null }],
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
    const configuredAfterAdd: IntegrationStatus = {
      ...configured,
      tpLink: {
        ...configured.tpLink,
        connections: [
          ...configured.tpLink.connections!,
          {
            id: "hall-hub",
            houseId: house.id,
            configured: true,
            connected: false,
            lastPollAt: null,
            mappedDevices: 0,
            discoveredDevices: 0,
            hubModel: "H200",
            error: null,
            host: "192.168.1.56",
            sourceType: "hub",
            sourceModel: "H200",
            sourceAlias: "Hall hub",
          },
        ],
      },
    };
    vi.spyOn(api, "discoverIntegrations").mockResolvedValue({
      tpLink: [
        { host: "192.168.1.56", model: "H200", alias: "Hall hub", sourceType: "hub", deviceId: null },
        { host: "192.168.1.64", model: "P110", alias: "Laundry plug", sourceType: "energy-device", deviceId: null },
      ],
      homeAssistant: [],
      warnings: [],
    });
    const configure = vi.spyOn(api, "configureTpLink").mockResolvedValue({
      ok: true,
      configured: true,
      created: true,
      connectionId: "hall-hub",
      houseId: house.id,
      integration: configuredAfterAdd,
    });
    vi.spyOn(api, "integrations").mockResolvedValue(configuredAfterAdd);
    renderPage({ integration: configured, onRefreshTpLinkDevices: vi.fn().mockResolvedValue([]) });

    await user.click(screen.getByRole("tab", { name: /Where readings come from/ }));
    const discoveryPanel = screen.getByRole("group", { name: "Search this network" });
    await waitFor(() => expect((discoveryPanel as HTMLDetailsElement).open).toBe(true));
    const directSection = screen.getByRole("heading", { name: "Connect TP-Link directly" }).closest("section")!;
    const addFlow = directSection.querySelector<HTMLDetailsElement>(".setup-config-disclosure")!;
    await waitFor(() => expect(addFlow.open).toBe(true));
    expect(within(directSection).getByText("Add Hall hub")).not.toBeNull();
    expect((within(directSection).getByRole("radio", { name: /Hall hub/ }) as HTMLInputElement).checked).toBe(true);
    expect(within(directSection).getByRole("radio", { name: /Laundry plug/ })).not.toBeNull();
    expect(within(directSection).getByText(/confirm whether to import it with the Tapo or Kasa account/i)).not.toBeNull();
    expect((await within(directSection).findByLabelText("Hub or energy-device address") as HTMLInputElement).value).toBe("192.168.1.56");
    expect(within(directSection).queryByLabelText("TP-Link account email")).toBeNull();
    expect(within(directSection).queryByLabelText("TP-Link account password")).toBeNull();
    await user.click(within(directSection).getByRole("button", { name: "Import Hall hub" }));

    await waitFor(() => expect(configure).toHaveBeenCalledWith({
      houseId: house.id,
      host: "192.168.1.56",
      credentialSourceConnectionId: "legacy",
    }));
    expect(api.testTpLinkDraft).not.toHaveBeenCalled();
    expect(addFlow.open).toBe(false);
    expect(addFlow.querySelector("form")).toBeNull();
    expect(addFlow.querySelector("summary")?.textContent).toContain("Laundry plug");
    expect(within(directSection).getByText(/Hall hub was added to Coast house/)).not.toBeNull();
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

  it("leaves H200 child discovery on the server after the initial post-save refresh", async () => {
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
      tpLink: [{ host: "192.168.1.42", model: "H200", alias: "Hall hub", sourceType: "hub", deviceId: null }],
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

    const setupStatus = screen.getByRole("region", { name: "TP-Link setup status" });
    expect(within(setupStatus).getByText("Waiting for H200 to report paired sensors…")).not.toBeNull();
    expect(within(setupStatus).getByText(/Stugu keeps checking on the server/)).not.toBeNull();
    expect(within(setupStatus).queryByRole("progressbar")).toBeNull();

    await act(async () => { await vi.advanceTimersByTimeAsync(30_000); });

    expect(refreshTpLinkDevices).toHaveBeenCalledTimes(1);
    expect(api.integrations).toHaveBeenCalledTimes(1);
    expect(within(setupStatus).getByText("Waiting for H200 to report paired sensors…")).not.toBeNull();
    expect(within(setupStatus).queryByRole("button", { name: "Set up sensors" })).toBeNull();
    rendered.rerender(<I18nProvider><IntegrationsPage
      {...rendered.props}
      integration={{
        ...connectedWithoutChildren,
        tpLink: { ...connectedWithoutChildren.tpLink, lastPollAt: "2026-07-28T10:01:00.000Z" },
      }}
    /></I18nProvider>);
    expect(within(setupStatus).getByText("No paired sensors appeared yet.")).not.toBeNull();
    rendered.rerender(<I18nProvider><IntegrationsPage
      {...rendered.props}
      integration={{
        ...connectedWithoutChildren,
        tpLink: { ...connectedWithoutChildren.tpLink, discoveredDevices: 1 },
      }}
    /></I18nProvider>);
    expect(within(setupStatus).getByText("TP-Link devices to set up: 1")).not.toBeNull();
    expect(within(setupStatus).getAllByRole("button", { name: "Set up sensors" }).length).toBeGreaterThan(0);
    expect(onOpenSensors).not.toHaveBeenCalled();
  });

  it("accepts a later server-pushed child result while the saved hub connects", async () => {
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
      tpLink: [{ host: "192.168.1.42", model: "H200", alias: "Hall hub", sourceType: "hub", deviceId: null }],
      homeAssistant: [],
      warnings: [],
    });
    vi.spyOn(api, "configureTpLink").mockResolvedValue({ ok: true, configured: true, integration: connectingWithoutChildren });
    const firstStatus = deferred<IntegrationStatus>();
    const status = vi.spyOn(api, "integrations").mockReturnValue(firstStatus.promise);
    const refreshTpLinkDevices = vi.fn().mockResolvedValue([]);
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
      firstStatus.resolve({
        ...connectedWithoutChildren,
        tpLink: { ...connectedWithoutChildren.tpLink, discoveredDevices: 1 },
      });
      await firstStatus.promise;
      await Promise.resolve();
    });
    await act(async () => { await vi.advanceTimersByTimeAsync(5_000); });

    expect(refreshTpLinkDevices).toHaveBeenCalledTimes(1);
    expect(status).toHaveBeenCalledTimes(1);
    expect(screen.getByText("Paired sensors found: 1.")).not.toBeNull();
  });


});
