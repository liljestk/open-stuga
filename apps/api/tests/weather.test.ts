import { createServer, type Server } from "node:http";
import type { House, HouseWeather, IntegrationStatus, WeatherUpdateEvent } from "@climate-twin/contracts";
import { afterEach, describe, expect, it, vi } from "vitest";
import request from "supertest";
import { createApi, type ApiRuntime } from "../src/app.js";
import type { AppConfig } from "../src/config.js";
import {
  currentObservation,
  FmiWeatherProvider,
  fmiWarningCoverage,
  parseCapWarnings,
  parseFmiTimeSeries,
  readTextWithByteLimit,
  WeatherRequestSupersededError,
  WeatherService,
  WeatherUnavailableError,
  type FmiTimeSeries,
  type WeatherProvider,
} from "../src/weather.js";

const config: AppConfig = {
  port: 0,
  apiHost: "127.0.0.1",
  databasePath: ":memory:",
  integrationSecretsFile: "integration-secrets.test.json",
  assetDirectory: ".",
  mockEnabled: false,
  mockIntervalMs: 25,
  retentionDays: 730,
  ingestApiKey: null,
  haUrl: null,
  haToken: null,
  haEntityMapFile: null,
  tpLinkHost: null,
  tpLinkUsername: null,
  tpLinkPassword: null,
  tpLinkDeviceMapFile: null,
  tpLinkPollIntervalMs: 10_000,
  tpLinkPython: "python",
  tpLinkBridgeScript: "apps/api/python/tp_link_bridge.py",
  alertWebhookUrl: null,
  alertWebhookBearerToken: null,
  corsOrigin: null,
};

const location = { latitude: 60.1699, longitude: 24.9384, label: "Helsinki" };

function weather(overrides: Partial<HouseWeather> = {}): HouseWeather {
  return {
    houseId: "house-main",
    location,
    provider: "fmi",
    attribution: "Finnish Meteorological Institute open data (CC BY 4.0)",
    fetchedAt: "2026-07-14T10:00:00.000Z",
    forecastIssuedAt: "2026-07-14T09:00:00.000Z",
    stale: false,
    current: { timestamp: "2026-07-14T09:50:00.000Z", temperatureC: 20.5 },
    observationStation: {
      id: "101004",
      name: "Helsinki Kaisaniemi",
      latitude: 60.1752,
      longitude: 24.9446,
      distanceKm: 0.8,
    },
    forecast: [{ timestamp: "2026-07-14T11:00:00.000Z", temperatureC: 21.2 }],
    warnings: [],
    unavailable: [],
    ...overrides,
  };
}

function forecastXml(latitude: number, longitude: number): string {
  return `<FeatureCollection><member><PointTimeSeriesObservation>
    <observedProperty href="https://opendata.fmi.fi/meta?param=Temperature" />
    <resultTime><TimeInstant><timePosition>2026-07-14T10:00:00Z</timePosition></TimeInstant></resultTime>
    <featureOfInterest><SF_SpatialSamplingFeature><sampledFeature><LocationCollection><member><Location>
      <identifier>forecast-grid</identifier><name>Forecast grid</name>
    </Location></member></LocationCollection></sampledFeature>
    <shape><Point><name>Forecast point</name><pos>${latitude} ${longitude}</pos></Point></shape>
    </SF_SpatialSamplingFeature></featureOfInterest>
    <result><MeasurementTimeseries><point><MeasurementTVP>
      <time>2026-07-14T11:00:00Z</time><value>18.5</value>
    </MeasurementTVP></point></MeasurementTimeseries></result>
  </PointTimeSeriesObservation></member></FeatureCollection>`;
}

