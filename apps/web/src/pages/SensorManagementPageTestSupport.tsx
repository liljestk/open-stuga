import { act, render, screen, waitFor, within } from "@testing-library/react";

import userEvent from "@testing-library/user-event";

import type { Sensor, TpLinkDiscoveredDevice } from "@climate-twin/contracts";

import { afterEach, describe, expect, it, vi } from "vitest";

import { api } from "../api";

import { createDemoState } from "../domain";

import { I18nProvider } from "../i18n";

import { SensorManagementPage } from "./SensorManagementPage";

export const discoveredDevice: TpLinkDiscoveredDevice = {
  houseId: "house-pine",
  deviceId: "tapo-child-office",
  model: "T315",
  alias: "Office window",
  status: "online",
  temperature: 21.4,
  humidity: 44,
  battery: 92,
  lastSeenAt: "2026-07-14T12:00:00.000Z",
  mappedSensorId: null,
};

export function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

export function renderPage(overrides: Partial<React.ComponentProps<typeof SensorManagementPage>> = {}) {
  localStorage.setItem("climate-twin-locale", "en");
  const state = createDemoState();
  const house = state.houses[0]!;
  const props: React.ComponentProps<typeof SensorManagementPage> = {
    state,
    house,
    houses: state.houses,
    integration: { ...state.integration, tpLink: {
      configured: true,
      connected: true,
      lastPollAt: "2026-07-14T12:00:00.000Z",
      mappedDevices: 0,
      discoveredDevices: 1,
      hubModel: "H200",
      error: null,
    } },
    tpLinkDevices: [discoveredDevice],
    tpLinkDevicesLoading: false,
    tpLinkDevicesError: null,
    onHouse: vi.fn(),
    onUpdateHouse: vi.fn().mockImplementation(async (id, patch) => {
      const current = state.houses.find((candidate) => candidate.id === id);
      if (!current) throw new Error("House not found");
      return { ...current, ...patch };
    }),
    onRefreshDevices: vi.fn().mockResolvedValue([discoveredDevice]),
    onCreateSensor: vi.fn().mockImplementation(async (input) => ({ ...input, id: "sensor-created" })),
    onUpdateSensor: vi.fn().mockImplementation(async (id, patch) => {
      const current = state.sensors.find((sensor) => sensor.id === id);
      if (!current) throw new Error("Sensor not found");
      const updated = { ...current, ...patch } as Sensor;
      if (patch.tpLinkDeviceId === null) delete updated.tpLinkDeviceId;
      return updated;
    }),
    onDeleteSensor: vi.fn().mockResolvedValue(undefined),
    onImportHistoricalData: vi.fn().mockResolvedValue({ submitted: 0, accepted: 0, ignoredDuplicates: 0 }),
    ...overrides,
  };

  return {
    ...render(<I18nProvider><SensorManagementPage {...props} /></I18nProvider>),
    props,
  };
}

export function expectDescribedError(control: HTMLElement, message: string) {
  expect(control.getAttribute("aria-invalid")).toBe("true");
  const descriptionId = control.getAttribute("aria-describedby");
  expect(descriptionId).not.toBeNull();
  expect(document.getElementById(descriptionId!)?.textContent).toBe(message);
}
