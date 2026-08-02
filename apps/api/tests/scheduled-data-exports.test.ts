import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ClimateDatabase } from "../src/db.js";
import {
  nextScheduledDataExportRun,
  ScheduledDataExportError,
  ScheduledDataExportService,
} from "../src/scheduled-data-exports.js";
import { HybridTelemetryReader } from "../src/timeseries/read-facade.js";

describe("scheduled data exports", () => {
  const directories: string[] = [];
  const databases: ClimateDatabase[] = [];

  afterEach(() => {
    for (const database of databases.splice(0)) database.close();
    for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
  });

  function fixture(nasConfigured = true) {
    const operationsDirectory = mkdtempSync(join(tmpdir(), "stugu-scheduled-export-"));
    directories.push(operationsDirectory);
    const database = new ClimateDatabase(":memory:", true);
    databases.push(database);
    database.activateRealDataMode();
    database.insertMeasurementSamples([{
      sensorId: "sensor-01",
      metric: "temperature",
      value: 21.25,
      canonicalUnit: "°C",
      timestamp: "2026-08-02T10:15:00.000Z",
      source: "api",
      quality: "good",
    }]);
    const audit = vi.fn();
    const service = new ScheduledDataExportService({
      database,
      telemetryReader: new HybridTelemetryReader({ local: database }),
      systemStorage: {
        status: () => ({ settings: {
          timeseries: { kind: "managed", path: null },
          backups: nasConfigured ? { kind: "nas-path", path: "/mnt/stugu/nas" } : { kind: "managed", path: null },
        } }),
      } as never,
      dataOperations: { audit } as never,
      operationsDirectory,
      now: () => new Date("2026-08-02T12:00:00.000Z"),
    });
    return { service, operationsDirectory, audit };
  }

  const input = {
    name: "Weekly readings",
    enabled: true,
    frequency: "weekly" as const,
    timeLocal: "02:00",
    dayOfWeek: 0,
    dayOfMonth: null,
    period: "24h" as const,
    sensorIds: ["sensor-01"],
    measurementIds: ["temperature"],
    resolution: "1h" as const,
    aggregation: "mean" as const,
    retentionCount: 12,
  };

  it("creates a Home schedule and stages a checksummed CSV handoff", async () => {
    const { service, operationsDirectory, audit } = fixture();
    const schedule = service.create("house-main", input);

    expect(schedule).toMatchObject({ houseId: "house-main", enabled: true, lastRunStatus: "never" });
    expect(schedule.nextRunAt).toBe("2026-08-08T23:00:00.000Z");

    const pending = await service.runNow(schedule.id);
    expect(pending.lastRunStatus).toBe("pending");
    const requestName = readdirSync(operationsDirectory).find((name) => name.endsWith(".request.json"));
    expect(requestName).toBeTruthy();
    const request = JSON.parse(readFileSync(join(operationsDirectory, requestName!), "utf8")) as Record<string, unknown>;
    expect(request).toMatchObject({
      schema: "stugu-data-export-request/v1",
      scheduleId: schedule.id,
      relativeDirectory: `data-exports/${schedule.id}`,
      retentionCount: 12,
    });
    const csv = readFileSync(join(operationsDirectory, request.payloadName as string), "utf8");
    expect(csv).toContain("Home time,UTC timestamp,Sensor name,Sensor ID,Temperature (°C)");
    expect(csv).toContain("21.3");
    expect(audit).toHaveBeenCalledWith("scheduled-data-export.staged", expect.objectContaining({ id: schedule.id }));

    writeFileSync(join(operationsDirectory, `data-export-${request.runId}.receipt.json`), JSON.stringify({
      schema: "stugu-data-export-receipt/v1",
      runId: request.runId,
      scheduleId: schedule.id,
      status: "complete",
      completedAt: "2026-08-02T12:01:00.000Z",
      outputName: request.outputName,
    }));
    service.reconcileReceipts();
    expect(service.get(schedule.id)).toMatchObject({
      lastRunStatus: "complete",
      lastOutputName: request.outputName,
    });
  });

  it("requires a configured NAS for active schedules", () => {
    const { service } = fixture(false);
    expect(() => service.create("house-main", input)).toThrowError(ScheduledDataExportError);
    expect(() => service.create("house-main", { ...input, enabled: false })).not.toThrow();
  });

  it("resolves monthly end-of-month schedules in the Home timezone", () => {
    expect(nextScheduledDataExportRun({
      frequency: "monthly",
      timeLocal: "02:00",
      dayOfWeek: null,
      dayOfMonth: 31,
    }, "Europe/Helsinki", new Date("2026-04-01T00:00:00.000Z"))).toBe("2026-04-29T23:00:00.000Z");
  });

  it("runs only once during a repeated daylight-saving wall-clock time", () => {
    const schedule = { frequency: "daily" as const, timeLocal: "03:30", dayOfWeek: null, dayOfMonth: null };
    const first = nextScheduledDataExportRun(schedule, "Europe/Helsinki", new Date("2026-10-24T22:00:00.000Z"));
    expect(first).toBe("2026-10-25T00:30:00.000Z");
    expect(nextScheduledDataExportRun(schedule, "Europe/Helsinki", new Date(first))).toBe("2026-10-26T01:30:00.000Z");
  });
});
