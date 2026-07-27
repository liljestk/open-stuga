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

import { integration, now, openHomePulseMore, sample, sensor } from "./DecisionLayerTestSupport";

describe("decision layer", () => {
  it("resurfaces a hidden insight when its severity changes", () => {
    const state = createDemoState();
    const house = state.houses[0]!;
    const roomSensor = state.sensors.find((candidate) => candidate.houseId === house.id)!;
    const latestMeasurements = { [roomSensor.id]: {
      temperature: { ...sample("temperature", 22), sensorId: roomSensor.id },
      humidity: { ...sample("humidity", 45), sensorId: roomSensor.id },
      co2: { ...sample("co2", 700), sensorId: roomSensor.id },
    } };
    const warningAlert: AlertEvent = {
      id: "changing-severity",
      ruleId: "changing-severity-rule",
      sensorId: roomSensor.id,
      metric: "temperature",
      value: 32,
      threshold: 30,
      severity: "warning",
      startedAt: "2026-07-14T11:50:00.000Z",
      acknowledgedAt: null,
      resolvedAt: null,
    };
    const baseProps = {
      house,
      sensors: [roomSensor],
      latestMeasurements,
      measurementHistory: {},
      alertRules: [],
      weather: null,
      referenceTime: now,
      onOpenTarget: vi.fn(),
    };
    const view = render(<I18nProvider><HomePulsePanel {...baseProps} alerts={[warningAlert]} /></I18nProvider>);
    openHomePulseMore(view.container);
    fireEvent.click(screen.getByRole("button", { name: /^Hide / }));
    expect(view.container.querySelector(".pulse-insight")).toBeNull();

    view.rerender(<I18nProvider><HomePulsePanel {...baseProps} alerts={[{ ...warningAlert, severity: "critical", value: 40 }]} /></I18nProvider>);
    expect(view.container.querySelector(".pulse-insight.critical")).not.toBeNull();
  });

  it("localizes generated Home Pulse guidance and evidence in Finnish", () => {
    localStorage.setItem("climate-twin-locale", "fi");
    const state = createDemoState();
    const house = state.houses[0]!;
    const roomSensor = state.sensors.find((candidate) => candidate.houseId === house.id)!;
    const humidity = (value: number, timestamp: string): MeasurementSample => ({
      sensorId: roomSensor.id,
      metric: "humidity",
      value,
      canonicalUnit: "%",
      timestamp,
      source: "mock",
      quality: "good",
    });
    const latestHumidity = humidity(70.5, "2026-07-14T11:55:00.000Z");

    const view = render(<I18nProvider><HomePulsePanel
      house={house}
      sensors={[roomSensor]}
      latestMeasurements={{ [roomSensor.id]: { humidity: latestHumidity } }}
      measurementHistory={{ [roomSensor.id]: { humidity: [
        humidity(68, "2026-07-14T10:50:00.000Z"),
        humidity(69, "2026-07-14T11:20:00.000Z"),
        latestHumidity,
      ] } }}
      alerts={[]}
      alertRules={[]}
      weather={null}
      referenceTime={now}
      onOpenTarget={vi.fn()}
    /></I18nProvider>);

    expect(within(view.container.querySelector(".pulse-glance-list")!).getByText(`Huoneen ${roomSensor.room} ilmankosteus on koholla`)).not.toBeNull();
    expect(screen.getByText("Viimeisin suhteellinen ilmankosteus on 70,5 %.")).not.toBeNull();
    fireEvent.click(view.container.querySelector(".home-pulse-more > summary")!);
    fireEvent.click(view.container.querySelector(".pulse-insight > summary")!);
    expect(screen.getByText("Viimeisin ilmankosteus")).not.toBeNull();
    expect(screen.queryByText(/Humidity is elevated/)).toBeNull();
    expect(view.container.querySelector(".home-pulse-more-content > .home-pulse-advisory")).not.toBeNull();
  });
});