describe("FMI weather parsing", () => {
  it("classifies definitely outside warning coverage without treating the Finland envelope as proof of coverage", () => {
    expect(fmiWarningCoverage(location)).toBe("unknown");
    expect(fmiWarningCoverage({ ...location, countryCode: "FI" })).toBe("covered");
    expect(fmiWarningCoverage({ ...location, countryCode: "SE" })).toBe("outside-coverage");
    expect(fmiWarningCoverage({ latitude: 40.7128, longitude: -74.006, label: "New York" }))
      .toBe("outside-coverage");
    expect(fmiWarningCoverage({ latitude: -33.8688, longitude: 151.2093, label: "Sydney" }))
      .toBe("outside-coverage");
  });

  it("marks warnings outside FMI coverage as non-authoritative and skips the CAP request", async () => {
    const newYork = { latitude: 40.7128, longitude: -74.006, label: "New York" };
    const fetchImpl = vi.fn(async (input: string | URL | Request) => {
      const url = String(input);
      const xml = url.includes("fmi::observations::weather")
        ? "<FeatureCollection />"
        : forecastXml(newYork.latitude, newYork.longitude);
      return new Response(xml, { status: 200, headers: { "content-type": "application/xml" } });
    });
    const provider = new FmiWeatherProvider({
      fetchImpl: fetchImpl as typeof fetch,
      now: () => new Date("2026-07-14T10:00:00Z"),
    });

    const result = await provider.fetch("house-new-york", newYork, 48);

    expect(result.forecast).toHaveLength(1);
    expect(result.warnings).toEqual([]);
    expect(result.unavailable).toContain("warnings");
    expect(result.componentStatus?.warnings).toMatchObject({
      provider: "fmi",
      availability: "not-applicable",
      coverage: "outside-coverage",
      emptyResultIsAuthoritative: false,
      stale: false,
    });
    expect(fetchImpl.mock.calls.some(([input]) => String(input).includes("alerts.fmi.fi"))).toBe(false);
  });

  it("does not turn a failed CAP request into an authoritative empty warning result", async () => {
    const fetchImpl = vi.fn(async (input: string | URL | Request) => {
      const url = String(input);
      if (url.includes("alerts.fmi.fi")) throw new Error("CAP unavailable");
      const xml = url.includes("fmi::observations::weather")
        ? "<FeatureCollection />"
        : forecastXml(location.latitude, location.longitude);
      return new Response(xml, { status: 200, headers: { "content-type": "application/xml" } });
    });
    const provider = new FmiWeatherProvider({
      fetchImpl: fetchImpl as typeof fetch,
      now: () => new Date("2026-07-14T10:00:00Z"),
    });

    const result = await provider.fetch("house-main", location, 48);

    expect(result.warnings).toEqual([]);
    expect(result.unavailable).toContain("warnings");
    expect(result.componentStatus?.warnings).toMatchObject({
      availability: "unavailable",
      coverage: "unknown",
      emptyResultIsAuthoritative: false,
    });
  });

  it("parses forecast points and observation-station shapes while omitting NaN values", () => {
    const xml = `
      <FeatureCollection>
        <member>
          <PointTimeSeriesObservation>
            <observedProperty href="https://opendata.fmi.fi/meta?param=Temperature" />
            <resultTime><TimeInstant><timePosition>2026-07-14T09:00:00Z</timePosition></TimeInstant></resultTime>
            <featureOfInterest>
              <SF_SpatialSamplingFeature>
                <sampledFeature>
                  <LocationCollection><member><Location><identifier>grid-60-24</identifier><name>Forecast grid</name></Location></member></LocationCollection>
                </sampledFeature>
                <shape><Point><name>Forecast point</name><pos>60.1699 24.9384</pos></Point></shape>
              </SF_SpatialSamplingFeature>
            </featureOfInterest>
            <result>
              <MeasurementTimeseries>
                <point><MeasurementTVP><time>2026-07-14T10:00:00Z</time><value>19.5</value></MeasurementTVP></point>
                <point><MeasurementTVP><time>2026-07-14T11:00:00Z</time><value>NaN</value></MeasurementTVP></point>
              </MeasurementTimeseries>
            </result>
          </PointTimeSeriesObservation>
        </member>
        <member>
          <PointTimeSeriesObservation>
            <observedProperty href="https://opendata.fmi.fi/meta?param=t2m" />
            <resultTime><TimeInstant><timePosition>2026-07-14T10:00:00Z</timePosition></TimeInstant></resultTime>
            <featureOfInterest>
              <SF_SpatialSamplingFeature>
                <sampledFeature>
                  <LocationCollection><member><Location><identifier>101004</identifier><name>Kaisaniemi location</name></Location></member></LocationCollection>
                </sampledFeature>
                <shape>
                  <MultiPoint><pointMembers><Point><name>Helsinki Kaisaniemi</name><pos>60.1752 24.9446</pos></Point></pointMembers></MultiPoint>
                </shape>
              </SF_SpatialSamplingFeature>
            </featureOfInterest>
            <result>
              <MeasurementTimeseries>
                <point><MeasurementTVP><time>2026-07-14T09:50:00Z</time><value>20.5</value></MeasurementTVP></point>
              </MeasurementTimeseries>
            </result>
          </PointTimeSeriesObservation>
        </member>
      </FeatureCollection>
    `;

    expect(parseFmiTimeSeries(xml)).toEqual([
      {
        parameter: "Temperature",
        resultTime: "2026-07-14T09:00:00Z",
        location: {
          id: "grid-60-24",
          name: "Forecast point",
          latitude: 60.1699,
          longitude: 24.9384,
        },
        values: [{ timestamp: "2026-07-14T10:00:00Z", value: 19.5 }],
      },
      {
        parameter: "t2m",
        resultTime: "2026-07-14T10:00:00Z",
        location: {
          id: "101004",
          name: "Helsinki Kaisaniemi",
          latitude: 60.1752,
          longitude: 24.9446,
        },
        values: [{ timestamp: "2026-07-14T09:50:00Z", value: 20.5 }],
      },
    ]);
  });

  it("selects CAP warnings containing the house and excludes cancellation messages", () => {
    const warning = (id: string, msgType: string, polygon: string, event: string) => `
      <entry>
        <id>${id}-entry</id>
        <content>
          <alert>
            <identifier>${id}</identifier>
            <status>Actual</status>
            <msgType>${msgType}</msgType>
            <info>
              <language>en-GB</language>
              <event>${event}</event>
              <headline>${event} headline</headline>
              <description>${event} description</description>
              <severity>Severe</severity>
              <urgency>Immediate</urgency>
              <certainty>Likely</certainty>
              <effective>2026-07-14T08:00:00Z</effective>
              <onset>2026-07-14T09:00:00Z</onset>
              <expires>2026-07-14T18:00:00Z</expires>
              <web>javascript:alert(1)</web>
              <area><areaDesc>Test area</areaDesc><polygon>${polygon}</polygon></area>
            </info>
          </alert>
        </content>
      </entry>
    `;
    const xml = `<feed>
      ${warning("inside", "Alert", "60,24 60,25 61,25 61,24 60,24", "Wind warning")}
      ${warning("outside", "Alert", "62,26 62,27 63,27 63,26 62,26", "Snow warning")}
      ${warning("cancelled", "Cancel", "60,24 60,25 61,25 61,24 60,24", "Cancelled warning")}
    </feed>`;

    expect(parseCapWarnings(xml, location, new Date("2026-07-14T12:00:00Z"))).toEqual([
      expect.objectContaining({
        id: "inside",
        event: "Wind warning",
        severity: "severe",
        areas: ["Test area"],
        web: null,
      }),
    ]);
  });

  it("excludes expired warnings", () => {
    const xml = `<feed><entry><content><alert>
      <identifier>expired</identifier><status>Actual</status><msgType>Alert</msgType>
      <info><language>en-GB</language><event>Wind</event><severity>Moderate</severity>
        <expires>2026-07-14T11:59:59Z</expires>
        <area><areaDesc>Test area</areaDesc><polygon>60,24 60,25 61,25 61,24 60,24</polygon></area>
      </info>
    </alert></content></entry></feed>`;

    expect(parseCapWarnings(xml, location, new Date("2026-07-14T12:00:00Z"))).toEqual([]);
  });

  it("selects a station with a recent temperature and anchors other fields to that time", () => {
    const station = (
      id: string,
      name: string,
      latitude: number,
      longitude: number,
      parameter: string,
      values: FmiTimeSeries["values"],
    ): FmiTimeSeries => ({
      parameter,
      resultTime: "2026-07-14T10:00:00Z",
      location: { id, name, latitude, longitude },
      values,
    });
    const series = [
      station("near", "Near but stale", 60.17, 24.94, "t2m", [
        { timestamp: "2026-07-14T08:00:00Z", value: 17 },
      ]),
      station("recent", "Recent station", 60.20, 24.98, "t2m", [
        { timestamp: "2026-07-14T09:30:00Z", value: 19 },
        { timestamp: "2026-07-14T09:50:00Z", value: 20 },
      ]),
      station("recent", "Recent station", 60.20, 24.98, "rh", [
        { timestamp: "2026-07-14T09:40:00Z", value: 65 },
      ]),
      station("recent", "Recent station", 60.20, 24.98, "ws_10min", [
        { timestamp: "2026-07-14T08:00:00Z", value: 99 },
      ]),
      station("recent", "Recent station", 60.20, 24.98, "vis", [
        { timestamp: "2026-07-14T10:00:00Z", value: 20_000 },
      ]),
    ];

    expect(currentObservation(series, location, new Date("2026-07-14T10:00:00Z"))).toEqual({
      current: {
        timestamp: "2026-07-14T09:50:00Z",
        temperatureC: 20,
        relativeHumidityPercent: 65,
        visibilityMeters: 20_000,
      },
      station: expect.objectContaining({ id: "recent", name: "Recent station" }),
    });
  });

  it("cancels a streamed response as soon as its byte limit is exceeded", async () => {
    let pulls = 0;
    let cancelled = false;
    const body = new ReadableStream<Uint8Array>({
      pull(controller) {
        pulls += 1;
        controller.enqueue(new TextEncoder().encode("1234"));
        if (pulls === 10) controller.close();
      },
      cancel() {
        cancelled = true;
      },
    });

    await expect(readTextWithByteLimit(new Response(body), 5)).rejects.toThrow("size limit");
    expect(cancelled).toBe(true);
    expect(pulls).toBeLessThan(10);
  });
});

