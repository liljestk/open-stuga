import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { House, IntegrationStatus, MeasurementSample, Sensor } from "@climate-twin/contracts";
import { describe, expect, it, vi } from "vitest";
import { I18nProvider } from "../i18n";
import { PortfolioOverview } from "./PortfolioOverview";

const readyHouse: House = {
  id: "house-helsinki",
  name: "Helsinki home",
  timezone: "Europe/Helsinki",
  location: { latitude: 60.17, longitude: 24.94, label: "Helsinki" },
  floors: [],
  createdAt: "2026-01-01T00:00:00.000Z",
  updatedAt: "2026-01-01T00:00:00.000Z",
};

const setupHouse: House = {
  id: "house-auckland",
  name: "Auckland home",
  timezone: "Pacific/Auckland",
  floors: [],
  createdAt: "2026-01-01T00:00:00.000Z",
  updatedAt: "2026-01-01T00:00:00.000Z",
};

const sensor: Sensor = {
  id: "sensor-living-room",
  houseId: readyHouse.id,
  floorId: "floor-main",
  name: "Living room",
  room: "Living room",
  model: "Tapo T315",
  x: 10,
  y: 10,
  z: 1.2,
  tags: [],
  enabled: true,
};

const integration: IntegrationStatus = {
  homeAssistant: { configured: false, connected: false, lastEventAt: null, mappedEntities: 0, error: null },
  tpLink: { configured: true, connected: true, lastPollAt: null, mappedDevices: 1, discoveredDevices: 1, hubModel: "H100", error: null },
  webhook: { configured: false, lastDeliveryAt: null, error: null },
  mock: { enabled: false, intervalMs: 2_000, mode: "real", activatedAt: "2026-01-01T00:00:00.000Z" },
  weather: { provider: "fmi", configuredHouses: 1, lastSuccessAt: null, error: null },
};

describe("PortfolioOverview", () => {
  it("keeps each home's readiness and actions scoped to that home", async () => {
    const user = userEvent.setup();
    const sample: MeasurementSample = {
      sensorId: sensor.id,
      metric: "temperature",
      value: 21.4,
      canonicalUnit: "°C",
      timestamp: new Date().toISOString(),
      source: "tp-link",
      quality: "good",
    };
    const onOpenTwin = vi.fn();
    const onOpenOutdoor = vi.fn();
    const onOpenSetup = vi.fn();
    render(
      <I18nProvider>
        <PortfolioOverview
          houses={[readyHouse, setupHouse]}
          sensors={[sensor]}
          latestMeasurements={{ [sensor.id]: { temperature: sample } }}
          openAlertSensorIds={new Set([sensor.id])}
          integration={integration}
          onOpenTwin={onOpenTwin}
          onOpenOutdoor={onOpenOutdoor}
          onOpenSetup={onOpenSetup}
        />
      </I18nProvider>,
    );

    const readyCard = screen.getByRole("heading", { name: readyHouse.name }).closest("article")!;
    const setupCard = screen.getByRole("heading", { name: setupHouse.name }).closest("article")!;
    expect(within(readyCard).getByText("Helsinki")).toBeTruthy();
    expect(within(readyCard).getByText(/1 enabled · reporting/)).toBeTruthy();
    expect(within(readyCard).getByText("1 alerts")).toBeTruthy();
    expect(within(readyCard).getByRole("button", { name: "Outdoor details: Helsinki home" })).toBeTruthy();
    expect(within(readyCard).getByRole("button", { name: "Open home: Helsinki home" }).textContent).toContain("Open home");
    expect(within(setupCard).getByText("Location not set")).toBeTruthy();
    expect(within(setupCard).getByText(/0 enabled · waiting for data/)).toBeTruthy();
    expect(within(setupCard).getByRole("button", { name: "Finish setup: Auckland home" })).toBeTruthy();
    expect(within(setupCard).getByRole("button", { name: "Open home: Auckland home" }).textContent).toContain("Open home");

    await user.click(within(readyCard).getByRole("button", { name: "Outdoor details: Helsinki home" }));
    expect(onOpenOutdoor).toHaveBeenCalledWith(readyHouse.id);
    await user.click(within(setupCard).getByRole("button", { name: "Finish setup: Auckland home" }));
    expect(onOpenSetup).toHaveBeenCalledWith(setupHouse.id);
    await user.click(within(setupCard).getByRole("button", { name: "Open home: Auckland home" }));
    expect(onOpenTwin).toHaveBeenCalledWith(setupHouse.id);
  });
});
