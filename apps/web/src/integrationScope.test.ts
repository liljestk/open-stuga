import { describe, expect, it } from "vitest";
import type { IntegrationStatus } from "@climate-twin/contracts";
import { createDemoState } from "./domain";
import { integrationForHouse } from "./integrationScope";

const aggregate: IntegrationStatus = {
  ...createDemoState().integration,
  homeAssistant: {
    configured: true, connected: true, lastEventAt: "2026-07-17T10:00:00.000Z", mappedEntities: 7, error: null,
    connections: [
      { houseId: "home-a", configured: true, connected: true, lastEventAt: "2026-07-17T10:00:00.000Z", mappedEntities: 5, error: null },
      { houseId: "home-b", configured: true, connected: false, lastEventAt: null, mappedEntities: 2, error: "offline" },
    ],
  },
  tpLink: {
    configured: true, connected: true, lastPollAt: "2026-07-17T10:00:00.000Z", mappedDevices: 3, discoveredDevices: 4, hubModel: null, error: null,
    connections: [
      { id: "a", houseId: "home-a", configured: true, connected: true, lastPollAt: "2026-07-17T10:00:00.000Z", mappedDevices: 2, discoveredDevices: 3, hubModel: "H100", error: null },
      { id: "b", houseId: "home-b", configured: true, connected: false, lastPollAt: null, mappedDevices: 1, discoveredDevices: 1, hubModel: "H200", error: "offline" },
    ],
  },
  weather: {
    policy: "automatic",
    availableProviders: ["fmi", "open-meteo"],
    provider: "fmi",
    configuredHouses: 2,
    lastSuccessAt: "2026-07-17T10:00:00.000Z",
    error: null,
    connections: [
      { houseId: "home-a", configured: true, provider: "fmi", lastSuccessAt: "2026-07-17T10:00:00.000Z", error: null },
      { houseId: "home-b", configured: true, provider: "open-meteo", lastSuccessAt: null, error: "forecast offline" },
    ],
  },
  webhook: { configured: false, lastDeliveryAt: null, error: null },
};

describe("integrationForHouse", () => {
  it("does not inherit a connected sibling Home's aggregate status", () => {
    const scoped = integrationForHouse(aggregate, "home-b");
    expect(scoped.homeAssistant).toMatchObject({ configured: true, connected: false, mappedEntities: 2, error: "offline" });
    expect(scoped.tpLink).toMatchObject({ configured: true, connected: false, mappedDevices: 1, discoveredDevices: 1, hubModel: "H200", error: "offline" });
    expect(scoped.weather).toMatchObject({ configuredHouses: 1, provider: "open-meteo", lastSuccessAt: null, error: "forecast offline" });
  });

  it("returns an unconfigured status when the Home has no connection", () => {
    const scoped = integrationForHouse(aggregate, "home-c");
    expect(scoped.homeAssistant).toMatchObject({ configured: false, connected: false, mappedEntities: 0, connections: [] });
    expect(scoped.tpLink).toMatchObject({ configured: false, connected: false, mappedDevices: 0, discoveredDevices: 0, connections: [] });
    expect(scoped.weather).toMatchObject({ configuredHouses: 0, lastSuccessAt: null, error: null, connections: [] });
  });

  it("keeps a Home online when one of its independent TP-Link connections is healthy", () => {
    const value: IntegrationStatus = {
      ...aggregate,
      tpLink: {
        ...aggregate.tpLink,
        connections: [
          ...aggregate.tpLink.connections!,
          { id: "a-backup", houseId: "home-a", configured: true, connected: false, lastPollAt: null, mappedDevices: 0, discoveredDevices: 0, hubModel: "H200", error: "offline" },
        ],
      },
    };

    expect(integrationForHouse(value, "home-a").tpLink).toMatchObject({
      configured: true,
      connected: true,
      mappedDevices: 2,
    });
  });

  it("does not reuse aggregate weather health from an older server without per-Home status", () => {
    const { connections: _connections, ...legacyWeather } = aggregate.weather;
    const legacy: IntegrationStatus = {
      ...aggregate,
      weather: {
        ...legacyWeather,
        configuredHouses: 2,
        lastSuccessAt: "2026-07-17T10:00:00.000Z",
        error: "a sibling failed",
      },
    };

    expect(integrationForHouse(legacy, "home-b", true).weather).toMatchObject({
      configuredHouses: 1,
      lastSuccessAt: null,
      error: null,
    });
  });
});
