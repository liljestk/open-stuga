import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";

import { describe, expect, it, vi } from "vitest";

import type { AlertEvent, IntegrationStatus, MaintenanceTask, ManualObservation, MeasurementSample, ObservationRevision, Sensor } from "@climate-twin/contracts";

import { ApiRequestError } from "../api";

import { I18nProvider } from "../i18n";

import { BUILTIN_MEASUREMENTS } from "../measurements";

import { createDemoState } from "../domain";

import { buildRoomComforts, RoomComfortBoard } from "./RoomComfortBoard";

import { buildMoistureAdvice, dewPointCelsius, MoistureCoach } from "./MoistureCoach";

import { buildHomeActivityEvents, HomeActivityTimeline } from "./HomeActivityTimeline";

import { HomePulsePanel } from "./HomePulsePanel";

import { observationInstantTimestamp } from "./RoomComparisonChart";

export const now = Date.parse("2026-07-14T12:00:00.000Z");

export const sensor: Sensor = {
  id: "sensor-room",
  houseId: "house",
  floorId: "floor",
  name: "Desk sensor",
  roomId: "room-office",
  room: "Office",
  model: "T315",
  x: 1,
  y: 1,
  z: 1.4,
  tags: [],
  enabled: true,
};

export function sample(metric: string, value: number, timestamp = "2026-07-14T11:55:00.000Z"): MeasurementSample {
  return { sensorId: sensor.id, metric, value, canonicalUnit: metric === "temperature" ? "°C" : metric === "humidity" ? "%" : "ppm", timestamp, source: "mock", quality: "good" };
}

export function openHomePulseMore(container: HTMLElement): HTMLDetailsElement {
  const details = container.querySelector<HTMLDetailsElement>(".home-pulse-more")!;
  fireEvent.click(within(details).getByText("More information"));
  return details;
}

export const integration: IntegrationStatus = {
  homeAssistant: { configured: false, connected: false, lastEventAt: null, mappedEntities: 0, error: null },
  tpLink: { configured: false, connected: false, lastPollAt: null, mappedDevices: 0, discoveredDevices: 0, hubModel: null, error: null },
  webhook: { configured: false, lastDeliveryAt: null, error: null },
  mock: { enabled: true, intervalMs: 2_000, mode: "demo", activatedAt: null },
  weather: { policy: "automatic", availableProviders: ["fmi", "open-meteo"], provider: "fmi", configuredHouses: 0, lastSuccessAt: null, error: null },
};
