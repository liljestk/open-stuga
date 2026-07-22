import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { AlertEvent, House, IntegrationStatus, MeasurementSample, Property, Sensor } from "@climate-twin/contracts";
import { describe, expect, it, vi } from "vitest";
import { I18nProvider } from "../i18n";
import { PortfolioOverview } from "./PortfolioOverview";

const property: Property = {
  id: "property-main",
  name: "Main estate",
  description: null,
  location: null,
  createdAt: "2026-01-01T00:00:00.000Z",
  updatedAt: "2026-01-01T00:00:00.000Z",
};

const readyHouse: House = {
  id: "house-helsinki",
  propertyId: "property-main",
  name: "Helsinki home",
  timezone: "Europe/Helsinki",
  location: { latitude: 60.17, longitude: 24.94, label: "Helsinki" },
  floors: [],
  createdAt: "2026-01-01T00:00:00.000Z",
  updatedAt: "2026-01-01T00:00:00.000Z",
};

const setupHouse: House = {
  id: "house-auckland",
  propertyId: "property-main",
  name: "Auckland home",
  timezone: "Pacific/Auckland",
  floors: [],
  createdAt: "2026-01-01T00:00:00.000Z",
  updatedAt: "2026-01-01T00:00:00.000Z",
};

const healthyHouse: House = {
  ...readyHouse,
  id: "house-turku",
  name: "Turku home",
  location: { latitude: 60.45, longitude: 22.27, label: "Turku" },
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

const healthySensor: Sensor = {
  ...sensor,
  id: "sensor-turku-living-room",
  houseId: healthyHouse.id,
};

const integration: IntegrationStatus = {
  homeAssistant: { configured: false, connected: false, lastEventAt: null, mappedEntities: 0, error: null },
  tpLink: { configured: true, connected: true, lastPollAt: null, mappedDevices: 1, discoveredDevices: 1, hubModel: "H100", error: null },
  webhook: { configured: false, lastDeliveryAt: null, error: null },
  mock: { enabled: false, intervalMs: 2_000, mode: "real", activatedAt: "2026-01-01T00:00:00.000Z" },
  weather: { provider: "fmi", configuredHouses: 1, lastSuccessAt: null, error: null },
};

const openAlert: AlertEvent = {
  id: "alert-living-room",
  ruleId: "rule-temperature",
  sensorId: sensor.id,
  metric: "temperature",
  value: 30,
  threshold: 28,
  severity: "warning",
  startedAt: new Date().toISOString(),
  acknowledgedAt: null,
  resolvedAt: null,
};

describe("PortfolioOverview", () => {
  it("keeps attention homes stable, discloses confirmed homes, and routes the primary blocker action", async () => {
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
    const healthySample: MeasurementSample = { ...sample, sensorId: healthySensor.id };
    const onOpenTwin = vi.fn();
    const onOpenOutdoor = vi.fn();
    const onOpenSetup = vi.fn();
    const view = render(
      <I18nProvider>
        <PortfolioOverview
          properties={[property]}
          propertyAreas={[]}
          houses={[healthyHouse, setupHouse, readyHouse]}
          sensors={[sensor, healthySensor]}
          latestMeasurements={{ [sensor.id]: { temperature: sample }, [healthySensor.id]: { temperature: healthySample } }}
          measurementHistory={{}}
          alerts={[openAlert]}
          alertRules={[]}
          integration={integration}
          onOpenProperty={vi.fn()}
          onOpenTwin={onOpenTwin}
          onOpenOutdoor={onOpenOutdoor}
          onOpenSetup={onOpenSetup}
        />
      </I18nProvider>,
    );

    const readyCard = screen.getByRole("heading", { name: readyHouse.name }).closest("article")!;
    const setupCard = screen.getByRole("heading", { name: setupHouse.name }).closest("article")!;
    const confirmedDisclosure = view.container.querySelector<HTMLDetailsElement>(".portfolio-confirmed-homes")!;
    expect(confirmedDisclosure.open).toBe(false);
    expect(confirmedDisclosure.contains(screen.getByRole("heading", { name: healthyHouse.name }))).toBe(true);
    expect(screen.getByRole("heading", { level: 2, name: property.name })).toBeTruthy();
    expect(screen.getByRole("heading", { level: 3, name: "2 homes have an open exception" })).toBeTruthy();
    expect(screen.getByRole("heading", { level: 4, name: setupHouse.name })).toBeTruthy();
    expect(screen.getByRole("heading", { level: 4, name: readyHouse.name })).toBeTruthy();
    expect(screen.getByRole("heading", { level: 3, name: healthyHouse.name })).toBeTruthy();
    expect(Array.from(view.container.querySelectorAll("article.portfolio-card h3, article.portfolio-card h4"), (heading) => heading.textContent))
      .toEqual([setupHouse.name, readyHouse.name, healthyHouse.name]);

    expect(within(readyCard).getByText("Helsinki")).toBeTruthy();
    expect(within(readyCard).getByText(/1 enabled.*reporting/)).toBeTruthy();
    expect(within(readyCard).getByText("1 alerts")).toBeTruthy();
    expect(within(readyCard).getByText("Action required")).toBeTruthy();
    expect(within(readyCard).getByRole("button", { name: "Open home: Helsinki home" }).classList.contains("primary-button")).toBe(true);
    expect(within(readyCard).getByRole("button", { name: "Outdoor details: Helsinki home" })).toBeTruthy();

    expect(within(setupCard).getByText("Location not set")).toBeTruthy();
    expect(within(setupCard).getByText("Condition unknown")).toBeTruthy();
    expect(within(setupCard).getByText(/0 enabled.*waiting for data/)).toBeTruthy();
    expect(within(setupCard).getByRole("button", { name: "Finish setup: Auckland home" }).classList.contains("primary-button")).toBe(true);
    expect(within(setupCard).getByRole("button", { name: "Open home: Auckland home" })).toBeTruthy();

    await user.click(within(readyCard).getByRole("button", { name: "Outdoor details: Helsinki home" }));
    expect(onOpenOutdoor).toHaveBeenCalledWith(readyHouse.id);
    await user.click(within(readyCard).getByRole("button", { name: "Open home: Helsinki home" }));
    expect(onOpenTwin).toHaveBeenCalledWith(readyHouse.id);
    await user.click(within(setupCard).getByRole("button", { name: "Finish setup: Auckland home" }));
    expect(onOpenSetup).toHaveBeenCalledWith(setupHouse.id);
    await user.click(within(setupCard).getByRole("button", { name: "Open home: Auckland home" }));
    expect(onOpenTwin).toHaveBeenCalledWith(setupHouse.id);

    await user.click(screen.getByText("Monitoring confirmed · 1"));
    expect(confirmedDisclosure.open).toBe(true);
    const healthyCard = screen.getByRole("heading", { name: healthyHouse.name }).closest("article")!;
    expect(within(healthyCard).getByText("Monitoring confirmed")).toBeTruthy();
  });

  it("keeps a Property with no Homes visible and navigable", async () => {
    const user = userEvent.setup();
    const landOnly = { ...property, id: "property-forest", name: "Forest parcel" };
    const onOpenProperty = vi.fn();
    render(
      <I18nProvider>
        <PortfolioOverview
          properties={[property, landOnly]}
          propertyAreas={[]}
          houses={[]}
          sensors={[]}
          latestMeasurements={{}}
          measurementHistory={{}}
          alerts={[]}
          alertRules={[]}
          integration={integration}
          onOpenProperty={onOpenProperty}
          onOpenTwin={vi.fn()}
          onOpenOutdoor={vi.fn()}
          onOpenSetup={vi.fn()}
        />
      </I18nProvider>,
    );

    expect(screen.getByRole("heading", { name: "Main estate" })).toBeTruthy();
    expect(screen.getByRole("heading", { name: "Forest parcel" })).toBeTruthy();
    expect(screen.getByText("2 properties")).toBeTruthy();
    expect(screen.getAllByText("No homes belong to this property yet.")).toHaveLength(2);
    await user.click(screen.getByRole("button", { name: "Properties: Forest parcel" }));
    expect(onOpenProperty).toHaveBeenCalledWith(landOnly.id);
  });

  it("explains an empty Guest scope instead of presenting an empty healthy portfolio", () => {
    render(
      <I18nProvider>
        <PortfolioOverview
          properties={[]}
          propertyAreas={[]}
          houses={[]}
          sensors={[]}
          latestMeasurements={{}}
          measurementHistory={{}}
          alerts={[]}
          alertRules={[]}
          integration={integration}
          readOnly
          onOpenProperty={vi.fn()}
          onOpenTwin={vi.fn()}
          onOpenOutdoor={vi.fn()}
          onOpenSetup={vi.fn()}
        />
      </I18nProvider>,
    );

    expect(screen.getByRole("heading", { name: "No property access" })).toBeTruthy();
    expect(screen.getByText(/administrator has not shared a property, home, or area/i)).toBeTruthy();
    expect(screen.queryByText("Monitoring confirmed")).toBeNull();
  });
});
