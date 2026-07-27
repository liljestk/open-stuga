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

export const config: AppConfig = {
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

export const location = { latitude: 60.1699, longitude: 24.9384, label: "Helsinki" };

export function weather(overrides: Partial<HouseWeather> = {}): HouseWeather {
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

export function forecastXml(latitude: number, longitude: number): string {
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
