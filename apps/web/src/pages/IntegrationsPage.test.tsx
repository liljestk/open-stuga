import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { House, HouseWeather, IntegrationStatus } from "@climate-twin/contracts";
import { afterEach, describe, expect, it, vi } from "vitest";
import { api } from "../api";
import { I18nProvider } from "../i18n";
import { IntegrationsPage } from "./IntegrationsPage";

vi.mock("../components/HouseLocationMap", () => ({
  HouseLocationMap: ({ onChange, ariaLabel }: { onChange: (location: { latitude: number; longitude: number }) => void; ariaLabel: string }) => (
    <button type="button" aria-label={ariaLabel} onClick={() => onChange({ latitude: 61.5, longitude: 25.25 })}>Map</button>
  ),
}));

const integration: IntegrationStatus = {
  homeAssistant: { configured: false, connected: false, lastEventAt: null, mappedEntities: 0, error: null },
  webhook: { configured: false, lastDeliveryAt: null, error: null },
  mock: { enabled: true, intervalMs: 2000 },
  weather: { provider: "fmi", configuredHouses: 1, lastSuccessAt: "2026-01-01T20:00:00.000Z", error: null },
};

const house: House = {
  id: "house-coast",
  name: "Coast house",
  timezone: "Europe/Helsinki",
  location: { latitude: 60.17, longitude: 24.94, label: "Helsinki" },
  floors: [],
  createdAt: "2026-01-01T00:00:00.000Z",
  updatedAt: "2026-01-01T00:00:00.000Z",
};

const weather: HouseWeather = {
  houseId: house.id,
  location: house.location!,
  provider: "fmi",
  attribution: "Finnish Meteorological Institute open data",
  fetchedAt: "2026-01-01T20:00:00.000Z",
  forecastIssuedAt: "2026-01-01T18:00:00.000Z",
  stale: false,
  current: {
    timestamp: "2026-01-01T20:00:00.000Z",
    temperatureC: 12.4,
    dewPointC: 7.2,
    relativeHumidityPercent: 71,
    pressureHpa: 1008,
    windDirectionDegrees: 220,
    windSpeedMps: 4.2,
    windGustMps: 7.1,
    precipitation1hMm: 0.4,
    precipitationIntensityMmPerHour: 0.7,
    precipitationProbabilityPercent: 60,
    precipitationFormCode: 1,
    snowDepthCm: 2,
    cloudCoverPercent: 84,
    lowCloudCoverPercent: 62,
    mediumCloudCoverPercent: 30,
    highCloudCoverPercent: 20,
    visibilityMeters: 12_000,
    globalRadiationWm2: 18,
    thunderstormProbabilityPercent: 5,
    frostProbabilityPercent: 10,
  },
  observationStation: { id: "station-1", name: "Harbour", latitude: 60.1, longitude: 24.9, distanceKm: 8.5 },
  forecast: [
    { timestamp: "2026-01-01T21:00:00.000Z", temperatureC: 11.8, relativeHumidityPercent: 74, windSpeedMps: 4.8, windGustMps: 7.5, precipitation1hMm: 0.6, precipitationProbabilityPercent: 70, cloudCoverPercent: 90, weatherSymbolCode: 22 },
    { timestamp: "2026-01-01T22:00:00.000Z", temperatureC: 10.6, relativeHumidityPercent: 78, windSpeedMps: 5.1, precipitation1hMm: 0.2, cloudCoverPercent: 76, weatherSymbolCode: 21 },
  ],
  warnings: [{
    id: "warning-1",
    event: "Wind warning",
    headline: "Strong wind near the coast",
    description: "Gusts may affect exposed structures.",
    severity: "moderate",
    urgency: "Expected",
    certainty: "Likely",
    effectiveAt: "2026-01-01T20:00:00.000Z",
    onsetAt: "2026-01-01T22:00:00.000Z",
    expiresAt: "2026-01-02T08:00:00.000Z",
    areas: ["Uusimaa"],
    web: "https://warnings.example.test/wind",
  }],
  unavailable: ["short-range"],
};

function renderPage(overrides: Partial<React.ComponentProps<typeof IntegrationsPage>> = {}) {
  localStorage.setItem("climate-twin-locale", "en");
  const props: React.ComponentProps<typeof IntegrationsPage> = {
    integration,
    house,
    houses: [house],
    units: "metric",
    onHouse: vi.fn(),
    onGeoreferenceChange: vi.fn().mockResolvedValue(undefined),
    ...overrides,
  };
  return { ...render(<I18nProvider><IntegrationsPage {...props} /></I18nProvider>), props };
}

afterEach(() => vi.restoreAllMocks());

