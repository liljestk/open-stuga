import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { House, IntegrationStatus } from "@climate-twin/contracts";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { api } from "../api";
import { ConfirmationProvider } from "../components/ConfirmationProvider";
import { queryClient } from "../data/queryClient";
import { I18nProvider } from "../i18n";
import { IntegrationsPage } from "./IntegrationsPage";
import { GreeSetupPanel } from "./IntegrationsPage/GreeSetupPanel";
import { TuyaSetupPanel } from "./IntegrationsPage/TuyaSetupPanel";
import { house, integration } from "./IntegrationsPageTestSupport";

const lakeHouse: House = {
  ...house,
  id: "house-lake",
  propertyId: "property-lake",
  name: "Lake home",
};

function withConfirmation(children: React.ReactNode) {
  return <I18nProvider><ConfirmationProvider>{children}</ConfirmationProvider></I18nProvider>;
}

function renderConnections(
  nextIntegration: IntegrationStatus,
  overrides: Partial<React.ComponentProps<typeof IntegrationsPage>> = {},
) {
  const props: React.ComponentProps<typeof IntegrationsPage> = {
    integration: nextIntegration,
    house,
    houses: [house],
    connectionHouses: [house, lakeHouse],
    units: "metric",
    streamConnection: "live",
    onHouse: vi.fn(),
    onHouseUpdate: vi.fn().mockResolvedValue(undefined),
    onGeoreferenceChange: vi.fn().mockResolvedValue(undefined),
    onIntegrationChange: vi.fn(),
    ...overrides,
  };
  render(withConfirmation(<IntegrationsPage {...props} />));
  return props;
}

beforeEach(() => {
  localStorage.setItem("climate-twin-locale", "en");
  window.history.replaceState(null, "", "/setup/connections");
  vi.spyOn(api, "discoverIntegrations").mockResolvedValue({
    tpLink: [],
    homeAssistant: [],
    warnings: [],
  });
  vi.spyOn(api, "discoverGree").mockResolvedValue([]);
  vi.spyOn(api, "heatPumpStates").mockResolvedValue([]);
  vi.spyOn(api, "connectedDevices").mockResolvedValue([]);
});

afterEach(() => {
  queryClient.clear();
  vi.restoreAllMocks();
});

