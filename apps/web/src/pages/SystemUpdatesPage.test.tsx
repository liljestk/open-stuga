import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { HostSystemHealth } from "@climate-twin/contracts";
import { api, type SystemStorageStatus, type SystemUpdateStatus } from "../api";
import { confirmAction } from "../components/ConfirmationProvider";
import { I18nProvider } from "../i18n";
import { SystemUpdatesPage } from "./SystemUpdatesPage";

vi.mock("../components/ConfirmationProvider", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../components/ConfirmationProvider")>();
  return { ...actual, confirmAction: vi.fn().mockResolvedValue(true) };
});

const status: SystemUpdateStatus = {
  currentVersion: "0.5.0",
  latestVersion: "0.6.0",
  updateAvailable: true,
  latestRelease: {
    version: "0.6.0",
    tagName: "v0.6.0",
    name: "Safer system updates",
    notes: "Backup before install\n\nRollback on failed health checks.",
    publishedAt: "2026-07-23T18:00:00.000Z",
    url: "https://github.com/liljestk/open-stuga/releases/tag/v0.6.0",
    prerelease: false,
  },
  releases: [],
  lastCheckedAt: "2026-07-23T20:00:00.000Z",
  checkError: null,
  settings: {
    mode: "manual",
    includePrereleases: false,
    checkIntervalHours: 24,
    updateTime: "03:00",
    updateDays: ["sun"],
    timezone: "Europe/Helsinki",
  },
  nextUpdateWindowAt: null,
  capability: {
    available: true,
    runtime: "docker",
    agentLastSeenAt: "2026-07-23T20:00:00.000Z",
    reason: "ready",
  },
  operation: null,
};

const storageStatus: SystemStorageStatus = {
  settings: {
    timeseries: { kind: "managed", path: null },
    backups: { kind: "managed", path: null },
  },
  revision: "a".repeat(64),
  allowedRoots: ["/mnt/stugu", "/media/stugu"],
  capability: {
    available: true,
    runtime: "raspberry-pi",
    agentLastSeenAt: "2026-08-02T10:00:00.000Z",
    reason: "ready",
    detail: null,
  },
  operation: null,
};

const thresholds = {
  warningPercent: 85,
  criticalPercent: 95,
  warningAfterSeconds: 300,
  criticalAfterSeconds: 120,
};
const hostHealth: HostSystemHealth = {
  state: "healthy",
  sampledAt: "2026-07-30T12:00:00.000Z",
  hostname: "stugu",
  platform: "linux",
  architecture: "arm64",
  release: "6.12",
  hostUptimeSeconds: 172_800,
  serviceUptimeSeconds: 7_200,
  cpu: {
    state: "healthy",
    usagePercent: 24.5,
    processUsagePercent: 17.8,
    logicalCores: 4,
    loadAverage: [0.42, 0.35, 0.3],
    temperatureCelsius: 51.2,
    usageThresholds: thresholds,
    temperatureThresholds: { ...thresholds, warningPercent: 75, criticalPercent: 85 },
    eventLoop: {
      state: "healthy",
      p95Milliseconds: 22.4,
      maxMilliseconds: 48.1,
      thresholds: {
        warningMilliseconds: 250,
        criticalMilliseconds: 1_000,
        warningAfterSeconds: 120,
        criticalAfterSeconds: 30,
      },
    },
  },
  memory: {
    state: "healthy",
    scope: "container",
    totalBytes: 4_294_967_296,
    usedBytes: 2_147_483_648,
    availableBytes: 2_147_483_648,
    usedPercent: 50,
    processResidentBytes: 134_217_728,
    thresholds,
  },
  storage: {
    state: "healthy",
    totalBytes: 68_719_476_736,
    usedBytes: 25_769_803_776,
    availableBytes: 42_949_672_960,
    usedPercent: 37.5,
    thresholds,
    warningAvailableBytes: 5_368_709_120,
    criticalAvailableBytes: 1_073_741_824,
    forecast: {
      state: "stable", sampleCount: 48, observedSeconds: 86_400, growthBytesPerDay: 0,
      warningAt: null, criticalAt: null, confidence: "medium",
    },
  },
  database: {
    state: "healthy",
    sqlite: {
      state: "healthy", sizeBytes: 12_582_912, usedBytes: 11_534_336, walBytes: 0,
      pageCount: 3_072, freePages: 256, tableCount: 42,
    },
    telemetry: {
      enabled: false, required: false, state: "disabled", sizeBytes: null,
      latencyMilliseconds: null, pool: null, queries: null,
    },
  },
  alertDelivery: {
    telegram: { configured: true, connected: true, lastDeliveryAt: null, error: null },
  },
  alerts: [],
};

