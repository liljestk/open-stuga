import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ScheduledDataExport } from "@climate-twin/contracts";
import { api } from "../api";
import { createDemoState } from "../domain";
import { I18nProvider } from "../i18n";
import { ScheduledDataExportsPanel } from "./ScheduledDataExportsPanel";

afterEach(() => vi.restoreAllMocks());

function renderPanel() {
  const state = createDemoState();
  const house = state.houses[0]!;
  const sensors = state.sensors.filter((sensor) => sensor.houseId === house.id && sensor.enabled);
  render(<I18nProvider><ScheduledDataExportsPanel
    house={house}
    period="30d"
    sensorIds={sensors.map((sensor) => sensor.id)}
    measurementIds={["temperature", "humidity"]}
    resolution="15m"
    aggregation="mean"
    configurationError={null}
  /></I18nProvider>);
  return { house, sensors };
}

function createdSchedule(houseId: string, overrides: Partial<ScheduledDataExport> = {}): ScheduledDataExport {
  return {
    id: "11111111-1111-4111-8111-111111111111",
    houseId,
    name: "Weekly export",
    enabled: true,
    frequency: "weekly",
    timeLocal: "02:00",
    dayOfWeek: 0,
    dayOfMonth: null,
    period: "30d",
    sensorIds: ["sensor-01"],
    measurementIds: ["temperature", "humidity"],
    resolution: "15m",
    aggregation: "mean",
    retentionCount: 12,
    nextRunAt: "2026-08-09T23:00:00.000Z",
    lastRunAt: null,
    lastRunStatus: "never",
    lastRunError: null,
    lastOutputName: null,
    revision: 1,
    createdAt: "2026-08-02T12:00:00.000Z",
    updatedAt: "2026-08-02T12:00:00.000Z",
    ...overrides,
  };
}

function mockTarget() {
  vi.spyOn(api, "scheduledDataExports").mockResolvedValue([]);
  vi.spyOn(api, "systemStorageStatus").mockResolvedValue({
    settings: { timeseries: { kind: "managed", path: null }, backups: { kind: "nas-path", path: "/mnt/stugu/nas" } },
    revision: "storage-revision",
    allowedRoots: ["/mnt/stugu"],
    capability: { available: true, runtime: "docker", agentLastSeenAt: "2026-08-02T12:00:00.000Z", reason: "ready", detail: null },
    operation: null,
  });
}

describe("ScheduledDataExportsPanel", () => {
  it("creates the weekly default from the current Data & Analytics selection", async () => {
    mockTarget();
    const create = vi.spyOn(api, "createScheduledDataExport");
    const { house, sensors } = renderPanel();
    create.mockResolvedValue(createdSchedule(house.id, { name: `${house.name} weekly export`, sensorIds: sensors.map((sensor) => sensor.id) }));

    await screen.findByText("NAS connected");
    await userEvent.setup().click(screen.getByRole("button", { name: "Schedule weekly export" }));

    await waitFor(() => expect(create).toHaveBeenCalledWith(house.id, expect.objectContaining({
      frequency: "weekly",
      period: "30d",
      sensorIds: sensors.map((sensor) => sensor.id),
      measurementIds: ["temperature", "humidity"],
      resolution: "15m",
      aggregation: "mean",
    })));
    expect(await screen.findByText(`${house.name} weekly export`)).toBeTruthy();
  });

  it("keeps monthly timing and retention in the advanced disclosure", async () => {
    mockTarget();
    const create = vi.spyOn(api, "createScheduledDataExport");
    const { house } = renderPanel();
    create.mockResolvedValue(createdSchedule(house.id, { name: "Month end", frequency: "monthly", dayOfWeek: null, dayOfMonth: 31, retentionCount: 6 }));
    const user = userEvent.setup();

    await screen.findByText("NAS connected");
    await user.click(screen.getByText("Advanced schedule"));
    await user.clear(screen.getByRole("textbox", { name: "Schedule name" }));
    await user.type(screen.getByRole("textbox", { name: "Schedule name" }), "Month end");
    await user.selectOptions(screen.getByRole("combobox", { name: "Frequency" }), "monthly");
    await user.clear(screen.getByRole("spinbutton", { name: "Day of month" }));
    await user.type(screen.getByRole("spinbutton", { name: "Day of month" }), "31");
    await user.clear(screen.getByRole("spinbutton", { name: /^Files to keep/u }));
    await user.type(screen.getByRole("spinbutton", { name: /^Files to keep/u }), "6");
    await user.click(screen.getByRole("button", { name: "Create schedule" }));

    await waitFor(() => expect(create).toHaveBeenCalledWith(house.id, expect.objectContaining({
      name: "Month end", frequency: "monthly", dayOfWeek: null, dayOfMonth: 31, retentionCount: 6,
    })));
  });
});
