import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";

import { StrictMode } from "react";

import userEvent from "@testing-library/user-event";

import { beforeEach, describe, expect, it, vi } from "vitest";

import { App } from "./App";

import { I18nProvider } from "./i18n";

import { createDemoState } from "./domain";

import { useClimateData } from "./useClimateData";

import { api } from "./api";

export function mockClimateData() {
  const state = createDemoState();
  const resolved = vi.fn().mockResolvedValue(undefined);
  const climate = {
    state,
    loading: false,
    bootstrapStatus: "ready",
    bootstrapError: null,
    retryBootstrap: vi.fn(),
    endSession: vi.fn(),
    dataMode: "demo",
    connection: "live",
    scenario: "normal",
    saveState: "idle",
    tpLinkDevices: [],
    tpLinkDevicesLoading: false,
    tpLinkDevicesError: null,
    refreshTpLinkDevices: resolved,
    applyIntegrationStatus: vi.fn(),
    selectHouse: resolved,
    loadSeries: resolved,
    importHistoricalMeasurements: vi.fn().mockResolvedValue({ submitted: 0, accepted: 0, ignoredDuplicates: 0 }),
    createHouse: vi.fn().mockResolvedValue(state.houses[0]),
    deleteHouse: resolved,
    createSensor: vi.fn().mockResolvedValue(state.sensors[0]),
    updateSensor: vi.fn().mockResolvedValue(state.sensors[0]),
    deleteSensor: resolved,
    moveSensor: resolved,
    updateFloor: resolved,
    updateHouse: resolved,
    updateHouseDraft: vi.fn(),
    setHouseGeoreference: resolved,
    saveLayout: resolved,
    runScenario: resolved,
    createRule: resolved,
    acknowledgeAlert: resolved,
    createObservation: vi.fn().mockResolvedValue(state.observations[0]),
    reloadObservation: vi.fn().mockResolvedValue(state.observations[0]),
    updateObservation: vi.fn().mockResolvedValue(state.observations[0]),
    observationRevisions: vi.fn().mockResolvedValue([]),
    createStaticParameter: vi.fn().mockResolvedValue(state.staticParameters[0]),
  } as unknown as ReturnType<typeof useClimateData>;
  vi.mocked(useClimateData).mockReturnValue(climate);
  return climate;
}

export function renderApp() {
  return render(<I18nProvider><App /></I18nProvider>);
}

export const ROUTE_READY_TIMEOUT_MS = 5_000;

export function findPageHeading(name: string) {
  return screen.findByRole("heading", { level: 1, name }, { timeout: ROUTE_READY_TIMEOUT_MS });
}
