import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { House, HouseWeather, OutdoorConditions } from "@climate-twin/contracts";
import { afterEach, describe, expect, it, vi } from "vitest";
import { api } from "../api";
import { I18nProvider } from "../i18n";
import { OutdoorWeatherPage, OutdoorWeatherView } from "./OutdoorWeatherPage";
import outdoorStyles from "./OutdoorWeatherPage.css?raw";

const house: House = {
  id: "house-coast",
  name: "Coast house",
  timezone: "Europe/Helsinki",
  location: { latitude: 60.17, longitude: 24.94, label: "Helsinki" },
  floors: [],
  createdAt: "2026-01-01T00:00:00.000Z",
  updatedAt: "2026-01-01T00:00:00.000Z",
};

function forecast(count = 48, start = "2026-01-01T00:00:00.000Z"): OutdoorConditions[] {
  const startTime = Date.parse(start);
  return Array.from({ length: count }, (_, index) => ({
    timestamp: new Date(startTime + index * 3_600_000).toISOString(),
    temperatureC: index,
    relativeHumidityPercent: 45 + index % 20,
    windSpeedMps: 2 + index / 10,
    windGustMps: 4 + index / 10,
    precipitation1hMm: 1,
    precipitationProbabilityPercent: index,
    cloudCoverPercent: index * 2 % 100,
  }));
}

function weather(overrides: Partial<HouseWeather> = {}): HouseWeather {
  return {
    houseId: house.id,
    location: house.location!,
    provider: "fmi",
    attribution: "Finnish Meteorological Institute open data",
    fetchedAt: "2026-01-01T00:00:00.000Z",
    forecastIssuedAt: "2025-12-31T22:00:00.000Z",
    stale: false,
    current: {
      timestamp: "2026-01-01T00:00:00.000Z",
      temperatureC: 2.5,
      dewPointC: -1,
      relativeHumidityPercent: 72,
      pressureHpa: 1008,
      windSpeedMps: 4.2,
      windGustMps: 6.1,
      windDirectionDegrees: 220,
      precipitation1hMm: 0.4,
      cloudCoverPercent: 80,
      visibilityMeters: 12_000,
    },
    observationStation: { id: "station-1", name: "Harbour", latitude: 60.1, longitude: 24.9, distanceKm: 8.5 },
    forecast: forecast(),
    warnings: [],
    unavailable: [],
    ...overrides,
  };
}

function componentStatuses(
  provider: HouseWeather["provider"],
  warningOverrides: Partial<NonNullable<HouseWeather["componentStatus"]>["warnings"]> = {},
): NonNullable<HouseWeather["componentStatus"]> {
  const attribution = provider === "fmi"
    ? "Finnish Meteorological Institute open data"
    : "Weather data by Open-Meteo.com (CC BY 4.0)";
  const status = (product: string): NonNullable<HouseWeather["componentStatus"]>["observation"] => ({
    provider,
    product,
    attribution,
    availability: "available",
    coverage: "covered",
    emptyResultIsAuthoritative: true,
    fetchedAt: "2026-01-01T00:00:00.000Z",
    stale: false,
  });
  return {
    observation: status("current conditions"),
    forecast: status("hourly forecast"),
    "short-range": status("short-range forecast"),
    warnings: { ...status("official warnings"), ...warningOverrides },
  };
}

function renderConnected(overrides: Partial<React.ComponentProps<typeof OutdoorWeatherPage>> = {}) {
  localStorage.setItem("climate-twin-locale", "en");
  return render(
    <I18nProvider>
      <OutdoorWeatherPage house={house} units="metric" {...overrides} />
    </I18nProvider>,
  );
}

function renderView(
  weatherValue: HouseWeather | null,
  overrides: Partial<React.ComponentProps<typeof OutdoorWeatherView>> = {},
) {
  localStorage.setItem("climate-twin-locale", "en");
  const props: React.ComponentProps<typeof OutdoorWeatherView> = {
    house,
    units: "metric",
    weather: weatherValue,
    loading: false,
    error: null,
    onRefresh: vi.fn(),
    ...overrides,
  };
  return {
    ...render(<I18nProvider><OutdoorWeatherView {...props} /></I18nProvider>),
    props,
  };
}

afterEach(() => vi.restoreAllMocks());

