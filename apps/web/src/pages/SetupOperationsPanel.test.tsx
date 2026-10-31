import { act, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type {
  BackupOperationStatus,
  DataExportPreview,
  DataExportPrivacyLevel,
  Sensor,
  SetupDoctorReport,
} from "@climate-twin/contracts";
import { api } from "../api";
import { createDemoState } from "../domain";
import { I18nProvider } from "../i18n";
import { SetupOperationsPanel, SystemOperationsPanel } from "./SetupOperationsPanel";

afterEach(() => vi.restoreAllMocks());
beforeEach(() => {
  vi.spyOn(api, "systemStorageStatus").mockResolvedValue({
    settings: { timeseries: { kind: "managed", path: null }, backups: { kind: "managed", path: null } },
    revision: "storage-revision",
    allowedRoots: ["/mnt/stugu"],
    capability: { available: true, runtime: "docker", agentLastSeenAt: "2026-08-01T10:00:00.000Z", reason: "ready", detail: null },
    operation: null,
  });
  vi.spyOn(api, "exportDestinations").mockResolvedValue({ selected: "nas", ready: false, nasConnected: false, accounts: [], connection: null });
});

const doctor: SetupDoctorReport = {
  generatedAt: "2026-08-01T10:00:00.000Z",
  overall: "attention",
  checks: [{
    id: "sensor-coverage",
    category: "sensors",
    status: "warning",
    title: "Sensor coverage needs review",
    detail: "One room has no current reading.",
    action: "Review sensors",
  }],
};

const idleBackup: BackupOperationStatus = {
  available: true,
  schedulerHealthy: true,
  requestId: null,
  state: "idle",
  requestedAt: null,
  completedAt: null,
  backupPath: null,
  lastError: null,
  latestVerifiedBackupAt: "2026-07-31T09:00:00.000Z",
  latestRestoreDrillAt: "2026-07-30T09:00:00.000Z",
};

function exportPreview(
  privacyLevel: DataExportPrivacyLevel,
  includesTelemetry: boolean,
): DataExportPreview {
  return {
    schemaVersion: "stugu.export/v1",
    generatedAt: "2026-08-01T10:00:00.000Z",
    privacyLevel,
    includesTelemetry,
    counts: { houses: 1, sensors: 2 },
    sensitiveCategories: privacyLevel === "full" ? ["guest access"] : [],
    estimatedTelemetryRows: includesTelemetry ? 42 : 0,
  };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((next) => { resolve = next; });
  return { promise, resolve };
}

describe("SystemOperationsPanel", () => {
  it("loads diagnostics and backup state, reviews export scope, and requests a backup", async () => {
    const user = userEvent.setup();
    const setupDoctor = vi.spyOn(api, "setupDoctor").mockResolvedValue(doctor);
    const backupStatus = vi.spyOn(api, "backupStatus").mockResolvedValue(idleBackup);
    const dataExportPreview = vi.spyOn(api, "dataExportPreview")
      .mockImplementation(async (privacy, telemetry) => exportPreview(privacy, telemetry));
    const requestBackup = vi.spyOn(api, "requestBackup").mockResolvedValue({
      ...idleBackup,
      requestId: "backup-request-1",
      state: "requested",
      requestedAt: "2026-08-01T10:05:00.000Z",
    });

    render(<I18nProvider><SystemOperationsPanel /></I18nProvider>);

    expect(await screen.findByText("Sensor coverage needs review")).toBeTruthy();
    expect(screen.getByRole("link", { name: "Review sensors" }).getAttribute("href")).toBe("/sensors");
    await waitFor(() => expect(backupStatus).toHaveBeenCalledOnce());
    await waitFor(() => expect(dataExportPreview).toHaveBeenCalledWith("operations", false));

    await user.selectOptions(screen.getByRole("combobox", { name: "Export privacy scope" }), "full");
    await waitFor(() => expect(dataExportPreview).toHaveBeenLastCalledWith("full", false));
    await user.click(screen.getByRole("checkbox", { name: "Include raw sensor readings" }));
    await waitFor(() => expect(dataExportPreview).toHaveBeenLastCalledWith("full", true));
    expect(screen.getByRole("link", { name: "Download reviewed export" }).getAttribute("href"))
      .toContain("privacyLevel=full&includeTelemetry=true");
    expect(await screen.findByText("42 reading rows")).toBeTruthy();

    await user.click(screen.getByRole("button", { name: "Recheck" }));
    await waitFor(() => expect(setupDoctor).toHaveBeenCalledTimes(2));
    await waitFor(() => expect(backupStatus).toHaveBeenCalledTimes(2));

    await user.click(screen.getByRole("button", { name: "Run verified backup" }));
    await waitFor(() => expect(requestBackup).toHaveBeenCalledOnce());
    expect(await screen.findByText("Requested")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Run verified backup" })).toBeDisabled();
  });
});

describe("SetupOperationsPanel", () => {
  it("loads, edits, and atomically saves mappings for the active Home", async () => {
    const user = userEvent.setup();
    const state = createDemoState();
    const house = state.houses[0]!;
    const sensor = state.sensors.find((candidate) => candidate.houseId === house.id)!;
    vi.spyOn(api, "sensors").mockResolvedValue([sensor]);
    const bulkSensorMappings = vi.spyOn(api, "bulkSensorMappings").mockResolvedValue({
      sensors: [{
        ...sensor,
        measurementEntityIds: {
          ...sensor.measurementEntityIds,
          temperature: "sensor.reviewed_temperature",
        },
      }],
    });

    render(<I18nProvider><SetupOperationsPanel house={house} /></I18nProvider>);

    const input = await screen.findByRole("textbox", {
      name: `${sensor.name} Temperature source ID`,
    });
    expect(screen.getByRole("region", { name: `Scrollable sensor mapping table for ${house.name}` })).toHaveClass("bulk-mapping-scroll");
    await user.clear(input);
    await user.type(input, " sensor.reviewed_temperature ");
    await user.click(screen.getByRole("button", { name: "Validate and save all mappings" }));

    await waitFor(() => expect(bulkSensorMappings).toHaveBeenCalledWith(house.id, [
      expect.objectContaining({
        sensorId: sensor.id,
        measurementEntityIds: expect.objectContaining({
          temperature: "sensor.reviewed_temperature",
        }),
      }),
    ]));
    expect(await screen.findByRole("status")).toHaveTextContent("Saved 1 sensor mappings atomically.");
  });

  it("ignores a stale Home load and keeps save errors scoped to the selected Home", async () => {
    const user = userEvent.setup();
    const state = createDemoState();
    const firstHouse = state.houses[0]!;
    const firstSensor = state.sensors.find((candidate) => candidate.houseId === firstHouse.id)!;
    const secondHouse = { ...firstHouse, id: "house-second", name: "Lake Home" };
    const secondSensor: Sensor = {
      ...firstSensor,
      id: "sensor-second",
      houseId: secondHouse.id,
      name: "Lake sensor",
      room: "Kitchen",
      temperatureEntityId: "",
      humidityEntityId: "",
      batteryEntityId: "",
      measurementEntityIds: {},
    };
    const firstLoad = deferred<Sensor[]>();
    vi.spyOn(api, "sensors")
      .mockReturnValueOnce(firstLoad.promise)
      .mockResolvedValueOnce([secondSensor]);
    const bulkSensorMappings = vi.spyOn(api, "bulkSensorMappings")
      .mockRejectedValue(new Error("Mapping save failed"));

    const view = render(
      <I18nProvider><SetupOperationsPanel house={firstHouse} /></I18nProvider>,
    );
    view.rerender(<I18nProvider><SetupOperationsPanel house={secondHouse} /></I18nProvider>);

    const input = await screen.findByRole("textbox", {
      name: "Lake sensor Temperature source ID",
    });
    firstLoad.resolve([firstSensor]);
    await act(async () => { await firstLoad.promise; });
    await waitFor(() => expect(screen.queryByText(firstSensor.name)).toBeNull());

    await user.type(input, "sensor.lake_temperature");
    await user.click(screen.getByRole("button", { name: "Validate and save all mappings" }));

    await waitFor(() => expect(bulkSensorMappings).toHaveBeenCalledWith(secondHouse.id, [
      expect.objectContaining({
        sensorId: secondSensor.id,
        measurementEntityIds: expect.objectContaining({
          temperature: "sensor.lake_temperature",
        }),
      }),
    ]));
    expect(await screen.findByRole("alert")).toHaveTextContent("The operation could not be completed.");
  });
});