describe("WeatherService", () => {
  afterEach(() => vi.restoreAllMocks());

  it("returns a fresh cached result and falls back to a stale result after refresh failure", async () => {
    let clock = 1_000;
    vi.spyOn(Date, "now").mockImplementation(() => clock);
    const provider: WeatherProvider = {
      fetch: vi.fn().mockResolvedValueOnce(weather()).mockRejectedValue(new WeatherUnavailableError("FMI offline")),
    };
    const status: IntegrationStatus["weather"] = {
      provider: "fmi",
      configuredHouses: 1,
      lastSuccessAt: null,
      error: null,
    };
    const onStatusChange = vi.fn();
    const service = new WeatherService(provider, status, onStatusChange, 100, 500);
    const house: House = {
      id: "house-main",
      name: "Home",
      timezone: "Europe/Helsinki",
      location,
      floors: [],
      createdAt: "2026-07-14T00:00:00.000Z",
      updatedAt: "2026-07-14T00:00:00.000Z",
    };

    const initial = await service.get(house, 48);
    const cached = await service.get(house, 48);
    expect(cached).toBe(initial);
    expect(provider.fetch).toHaveBeenCalledTimes(1);
    expect(status).toMatchObject({ lastSuccessAt: initial.fetchedAt, error: null });
    expect(status.connections).toEqual([{
      houseId: house.id,
      configured: true,
      provider: "fmi",
      lastSuccessAt: initial.fetchedAt,
      error: null,
    }]);

    clock = 1_101;
    const stale = await service.get(house, 48);
    expect(stale).toEqual({ ...initial, stale: true });
    expect(initial.stale).toBe(false);
    expect(provider.fetch).toHaveBeenCalledTimes(2);
    expect(status.error).toBe("FMI offline");
    expect(status.connections?.[0]).toMatchObject({ houseId: house.id, error: "FMI offline" });
    expect(onStatusChange).toHaveBeenCalledTimes(2);

    clock = 1_501;
    await expect(service.get(house, 48)).rejects.toThrow("FMI offline");
    expect(provider.fetch).toHaveBeenCalledTimes(3);
  });

  it("removes expired forecast points and warnings from a stale fallback", async () => {
    let clock = Date.parse("2026-07-14T10:00:00Z");
    vi.spyOn(Date, "now").mockImplementation(() => clock);
    const initial = weather({
      forecast: [
        { timestamp: "2026-07-14T10:05:00Z", temperatureC: 20 },
        { timestamp: "2026-07-14T11:00:00Z", temperatureC: 21 },
      ],
      warnings: [
        {
          id: "expiring", event: "Wind", headline: "Wind", description: "",
          severity: "moderate", urgency: "Expected", certainty: "Likely",
          effectiveAt: null, onsetAt: null, expiresAt: "2026-07-14T10:05:00Z", areas: ["Uusimaa"], web: null,
        },
        {
          id: "open-ended", event: "Flood", headline: "Flood", description: "",
          severity: "minor", urgency: "Expected", certainty: "Possible",
          effectiveAt: null, onsetAt: null, expiresAt: null, areas: ["Uusimaa"], web: null,
        },
      ],
    });
    const provider: WeatherProvider = {
      fetch: vi.fn().mockResolvedValueOnce(initial).mockRejectedValue(new WeatherUnavailableError("FMI offline")),
    };
    const status: IntegrationStatus["weather"] = {
      provider: "fmi", configuredHouses: 1, lastSuccessAt: null, error: null,
    };
    const service = new WeatherService(provider, status, vi.fn(), 5 * 60_000);
    const house: House = {
      id: "house-main", name: "Home", timezone: "Europe/Helsinki", location, floors: [],
      createdAt: "2026-07-14T00:00:00.000Z", updatedAt: "2026-07-14T00:00:00.000Z",
    };

    await service.get(house, 48);
    clock = Date.parse("2026-07-14T10:06:00Z");
    const stale = await service.get(house, 48);

    expect(stale.stale).toBe(true);
    expect(stale.forecast.map((point) => point.timestamp)).toEqual(["2026-07-14T11:00:00Z"]);
    expect(stale.warnings.map((warning) => warning.id)).toEqual(["open-ended"]);
  });

  it("coalesces identical requests and keeps alternating horizons in a bounded LRU", async () => {
    const status: IntegrationStatus["weather"] = {
      provider: "fmi", configuredHouses: 1, lastSuccessAt: null, error: null,
    };
    let release: ((value: HouseWeather) => void) | undefined;
    const provider: WeatherProvider = {
      fetch: vi.fn(() => new Promise<HouseWeather>((resolve) => { release = resolve; })),
    };
    const service = new WeatherService(provider, status, vi.fn(), 60_000, 60_000, 2);
    const house: House = {
      id: "house-main", name: "Home", timezone: "Europe/Helsinki", location, floors: [],
      createdAt: "2026-07-14T00:00:00.000Z", updatedAt: "2026-07-14T00:00:00.000Z",
    };

    const first = service.get(house, 24);
    const duplicate = service.get(house, 24);
    expect(provider.fetch).toHaveBeenCalledTimes(1);
    release?.(weather());
    await expect(Promise.all([first, duplicate])).resolves.toHaveLength(2);

    const fetchMock = provider.fetch as ReturnType<typeof vi.fn>;
    fetchMock.mockResolvedValue(weather());
    await service.get(house, 48);
    await service.get(house, 24);
    expect(provider.fetch).toHaveBeenCalledTimes(2);

    await service.get(house, 72);
    await service.get(house, 48);
    expect(provider.fetch).toHaveBeenCalledTimes(4);
  });

  it("rejects an invalidated in-flight result without updating cache or integration status", async () => {
    const status: IntegrationStatus["weather"] = {
      provider: "fmi", configuredHouses: 1, lastSuccessAt: null, error: null,
    };
    const onStatusChange = vi.fn();
    let releaseOld: ((value: HouseWeather) => void) | undefined;
    const replacementLocation = { latitude: 35.6762, longitude: 139.6503, label: "Tokyo" };
    const provider: WeatherProvider = {
      fetch: vi.fn()
        .mockImplementationOnce(() => new Promise<HouseWeather>((resolve) => { releaseOld = resolve; }))
        .mockImplementationOnce(async (houseId, requestedLocation) => weather({ houseId, location: requestedLocation })),
    };
    const service = new WeatherService(provider, status, onStatusChange);
    const house: House = {
      id: "house-main", name: "Home", timezone: "Europe/Helsinki", location, floors: [],
      createdAt: "2026-07-14T00:00:00.000Z", updatedAt: "2026-07-14T00:00:00.000Z",
    };

    const pending = service.get(house, 48);
    service.invalidate(house.id);
    releaseOld?.(weather());

    await expect(pending).rejects.toBeInstanceOf(WeatherRequestSupersededError);
    expect(status).toEqual({ provider: "fmi", configuredHouses: 1, lastSuccessAt: null, error: null });
    expect(onStatusChange).not.toHaveBeenCalled();

    const replacement = await service.get({
      ...house,
      location: replacementLocation,
      updatedAt: "2026-07-14T00:01:00.000Z",
    }, 48);
    expect(replacement.location).toEqual(replacementLocation);
    expect(provider.fetch).toHaveBeenCalledTimes(2);
    expect(onStatusChange).toHaveBeenCalledTimes(1);
  });
});

