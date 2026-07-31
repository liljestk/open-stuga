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
import {
  monitoringDetail,
  monitoringInsight,
  monitoringSummary,
} from "../monitoringTestSupport";

import { integration, now, openHomePulseMore, sample, sensor } from "./DecisionLayerTestSupport";

describe("decision layer", () => {
  it("omits unsupported CO2 from room cards but keeps configured missing readings visible", () => {
    const unsupported = render(<I18nProvider><RoomComfortBoard
      sensors={[sensor]}
      latestMeasurements={{ [sensor.id]: { temperature: sample("temperature", 22), humidity: sample("humidity", 45) } }}
      measurementHistory={{}}
      definitions={BUILTIN_MEASUREMENTS}
      alerts={[]}
      units="metric"
      now={now}
      onOpenRoom={vi.fn()}
    /></I18nProvider>);

    const unsupportedCard = screen.getByRole("button", { name: /^Open Office\./ });
    expect(within(unsupportedCard).queryByText("Carbon dioxide")).toBeNull();
    expect(unsupportedCard.getAttribute("aria-label")).not.toMatch(/Carbon dioxide/);
    expect(unsupportedCard.querySelector(".room-card-readings.two-metrics")).not.toBeNull();
    unsupported.unmount();

    render(<I18nProvider><RoomComfortBoard
      sensors={[{ ...sensor, measurementEntityIds: { co2: "sensor.office_co2" } }]}
      latestMeasurements={{ [sensor.id]: { temperature: sample("temperature", 22), humidity: sample("humidity", 45) } }}
      measurementHistory={{}}
      definitions={BUILTIN_MEASUREMENTS}
      alerts={[]}
      units="metric"
      now={now}
      onOpenRoom={vi.fn()}
    /></I18nProvider>);

    const supportedCard = screen.getByRole("button", { name: /^Open Office\./ });
    expect(within(supportedCard).getByText("Carbon dioxide")).not.toBeNull();
    expect(supportedCard.getAttribute("aria-label")).toMatch(/Carbon dioxide: —/);
  });

  it("uses fresh retained T310 history when the latest room snapshot is temporarily absent", () => {
    const kitchenSensor = { ...sensor, id: "kitchen-t310", room: "Kitchen", name: "Kitchen T310", model: "T310" };
    const temperature = { ...sample("temperature", 21.4, "2026-07-14T11:58:00.000Z"), sensorId: kitchenSensor.id };
    const humidity = { ...sample("humidity", 43, "2026-07-14T11:58:00.000Z"), sensorId: kitchenSensor.id };

    const [room] = buildRoomComforts({
      sensors: [kitchenSensor],
      latestMeasurements: {},
      measurementHistory: { [kitchenSensor.id]: { temperature: [temperature], humidity: [humidity] } },
      alerts: [],
      now,
    });

    expect(room).toMatchObject({
      room: "Kitchen",
      state: "comfortable",
      temperature: 21.4,
      humidity: 43,
      updatedAt: "2026-07-14T11:58:00.000Z",
    });
  });

  it("uses the newest valid retained sample when a stale sample follows it", () => {
    const good = sample("temperature", 21.4, "2026-07-14T11:58:00.000Z");
    const stale = { ...sample("temperature", 99, "2026-07-14T11:59:00.000Z"), quality: "stale" as const };

    const [room] = buildRoomComforts({
      sensors: [sensor],
      latestMeasurements: { [sensor.id]: { temperature: stale } },
      measurementHistory: { [sensor.id]: { temperature: [good, stale] } },
      alerts: [],
      now,
    });

    expect(room?.temperature).toBe(21.4);
  });

  it("builds the sparkline from only the last 24 valid ordered values", () => {
    const temperature = Array.from({ length: 30 }, (_, index) => (
      sample(
        "temperature",
        index,
        new Date(Date.parse("2026-07-14T11:30:00.000Z") + index * 60_000).toISOString(),
      )
    ));

    const [room] = buildRoomComforts({
      sensors: [sensor],
      latestMeasurements: {},
      measurementHistory: { [sensor.id]: { temperature } },
      alerts: [],
      now,
    });

    expect(room?.temperatureTrend).toEqual(Array.from({ length: 24 }, (_, index) => index + 6));
  });

  it("sums fresh electricity sensors in a room and identifies a power-only room as live", () => {
    const meter = { ...sensor, id: "kitchen-meter", room: "Kitchen", name: "Kitchen meter", model: "P110" };
    const plug = { ...sensor, id: "kitchen-plug", room: "Kitchen", name: "Kitchen plug", model: "P110" };
    const latestMeasurements = {
      [meter.id]: { power: { ...sample("power", 125), sensorId: meter.id, canonicalUnit: "W" } },
      [plug.id]: { power: { ...sample("power", 75), sensorId: plug.id, canonicalUnit: "W" } },
    };

    const [room] = buildRoomComforts({
      sensors: [meter, plug],
      latestMeasurements,
      measurementHistory: {},
      alerts: [],
      now,
    });
    expect(room).toMatchObject({ state: "live", power: 200 });

    render(<I18nProvider><RoomComfortBoard
      sensors={[meter, plug]}
      latestMeasurements={latestMeasurements}
      measurementHistory={{}}
      definitions={BUILTIN_MEASUREMENTS}
      alerts={[]}
      units="metric"
      now={now}
      onOpenRoom={vi.fn()}
    /></I18nProvider>);
    const card = screen.getByRole("button", { name: /^Open Kitchen\./ });
    expect(within(card).getByText("200 W")).not.toBeNull();
    expect(within(card).getByText("Live")).not.toBeNull();
  });

  it("does not revive a room from stale retained history", () => {
    const staleTemperature = { ...sample("temperature", 21), quality: "stale" as const };
    const [room] = buildRoomComforts({
      sensors: [sensor],
      latestMeasurements: {},
      measurementHistory: { [sensor.id]: { temperature: [staleTemperature] } },
      alerts: [],
      now,
    });
    expect(room?.state).toBe("offline");
    expect(room?.temperature).toBeNull();
  });

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
    const responseFor = (severity: "warning" | "critical") => monitoringDetail(
      monitoringSummary({
        houseId: house.id,
        status: "action-required",
        pulseStatus: severity === "critical" ? "critical" : "attention",
        coverage: { enabledSensors: 1, freshSensors: 1 },
        activeAlertCount: 1,
      }),
      [monitoringInsight({
        id: `active-alert:${warningAlert.id}`,
        kind: "active-alert",
        severity,
        title: "Temperature alert - Living room",
        house,
        sensor: roomSensor,
      })],
    );
    const view = render(<I18nProvider><HomePulsePanel {...baseProps} alerts={[warningAlert]} monitoring={responseFor("warning")} /></I18nProvider>);
    openHomePulseMore(view.container);
    fireEvent.click(screen.getByRole("button", { name: /^Hide / }));
    expect(view.container.querySelector(".pulse-insight")).toBeNull();

    view.rerender(<I18nProvider><HomePulsePanel {...baseProps} alerts={[{ ...warningAlert, severity: "critical", value: 40 }]} monitoring={responseFor("critical")} /></I18nProvider>);
    expect(view.container.querySelector(".pulse-insight.critical")).not.toBeNull();
    expect(screen.queryByRole("button", { name: /^Hide / })).toBeNull();
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
      monitoring={monitoringDetail(
        monitoringSummary({
          houseId: house.id,
          pulseStatus: "attention",
          coverage: { enabledSensors: 1, freshSensors: 1 },
        }),
        [monitoringInsight({
          id: `humidity:${roomSensor.id}`,
          kind: "humidity",
          severity: "notice",
          title: `Humidity is elevated in ${roomSensor.room}`,
          summary: "Humidity is elevated.",
          action: "Ventilate.",
          house,
          sensor: roomSensor,
          evidence: [
            { label: "Latest humidity", value: 70.5, unit: "%", metric: "humidity", sensorId: roomSensor.id },
            { label: "Elevated readings", value: "3 of 3", metric: "humidity", sensorId: roomSensor.id },
          ],
        })],
      )}
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
