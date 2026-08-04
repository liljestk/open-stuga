import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import axe from "axe-core";
import type { HeatPumpState, IntegrationStatus } from "@climate-twin/contracts";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { api } from "../../api";
import { I18nProvider } from "../../i18n";
import { house, integration } from "../IntegrationsPageTestSupport";
import { GreeSetupPanel } from "./GreeSetupPanel";

const connection = {
  id: "gree-aabbccddeeff",
  houseId: house.id,
  equipmentId: "heat-pump-aabbccddeeff",
  configured: true,
  connected: true,
  lastPollAt: "2026-07-29T08:00:00.000Z",
  error: null,
  transport: "local" as const,
  host: "192.168.1.55",
  mac: "AABBCCDDEEFF",
  name: "Nordkapp",
  brand: "Wilfa",
  model: "Nordkapp 30",
  version: "4.0",
};

const state: HeatPumpState = {
  connectionId: connection.id,
  houseId: house.id,
  equipmentId: connection.equipmentId,
  deviceId: connection.mac,
  name: connection.name,
  brand: connection.brand,
  model: connection.model,
  transport: "local",
  floorId: null,
  roomId: null,
  x: null,
  y: null,
  z: null,
  observedAt: connection.lastPollAt,
  receivedAt: connection.lastPollAt,
  available: true,
  power: true,
  selectedMode: "cool",
  targetTemperatureC: 22,
  currentTemperatureC: 25,
  currentTemperatureSource: "reported",
  fanSpeed: "Auto",
  horizontalSwing: "Default",
  verticalSwing: "FullSwing",
  quiet: false,
  turbo: false,
  xfan: true,
  compressorFrequencyHz: null,
  diagnostics: {},
  activity: "unknown",
  activityEvidence: "unavailable",
};

function renderPanel(
  nextIntegration: IntegrationStatus,
  devices: React.ComponentProps<typeof GreeSetupPanel>["devices"] = [],
) {
  const onIntegrationChange = vi.fn();
  render(<I18nProvider><GreeSetupPanel
    house={house}
    integration={nextIntegration}
    devices={devices}
    onIntegrationChange={onIntegrationChange}
  /></I18nProvider>);
  return onIntegrationChange;
}

