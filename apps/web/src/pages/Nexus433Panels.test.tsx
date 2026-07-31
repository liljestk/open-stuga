import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Nexus433Status, Sensor } from "@climate-twin/contracts";
import { api } from "../api";
import { I18nProvider } from "../i18n";
import { house } from "./IntegrationsPageTestSupport";
import { Nexus433SetupPanel } from "./IntegrationsPage/Nexus433SetupPanel";
import { Nexus433SendersPanel } from "./SensorManagementPage/Nexus433SendersPanel";

const availableStatus: Nexus433Status = {
  houseId: house.id,
  capability: { available: true, gpioChip: "/dev/gpiochip0", gpioLine: 17 },
  enabled: true,
  revision: 1,
  runtime: "connected",
  brokerConnected: true,
  receiverOnline: true,
  receiverIdentity: "aabbccddeeff",
  lastMessageAt: "2026-07-31T10:00:00.000Z",
  error: null,
  operation: null,
};

const sensor: Sensor = {
  id: "sensor-01",
  houseId: house.id,
  floorId: "floor-ground",
  roomId: "living",
  room: "Living room",
  name: "Living room",
  model: "Nexus 433 MHz",
  x: 1,
  y: 1,
  z: 1.4,
  tags: [],
  enabled: true,
};

beforeEach(() => {
  localStorage.setItem("climate-twin-locale", "en");
  vi.spyOn(api, "nexus433Candidates").mockResolvedValue([]);
  vi.spyOn(api, "nexus433Bindings").mockResolvedValue([]);
});

afterEach(() => vi.restoreAllMocks());

describe("Nexus433 setup surfaces", () => {
  it("stays absent on hosts without the receiver capability", async () => {
    vi.spyOn(api, "nexus433Status").mockResolvedValue({
      ...availableStatus,
      capability: { available: false, gpioChip: null, gpioLine: null },
      enabled: false,
      runtime: "unavailable",
      brokerConnected: false,
      receiverOnline: null,
    });
    const { container } = render(<I18nProvider><Nexus433SetupPanel house={house} onOpenSensors={vi.fn()} /></I18nProvider>);
    await waitFor(() => expect(api.nexus433Status).toHaveBeenCalled());
    expect(container).toBeEmptyDOMElement();
  });

  it("queues receiver enablement from the Home connections surface", async () => {
    const disabled = { ...availableStatus, enabled: false, revision: 0, runtime: "disabled" as const, brokerConnected: false };
    vi.spyOn(api, "nexus433Status").mockResolvedValue(disabled);
    const configure = vi.spyOn(api, "configureNexus433").mockResolvedValue({ ...availableStatus, runtime: "starting" });
    render(<I18nProvider><Nexus433SetupPanel house={house} onOpenSensors={vi.fn()} /></I18nProvider>);
    const user = userEvent.setup();
    await user.click(await screen.findByRole("button", { name: "Start receiver" }));
    expect(configure).toHaveBeenCalledWith({ houseId: house.id, enabled: true, expectedRevision: 0 });
  });

  it("offers explicit ID replacement against the existing logical Sensor", async () => {
    vi.spyOn(api, "nexus433Status").mockResolvedValue(availableStatus);
    vi.mocked(api.nexus433Candidates).mockResolvedValue([{
      id: "candidate-2",
      providerKey: "6d01",
      senderId: "6d",
      channel: 1,
      firstSeenAt: "2026-07-31T10:00:00.000Z",
      lastSeenAt: "2026-07-31T10:00:00.000Z",
      expiresAt: "2026-07-31T16:00:00.000Z",
      sample: { temperature: 21.5, humidity: 48, battery: "ok", quality: 90 },
    }]);
    vi.mocked(api.nexus433Bindings).mockResolvedValue([{
      id: "binding-1",
      sensorId: sensor.id,
      providerKey: "5c01",
      senderId: "5c",
      channel: 1,
      revision: 1,
      battery: "ok",
      signalQuality: 85,
      available: false,
      lastSeenAt: "2026-07-31T09:00:00.000Z",
      lastAcceptedAt: "2026-07-31T09:00:00.000Z",
      createdAt: "2026-07-30T09:00:00.000Z",
    }]);
    const reconnect = vi.spyOn(api, "reconnectNexus433Sensor").mockResolvedValue({
      binding: { ...(await api.nexus433Bindings(house.id))[0]!, providerKey: "6d01", senderId: "6d", revision: 2 },
    });
    render(<I18nProvider><Nexus433SendersPanel house={house} sensors={[sensor]} readOnly={false} onAddSensor={vi.fn()} /></I18nProvider>);
    const user = userEvent.setup();
    await user.selectOptions(await screen.findByRole("combobox", { name: "Sensor" }), sensor.id);
    await user.click(screen.getByRole("button", { name: "Reconnect sender" }));
    await waitFor(() => expect(reconnect).toHaveBeenCalledWith(sensor.id, {
      houseId: house.id,
      candidateId: "candidate-2",
      expectedRevision: 1,
    }));
  });
});
