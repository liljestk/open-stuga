import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { IntegrationStatus } from "@climate-twin/contracts";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { api } from "../api";
import { historyAutomation, house, integration, renderPage } from "./IntegrationsPageTestSupport";

beforeEach(() => {
  window.history.replaceState(null, "", "/setup/connections");
  vi.spyOn(window, "confirm").mockReturnValue(true);
  vi.spyOn(api, "testTpLinkDraft").mockResolvedValue({ ok: true, message: "Connected" });
  vi.spyOn(api, "tpLinkHistoryExportJobs").mockResolvedValue({
    enabled: false,
    automation: historyAutomation,
    jobs: [],
  });
  vi.spyOn(api, "tpLinkDevices").mockResolvedValue([]);
  vi.spyOn(api, "discoverIntegrations").mockResolvedValue({
    tpLink: [],
    homeAssistant: [],
    warnings: [],
  });
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("Saved connection data paths", () => {
  it("imports a discovered device with an existing Tapo account by default", async () => {
    const user = userEvent.setup();
    const savedHub = {
      id: "hall-hub",
      houseId: house.id,
      configured: true,
      connected: true,
      lastPollAt: "2026-07-17T08:00:00.000Z",
      mappedDevices: 2,
      discoveredDevices: 3,
      hubModel: "H200" as const,
      error: null,
      host: "192.168.68.57",
      sourceType: "hub" as const,
      sourceModel: "H200",
      sourceAlias: "Hall hub",
    };
    const sourceIntegration: IntegrationStatus = {
      ...integration,
      tpLink: {
        ...integration.tpLink,
        configured: true,
        connected: true,
        connections: [savedHub],
      },
    };
    const importedConnection = {
      ...savedHub,
      id: "water-heater",
      host: "192.168.68.64",
      sourceType: "energy-device" as const,
      sourceModel: "P115",
      sourceAlias: "Water heater",
      hubModel: null,
      mappedDevices: 0,
      discoveredDevices: 1,
    };
    const configuredAfterImport: IntegrationStatus = {
      ...sourceIntegration,
      tpLink: {
        ...sourceIntegration.tpLink,
        connections: [savedHub, importedConnection],
      },
    };
    vi.spyOn(api, "discoverIntegrations").mockResolvedValue({
      tpLink: [{
        host: "192.168.68.64",
        model: "P115",
        alias: "Water heater",
        sourceType: "energy-device",
        deviceId: "p115-water-heater",
      }],
      homeAssistant: [],
      warnings: [],
    });
    const configure = vi.spyOn(api, "configureTpLink").mockResolvedValue({
      ok: true,
      configured: true,
      created: true,
      connectionId: importedConnection.id,
      houseId: house.id,
      deviceId: "p115-water-heater",
      sourceType: "energy-device",
      sourceModel: "P115",
      sourceAlias: "Water heater",
      integration: configuredAfterImport,
    });

    renderPage({ integration: sourceIntegration });

    const directSection = screen.getByRole("heading", {
      name: "Connect TP-Link directly",
    }).closest("section")!;
    expect(await within(directSection).findByText(/confirm whether to import it with the Tapo or Kasa account/i)).not.toBeNull();
    expect((within(directSection).getByRole("radio", {
      name: /Use the saved Tapo \/ Kasa account/i,
    }) as HTMLInputElement).checked).toBe(true);
    expect(within(directSection).getByText(/already used by Hall hub/i)).not.toBeNull();
    expect(within(directSection).queryByLabelText("TP-Link account email")).toBeNull();
    expect(within(directSection).queryByLabelText("TP-Link account password")).toBeNull();

    await user.click(within(directSection).getByRole("radio", { name: /Use a different account/i }));
    expect(within(directSection).getByLabelText("TP-Link account email")).not.toBeNull();
    expect(within(directSection).getByLabelText("TP-Link account password")).not.toBeNull();
    await user.click(within(directSection).getByRole("radio", { name: /Use the saved Tapo \/ Kasa account/i }));
    await user.click(within(directSection).getByRole("button", { name: "Import Water heater" }));

    await waitFor(() => expect(configure).toHaveBeenCalledWith({
      houseId: house.id,
      host: "192.168.68.64",
      credentialSourceConnectionId: savedHub.id,
    }));
    expect(api.testTpLinkDraft).not.toHaveBeenCalled();
    expect(window.confirm).not.toHaveBeenCalled();
    expect(within(directSection).getByText(/Water heater was added/)).not.toBeNull();
  });

  it("separates hub paths from direct plug paths and updates only the selected saved address", async () => {
    const user = userEvent.setup();
    const sourceIntegration: IntegrationStatus = {
      ...integration,
      tpLink: {
        ...integration.tpLink,
        configured: true,
        connected: true,
        connections: [
          {
            id: "hall-hub",
            houseId: house.id,
            configured: true,
            connected: false,
            lastPollAt: null,
            mappedDevices: 2,
            discoveredDevices: 3,
            hubModel: "H200",
            error: "Timed out getting discovery response for 192.168.68.57",
            host: "192.168.68.57",
            sourceType: "hub",
            sourceModel: "H200",
            sourceAlias: "Hall hub",
          },
          {
            id: "workshop-plug",
            houseId: house.id,
            configured: true,
            connected: true,
            lastPollAt: "2026-07-17T08:00:00.000Z",
            mappedDevices: 1,
            discoveredDevices: 1,
            hubModel: null,
            error: null,
            host: "192.168.68.56",
            sourceType: "energy-device",
            sourceModel: "P110",
            sourceAlias: "Workshop plug",
          },
        ],
      },
    };
    const configure = vi.spyOn(api, "configureTpLink").mockResolvedValue({
      ok: true,
      configured: true,
      created: false,
      connectionId: "hall-hub",
      houseId: house.id,
      integration: sourceIntegration,
    });

    renderPage({ integration: sourceIntegration });

    const manager = screen.getByRole("heading", {
      name: "Where readings come from",
      level: 2,
    }).closest("section")!;
    expect(within(manager).getByRole("heading", { name: "TP-Link hubs" })).not.toBeNull();
    expect(within(manager).getByRole("heading", { name: "Direct TP-Link devices" })).not.toBeNull();
    expect(within(manager).getByText(/checks every saved source automatically/i)).not.toBeNull();
    const hallDetails = within(manager).getByText("Hall hub").closest("details")!;
    const plugDetails = within(manager).getByText("Workshop plug").closest("details")!;
    expect(hallDetails.open).toBe(false);
    expect(plugDetails.open).toBe(false);
    await user.click(hallDetails.querySelector("summary")!);
    await user.click(plugDetails.querySelector("summary")!);
    expect(within(manager).getByText("Paired devices → H200 hub → Stugu")).not.toBeNull();
    expect(within(manager).getByText("P110 plug or meter → Stugu")).not.toBeNull();
    expect(within(manager).getByText("192.168.68.57")).not.toBeNull();
    expect(within(manager).getByText("192.168.68.56")).not.toBeNull();
    expect(within(manager).getByText("Timed out getting discovery response for 192.168.68.57")).not.toBeNull();

    await user.click(within(manager).getByRole("button", { name: "Update address for Hall hub" }));
    expect((screen.getByRole("group", { name: "Search this network" }) as HTMLDetailsElement).open).toBe(true);
    const directSection = screen.getByRole("heading", {
      name: "Connect TP-Link directly",
    }).closest("section")!;
    expect(within(directSection).getByText(/Saving replaces its address instead of creating another connection/)).not.toBeNull();
    const hostInput = within(directSection).getByLabelText("Hub or energy-device address");
    expect((hostInput as HTMLInputElement).value).toBe("192.168.68.57");
    await user.clear(hostInput);
    await user.type(hostInput, "192.168.68.99");
    await user.type(within(directSection).getByLabelText("TP-Link account email"), "owner@example.test");
    await user.type(within(directSection).getByLabelText("TP-Link account password"), "secret");
    await user.click(within(directSection).getByRole("button", {
      name: "Check direct TP-Link connection",
    }));
    await waitFor(() => expect(api.testTpLinkDraft).toHaveBeenCalled());
    await user.click(within(directSection).getByRole("button", { name: "Save and connect" }));
    await waitFor(() => expect(configure).toHaveBeenCalledWith({
      houseId: house.id,
      connectionId: "hall-hub",
      host: "192.168.68.99",
      username: "owner@example.test",
      password: "secret",
    }));
    expect(within(directSection).getByText(/Hall hub was updated/)).not.toBeNull();
  });
});