describe("GET /api/v1/houses/:id/weather", () => {
  let runtime: ApiRuntime | undefined;

  afterEach(async () => {
    await runtime?.close();
    runtime = undefined;
  });

  it("requires a location, returns injected provider data, and caches identical requests", async () => {
    const provider: WeatherProvider = {
      fetch: vi.fn(async (houseId, requestedLocation) => weather({ houseId, location: requestedLocation })),
    };
    runtime = createApi({ config, weatherProvider: provider, startBackground: false });
    const events: WeatherUpdateEvent[] = [];
    runtime.weatherEvents.subscribe((event) => events.push(event));

    await request(runtime.app).get("/api/v1/houses/house-main/weather")
      .expect(409)
      .expect(({ body }) => expect(body.error.code).toBe("HOUSE_LOCATION_REQUIRED"));
    expect(provider.fetch).not.toHaveBeenCalled();

    await request(runtime.app).patch("/api/v1/houses/house-main").send({ location }).expect(200);
    const first = await request(runtime.app).get("/api/v1/houses/house-main/weather").query({ hours: 24 }).expect(200);
    const second = await request(runtime.app).get("/api/v1/houses/house-main/weather").query({ hours: 24 }).expect(200);

    expect(first.body.weather).toMatchObject({
      houseId: "house-main",
      location,
      provider: "fmi",
      stale: false,
    });
    expect(second.body).toEqual(first.body);
    expect(provider.fetch).toHaveBeenCalledTimes(1);
    expect(provider.fetch).toHaveBeenCalledWith("house-main", location, 24);
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      type: "weather.snapshot",
      houseId: "house-main",
      trigger: "on-demand",
      weather: { provider: "fmi", fetchedAt: "2026-07-14T10:00:00.000Z" },
    });
    await request(runtime.app).get("/api/v1/integrations/status").expect(200)
      .expect(({ body }) => expect(body.mock).toMatchObject({ enabled: false, mode: "real" }));
    expect(runtime.database.db.prepare(`SELECT source, temperature_c AS temperatureC
      FROM outdoor_temperature_samples WHERE house_id = 'house-main' AND source = 'fmi-observation'`).all())
      .toEqual([expect.objectContaining({ source: "fmi-observation", temperatureC: 20.5 })]);
    expect((runtime.database.db.prepare("SELECT COUNT(*) AS count FROM readings WHERE source = 'mock'").get() as { count: number }).count).toBe(0);
  });

  it("discards an old-location response when the house changes while the request is in flight", async () => {
    const firstLocation = { latitude: 60.1699, longitude: 24.9384, label: "Helsinki" };
    const secondLocation = { latitude: 35.6762, longitude: 139.6503, label: "Tokyo" };
    let releaseFirst: ((value: HouseWeather) => void) | undefined;
    let signalStarted: (() => void) | undefined;
    const started = new Promise<void>((resolve) => { signalStarted = resolve; });
    const provider: WeatherProvider = {
      fetch: vi.fn((houseId, requestedLocation) => {
        if (requestedLocation.longitude === firstLocation.longitude) {
          signalStarted?.();
          return new Promise<HouseWeather>((resolve) => { releaseFirst = resolve; });
        }
        return Promise.resolve(weather({ houseId, location: requestedLocation }));
      }),
    };
    runtime = createApi({ config, weatherProvider: provider, startBackground: false });
    const events: WeatherUpdateEvent[] = [];
    runtime.weatherEvents.subscribe((event) => events.push(event));
    await request(runtime.app).patch("/api/v1/houses/house-main").send({ location: firstLocation }).expect(200);

    const pendingResponse = request(runtime.app).get("/api/v1/houses/house-main/weather").then((response) => response);
    await started;
    await request(runtime.app).patch("/api/v1/houses/house-main").send({ location: secondLocation }).expect(200);
    releaseFirst?.(weather({ location: firstLocation }));

    const superseded = await pendingResponse;
    expect(superseded.status).toBe(409);
    expect(superseded.body.error.code).toBe("WEATHER_REQUEST_SUPERSEDED");
    expect((runtime.database.db.prepare("SELECT COUNT(*) AS count FROM outdoor_temperature_samples").get() as { count: number }).count)
      .toBe(0);
    expect(events).toEqual([]);
    await request(runtime.app).get("/api/v1/integrations/status").expect(200).expect(({ body }) => {
      expect(body.weather).toMatchObject({ lastSuccessAt: null, error: null });
      expect(body.mock).toMatchObject({ mode: "demo" });
    });

    const current = await request(runtime.app).get("/api/v1/houses/house-main/weather").expect(200);
    expect(current.body.weather.location).toEqual(secondLocation);
    expect(provider.fetch).toHaveBeenCalledTimes(2);
    expect(events).toHaveLength(1);
    expect(events[0]?.weather.location).toEqual(secondLocation);
  });

  it("turns scheduled pulls from a non-streaming provider into weather events", async () => {
    const provider: WeatherProvider = {
      fetch: vi.fn(async (houseId, requestedLocation) => weather({ houseId, location: requestedLocation })),
    };
    runtime = createApi({ config, weatherProvider: provider, startBackground: false });
    await request(runtime.app).patch("/api/v1/houses/house-main").send({ location }).expect(200);
    const events: WeatherUpdateEvent[] = [];
    runtime.weatherEvents.subscribe((event) => events.push(event));

    await expect(runtime.weatherMonitor.runOnce()).resolves.toMatchObject({ succeeded: 1, failed: 0 });

    expect(provider.fetch).toHaveBeenCalledTimes(1);
    expect(events).toEqual([expect.objectContaining({
      type: "weather.snapshot",
      trigger: "scheduled-refresh",
      houseId: "house-main",
    })]);
    expect((runtime.database.db.prepare("SELECT COUNT(*) AS count FROM outdoor_temperature_samples").get() as { count: number }).count)
      .toBe(1);
  });

  it("fans accepted weather snapshots out through the existing SSE stream with a stable event ID", async () => {
    const provider: WeatherProvider = {
      fetch: vi.fn(async (houseId, requestedLocation) => weather({ houseId, location: requestedLocation })),
    };
    runtime = createApi({ config, weatherProvider: provider, startBackground: false });
    await request(runtime.app).patch("/api/v1/houses/house-main").send({ location }).expect(200);

    const server: Server = createServer(runtime.app);
    const controller = new AbortController();
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    try {
      const address = server.address();
      if (!address || typeof address === "string") throw new Error("Test server did not bind to a TCP port");
      const stream = await fetch(`http://127.0.0.1:${address.port}/api/v1/events`, { signal: controller.signal });
      const reader = stream.body?.getReader();
      if (!reader) throw new Error("SSE response did not expose a body");
      await reader.read(); // immediate integration snapshot

      await fetch(`http://127.0.0.1:${address.port}/api/v1/houses/house-main/weather`);
      const readWeatherEvent = async (): Promise<string> => {
        let payload = "";
        while (!payload.includes("event: weather")) {
          const chunk = await reader.read();
          if (chunk.done) break;
          payload += new TextDecoder().decode(chunk.value);
        }
        return payload;
      };
      let timeout: ReturnType<typeof setTimeout> | undefined;
      const payload = await Promise.race([
        readWeatherEvent(),
        new Promise<string>((_resolve, reject) => {
          timeout = setTimeout(() => reject(new Error("Timed out waiting for weather SSE event")), 2_000);
        }),
      ]).finally(() => { if (timeout) clearTimeout(timeout); });

      expect(payload).toMatch(/id: weather-[a-f0-9]{64}/);
      expect(payload).toContain("event: weather");
      expect(payload).toContain('"type":"weather.snapshot"');
      expect(payload).toContain('"houseId":"house-main"');
    } finally {
      controller.abort();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });
});