describe("FMI weather integration", () => {
  it("renders broad current conditions, the hourly forecast, and warning details", async () => {
    const weatherSpy = vi.spyOn(api, "houseWeather").mockResolvedValue(weather);
    renderPage();

    expect((await screen.findAllByText("12.4 °C")).length).toBeGreaterThan(0);
    expect(weatherSpy).toHaveBeenCalledWith(house.id, 48);
    expect(screen.getByText("Dew point")).not.toBeNull();
    expect(screen.getByText("Air pressure")).not.toBeNull();
    expect(screen.getByText("Precipitation intensity")).not.toBeNull();
    expect(screen.getByText("Global solar radiation")).not.toBeNull();
    expect(screen.getByText("Thunderstorm probability")).not.toBeNull();
    expect(screen.getByText("short-range forecast supplement")).not.toBeNull();
    expect(screen.getByText("Observation station Harbour, 8.5 km away")).not.toBeNull();

    const forecastTable = screen.getByRole("table");
    expect(within(forecastTable).getByText("11.8 °C")).not.toBeNull();
    expect(within(forecastTable).getByText("22")).not.toBeNull();
    expect(screen.getByRole("heading", { name: "Strong wind near the coast" })).not.toBeNull();
    expect(screen.getByText("Gusts may affect exposed structures.")).not.toBeNull();
    expect(screen.getByText("Uusimaa")).not.toBeNull();
    expect(screen.getByText("Finnish Meteorological Institute open data")).not.toBeNull();
  });

  it("supports map placement, keyboard coordinate fields, saving, and house selection", async () => {
    const user = userEvent.setup();
    const { location: _location, ...houseWithoutLocation } = house;
    const noLocation: House = houseWithoutLocation;
    const secondHouse: House = { ...houseWithoutLocation, id: "house-lake", name: "Lake house" };
    const onHouse = vi.fn();
    const onGeoreferenceChange = vi.fn().mockResolvedValue(undefined);
    const rendered = renderPage({ house: noLocation, houses: [noLocation, secondHouse], onHouse, onGeoreferenceChange });

    await user.click(screen.getByRole("button", { name: "Map for choosing the house location" }));
    expect((screen.getByRole("spinbutton", { name: "Latitude" }) as HTMLInputElement).value).toBe("61.500000");
    expect((screen.getByRole("spinbutton", { name: "Longitude" }) as HTMLInputElement).value).toBe("25.250000");
    await user.type(screen.getByRole("textbox", { name: /Location label/ }), "Summer home");
    await user.click(screen.getByRole("button", { name: "Save location" }));

    await waitFor(() => expect(onGeoreferenceChange).toHaveBeenCalledWith({ location: { latitude: 61.5, longitude: 25.25, label: "Summer home" } }));
    expect(screen.getByText("House location saved. Weather data is updating.")).not.toBeNull();
    rendered.rerender(<I18nProvider><IntegrationsPage {...rendered.props} house={{
      ...noLocation,
      location: { latitude: 61.5, longitude: 25.25, label: "Summer home" },
    }} /></I18nProvider>);
    expect(screen.getByText("House location saved. Weather data is updating.")).not.toBeNull();
    await user.selectOptions(screen.getByRole("combobox", { name: "House" }), secondHouse.id);
    expect(onHouse).toHaveBeenCalledWith(secondHouse.id);
  });

  it("saves and clears plan orientation independently from location", async () => {
    const user = userEvent.setup();
    vi.spyOn(api, "houseWeather").mockResolvedValue(weather);
    const onGeoreferenceChange = vi.fn().mockResolvedValue(undefined);
    renderPage({ house: { ...house, orientationDegrees: 90 }, onGeoreferenceChange });

    expect(screen.getByText(/90.*\(east\)/)).not.toBeNull();
    await user.click(screen.getByRole("button", { name: /^W\s*270/ }));
    expect(screen.getByText(/270.*\(west\)/)).not.toBeNull();
    await user.click(screen.getByRole("button", { name: "Save orientation" }));
    await waitFor(() => expect(onGeoreferenceChange).toHaveBeenCalledWith({ orientationDegrees: 270 }));

    await user.click(screen.getByRole("button", { name: "Remove location" }));
    await waitFor(() => expect(onGeoreferenceChange).toHaveBeenCalledWith({ location: null }));
    expect(onGeoreferenceChange).not.toHaveBeenCalledWith(expect.objectContaining({ location: null, orientationDegrees: expect.anything() }));

    await user.click(screen.getByRole("button", { name: "Clear orientation" }));
    await waitFor(() => expect(onGeoreferenceChange).toHaveBeenCalledWith({ orientationDegrees: null }));
  });

  it("does not report no active warnings when FMI warning data is unavailable", async () => {
    vi.spyOn(api, "houseWeather").mockResolvedValue({
      ...weather,
      warnings: [],
      unavailable: ["warnings"],
    });
    renderPage();

    expect(await screen.findByText("FMI warning data is unavailable")).not.toBeNull();
    expect(screen.getByText("Warnings could not be loaded for this update. This does not mean there are no active warnings.")).not.toBeNull();
    expect(screen.queryByText("No active warnings for this location")).toBeNull();
  });
});
