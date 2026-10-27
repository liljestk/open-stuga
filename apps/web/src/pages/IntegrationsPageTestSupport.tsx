import { render } from "@testing-library/react";

import type { House, IntegrationStatus, TpLinkDiscoveredDevice } from "@climate-twin/contracts";

import { vi } from "vitest";

import { I18nProvider } from "../i18n";

import { IntegrationsPage } from "./IntegrationsPage";

export const integration: IntegrationStatus = {
  homeAssistant: { configured: false, connected: false, lastEventAt: null, mappedEntities: 0, error: null },
  tpLink: { configured: false, connected: false, lastPollAt: null, mappedDevices: 0, discoveredDevices: 0, hubModel: null, error: null },
  webhook: { configured: false, lastDeliveryAt: null, error: null },
  mock: { enabled: true, intervalMs: 2000, mode: "demo", activatedAt: null },
  weather: { policy: "automatic", availableProviders: ["fmi", "open-meteo"], provider: "fmi", configuredHouses: 1, lastSuccessAt: "2026-01-01T20:00:00.000Z", error: null },
};

export const house: House = {
  id: "house-coast",
  propertyId: "property-coast",
  name: "Coast house",
  timezone: "Europe/Helsinki",
  location: { latitude: 60.17, longitude: 24.94, label: "Helsinki" },
  floors: [],
  createdAt: "2026-01-01T00:00:00.000Z",
  updatedAt: "2026-01-01T00:00:00.000Z",
};

export const discoveredChild: TpLinkDiscoveredDevice = {
  deviceId: "tapo-child-hall",
  model: "T310",
  alias: "Hall sensor",
  status: "online",
  temperature: 21.2,
  humidity: 44,
  battery: 92,
  lastSeenAt: "2026-07-14T12:00:00.000Z",
  mappedSensorId: null,
};

export const historyAutomation = {
  operational: true,
  canaryPending: false,
  waitingEmails: 0,
  maxPendingEmails: 1,
  exportIntervalMinutes: 15 as const,
  canaryApprovalMaxAgeDays: 30,
  mailbox: {
    lastSuccessfulPollAt: null,
    lastErrorAt: null,
    lastErrorCode: null,
    consecutiveFailures: 0,
    budgetExhaustions: 0,
  },
  lastWorkerSeenAt: null,
  deploymentFingerprintPrefix: null,
};

export function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  const promise = new Promise<T>((next) => { resolve = next; });
  return { promise, resolve };
}

export function connectedTpLink(overrides: Partial<IntegrationStatus["tpLink"]> = {}): IntegrationStatus {
  return {
    ...integration,
    tpLink: {
      ...integration.tpLink,
      configured: true,
      connected: true,
      lastPollAt: "2026-07-16T08:30:15.000Z",
      mappedDevices: 2,
      discoveredDevices: 3,
      hubModel: "H200",
      error: null,
      ...overrides,
    },
    mock: { ...integration.mock, enabled: false, mode: "real", activatedAt: "2026-07-16T08:30:00.000Z" },
  };
}

export function renderPage(overrides: Partial<React.ComponentProps<typeof IntegrationsPage>> = {}) {
  localStorage.setItem("climate-twin-locale", "en");
  const props: React.ComponentProps<typeof IntegrationsPage> = {
    integration,
    house,
    houses: [house],
    units: "metric",
    streamConnection: "live",
    onHouse: vi.fn(),
    onHouseUpdate: vi.fn().mockResolvedValue(undefined),
    onGeoreferenceChange: vi.fn().mockResolvedValue(undefined),
    onIntegrationChange: vi.fn(),
    ...overrides,
  };
  return { ...render(<I18nProvider><IntegrationsPage {...props} /></I18nProvider>), props };
}