describe("OutdoorWeatherPage", () => {
  it("loads the existing 48-hour contract and paginates semantic 12-hour windows while summarizing all 48 hours", async () => {
    const user = userEvent.setup();
    const weatherSpy = vi.spyOn(api, "houseWeather").mockResolvedValue(weather());
    renderConnected();

    expect(await screen.findByRole("heading", { level: 1, name: "Outdoor weather" })).toBeTruthy();
    expect(weatherSpy).toHaveBeenCalledWith(house.id, 48);
    const summary = screen.getByRole("heading", { name: "Full 48-hour summary" }).closest("section")!;
    expect(within(summary).getByText("0 °C – 47 °C")).toBeTruthy();
    expect(within(summary).getByText("48 mm")).toBeTruthy();

    const table = screen.getByRole("table", { name: /Hourly forecast for Coast house, Next 12h/ });
    expect(within(table).getAllByRole("row")).toHaveLength(13);
    expect(within(table).getByText("0 °C")).toBeTruthy();
    expect(within(table).queryByText("12 °C")).toBeNull();

    await user.click(screen.getByRole("tab", { name: /\+12–24h/ }));
    expect(screen.getByRole("tab", { name: /\+12–24h/ }).getAttribute("aria-selected")).toBe("true");
    expect(within(screen.getByRole("table", { name: /\+12–24h/ })).getByText("12 °C")).toBeTruthy();
  });

  it("preserves a selected window across refresh, clamps it when data shrinks, and resets for house or horizon changes", async () => {
    const user = userEvent.setup();
    const initial = weather();
    const rendered = renderView(initial);

    await user.click(screen.getByRole("tab", { name: /\+36–48h/ }));
    expect(screen.getByRole("tab", { name: /\+36–48h/ }).getAttribute("aria-selected")).toBe("true");

    rendered.rerender(
      <I18nProvider>
        <OutdoorWeatherView {...rendered.props} weather={{ ...initial, fetchedAt: "2026-01-01T00:10:00.000Z" }} loading />
      </I18nProvider>,
    );
    expect(screen.getByRole("tab", { name: /\+36–48h/ }).getAttribute("aria-selected")).toBe("true");

    rendered.rerender(
      <I18nProvider>
        <OutdoorWeatherView {...rendered.props} weather={{ ...initial, forecast: forecast(25) }} />
      </I18nProvider>,
    );
    await waitFor(() => expect(screen.getByRole("tab", { name: /\+24–36h/ }).getAttribute("aria-selected")).toBe("true"));
    expect(screen.queryByRole("tab", { name: /\+36–48h/ })).toBeNull();

    const secondHouse: House = { ...house, id: "house-remote", name: "Remote house", timezone: "America/New_York" };
    rendered.rerender(
      <I18nProvider>
        <OutdoorWeatherView {...rendered.props} house={secondHouse} weather={{ ...initial, houseId: secondHouse.id }} />
      </I18nProvider>,
    );
    await waitFor(() => expect(screen.getByRole("tab", { name: /Next 12h/ }).getAttribute("aria-selected")).toBe("true"));

    await user.click(screen.getByRole("tab", { name: /\+12–24h/ }));
    rendered.rerender(
      <I18nProvider>
        <OutdoorWeatherView {...rendered.props} house={secondHouse} weather={{ ...initial, houseId: secondHouse.id }} horizonHours={24} />
      </I18nProvider>,
    );
    await waitFor(() => expect(screen.getByRole("tab", { name: /Next 12h/ }).getAttribute("aria-selected")).toBe("true"));
  });

  it("keeps warning status persistent and never turns unavailable or stale coverage into an all-clear", () => {
    const unavailable = weather({ warnings: [], unavailable: ["warnings"] });
    const rendered = renderView(unavailable);

    expect(screen.getByRole("heading", { name: "Warning status could not be verified" })).toBeTruthy();
    expect(screen.getByText(/Do not interpret this state as meaning there are no warnings/)).toBeTruthy();
    expect(screen.queryByText("No active warnings were returned")).toBeNull();

    rendered.rerender(<I18nProvider><OutdoorWeatherView {...rendered.props} weather={weather()} /></I18nProvider>);
    expect(screen.getByRole("heading", { name: "No active warnings were returned" })).toBeTruthy();
    expect(screen.getByText(/not a guarantee of warning coverage outside FMI's service/)).toBeTruthy();

    rendered.rerender(<I18nProvider><OutdoorWeatherView {...rendered.props} weather={weather({ stale: true })} /></I18nProvider>);
    expect(screen.getByRole("heading", { name: "Warning status could not be verified" })).toBeTruthy();
  });

  it("never presents an empty warning result as clear when component metadata says it is non-authoritative", () => {
    const rendered = renderView(weather({
      warnings: [],
      unavailable: [],
      componentStatus: componentStatuses("fmi", { emptyResultIsAuthoritative: false }),
    }));

    expect(screen.getByRole("heading", { name: "Warning status could not be verified" })).toBeTruthy();
    expect(screen.queryByRole("heading", { name: "No active warnings were returned" })).toBeNull();

    rendered.rerender(<I18nProvider><OutdoorWeatherView {...rendered.props} weather={weather({
      warnings: [],
      unavailable: [],
      componentStatus: componentStatuses("fmi", { emptyResultIsAuthoritative: true }),
    })} /></I18nProvider>);
    expect(screen.getByRole("heading", { name: "No active warnings were returned" })).toBeTruthy();
  });

  it("credits Open-Meteo and keeps its empty warning capability explicitly unverified", () => {
    const attribution = "Weather data by Open-Meteo.com (CC BY 4.0)";
    const globalHouse: House = {
      ...house,
      id: "house-auckland",
      name: "Auckland house",
      timezone: "Pacific/Auckland",
      location: { latitude: -36.85, longitude: 174.76, label: "Auckland" },
    };
    renderView(weather({
      houseId: globalHouse.id,
      location: globalHouse.location!,
      provider: "open-meteo",
      attribution,
      observationStation: null,
      warnings: [],
      unavailable: ["warnings"],
      componentStatus: componentStatuses("open-meteo", {
        availability: "not-applicable",
        coverage: "outside-coverage",
        emptyResultIsAuthoritative: false,
      }),
    }), { house: globalHouse });

    const attributionLink = screen.getByRole("link", { name: attribution });
    expect(attributionLink.getAttribute("href")).toBe("https://open-meteo.com/");
    expect(screen.getByText(/Modelled/)).toBeTruthy();
    expect(screen.getByRole("heading", { name: "Warning status could not be verified" })).toBeTruthy();
    expect(screen.queryByRole("heading", { name: "No active warnings were returned" })).toBeNull();
  });

  it("shows active warning details even when refresh verification failed", () => {
    renderView(weather({
      stale: true,
      warnings: [{
        id: "warning-1",
        event: "Wind warning",
        headline: "Strong wind near the coast",
        description: "Gusts may affect exposed structures.",
        severity: "moderate",
        urgency: "Expected",
        certainty: "Likely",
        effectiveAt: "2026-01-01T00:00:00.000Z",
        onsetAt: "2026-01-01T02:00:00.000Z",
        expiresAt: "2026-01-01T08:00:00.000Z",
        areas: ["Uusimaa"],
        web: "https://warnings.example.test/wind",
      }],
    }));

    const warningRegion = screen.getByRole("heading", { name: "Active official warnings" }).closest("section")!;
    expect(warningRegion.getAttribute("aria-live")).toBe("polite");
    expect(screen.getByRole("article", { name: "Strong wind near the coast" })).toBeTruthy();
    expect(screen.getByRole("heading", { level: 3, name: "Strong wind near the coast" })).toBeTruthy();
    expect(screen.getByRole("link", { name: /Open official warning: Strong wind near the coast/ })).toBeTruthy();
    expect(screen.getByText(/Do not interpret this state as meaning there are no warnings/)).toBeTruthy();
  });

  it("uses the shared page-heading language without creating a nested main landmark", () => {
    const rendered = renderView(weather());

    expect(rendered.container.querySelector("main")).toBeNull();
    expect(screen.getByRole("heading", { level: 1, name: "Outdoor weather" }).closest("header")?.classList.contains("page-heading")).toBe(true);
  });

  it("keeps semantic Outdoor status colors at WCAG AA contrast in both themes", () => {
    const lightBlock = outdoorStyles.match(/\.outdoor-weather-page\s*\{([^}]*)\}/s)?.[1] ?? "";
    const darkBlock = outdoorStyles.match(/@media \(prefers-color-scheme: dark\)[\s\S]*?\.outdoor-weather-page\s*\{([^}]*)\}/)?.[1] ?? "";
    const light = cssVariables(lightBlock);
    const dark = cssVariables(darkBlock);

    for (const [foreground, background] of [
      [light["--outdoor-blue"], "#fcfbf7"],
      [light["--outdoor-green"], light["--outdoor-green-soft"]],
      [light["--outdoor-amber"], light["--outdoor-amber-soft"]],
      [light["--outdoor-warning"], light["--outdoor-warning-soft"]],
      [light["--outdoor-accent-on"], light["--outdoor-accent-surface"]],
      [dark["--outdoor-blue"], "#1b1d19"],
      [dark["--outdoor-green"], dark["--outdoor-green-soft"]],
      [dark["--outdoor-amber"], dark["--outdoor-amber-soft"]],
      [dark["--outdoor-warning"], dark["--outdoor-warning-soft"]],
      [dark["--outdoor-accent-on"], dark["--outdoor-accent-surface"]],
    ]) expect(contrastRatio(foreground!, background!)).toBeGreaterThanOrEqual(4.5);
  });

  it("uses unambiguous date and UTC-offset labels, provides mobile cards, and keeps advanced details collapsed", async () => {
    const user = userEvent.setup();
    const newYork: House = {
      ...house,
      id: "house-new-york",
      name: "New York house",
      timezone: "America/New_York",
      location: { latitude: 40.7128, longitude: -74.006, label: "New York" },
    };
    const newYorkWeather = weather({
      houseId: newYork.id,
      location: newYork.location!,
      current: { timestamp: "2026-01-01T05:00:00.000Z", temperatureC: 1 },
      forecast: forecast(48, "2026-01-01T05:00:00.000Z"),
    });
    renderView(newYorkWeather, { house: newYork });

    const table = screen.getByRole("table", { name: /Hourly forecast for New York house/ });
    expect(within(table).getAllByText(/Jan 1, 2026/).length).toBeGreaterThan(0);
    expect(within(table).getAllByText(/GMT-5/).length).toBeGreaterThan(0);
    const mobileCards = document.querySelector(".outdoor-forecast-cards");
    expect(mobileCards?.getAttribute("aria-label")).toMatch(/Hourly forecast cards for New York house/);

    const details = screen.getByText("Advanced weather details").closest("details")!;
    expect(details.hasAttribute("open")).toBe(false);
    await user.click(screen.getByText("Advanced weather details"));
    expect(details.hasAttribute("open")).toBe(true);
    expect(within(details).getByText("Weather reference")).toBeTruthy();
  });

  it("does not request weather for an unlocated house and offers a routing callback", async () => {
    const user = userEvent.setup();
    const weatherSpy = vi.spyOn(api, "houseWeather");
    const onConfigureLocation = vi.fn();
    const { location: _location, ...unlocated } = house;
    renderConnected({ house: unlocated, onConfigureLocation });

    expect(screen.getByRole("heading", { name: "A weather location is needed" })).toBeTruthy();
    expect(weatherSpy).not.toHaveBeenCalled();
    await user.click(screen.getByRole("button", { name: "Configure location" }));
    expect(onConfigureLocation).toHaveBeenCalledOnce();
  });
});

function cssVariables(source: string): Record<string, string> {
  return Object.fromEntries([...source.matchAll(/(--[\w-]+)\s*:\s*(#[\da-f]{3,6})/gi)].map((match) => [match[1]!, match[2]!]));
}

function contrastRatio(foreground: string, background: string): number {
  const luminance = (color: string) => {
    const hexChannels = color.length === 4
      ? color.slice(1).split("").map((channel) => `${channel}${channel}`)
      : [color.slice(1, 3), color.slice(3, 5), color.slice(5, 7)];
    const channels = hexChannels
      .map((channel) => parseInt(channel, 16) / 255)
      .map((value) => value <= .04045 ? value / 12.92 : ((value + .055) / 1.055) ** 2.4);
    return .2126 * channels[0]! + .7152 * channels[1]! + .0722 * channels[2]!;
  };
  const foregroundLuminance = luminance(foreground);
  const backgroundLuminance = luminance(background);
  return (Math.max(foregroundLuminance, backgroundLuminance) + .05)
    / (Math.min(foregroundLuminance, backgroundLuminance) + .05);
}
