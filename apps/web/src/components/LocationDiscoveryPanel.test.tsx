import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { api } from "../api";
import { I18nProvider } from "../i18n";
import { LocationDiscoveryPanel } from "./LocationDiscoveryPanel";

describe("LocationDiscoveryPanel", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it("does not search or request browser location until the user asks", () => {
    const search = vi.spyOn(api, "searchLocations");
    const coordinateDefaults = vi.spyOn(api, "coordinateDefaults");
    const getCurrentPosition = vi.fn();
    vi.stubGlobal("navigator", { language: navigator.language, geolocation: { getCurrentPosition } });

    render(<I18nProvider><LocationDiscoveryPanel currentTimezone="UTC" onApply={vi.fn()} /></I18nProvider>);

    expect(search).not.toHaveBeenCalled();
    expect(coordinateDefaults).not.toHaveBeenCalled();
    expect(getCurrentPosition).not.toHaveBeenCalled();
    expect(screen.getByRole("button", { name: "Use this device's location" })).not.toBeNull();
  });

  it("shows the saved location summary before revealing ways to change it", async () => {
    const user = userEvent.setup();
    render(
      <I18nProvider>
        <LocationDiscoveryPanel
          currentLocation={{ latitude: 60.17, longitude: 24.94, label: "Helsinki" }}
          currentTimezone="Europe/Helsinki"
          onApply={vi.fn()}
        />
      </I18nProvider>,
    );

    expect(screen.getByText("Helsinki")).not.toBeNull();
    expect(screen.queryByLabelText("Find this home")).toBeNull();
    await user.click(screen.getByRole("button", { name: "Change" }));
    expect(screen.getByLabelText("Find this home")).not.toBeNull();
  });

  it("shows and confirms an inferred location, timezone, and automatic weather summary", async () => {
    const user = userEvent.setup();
    vi.spyOn(api, "searchLocations").mockResolvedValue([{
      id: "658225",
      name: "Helsinki",
      label: "Helsinki, Uusimaa, Finland",
      latitude: 60.16952,
      longitude: 24.93545,
      timezone: "Europe/Helsinki",
      countryCode: "FI",
      country: "Finland",
      region: "Uusimaa",
      source: "open-meteo-geocoding",
      confidence: "high",
    }]);
    const onApply = vi.fn().mockResolvedValue(undefined);
    render(<I18nProvider><LocationDiscoveryPanel currentTimezone="UTC" onApply={onApply} /></I18nProvider>);

    await user.type(screen.getByLabelText("Find this home"), "Helsinki");
    await user.click(screen.getByRole("button", { name: "Search" }));
    expect((await screen.findByRole("status")).textContent).toContain("Location suggestions: 1.");
    expect(screen.getByRole("button", { name: /Helsinki, Uusimaa, Finland/ }).getAttribute("aria-pressed")).toBe("true");
    expect(await screen.findByText(/Helsinki, Uusimaa, Finland · Europe\/Helsinki · weather automatic/)).not.toBeNull();
    expect(onApply).not.toHaveBeenCalled();

    await user.click(screen.getByRole("button", { name: "Use this setup" }));
    expect(onApply).toHaveBeenCalledWith(expect.objectContaining({
      location: expect.objectContaining({ latitude: 60.16952, longitude: 24.93545 }),
      timezone: "Europe/Helsinki",
      source: "place-search",
      confidence: "high",
    }));
  });

  it("exposes search and device-location progress with explicit busy labels", async () => {
    const user = userEvent.setup();
    let resolveSearch!: (results: Awaited<ReturnType<typeof api.searchLocations>>) => void;
    vi.spyOn(api, "searchLocations").mockImplementation(() => new Promise((resolve) => {
      resolveSearch = resolve;
    }));
    const getCurrentPosition = vi.fn();
    vi.stubGlobal("navigator", { language: navigator.language, geolocation: { getCurrentPosition } });

    render(<I18nProvider><LocationDiscoveryPanel currentTimezone="UTC" onApply={vi.fn()} /></I18nProvider>);

    const searchInput = screen.getByLabelText("Find this home");
    await user.type(searchInput, "Turku");
    await user.click(screen.getByRole("button", { name: "Search" }));

    const searchForm = searchInput.closest("form");
    expect(searchForm?.getAttribute("aria-busy")).toBe("true");
    expect((screen.getByRole("button", { name: "Searching…" }) as HTMLButtonElement).disabled).toBe(true);

    resolveSearch([{
      id: "633679",
      name: "Turku",
      label: "Turku, Southwest Finland, Finland",
      latitude: 60.45148,
      longitude: 22.26869,
      timezone: "Europe/Helsinki",
      countryCode: "FI",
      country: "Finland",
      region: "Southwest Finland",
      source: "open-meteo-geocoding",
      confidence: "high",
    }]);
    expect(await screen.findByText("Location suggestions: 1.")).not.toBeNull();
    expect(searchForm?.getAttribute("aria-busy")).toBe("false");

    await user.click(screen.getByRole("button", { name: "Use this device's location" }));
    expect(getCurrentPosition).toHaveBeenCalledOnce();
    expect((screen.getByRole("button", { name: "Finding your location…" }) as HTMLButtonElement).disabled).toBe(true);
  });

  it("reviews browser geolocation before persisting it", async () => {
    const user = userEvent.setup();
    let shareLocation!: PositionCallback;
    const getCurrentPosition = vi.fn((success: PositionCallback) => { shareLocation = success; });
    vi.stubGlobal("navigator", { language: navigator.language, geolocation: { getCurrentPosition } });
    vi.spyOn(api, "coordinateDefaults").mockResolvedValue({ timezone: "Europe/Helsinki", source: "open-meteo-coordinate" });
    const onApply = vi.fn().mockResolvedValue(undefined);
    render(<I18nProvider><LocationDiscoveryPanel currentTimezone="UTC" onApply={onApply} /></I18nProvider>);

    await user.click(screen.getByRole("button", { name: "Use this device's location" }));
    shareLocation({ coords: { latitude: 60.16952, longitude: 24.93545 } } as GeolocationPosition);

    expect(await screen.findByText(/Current device location.*Europe\/Helsinki.*weather automatic/)).not.toBeNull();
    expect(onApply).not.toHaveBeenCalled();
    await user.click(screen.getByRole("button", { name: "Use this setup" }));
    expect(onApply).toHaveBeenCalledWith(expect.objectContaining({
      location: expect.objectContaining({ latitude: 60.16952, longitude: 24.93545 }),
      timezone: "Europe/Helsinki",
      source: "browser-geolocation",
    }));
  });
});