beforeEach(() => {
  localStorage.setItem("climate-twin-locale", "en");
  vi.spyOn(api, "discoverGree").mockResolvedValue([]);
  vi.spyOn(api, "heatPumpStates").mockResolvedValue([]);
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("Gree heat-pump setup", () => {
  it("offers the explicit EWPE fallback before a unit is discovered", () => {
    render(<I18nProvider><GreeSetupPanel
      house={house}
      integration={integration}
      devices={[]}
      onIntegrationChange={vi.fn()}
    /></I18nProvider>);
    expect(screen.getByText("Connect EWPE Smart")).not.toBeNull();
  });

  it("discovers silently when the Connections section opens", async () => {
    vi.mocked(api.discoverGree).mockResolvedValue([{
      transport: "local",
      host: connection.host,
      port: 7000,
      mac: connection.mac,
      name: connection.name,
      brand: connection.brand,
      model: connection.model,
      version: connection.version,
    }]);
    renderPanel(integration);

    expect(await screen.findByRole("button", { name: `Add to ${house.name}` })).not.toBeNull();
    expect(api.discoverGree).toHaveBeenCalledWith(house.id);
  });

  it("discovers through EWPE and saves credentials only with the explicit add", async () => {
    const cloudDevice = {
      transport: "ewpe-cloud" as const,
      host: "mqtt-eu.gree.com",
      port: 1984,
      mac: connection.mac,
      name: "AC3a95",
      brand: "Wilfa",
      model: "10001",
      version: "19.4",
      cloudHomeName: "Home",
      cloudRoomName: "Living room",
    };
    const discoverCloud = vi.spyOn(api, "discoverGreeCloud").mockResolvedValue([cloudDevice]);
    const configureCloud = vi.spyOn(api, "configureGreeCloud").mockResolvedValue({
      ok: true,
      configured: true,
      connectionId: connection.id,
      houseId: house.id,
      state: { ...state, transport: "ewpe-cloud", name: cloudDevice.name },
      integration: {
        ...integration,
        gree: {
          configured: true,
          connected: true,
          lastPollAt: connection.lastPollAt,
          error: null,
          connections: [{ ...connection, transport: "ewpe-cloud", name: cloudDevice.name }],
        },
      },
    });
    renderPanel(integration);
    const user = userEvent.setup();

    await user.click(screen.getByText("Connect EWPE Smart"));
    await user.type(screen.getByLabelText("EWPE email or username"), "reader@example.com");
    await user.type(screen.getByLabelText("EWPE password"), "secret");
    await user.click(screen.getByRole("button", { name: "Find heat pumps in EWPE" }));
    await waitFor(() => expect(discoverCloud).toHaveBeenCalledWith({
      houseId: house.id,
      username: "reader@example.com",
      password: "secret",
    }));
    expect(configureCloud).not.toHaveBeenCalled();

    await user.click(await screen.findByRole("button", { name: `Add to ${house.name}` }));
    await waitFor(() => expect(configureCloud).toHaveBeenCalledWith({
      houseId: house.id,
      mac: connection.mac,
      username: "reader@example.com",
      password: "secret",
    }));
    expect(screen.getByLabelText("EWPE password")).toHaveValue("");
  });

  it("offers one explicit add action for a discovered Wilfa unit", async () => {
    const configuredIntegration: IntegrationStatus = {
      ...integration,
      gree: {
        configured: true,
        connected: false,
        lastPollAt: null,
        error: null,
        connections: [{ ...connection, connected: false, lastPollAt: null }],
      },
    };
    const configure = vi.spyOn(api, "configureGree").mockResolvedValue({
      ok: true,
      configured: true,
      connectionId: connection.id,
      houseId: house.id,
      state,
      integration: configuredIntegration,
    });
    const onIntegrationChange = renderPanel(integration, [{
      transport: "local",
      host: connection.host,
      port: 7000,
      mac: connection.mac,
      name: connection.name,
      brand: connection.brand,
      model: connection.model,
      version: connection.version,
    }]);
    const user = userEvent.setup();

    expect(screen.getByRole("heading", { name: "Gree / Wilfa" })).not.toBeNull();
    await user.click(screen.getByRole("button", { name: `Add to ${house.name}` }));
    await waitFor(() => expect(configure).toHaveBeenCalledWith({
      houseId: house.id,
      mac: connection.mac,
    }));
    expect(onIntegrationChange).toHaveBeenCalledWith(configuredIntegration);
    expect(screen.getByText("Nordkapp was added.")).not.toBeNull();
  });

  it("does not present a selected cooling mode as actual compressor activity", async () => {
    vi.mocked(api.heatPumpStates).mockResolvedValue([{ ...state, compressorFrequencyHz: 12 }]);
    renderPanel({
      ...integration,
      gree: {
        configured: true,
        connected: true,
        lastPollAt: connection.lastPollAt,
        error: null,
        connections: [connection],
      },
    });

    expect(await screen.findByText("Cooling selected")).not.toBeNull();
    expect(screen.getByText("12 Hz")).not.toBeNull();
    expect(screen.getByText("Not reported by unit")).not.toBeNull();
    expect(screen.queryByText("Actively cooling")).toBeNull();
  });

  it("does not present stale state as current while the unit is unavailable", async () => {
    vi.mocked(api.heatPumpStates).mockResolvedValue([state]);
    renderPanel({
      ...integration,
      gree: {
        configured: true,
        connected: false,
        lastPollAt: connection.lastPollAt,
        error: "Heat-pump polling is unavailable",
        connections: [{
          ...connection,
          connected: false,
          error: "Heat-pump polling is unavailable",
        }],
      },
    });

    expect(await screen.findByText("Needs attention")).not.toBeNull();
    expect(screen.queryByText("Cooling selected")).toBeNull();
  });

  it("keeps the configured panel accessible", async () => {
    vi.mocked(api.heatPumpStates).mockResolvedValue([state]);
    const { container } = render(<I18nProvider><GreeSetupPanel
      house={house}
      integration={{
        ...integration,
        gree: {
          configured: true,
          connected: true,
          lastPollAt: connection.lastPollAt,
          error: null,
          connections: [connection],
        },
      }}
      devices={[]}
      onIntegrationChange={vi.fn()}
    /></I18nProvider>);

    await screen.findByText("Cooling selected");
    const result = await axe.run(container, {
      rules: { "color-contrast": { enabled: false } },
    });
    expect(result.violations).toEqual([]);
  });
});