describe("destructive integration flows", () => {
  it("cancels, then confirms moving Home Assistant between named Homes", async () => {
    const user = userEvent.setup();
    const source: IntegrationStatus = {
      ...integration,
      homeAssistant: {
        configured: true,
        connected: true,
        lastEventAt: "2026-07-31T10:00:00.000Z",
        mappedEntities: 2,
        error: null,
        connections: [{
          houseId: house.id,
          configured: true,
          connected: true,
          lastEventAt: "2026-07-31T10:00:00.000Z",
          mappedEntities: 2,
          error: null,
        }],
      },
    };
    const moved: IntegrationStatus = {
      ...source,
      homeAssistant: {
        ...source.homeAssistant,
        connections: [{ ...source.homeAssistant.connections![0]!, houseId: lakeHouse.id }],
      },
    };
    const move = vi.fn().mockResolvedValue({
      ok: true,
      fromHouseId: house.id,
      houseId: lakeHouse.id,
      integration: moved,
    });
    const props = renderConnections(source, { onMoveHomeAssistant: move });
    const manager = screen.getByRole("heading", { name: "Where readings come from", level: 2 }).closest("section")!;
    const picker = within(manager).getByRole("combobox", { name: "Assigned home for Home Assistant" });
    await user.selectOptions(picker, lakeHouse.id);
    const trigger = within(manager).getByRole("button", { name: "Move Home Assistant to Lake home" });

    await user.click(trigger);
    let dialog = screen.getByRole("dialog");
    expect(dialog).toHaveTextContent(
      "Move Home Assistant from Coast house to Lake home? Existing measurement mappings remain with Coast house; new sensors found through this connection will belong to Lake home.",
    );
    expect(within(dialog).getByRole("button", { name: "Move" })).toHaveClass("primary-button");
    await user.click(within(dialog).getByRole("button", { name: "Cancel" }));
    expect(move).not.toHaveBeenCalled();
    expect(trigger).toHaveFocus();

    await user.click(trigger);
    dialog = screen.getByRole("dialog");
    await user.click(within(dialog).getByRole("button", { name: "Move" }));

    await waitFor(() => expect(move).toHaveBeenCalledWith(house.id, lakeHouse.id));
    expect(props.onIntegrationChange).toHaveBeenCalledWith(moved);
    expect(screen.getByText("Connection moved to Lake home.")).not.toBeNull();
  });

  it("disconnects only the selected Home Assistant assignment after confirmation", async () => {
    const user = userEvent.setup();
    const source: IntegrationStatus = {
      ...integration,
      homeAssistant: {
        configured: true,
        connected: true,
        lastEventAt: null,
        mappedEntities: 2,
        error: null,
        connections: [{
          houseId: house.id,
          configured: true,
          connected: true,
          lastEventAt: null,
          mappedEntities: 2,
          error: null,
        }],
      },
    };
    const disconnected: IntegrationStatus = {
      ...source,
      homeAssistant: {
        ...source.homeAssistant,
        configured: false,
        connected: false,
        mappedEntities: 0,
        connections: [],
      },
    };
    const disconnect = vi.fn().mockResolvedValue({ ok: true, integration: disconnected });
    const props = renderConnections(source, { onDisconnectHomeAssistant: disconnect });

    await user.click(screen.getByRole("button", { name: "Disconnect Home Assistant from Coast house" }));
    const dialog = screen.getByRole("dialog");
    expect(dialog).toHaveTextContent(
      "Disconnect Home Assistant from Coast house? Sensor measurement mappings are preserved and will resume if this Home is connected again.",
    );
    expect(within(dialog).getByRole("button", { name: "Disconnect" })).toHaveClass("danger-button");
    await user.click(within(dialog).getByRole("button", { name: "Disconnect" }));

    await waitFor(() => expect(disconnect).toHaveBeenCalledWith(house.id));
    expect(props.onIntegrationChange).toHaveBeenCalledWith(disconnected);
    expect(screen.getByText("The Home assignment was disconnected.")).not.toBeNull();
  });

  it("preserves Gree history while disconnecting the selected heat pump", async () => {
    const user = userEvent.setup();
    const connection = {
      id: "gree-aabbccddeeff",
      houseId: house.id,
      equipmentId: "heat-pump-aabbccddeeff",
      configured: true,
      connected: true,
      lastPollAt: "2026-07-31T10:00:00.000Z",
      error: null,
      transport: "local" as const,
      host: "192.168.1.55",
      mac: "AABBCCDDEEFF",
      name: "Nordkapp",
      brand: "Wilfa",
      model: "Nordkapp 30",
      version: "4.0",
    };
    const source: IntegrationStatus = {
      ...integration,
      gree: {
        configured: true,
        connected: true,
        lastPollAt: connection.lastPollAt,
        error: null,
        connections: [connection],
      },
    };
    const disconnected: IntegrationStatus = {
      ...source,
      gree: {
        configured: false,
        connected: false,
        lastPollAt: null,
        error: null,
        connections: [],
      },
    };
    const disconnect = vi.spyOn(api, "disconnectGree").mockResolvedValue({ ok: true, integration: disconnected });
    const onIntegrationChange = vi.fn();
    render(withConfirmation(<GreeSetupPanel
      house={house}
      integration={source}
      devices={[]}
      onIntegrationChange={onIntegrationChange}
    />));

    await user.click(screen.getByRole("button", { name: "Disconnect" }));
    const dialog = screen.getByRole("dialog");
    expect(dialog).toHaveTextContent("Disconnect Nordkapp from Stugu? Its inventory record and state history will remain.");
    await user.click(within(dialog).getByRole("button", { name: "Disconnect" }));

    await waitFor(() => expect(disconnect).toHaveBeenCalledWith(connection.id));
    expect(onIntegrationChange).toHaveBeenCalledWith(disconnected);
    expect(screen.getByText("Nordkapp was disconnected. Its history was kept.")).not.toBeNull();
  });

  it("reports a failed Tuya disconnect and allows a confirmed retry", async () => {
    const user = userEvent.setup();
    const connection = {
      id: "tuya-reading-lamp",
      houseId: house.id,
      equipmentId: "equipment-reading-lamp",
      configured: true,
      connected: true,
      lastPollAt: "2026-07-31T10:00:00.000Z",
      error: null,
      host: "192.168.1.60",
      kind: "light" as const,
      profileId: "tuya-light-v1",
      name: "Reading lamp",
      model: "Smart bulb",
      capabilities: {
        power: true,
        brightness: true,
        colorTemperature: true,
        color: true,
        measuredPower: false,
        measuredEnergy: false,
      },
    };
    const source: IntegrationStatus = {
      ...integration,
      tuya: {
        configured: true,
        connected: true,
        lastPollAt: connection.lastPollAt,
        error: null,
        connections: [connection],
      },
    };
    const disconnected: IntegrationStatus = {
      ...source,
      tuya: {
        configured: false,
        connected: false,
        lastPollAt: null,
        error: null,
        connections: [],
      },
    };
    const disconnect = vi.spyOn(api, "disconnectTuya")
      .mockRejectedValueOnce(new Error("offline"))
      .mockResolvedValueOnce({ ok: true, integration: disconnected });
    const onIntegrationChange = vi.fn();
    render(withConfirmation(<TuyaSetupPanel
      house={house}
      integration={source}
      onIntegrationChange={onIntegrationChange}
    />));
    const trigger = screen.getByRole("button", { name: "Disconnect" });

    await user.click(trigger);
    let dialog = screen.getByRole("dialog");
    expect(dialog).toHaveTextContent("Disconnect Reading lamp from Stugu? Its inventory record and energy history will remain.");
    await user.click(within(dialog).getByRole("button", { name: "Disconnect" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("The Tuya connection could not be removed.");
    expect(trigger).not.toBeDisabled();

    await user.click(trigger);
    dialog = screen.getByRole("dialog");
    await user.click(within(dialog).getByRole("button", { name: "Disconnect" }));

    await waitFor(() => expect(disconnect).toHaveBeenCalledTimes(2));
    expect(onIntegrationChange).toHaveBeenCalledWith(disconnected);
    expect(screen.getByText("The Tuya device was disconnected. Its history was kept.")).not.toBeNull();
  });
});
