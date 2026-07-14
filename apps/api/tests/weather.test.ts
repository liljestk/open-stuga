import type { House, HouseWeather, IntegrationStatus } from "@climate-twin/contracts";
import { afterEach, describe, expect, it, vi } from "vitest";
import request from "supertest";
import { createApi, type ApiRuntime } from "../src/app.js";
import type { AppConfig } from "../src/config.js";
import {
  parseCapWarnings,
  parseFmiTimeSeries,
  WeatherService,
  WeatherUnavailableError,
  type WeatherProvider,
} from "../src/weather.js";

const config: AppConfig = {
  port: 0,
  apiHost: "127.0.0.1",
  databasePath: ":memory:",
  assetDirectory: ".",
  mockEnabled: false,
  mockIntervalMs: 25,
  retentionDays: 730,
  ingestApiKey: null,
  haUrl: null,
  haToken: null,
  haEntityMapFile: null,
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

describe("FMI weather parsing", () => {
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

    expect(parseCapWarnings(xml, location)).toEqual([
      expect.objectContaining({
        id: "inside",
        event: "Wind warning",
        severity: "severe",
        areas: ["Test area"],
        web: null,
      }),
    ]);
  });
});

describe("WeatherService", () => {
  afterEach(() => vi.restoreAllMocks());

  it("returns a fresh cached result and falls back to a stale result after refresh failure", async () => {
    let clock = 1_000;
    vi.spyOn(Date, "now").mockImplementation(() => clock);
    const provider: WeatherProvider = {
      fetch: vi.fn().mockResolvedValueOnce(weather()).mockRejectedValueOnce(new WeatherUnavailableError("FMI offline")),
    };
    const status: IntegrationStatus["weather"] = {
      provider: "fmi",
      configuredHouses: 1,
      lastSuccessAt: null,
      error: null,
    };
    const onStatusChange = vi.fn();
    const service = new WeatherService(provider, status, onStatusChange, 100);
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

    clock = 1_101;
    const stale = await service.get(house, 48);
    expect(stale).toEqual({ ...initial, stale: true });
    expect(initial.stale).toBe(false);
    expect(provider.fetch).toHaveBeenCalledTimes(2);
    expect(status.error).toBe("FMI offline");
    expect(onStatusChange).toHaveBeenCalledTimes(2);
  });
});

describe("GET /api/v1/houses/:id/weather", () => {
  let runtime: ApiRuntime | undefined;

  afterEach(() => {
    runtime?.close();
    runtime = undefined;
  });

  it("requires a location, returns injected provider data, and caches identical requests", async () => {
    const provider: WeatherProvider = {
      fetch: vi.fn(async (houseId, requestedLocation) => weather({ houseId, location: requestedLocation })),
    };
    runtime = createApi({ config, weatherProvider: provider, startBackground: false });

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
  });
});