beforeEach(() => {
  vi.mocked(confirmAction).mockReset().mockResolvedValue(true);
  vi.spyOn(api, "hostSystemHealth").mockResolvedValue(hostHealth);
  vi.spyOn(api, "systemStorageStatus").mockResolvedValue(storageStatus);
});
afterEach(() => vi.restoreAllMocks());

describe("system updates page", () => {
  it("shows installed/latest versions and readable release notes", async () => {
    vi.spyOn(api, "systemUpdateStatus").mockResolvedValue(status);
    render(<I18nProvider><SystemUpdatesPage /></I18nProvider>);

    expect(await screen.findByText("Safer system updates")).toBeTruthy();
    expect(screen.getByText("v0.5.0")).toBeTruthy();
    expect(screen.getByText("v0.6.0")).toBeTruthy();
    expect(
      (screen.getByRole("button", { name: "Update now" }) as HTMLButtonElement).disabled
    ).toBe(false);
    expect(screen.getByRole("heading", { name: "System", level: 1 })).toBeTruthy();
    const hostMetricsSummary = screen.getByText("Metrics and alert thresholds").closest("summary")!;
    expect(hostMetricsSummary.closest("details")?.open).toBe(false);
    fireEvent.click(hostMetricsSummary);
    expect(screen.getByText("24.5%")).toBeTruthy();
    expect(screen.getByText("22.4 ms")).toBeTruthy();
    expect(screen.getByText("12 MiB")).toBeTruthy();
    expect(screen.getByText(/No meaningful growth/)).toBeTruthy();
    expect(screen.getByText(/existing Telegram alert chat/)).toBeTruthy();
    expect(screen.getByRole("link", { name: "/api/v1/system/metrics" }).getAttribute("href")).toBe("/api/v1/system/metrics");
    expect(screen.getByRole("link", { name: "Export error log" }).getAttribute("href")).toBe("/api/v1/system/error-logs");
    const releaseSummary = screen.getByText("Safer system updates").closest("summary")!;
    const scheduleSummary = screen.getByText("When should updates install?").closest("summary")!;
    expect(releaseSummary.closest("details")?.open).toBe(false);
    expect(scheduleSummary.closest("details")?.open).toBe(false);
    fireEvent.click(releaseSummary);
    expect(screen.getByRole("region", { name: "Safer system updates" })).toHaveTextContent("Rollback on failed health checks");
  });

  it("presents sustained API scheduling delay as host strain", async () => {
    vi.mocked(api.hostSystemHealth).mockResolvedValue({
      ...hostHealth,
      state: "warning",
      cpu: {
        ...hostHealth.cpu,
        state: "warning",
        eventLoop: {
          ...hostHealth.cpu.eventLoop,
          state: "warning",
          p95Milliseconds: 300,
          maxMilliseconds: 840,
        },
      },
      alerts: [{
        id: "host-system-event-loop-warning",
        metric: "event-loop",
        severity: "warning",
        value: 300,
        unit: "ms",
        threshold: 250,
        startedAt: "2026-07-30T11:58:00.000Z",
        message: "API scheduling is delayed.",
        recommendation: "Check API work.",
      }],
    });
    vi.spyOn(api, "systemUpdateStatus").mockResolvedValue(status);
    render(<I18nProvider><SystemUpdatesPage /></I18nProvider>);

    expect(await screen.findByRole("heading", { name: "The Stugu API is struggling to respond" })).toBeTruthy();
    expect(screen.getByText(/300 ms p95/)).toBeTruthy();
    expect(screen.getByText(/history recovery/)).toBeTruthy();
  });

  it("presents low storage as an actionable host alert", async () => {
    vi.mocked(api.hostSystemHealth).mockResolvedValue({
      ...hostHealth,
      state: "critical",
      storage: {
        ...hostHealth.storage,
        state: "critical",
        availableBytes: 536_870_912,
        usedBytes: 68_182_605_824,
        usedPercent: 99.2,
      },
      alerts: [{
        id: "host-system-storage-critical",
        metric: "storage",
        severity: "critical",
        value: 99.2,
        unit: "%",
        threshold: 95,
        startedAt: "2026-07-30T11:59:00.000Z",
        message: "Storage is low.",
        recommendation: "Free space.",
      }],
    });
    vi.spyOn(api, "systemUpdateStatus").mockResolvedValue(status);
    render(<I18nProvider><SystemUpdatesPage /></I18nProvider>);

    expect(await screen.findByRole("heading", { name: /data volume is running low/i })).toBeTruthy();
    expect(screen.getByText(/Only 512 MiB remains/)).toBeTruthy();
    expect(screen.getByText(/Free space or expand the data volume/)).toBeTruthy();
  });

  it("saves an automatic local-time maintenance window", async () => {
    vi.spyOn(api, "systemUpdateStatus").mockResolvedValue(status);
    const save = vi.spyOn(api, "updateSystemUpdateSettings").mockImplementation(async (settings) => ({
      ...status,
      settings,
      nextUpdateWindowAt: "2026-07-26T00:00:00.000Z",
    }));
    render(<I18nProvider><SystemUpdatesPage /></I18nProvider>);

    await screen.findByText("Safer system updates");
    fireEvent.click(screen.getByText("When should updates install?").closest("summary")!);
    fireEvent.click(screen.getByRole("radio", { name: /Automatic/ }));
    fireEvent.click(screen.getByRole("checkbox", { name: "Mon" }));
    fireEvent.click(screen.getByRole("button", { name: "Save update schedule" }));
    await waitFor(() => expect(save).toHaveBeenCalledWith(expect.objectContaining({
      mode: "automatic",
      updateDays: expect.arrayContaining(["sun", "mon"]),
      timezone: "Europe/Helsinki",
    })));
  });

  it("configures an already-mounted NAS recovery target from System settings", async () => {
    vi.spyOn(api, "systemUpdateStatus").mockResolvedValue(status);
    const save = vi.spyOn(api, "updateSystemStorage").mockImplementation(async (input) => ({
      ...storageStatus,
      operation: {
        id: "27974c49-f62e-4365-9ee7-802c7488557e",
        phase: "queued",
        requestedAt: "2026-08-02T10:00:00.000Z",
        startedAt: null,
        completedAt: null,
        updatedAt: "2026-08-02T10:00:00.000Z",
        detail: "Waiting for the external host agent",
        previous: storageStatus.settings,
        target: input.settings,
      },
    }));
    render(<I18nProvider><SystemUpdatesPage /></I18nProvider>);

    expect(await screen.findByRole("heading", { name: "Storage", level: 2 })).toBeTruthy();
    fireEvent.click(screen.getByText("Configure storage locations"));
    fireEvent.click(screen.getByRole("radio", { name: /Mounted NAS/ }));
    fireEvent.change(screen.getByPlaceholderText("/mnt/stugu/backups"), { target: { value: "/mnt/stugu/nas-backups" } });
    expect(screen.getByRole("heading", { name: "Stugu will migrate this automatically" })).toBeTruthy();
    expect(screen.getByText("Existing verified recovery sets will be copied to the new location automatically.")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Start safe migration" }));

    await waitFor(() => expect(save).toHaveBeenCalledWith({
      settings: {
        timeseries: { kind: "managed", path: null },
        backups: { kind: "nas-path", path: "/mnt/stugu/nas-backups" },
      },
      expectedRevision: "a".repeat(64),
      confirmation: "APPLY_STORAGE",
    }));
    expect(confirmAction).toHaveBeenCalledWith(expect.stringContaining("automatic recovery-set migration"), "Start safe migration", false);
    expect(screen.getByDisplayValue("/mnt/stugu/nas-backups")).toBeTruthy();
  });

  it("explains and queues an automatic telemetry migration", async () => {
    vi.spyOn(api, "systemUpdateStatus").mockResolvedValue(status);
    const save = vi.spyOn(api, "updateSystemStorage").mockImplementation(async (input) => ({
      ...storageStatus,
      operation: {
        id: "27974c49-f62e-4365-9ee7-802c7488557e",
        phase: "queued",
        requestedAt: "2026-08-02T10:00:00.000Z",
        startedAt: null,
        completedAt: null,
        updatedAt: "2026-08-02T10:00:00.000Z",
        detail: "Waiting for the external host agent",
        previous: storageStatus.settings,
        target: input.settings,
      },
    }));
    render(<I18nProvider><SystemUpdatesPage /></I18nProvider>);

    await screen.findByRole("heading", { name: "Storage", level: 2 });
    fireEvent.click(screen.getByText("Configure storage locations"));
    fireEvent.click(screen.getByRole("radio", { name: /Local SSD directory/ }));
    fireEvent.change(screen.getByPlaceholderText("/mnt/stugu/telemetry"), { target: { value: "/mnt/stugu/telemetry" } });

    expect(screen.getByText(/Every telemetry sample will be copied/)).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Start safe migration" }));

    await waitFor(() => expect(save).toHaveBeenCalledWith({
      settings: {
        timeseries: { kind: "local-path", path: "/mnt/stugu/telemetry" },
        backups: { kind: "managed", path: null },
      },
      expectedRevision: "a".repeat(64),
      confirmation: "MOVE_STORAGE",
    }));
    expect(confirmAction).toHaveBeenCalledWith(expect.stringContaining("copy every sample"), "Start safe migration", false);
    expect(screen.getByDisplayValue("/mnt/stugu/telemetry")).toBeTruthy();
  });

  it("disables installation when the external agent is not connected", async () => {
    vi.spyOn(api, "systemUpdateStatus").mockResolvedValue({
      ...status,
      capability: { available: false, runtime: null, agentLastSeenAt: null, reason: "agent-not-connected" },
    });
    render(<I18nProvider><SystemUpdatesPage /></I18nProvider>);

    expect(
      (await screen.findByRole("button", { name: "Update now" }) as HTMLButtonElement).disabled
    ).toBe(true);
    expect(screen.getByText(/update-agent:service:install/)).toBeTruthy();
  });

  it("shows the current step, completed steps, elapsed progress, and activity", async () => {
    vi.spyOn(api, "systemUpdateStatus").mockResolvedValue({
      ...status,
      operation: {
        id: "27974c49-f62e-4365-9ee7-802c7488557e",
        version: "0.6.0",
        tagName: "v0.6.0",
        phase: "backup",
        requestedAt: "2026-07-23T20:01:00.000Z",
        startedAt: "2026-07-23T20:01:02.000Z",
        completedAt: null,
        updatedAt: "2026-07-23T20:01:05.000Z",
        phaseStartedAt: "2026-07-23T20:01:05.000Z",
        detail: "Creating a verified pre-update backup",
        previousVersion: "0.5.0",
        activity: [
          { phase: "queued", at: "2026-07-23T20:01:00.000Z", detail: "Update requested" },
          { phase: "preparing", at: "2026-07-23T20:01:02.000Z", detail: "Checking running services" },
          { phase: "backup", at: "2026-07-23T20:01:05.000Z", detail: "Creating a verified pre-update backup" },
        ],
      },
    });
    render(<I18nProvider><SystemUpdatesPage /></I18nProvider>);

    expect(await screen.findByText("Step 2 of 5")).toBeTruthy();
    expect(screen.getByRole("progressbar", { name: "Step 2 of 5" }).getAttribute("value")).toBe("1");
    expect(screen.getByText("Back up").closest("li")?.getAttribute("aria-current")).toBe("step");
    expect(screen.getByText("Prepare").closest("li")?.classList.contains("complete")).toBe(true);
    expect(screen.getAllByText("Creating a verified pre-update backup")).toHaveLength(2);
  });

  it("queues an ad-hoc update after explicit confirmation", async () => {
    vi.spyOn(api, "systemUpdateStatus").mockResolvedValue(status);
    const install = vi.spyOn(api, "installLatestSystemUpdate").mockResolvedValue({
      ...status,
      operation: {
        id: "27974c49-f62e-4365-9ee7-802c7488557e",
        version: "0.6.0",
        tagName: "v0.6.0",
        phase: "queued",
        requestedAt: "2026-07-23T20:01:00.000Z",
        startedAt: null,
        completedAt: null,
        updatedAt: "2026-07-23T20:01:00.000Z",
        phaseStartedAt: "2026-07-23T20:01:00.000Z",
        detail: "Waiting for the external update agent",
        previousVersion: "0.5.0",
        activity: [{
          phase: "queued",
          at: "2026-07-23T20:01:00.000Z",
          detail: "Update requested; waiting for the external update agent",
        }],
      },
    });
    render(<I18nProvider><SystemUpdatesPage /></I18nProvider>);

    fireEvent.click(await screen.findByRole("button", { name: "Update now" }));
    await waitFor(() => expect(install).toHaveBeenCalledOnce());
    expect(confirmAction).toHaveBeenCalledWith(expect.stringContaining("0.6.0"), "Install update", false);
    expect(await screen.findByText("Waiting for the update agent")).toBeTruthy();
    expect(screen.getByText("Prepare")).toBeTruthy();
    expect(screen.getByText("Live activity")).toBeTruthy();
  });
});
