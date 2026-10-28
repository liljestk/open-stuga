import { BUILTIN_MEASUREMENT_DEFINITIONS } from "@climate-twin/contracts";
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";

import { describe, expect, it, vi } from "vitest";

import type { AlertEvent, MaintenanceTask, ManualObservation, ObservationRevision } from "@climate-twin/contracts";

import { ApiRequestError } from "../api";

import { I18nProvider } from "../i18n";


import { createDemoState } from "../domain";

import { buildRoomComforts, RoomComfortBoard } from "../pages/TwinDashboard/RoomComfortBoard";

import { buildMoistureAdvice, dewPointCelsius, MoistureCoach } from "../pages/TwinDashboard/MoistureCoach";

import { buildHomeActivityEvents, HomeActivityTimeline } from "./HomeActivityTimeline";

import { HomePulsePanel } from "../pages/TwinDashboard/HomePulsePanel";

import { observationInstantTimestamp } from "./RoomComparisonChart";
import {
  monitoringDetail,
  monitoringInsight,
  monitoringSummary,
} from "../monitoringTestSupport";

import { integration, now, openHomePulseMore, sample, sensor } from "./DecisionLayerTestSupport";

describe("decision layer", () => {
  it("places only instant-precision observations on the instant comparison chart", () => {
    const observation: ManualObservation = {
      id: "observation-time",
      houseId: "house",
      floorId: "floor",
      sensorId: null,
      kind: "note",
      severity: "info",
      note: "Time semantics",
      x: null,
      y: null,
      occurredAt: "2026-07-14T09:00:00.000Z",
      createdAt: "2026-07-15T10:00:00.000Z",
    };
    expect(observationInstantTimestamp({ ...observation, timePrecision: "exact" })).toBe(Date.parse(observation.occurredAt));
    expect(observationInstantTimestamp({ ...observation, timePrecision: "approximate" })).toBe(Date.parse(observation.occurredAt));
    expect(observationInstantTimestamp({ ...observation, timePrecision: "date-only", occurredAt: "2026-07-14" })).toBeNull();
    expect(observationInstantTimestamp({ ...observation, timePrecision: "date-range", occurredAt: "2026-07-01", validFrom: "2026-07-01", validTo: "2026-07-14" })).toBeNull();
    expect(observationInstantTimestamp({ ...observation, timePrecision: "unknown", occurredAt: "" })).toBeNull();
  });

  it("prioritizes an alerted room and rejects implausible future samples", () => {
    const alert: AlertEvent = { id: "alert", ruleId: "rule", sensorId: sensor.id, metric: "humidity", value: 72, threshold: 65, severity: "warning", startedAt: "2026-07-14T11:50:00.000Z", acknowledgedAt: null, resolvedAt: null };
    const comforts = buildRoomComforts({
      sensors: [sensor],
      latestMeasurements: { [sensor.id]: { temperature: sample("temperature", 22), humidity: sample("humidity", 67), co2: sample("co2", 950) } },
      measurementHistory: { [sensor.id]: { temperature: [sample("temperature", 21, "2026-07-14T10:00:00.000Z"), sample("temperature", 22)] } },
      alerts: [alert],
      now,
    });
    expect(comforts[0]).toMatchObject({ room: "Office", state: "attention", temperature: 22, humidity: 67 });

    const future = buildRoomComforts({
      sensors: [sensor],
      latestMeasurements: { [sensor.id]: { temperature: sample("temperature", 22, "2026-07-15T12:00:00.000Z") } },
      measurementHistory: {},
      alerts: [],
      now,
    });
    expect(future[0]?.state).toBe("offline");
  });

  it("compares dew point instead of relative humidity for ventilation guidance", () => {
    expect(dewPointCelsius(22, 65)).toBeCloseTo(15.1, 1);
    const advice = buildMoistureAdvice({
      sensors: [sensor],
      latestMeasurements: { [sensor.id]: { temperature: sample("temperature", 22), humidity: sample("humidity", 65) } },
      conditions: { timestamp: "2026-07-14T11:50:00.000Z", temperatureC: 12, dewPointC: 7, relativeHumidityPercent: 72 },
      now,
    });
    expect(advice).toMatchObject({ kind: "ventilate", room: "Office", reason: "drier-outside", elevatedMoisture: true });

    expect(buildMoistureAdvice({
      sensors: [sensor],
      latestMeasurements: { [sensor.id]: { temperature: sample("temperature", 22), humidity: sample("humidity", 65) } },
      conditions: { timestamp: "2026-07-14T11:50:00.000Z", temperatureC: 12, dewPointC: 7 },
      weatherStale: true,
      now,
    }).kind).toBe("limited");
  });

  it("keeps Moisture Coach evidence and actions behind an explicit disclosure", () => {
    const onOpenSensor = vi.fn();
    const view = render(<I18nProvider><MoistureCoach
      sensors={[sensor]}
      latestMeasurements={{ [sensor.id]: { temperature: sample("temperature", 22), humidity: sample("humidity", 65) } }}
      conditions={{ timestamp: "2026-07-14T11:50:00.000Z", temperatureC: 12, dewPointC: 7, relativeHumidityPercent: 72 }}
      units="metric"
      now={now}
      onOpenSensor={onOpenSensor}
    /></I18nProvider>);

    const details = view.container.querySelector<HTMLDetailsElement>(".moisture-coach-disclosure")!;
    expect(details.open).toBe(false);
    expect(within(details.querySelector("summary")!).getByText("More information")).not.toBeNull();
    expect(details.querySelector(".moisture-evidence")).not.toBeNull();

    fireEvent.click(details.querySelector("summary")!);
    expect(details.open).toBe(true);
    fireEvent.click(within(details).getByRole("button", { name: "Inspect room" }));
    expect(onOpenSensor).toHaveBeenCalledWith(sensor.id);
  });

  it("sorts maintenance, observations, alerts, and weather into one activity feed", () => {
    const maintenanceTask: MaintenanceTask = {
      id: "task",
      propertyId: "property",
      houseId: "house",
      floorId: "floor",
      title: "Replace sink seal",
      description: null,
      basis: "condition-based",
      basisDetail: "Linked leak observation",
      priority: "high",
      plannedFor: "2026-07-15",
      dueBy: "2026-07-16",
      observationIds: ["observation"],
      status: "in-progress",
      completionNote: null,
      completedAt: null,
      verificationNote: null,
      verifiedAt: null,
      revision: 2,
      createdAt: "2026-07-14T08:00:00.000Z",
      updatedAt: "2026-07-14T11:15:00.000Z",
    };
    const events = buildHomeActivityEvents({
      sensors: [sensor],
      alerts: [{ id: "alert", ruleId: "rule", sensorId: sensor.id, metric: "humidity", value: 72, threshold: 65, severity: "warning", startedAt: "2026-07-14T10:00:00.000Z", acknowledgedAt: null, resolvedAt: null }],
      observations: [{ id: "observation", houseId: "house", floorId: "floor", sensorId: null, kind: "maintenance", severity: "info", note: "Filter changed", x: 1, y: 1, occurredAt: "2026-07-14T11:00:00.000Z", createdAt: "2026-07-14T11:00:00.000Z" }],
      maintenanceTasks: [maintenanceTask],
      warnings: [
        { id: "warning", event: "Wind", headline: "Strong gusts", description: "", severity: "moderate", urgency: "", certainty: "", effectiveAt: "2026-07-14T09:00:00.000Z", onsetAt: null, expiresAt: null, areas: [], web: null },
        { id: "uv", event: "UV advisory", headline: "High UV", description: "", severity: "moderate", urgency: "", certainty: "", effectiveAt: "2026-07-14T11:30:00.000Z", onsetAt: null, expiresAt: null, areas: [], web: null },
      ],
      integration,
    });
    expect(events.map((event) => event.kind)).toEqual(["maintenance", "observation", "alert", "weather"]);
    expect(events.some((event) => event.id === "weather:uv")).toBe(false);
    expect(events[0]).toMatchObject({ title: "Replace sink seal", detail: "in-progress", severity: "warning" });
    expect(events[2]).toMatchObject({ sensorId: sensor.id, floorId: sensor.floorId });
  });

  it("shows observation time separately from immutable recorded provenance and loads its revision ledger", async () => {
    const observation: ManualObservation = {
      id: "observation",
      houseId: "house",
      floorId: "floor",
      sensorId: null,
      kind: "maintenance",
      severity: "info",
      note: "Roof checked",
      x: 1,
      y: 1,
      occurredAt: "2026-07-14",
      createdAt: "2026-07-15T10:00:00.000Z",
      timePrecision: "date-only",
      validFrom: null,
      validTo: null,
      source: "contractor",
      sourceDetail: "Roof inspection report",
      confidence: "awaiting-inspection",
      revision: 2,
      updatedAt: "2026-07-15T10:00:00.000Z",
    };
    const revisions: ObservationRevision[] = [{
      observationId: observation.id,
      revision: 2,
      changedAt: "2026-07-15T10:00:00.000Z",
      actor: "local-rest",
      actorId: "user-1",
      actorLabel: "owner@example.com",
      changedFields: ["confidence"],
      snapshot: observation,
    }];
    const onLoadObservationRevisions = vi.fn().mockResolvedValue(revisions);
    render(<I18nProvider><HomeActivityTimeline
      sensors={[sensor]}
      alerts={[]}
      observations={[observation]}
      warnings={[]}
      integration={integration}
      timeZone="Pacific/Kiritimati"
      onLoadObservationRevisions={onLoadObservationRevisions}
      onOpenSensor={vi.fn()}
      onOpenFloor={vi.fn()}
    /></I18nProvider>);

    expect(screen.getByText("Observed 2026-07-14", { selector: "time" })).not.toBeNull();
    const details = screen.getByText("Observation details").closest("details")!;
    expect(details.hasAttribute("open")).toBe(false);
    fireEvent.click(within(details).getByText("Observation details"));
    expect(within(details).getByText("Recorded")).not.toBeNull();
    expect(within(details).getByText("Date only")).not.toBeNull();
    expect(within(details).getByText("Contractor · Roof inspection report")).not.toBeNull();
    expect(within(details).getByText("Awaiting inspection")).not.toBeNull();
    expect(within(details).getByText("Current revision 2")).not.toBeNull();
    fireEvent.click(within(details).getByRole("button", { name: "Show revision history" }));
    expect(await within(details).findByText("Revision 2")).not.toBeNull();
    expect(within(details).getByText("Changed by owner@example.com")).not.toBeNull();
    expect(within(details).getByText("Changed fields: Confidence")).not.toBeNull();
    expect(onLoadObservationRevisions).toHaveBeenCalledWith(observation.id);
  });

  it("resolves an observation with an outcome and can reopen it", async () => {
    const observation: ManualObservation = {
      id: "observation-leak",
      houseId: "house",
      floorId: "floor",
      sensorId: null,
      kind: "leak",
      severity: "warning",
      note: "Water below the sink",
      x: 1,
      y: 1,
      occurredAt: "2026-07-14T10:00:00.000Z",
      createdAt: "2026-07-14T10:05:00.000Z",
      status: "open",
      resolutionNote: null,
      resolvedAt: null,
      revision: 2,
      updatedAt: "2026-07-14T10:05:00.000Z",
    };
    const onUpdateObservation = vi.fn().mockResolvedValue({
      ...observation,
      status: "resolved",
      resolutionNote: "Fixed leak",
      resolvedAt: "2026-07-15T08:00:00.000Z",
      revision: 3,
    });
    const view = render(<I18nProvider><HomeActivityTimeline
      sensors={[sensor]}
      alerts={[]}
      observations={[observation]}
      warnings={[]}
      integration={integration}
      timeZone="Europe/Helsinki"
      onUpdateObservation={onUpdateObservation}
      onOpenSensor={vi.fn()}
      onOpenFloor={vi.fn()}
    /></I18nProvider>);

    expect(screen.getByText("Open", { selector: ".observation-status-badge" })).not.toBeNull();
    fireEvent.click(screen.getByText("Observation details"));
    const outcome = screen.getByPlaceholderText("For example, fixed leak");
    expect(screen.getByRole("button", { name: "Mark resolved" }).hasAttribute("disabled")).toBe(true);
    fireEvent.change(outcome, { target: { value: "  Fixed leak  " } });
    fireEvent.click(screen.getByRole("button", { name: "Mark resolved" }));
    await waitFor(() => expect(onUpdateObservation).toHaveBeenCalledWith(observation.id, {
      baseRevision: 2,
      status: "resolved",
      resolutionNote: "Fixed leak",
    }));

    view.rerender(<I18nProvider><HomeActivityTimeline
      sensors={[sensor]}
      alerts={[]}
      observations={[{
        ...observation,
        status: "resolved",
        resolutionNote: "Fixed leak",
        resolvedAt: "2026-07-15T08:00:00.000Z",
        revision: 3,
      }]}
      warnings={[]}
      integration={integration}
      timeZone="Europe/Helsinki"
      onUpdateObservation={onUpdateObservation}
      onOpenSensor={vi.fn()}
      onOpenFloor={vi.fn()}
    /></I18nProvider>);
    expect(screen.getByText("Resolved", { selector: ".observation-status-badge" })).not.toBeNull();
    expect(screen.getByRole("status").textContent).toBe("Observation marked resolved.");
    expect(screen.getByText(/^Resolved /, { selector: ".activity-resolved-time" })).not.toBeNull();
    fireEvent.click(screen.getByText("Observation details"));
    expect(screen.getByText("Fixed leak")).not.toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Reopen observation" }));
    await waitFor(() => expect(onUpdateObservation).toHaveBeenLastCalledWith(observation.id, {
      baseRevision: 3,
      status: "open",
      resolutionNote: null,
    }));
  });

  it("offers to reload the latest observation after a revision conflict", async () => {
    const observation: ManualObservation = {
      id: "observation-conflict",
      houseId: "house",
      floorId: "floor",
      sensorId: null,
      kind: "leak",
      severity: "warning",
      note: "Water below the sink",
      x: 1,
      y: 1,
      occurredAt: "2026-07-14T10:00:00.000Z",
      createdAt: "2026-07-14T10:05:00.000Z",
      status: "open",
      resolutionNote: null,
      resolvedAt: null,
      revision: 2,
      updatedAt: "2026-07-14T10:05:00.000Z",
    };
    const onUpdateObservation = vi.fn().mockRejectedValue(new ApiRequestError(
      409,
      "revision_conflict",
      "The observation changed before this resolution could be saved.",
    ));
    const onReloadObservation = vi.fn().mockResolvedValue({
      ...observation,
      note: "Updated by another user",
      revision: 3,
    });
    render(<I18nProvider><HomeActivityTimeline
      sensors={[sensor]}
      alerts={[]}
      observations={[observation]}
      warnings={[]}
      integration={integration}
      timeZone="Europe/Helsinki"
      onUpdateObservation={onUpdateObservation}
      onReloadObservation={onReloadObservation}
      onOpenSensor={vi.fn()}
      onOpenFloor={vi.fn()}
    /></I18nProvider>);

    fireEvent.click(screen.getByText("Observation details"));
    const resolutionInput = screen.getByPlaceholderText("For example, fixed leak");
    expect(resolutionInput.getAttribute("maxlength")).toBe("5000");
    fireEvent.change(resolutionInput, { target: { value: "Fixed leak" } });
    fireEvent.click(screen.getByRole("button", { name: "Mark resolved" }));

    const conflict = await screen.findByRole("alert");
    expect(conflict.textContent).toMatch(/changed|conflict/i);
    fireEvent.click(screen.getByRole("button", { name: "Reload latest" }));
    await waitFor(() => expect(onReloadObservation).toHaveBeenCalledWith(observation.id));
  });

  it("makes every observation available when the activity filter is set to observations", () => {
    const observations: ManualObservation[] = Array.from({ length: 12 }, (_, index) => ({
      id: `observation-${index}`,
      houseId: "house",
      floorId: "floor",
      sensorId: null,
      kind: "note",
      severity: "info",
      note: `Finding ${index + 1}`,
      x: null,
      y: null,
      occurredAt: `2026-07-${String(index + 1).padStart(2, "0")}T10:00:00.000Z`,
      createdAt: `2026-07-${String(index + 1).padStart(2, "0")}T10:05:00.000Z`,
      status: "open",
      resolutionNote: null,
      resolvedAt: null,
      revision: 1,
    }));
    render(<I18nProvider><HomeActivityTimeline
      sensors={[sensor]}
      alerts={[]}
      observations={observations}
      warnings={[]}
      integration={integration}
      timeZone="UTC"
      onUpdateObservation={vi.fn()}
      onOpenSensor={vi.fn()}
      onOpenFloor={vi.fn()}
    /></I18nProvider>);

    expect(screen.getAllByText("Observation details")).toHaveLength(10);
    fireEvent.change(screen.getByLabelText("Filter home activity"), { target: { value: "observation" } });
    expect(screen.getAllByText("Observation details")).toHaveLength(12);
  });

  it("opens stable Room evidence without selecting a representative sensor", () => {
    const onOpenRoom = vi.fn();
    render(<I18nProvider><RoomComfortBoard sensors={[sensor]} latestMeasurements={{ [sensor.id]: { temperature: sample("temperature", 22), humidity: sample("humidity", 45), co2: sample("co2", 700) } }} measurementHistory={{}} definitions={BUILTIN_MEASUREMENT_DEFINITIONS} alerts={[]} units="metric" now={now} onOpenRoom={onOpenRoom} /></I18nProvider>);
    fireEvent.click(screen.getByRole("button", { name: /^Open Office\. Status: Comfortable\./ }));
    expect(onOpenRoom).toHaveBeenCalledWith("floor", "room-office");
    expect(screen.getByRole("heading", { name: "Office" })).not.toBeNull();
    expect(screen.getByText("Desk sensor")).not.toBeNull();
    expect(screen.getByText("1 fresh of 1")).not.toBeNull();
  });

  it("never hides rooms needing attention behind the routine-room disclosure", () => {
    const sensors = Array.from({ length: 6 }, (_, index) => ({
      ...sensor,
      id: `sensor-attention-${index}`,
      name: `Sensor ${index + 1}`,
      room: `Room ${index + 1}`,
      roomId: `room-attention-${index}`,
    }));
    const latestMeasurements = Object.fromEntries(sensors.map((item) => [item.id, {
      temperature: { ...sample("temperature", 29), sensorId: item.id },
      humidity: { ...sample("humidity", 75), sensorId: item.id },
    }]));

    render(<I18nProvider><RoomComfortBoard sensors={sensors} latestMeasurements={latestMeasurements} measurementHistory={{}} definitions={BUILTIN_MEASUREMENT_DEFINITIONS} alerts={[]} units="metric" now={now} onOpenRoom={vi.fn()} /></I18nProvider>);

    for (const item of sensors) expect(screen.getByRole("button", { name: new RegExp(`^Open ${item.room}\\. Status: Needs attention\\.`) })).not.toBeNull();
    expect(screen.queryByText(/Show .* more rooms/)).toBeNull();
  });

  it.each(["pending", "error", "partial", "unknown", "not-successful"] as const)("uses neutral unknown Home Pulse content for %s monitoring", (condition) => {
    const state = createDemoState();
    const house = state.houses[0]!;
    const roomSensor = state.sensors.find((candidate) => candidate.houseId === house.id)!;
    const response = monitoringDetail(
      monitoringSummary({
        houseId: house.id,
        status: condition === "unknown" ? "unknown" : condition === "not-successful" ? "inspection-recommended" : "monitoring-ok",
        pulseStatus: condition === "unknown" ? "unknown" : "steady",
        coverage: { enabledSensors: 1, freshSensors: 1 },
      }),
      [],
    );
    const requestProps = condition === "pending" || condition === "error"
      ? { monitoringRequestState: condition }
      : { monitoring: condition === "partial" ? { ...response, completeness: "partial" as const } : response };
    const view = render(<I18nProvider><HomePulsePanel
      house={house}
      sensors={[roomSensor]}
      latestMeasurements={{}}
      measurementHistory={{}}
      alerts={[]}
      alertRules={[]}
      weather={null}
      referenceTime={now}
      {...requestProps}
      onOpenTarget={vi.fn()}
    /></I18nProvider>);

    expect(screen.getByRole("heading", { name: "Waiting for a reliable pulse" })).not.toBeNull();
    const unknownSummary = view.container.querySelector<HTMLElement>('[data-pulse-empty-state="unknown"]')!;
    expect(unknownSummary).not.toBeNull();
    expect(within(unknownSummary).getByText("More fresh sensor data is needed before drawing a conclusion.")).not.toBeNull();
    expect(view.container.querySelector(".pulse-calm")).toBeNull();
    expect(screen.queryByText("No action is being suggested right now.")).toBeNull();
  });

  it("uses calm success content only for complete steady monitoring", () => {
    const state = createDemoState();
    const house = state.houses[0]!;
    const roomSensor = state.sensors.find((candidate) => candidate.houseId === house.id)!;
    const view = render(<I18nProvider><HomePulsePanel
      house={house}
      sensors={[roomSensor]}
      latestMeasurements={{}}
      measurementHistory={{}}
      alerts={[]}
      alertRules={[]}
      weather={null}
      referenceTime={now}
      monitoring={monitoringDetail(monitoringSummary({
        houseId: house.id,
        coverage: { enabledSensors: 1, freshSensors: 1 },
      }), [])}
      onOpenTarget={vi.fn()}
    /></I18nProvider>);

    expect(view.container.querySelector(".pulse-calm")).not.toBeNull();
    expect(screen.getByText("No action is being suggested right now.")).not.toBeNull();
    expect(view.container.querySelector("[data-pulse-empty-state]")).toBeNull();
  });

  it("auto-expands critical Home Pulse guidance with its visible advisory", () => {
    const state = createDemoState();
    const house = state.houses[0]!;
    const roomSensor = state.sensors.find((candidate) => candidate.houseId === house.id)!;
    const temperature = { ...sample("temperature", 40), sensorId: roomSensor.id };
    const alert: AlertEvent = {
      id: "critical-temperature",
      ruleId: "temperature-rule",
      sensorId: roomSensor.id,
      metric: "temperature",
      value: 40,
      threshold: 35,
      severity: "critical",
      startedAt: "2026-07-14T11:50:00.000Z",
      acknowledgedAt: null,
      resolvedAt: null,
    };
    const view = render(<I18nProvider><HomePulsePanel
      house={house}
      sensors={[roomSensor]}
      latestMeasurements={{ [roomSensor.id]: { temperature } }}
      measurementHistory={{}}
      alerts={[alert]}
      alertRules={[]}
      weather={null}
      referenceTime={now}
      monitoring={monitoringDetail(
        monitoringSummary({
          houseId: house.id,
          status: "action-required",
          pulseStatus: "critical",
          coverage: { enabledSensors: 1, freshSensors: 1 },
          activeAlertCount: 1,
        }),
        [monitoringInsight({
          id: `active-alert:${alert.id}`,
          kind: "active-alert",
          severity: "critical",
          title: "Temperature alert - Living room",
          summary: "This critical alert remains open and should be checked.",
          house,
          sensor: roomSensor,
          evidence: [{ label: "Alert value", value: 40, unit: "Â°C" }],
        })],
      )}
      onOpenTarget={vi.fn()}
    /></I18nProvider>);

    const more = view.container.querySelector<HTMLDetailsElement>(".home-pulse-more")!;
    expect(more.open).toBe(false);
    const criticalGlance = view.container.querySelector<HTMLElement>(".pulse-glance-list .critical")!;
    expect(within(criticalGlance).getByText("Critical")).not.toBeNull();
    expect(within(criticalGlance).getByText("Critical alert in Living room")).not.toBeNull();
    openHomePulseMore(view.container);
    const criticalInsight = view.container.querySelector<HTMLDetailsElement>(".pulse-insight.critical")!;
    expect(criticalInsight.open).toBe(true);
    expect(within(criticalInsight).getByRole("button", { name: "Inspect room" })).toBeTruthy();
    expect(view.container.querySelector(".home-pulse-more-content > .home-pulse-advisory")).not.toBeNull();
  });

  it("keeps critical Home Pulse guidance visible and acknowledges it through the alert lifecycle", async () => {
    const state = createDemoState();
    const house = state.houses[0]!;
    const roomSensor = state.sensors.find((candidate) => candidate.houseId === house.id)!;
    const temperature = { ...sample("temperature", 40), sensorId: roomSensor.id };
    const alert: AlertEvent = {
      id: "critical-temperature-hide",
      ruleId: "temperature-rule",
      sensorId: roomSensor.id,
      metric: "temperature",
      value: 40,
      threshold: 35,
      severity: "critical",
      startedAt: "2026-07-14T11:50:00.000Z",
      acknowledgedAt: null,
      resolvedAt: null,
    };
    const onAcknowledge = vi.fn().mockResolvedValue(undefined);
    localStorage.setItem(`stugu-home-pulse-hidden:v1:${house.id}`, JSON.stringify([`active-alert:${alert.id}:critical`]));
    const panel = <I18nProvider><HomePulsePanel
      house={house}
      sensors={[roomSensor]}
      latestMeasurements={{ [roomSensor.id]: { temperature, humidity: { ...sample("humidity", 45), sensorId: roomSensor.id }, co2: { ...sample("co2", 700), sensorId: roomSensor.id } } }}
      measurementHistory={{}}
      alerts={[alert]}
      alertRules={[]}
      weather={null}
      referenceTime={now}
      monitoring={monitoringDetail(
        monitoringSummary({
          houseId: house.id,
          status: "action-required",
          pulseStatus: "critical",
          coverage: { enabledSensors: 1, freshSensors: 1 },
          activeAlertCount: 1,
        }),
        [monitoringInsight({
          id: `active-alert:${alert.id}`,
          kind: "active-alert",
          severity: "critical",
          title: "Temperature alert - Living room",
          summary: "This critical alert remains open and should be checked.",
          house,
          sensor: roomSensor,
        })],
      )}
      onOpenTarget={vi.fn()}
      onAcknowledge={onAcknowledge}
    /></I18nProvider>;
    const view = render(panel);

    openHomePulseMore(view.container);
    expect(view.container.querySelector(".pulse-insight.critical")).not.toBeNull();
    expect(screen.getByRole("heading", { name: "Check this home now" })).not.toBeNull();
    expect(view.container.querySelector(".home-pulse-more-content > .home-pulse-advisory")).not.toBeNull();
    expect(screen.queryByText("No action is being suggested right now.")).toBeNull();
    expect(screen.queryByRole("button", { name: /^Hide / })).toBeNull();
    expect(view.container.querySelector(".pulse-hidden-disclosure")).toBeNull();
    await waitFor(() => expect(localStorage.getItem(`stugu-home-pulse-hidden:v1:${house.id}`)).toBeNull());

    fireEvent.click(screen.getByRole("button", { name: "Acknowledge" }));
    await waitFor(() => expect(onAcknowledge).toHaveBeenCalledWith(alert.id));
    expect(screen.getByText("Acknowledged")).not.toBeNull();
  });

  it("promotes the next ranked insight after one is hidden", () => {
    const state = createDemoState();
    const house = state.houses[0]!;
    const baseSensor = state.sensors.find((candidate) => candidate.houseId === house.id)!;
    const sensors = Array.from({ length: 4 }, (_, index) => ({ ...baseSensor, id: `pulse-sensor-${index}`, name: `Pulse sensor ${index + 1}`, room: `Pulse room ${index + 1}` }));
    const alerts: AlertEvent[] = sensors.map((item, index) => ({
      id: `pulse-alert-${index}`,
      ruleId: `pulse-rule-${index}`,
      sensorId: item.id,
      metric: "temperature",
      value: 35 + index,
      threshold: 30,
      severity: "warning",
      startedAt: `2026-07-14T11:${String(40 + index).padStart(2, "0")}:00.000Z`,
      acknowledgedAt: null,
      resolvedAt: null,
    }));
    const view = render(<I18nProvider><HomePulsePanel
      house={house}
      sensors={sensors}
      latestMeasurements={{}}
      measurementHistory={{}}
      alerts={alerts}
      alertRules={[]}
      weather={null}
      referenceTime={now}
      monitoring={monitoringDetail(
        monitoringSummary({
          houseId: house.id,
          status: "action-required",
          pulseStatus: "attention",
          coverage: { enabledSensors: sensors.length, freshSensors: sensors.length },
          activeAlertCount: alerts.length,
        }),
        alerts.map((alert, index) => monitoringInsight({
          id: `active-alert:${alert.id}`,
          kind: "active-alert",
          severity: "warning",
          title: `Temperature alert - ${sensors[index]!.room}`,
          house,
          sensor: sensors[index]!,
          rank: index + 1,
        })),
      )}
      onOpenTarget={vi.fn()}
    /></I18nProvider>);

    expect(view.container.querySelectorAll(".pulse-insight")).toHaveLength(3);
    openHomePulseMore(view.container);
    fireEvent.click(screen.getAllByRole("button", { name: /^Hide / })[0]!);
    expect(view.container.querySelectorAll(".pulse-insight")).toHaveLength(3);
    expect(view.container.querySelector(".pulse-hidden-disclosure > summary")?.textContent).toContain("1 hidden Home Pulse item");
  });
});
