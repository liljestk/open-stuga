import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { HostSystemHealth } from "@climate-twin/contracts";
import { api, type SystemStorageStatus, type SystemUpdateStatus } from "../api";
import { confirmAction } from "../components/ConfirmationProvider";
import { I18nProvider } from "../i18n";
import { SystemUpdatesPage } from "./SystemUpdatesPage";

class FakeSystemUpdateEventSource {
  static latest: FakeSystemUpdateEventSource | null = null;
  readonly listeners = new Map<string, EventListener>();
  onopen: ((event: Event) => void) | null = null;
  onerror: ((event: Event) => void) | null = null;
  onmessage: ((event: MessageEvent<string>) => void) | null = null;
  closed = false;

  constructor(readonly url: string, readonly options?: EventSourceInit) {
    FakeSystemUpdateEventSource.latest = this;
  }

  addEventListener(type: string, listener: EventListenerOrEventListenerObject): void {
    if (typeof listener === "function") this.listeners.set(type, listener);
  }

  close(): void {
    this.closed = true;
  }

  emit(type: string, data: unknown): void {
    this.listeners.get(type)?.(new MessageEvent(type, { data: JSON.stringify(data) }));
  }
}

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

const binding = {
  operationId: "80d65f28-33cc-4424-b72f-47be89c275ab",
  targetVersion: "0.35.0",
  targetGeneration: 3,
  targetDigest: `sha256:${"d".repeat(64)}`,
  targetSlot: "b",
} as const;

const v2Status: SystemUpdateStatus = {
  ...status,
  schema: "stugu-system-updates/v2",
  revision: 7,
  application: {
    currentVersion: status.currentVersion,
    latestVersion: status.latestVersion,
    updateAvailable: true,
    capability: status.capability,
    operation: null,
  },
  host: {
    supported: true,
    phase: "available",
    reason: null,
    detail: null,
    currentVersion: "0.34.2",
    currentGeneration: 2,
    activeSlot: "a",
    updateAvailable: true,
    targetVersion: binding.targetVersion,
    targetGeneration: binding.targetGeneration,
    targetDigest: binding.targetDigest,
    updatedAt: "2026-08-04T16:00:00.000Z",
    readyToRestart: null,
  },
  workflow: null,
};

const currentV2Status: SystemUpdateStatus = {
  ...v2Status,
  latestVersion: status.currentVersion,
  updateAvailable: false,
  latestRelease: null,
  application: {
    ...v2Status.application!,
    latestVersion: status.currentVersion,
    updateAvailable: false,
  },
  host: {
    ...v2Status.host!,
    phase: "current",
    updateAvailable: false,
    targetVersion: null,
    targetGeneration: null,
    targetDigest: null,
  },
};

const blockedSummaryCases: ReadonlyArray<{ name: string; componentName: string; blockedStatus: SystemUpdateStatus }> = [
  {
    name: "the host updater is unavailable",
    componentName: "Host system",
    blockedStatus: {
      ...currentV2Status,
      host: {
        ...currentV2Status.host!,
        supported: false,
        phase: "unavailable",
        reason: "bridge-not-connected",
        detail: "The host update bridge is not connected",
      },
    },
  },
  {
    name: "the application update agent is offline",
    componentName: "Application",
    blockedStatus: {
      ...currentV2Status,
      capability: {
        available: false,
        runtime: "raspberry-pi",
        agentLastSeenAt: null,
        reason: "agent-not-connected",
      },
      application: {
        ...currentV2Status.application!,
        capability: {
          available: false,
          runtime: "raspberry-pi",
          agentLastSeenAt: null,
          reason: "agent-not-connected",
        },
      },
    },
  },
];

const stagedStatus: SystemUpdateStatus = {
  ...v2Status,
  revision: 12,
  host: {
    ...v2Status.host!,
    phase: "ready-to-restart",
    readyToRestart: binding,
  },
  workflow: {
    id: "65ee172f-8ec3-4ff1-a52b-3468b33c5791",
    revision: 12,
    action: "update-everything",
    phase: "awaiting-restart",
    requestedAt: "2026-08-04T16:00:00.000Z",
    updatedAt: "2026-08-04T16:04:00.000Z",
    completedAt: null,
    detail: "The verified host update is prepared",
    hostOperationId: binding.operationId,
    targets: {
      applicationVersion: "0.6.0",
      hostVersion: binding.targetVersion,
      hostGeneration: binding.targetGeneration,
      hostDigest: binding.targetDigest,
    },
    steps: [
      { id: "backup", state: "complete" },
      { id: "stage-host", state: "complete" },
      { id: "restart-host", state: "waiting" },
    ],
    canCancel: true,
    recoveryRequired: false,
    reason: null,
  },
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
afterEach(() => {
  FakeSystemUpdateEventSource.latest = null;
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("system updates page", () => {
  it("treats a non-Pi host as managed separately instead of an action item", async () => {
    vi.spyOn(api, "systemUpdateStatus").mockResolvedValue({
      ...currentV2Status,
      host: {
        ...currentV2Status.host!,
        supported: false,
        phase: "unavailable",
        reason: "not-raspberry-pi",
        detail: "Host updates are available only on Stugu Raspberry Pi appliances",
        updateAvailable: false,
        targetVersion: null,
        targetGeneration: null,
        targetDigest: null,
      },
    });
    render(<I18nProvider><SystemUpdatesPage /></I18nProvider>);

    const hostCard = (await screen.findByRole("heading", { name: "Host system", level: 3 })).closest("article")!;
    expect(within(hostCard).getByText("Managed separately")).toBeTruthy();
    expect(within(hostCard).getByText(/managed outside Stugu/)).toBeTruthy();
    expect(within(hostCard).queryByText("Action needed")).toBeNull();
    expect(screen.getByRole("heading", { name: "Stugu is up to date", level: 2 })).toBeTruthy();
  });

  it.each(blockedSummaryCases)("fails the overall summary closed when $name", async ({ blockedStatus, componentName }) => {
    vi.spyOn(api, "systemUpdateStatus").mockResolvedValue(blockedStatus);
    render(<I18nProvider><SystemUpdatesPage /></I18nProvider>);

    const heading = await screen.findByRole("heading", { name: "Update information needs attention", level: 2 });
    expect(heading.closest("section")?.classList.contains("attention")).toBe(true);
    expect(screen.getByText("A trusted target is incomplete, so Stugu will not start the update.")).toBeTruthy();
    expect(screen.queryByRole("heading", { name: "Stugu is up to date", level: 2 })).toBeNull();
    const component = screen.getByRole("heading", { name: componentName, level: 3 }).closest("article")!;
    expect(within(component).getByText("Action needed")).toBeTruthy();
  });

  it("keeps completed update history out of the default view", async () => {
    vi.spyOn(api, "systemUpdateStatus").mockResolvedValue({
      ...v2Status,
      operation: {
        id: "27974c49-f62e-4365-9ee7-802c7488557e",
        version: "0.4.0",
        tagName: "v0.4.0",
        phase: "complete",
        requestedAt: "2026-07-01T10:00:00.000Z",
        startedAt: "2026-07-01T10:00:01.000Z",
        completedAt: "2026-07-01T10:01:00.000Z",
        updatedAt: "2026-07-01T10:01:00.000Z",
        phaseStartedAt: "2026-07-01T10:00:50.000Z",
        detail: "Legacy update completed",
        previousVersion: "0.3.0",
        activity: [{ phase: "complete", at: "2026-07-01T10:01:00.000Z", detail: "Legacy update completed" }],
      },
    });
    render(<I18nProvider><SystemUpdatesPage /></I18nProvider>);

    await screen.findByRole("heading", { name: "System", level: 1 });
    expect(screen.queryByText("Legacy update completed")).toBeNull();
  });

  it("shows installed/latest versions and readable release notes", async () => {
    vi.spyOn(api, "systemUpdateStatus").mockResolvedValue(status);
    render(<I18nProvider><SystemUpdatesPage /></I18nProvider>);

    expect(await screen.findByText("Safer system updates")).toBeTruthy();
    expect(screen.getByText("v0.5.0")).toBeTruthy();
    expect(screen.getByText("v0.6.0")).toBeTruthy();
    expect(
      (screen.getByRole("button", { name: "Update application" }) as HTMLButtonElement).disabled
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

  it("hydrates after an initial API failure when live updates return after reboot", async () => {
    vi.stubGlobal("EventSource", FakeSystemUpdateEventSource);
    const loadStatus = vi.spyOn(api, "systemUpdateStatus")
      .mockRejectedValueOnce(new Error("The host is restarting"))
      .mockResolvedValue(v2Status);
    render(<I18nProvider><SystemUpdatesPage /></I18nProvider>);

    expect(await screen.findByRole("heading", { name: "System updates could not be loaded" })).toBeTruthy();
    expect(FakeSystemUpdateEventSource.latest?.url).toBe("/api/v1/system/updates/events");

    await act(async () => {
      FakeSystemUpdateEventSource.latest?.emit("system-update", v2Status);
    });

    await waitFor(() => expect(loadStatus).toHaveBeenCalledTimes(2));
    expect(await screen.findByRole("button", { name: "Update everything" })).toBeTruthy();
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

    expect(await screen.findByText(/trusted update service is not connected/)).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Update application" })).toBeNull();
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

    fireEvent.click(await screen.findByRole("button", { name: "Update application" }));
    await waitFor(() => expect(install).toHaveBeenCalledOnce());
    expect(confirmAction).toHaveBeenCalledWith(expect.stringContaining("0.6.0"), "Install update", false);
    expect(await screen.findByText("Waiting for the update agent")).toBeTruthy();
    expect(screen.getByText("Prepare")).toBeTruthy();
    expect(screen.getByText("Live activity")).toBeTruthy();
  });

  it.each([
    {
      name: "an application-only Pi update",
      label: "Update application",
      route: "application",
      projectedStatus: {
        ...v2Status,
        capability: { ...v2Status.capability, runtime: "raspberry-pi" as const },
        application: {
          ...v2Status.application!,
          capability: { ...v2Status.capability, runtime: "raspberry-pi" as const },
          updateAvailable: true,
        },
        host: {
          ...v2Status.host!,
          updateAvailable: false,
          targetVersion: null,
          targetGeneration: null,
          targetDigest: null,
        },
      },
    },
    {
      name: "a host-only update",
      label: "Update host system",
      route: "workflow",
      projectedStatus: {
        ...v2Status,
        updateAvailable: false,
        application: { ...v2Status.application!, updateAvailable: false },
      },
    },
    {
      name: "a combined application and host update",
      label: "Update everything",
      route: "workflow",
      projectedStatus: v2Status,
    },
  ])("routes $name through the correct updater", async ({ label, route, projectedStatus }) => {
    vi.spyOn(api, "systemUpdateStatus").mockResolvedValue(projectedStatus);
    const install = vi.spyOn(api, "installLatestSystemUpdate").mockResolvedValue(projectedStatus);
    const operate = vi.spyOn(api, "operateSystemUpdate").mockResolvedValue(projectedStatus);
    render(<I18nProvider><SystemUpdatesPage /></I18nProvider>);

    fireEvent.click(await screen.findByRole("button", { name: label }));

    if (route === "application") {
      await waitFor(() => expect(install).toHaveBeenCalledOnce());
      expect(operate).not.toHaveBeenCalled();
    } else {
      await waitFor(() => expect(operate).toHaveBeenCalledWith({
        action: "update-everything",
        expectedRevision: projectedStatus.revision,
      }));
      expect(install).not.toHaveBeenCalled();
    }
  });

  it("starts one revision-bound application and host update sequence", async () => {
    vi.spyOn(api, "systemUpdateStatus").mockResolvedValue(v2Status);
    const operate = vi.spyOn(api, "operateSystemUpdate").mockResolvedValue({
      ...v2Status,
      revision: 8,
      workflow: {
        ...stagedStatus.workflow!,
        revision: 8,
        phase: "preparing",
        hostOperationId: null,
        steps: [{ id: "backup", state: "active" }],
        canCancel: false,
      },
    });
    render(<I18nProvider><SystemUpdatesPage /></I18nProvider>);

    fireEvent.click(await screen.findByRole("button", { name: "Update everything" }));

    await waitFor(() => expect(operate).toHaveBeenCalledWith({
      action: "update-everything",
      expectedRevision: 7,
    }));
    expect(confirmAction).not.toHaveBeenCalled();
    expect(await screen.findByRole("heading", { name: "Preparing a safe update" })).toBeTruthy();
  });

  it("confirms the exact staged host identity before restart and restores focus", async () => {
    vi.spyOn(api, "systemUpdateStatus").mockResolvedValue(stagedStatus);
    const operate = vi.spyOn(api, "operateSystemUpdate").mockResolvedValue(stagedStatus);
    render(<I18nProvider><SystemUpdatesPage /></I18nProvider>);

    const restart = await screen.findByRole("button", { name: "Restart and install" });
    restart.focus();
    fireEvent.click(restart);
    const dialog = screen.getByRole("dialog");
    expect(within(dialog).getByText(/host v0.35.0 \(generation 3\)/)).toBeTruthy();
    fireEvent.click(within(dialog).getByText("Prepared update identity"));
    expect(within(dialog).getByText(binding.operationId)).toBeTruthy();
    expect(within(dialog).getByText(binding.targetDigest)).toBeTruthy();
    fireEvent.click(within(dialog).getByRole("button", { name: "Restart and install" }));

    await waitFor(() => expect(operate).toHaveBeenCalledWith({
      action: "activate-host",
      expectedRevision: 12,
      workflowId: stagedStatus.workflow!.id,
      hostOperationId: binding.operationId,
      targetVersion: binding.targetVersion,
      targetGeneration: binding.targetGeneration,
      targetDigest: binding.targetDigest,
      confirmation: "RESTART_AND_INSTALL",
    }));
    await waitFor(() => expect(restart).toHaveFocus());
  });

  it("cancels only the exact prepared host operation", async () => {
    vi.spyOn(api, "systemUpdateStatus").mockResolvedValue(stagedStatus);
    const operate = vi.spyOn(api, "operateSystemUpdate").mockResolvedValue({
      ...v2Status,
      revision: 13,
    });
    render(<I18nProvider><SystemUpdatesPage /></I18nProvider>);

    fireEvent.click(await screen.findByRole("button", { name: "Cancel prepared update" }));

    await waitFor(() => expect(operate).toHaveBeenCalledWith({
      action: "cancel-host",
      expectedRevision: 12,
      workflowId: stagedStatus.workflow!.id,
      hostOperationId: binding.operationId,
      targetVersion: binding.targetVersion,
      targetGeneration: binding.targetGeneration,
      targetDigest: binding.targetDigest,
    }));
  });

  it("never restarts a standalone staged host without its verified workflow", async () => {
    vi.spyOn(api, "systemUpdateStatus").mockResolvedValue({
      ...stagedStatus,
      workflow: null,
    });
    render(<I18nProvider><SystemUpdatesPage /></I18nProvider>);

    expect(await screen.findByRole("heading", { name: "Update information needs attention", level: 2 })).toBeTruthy();
    expect((await screen.findAllByText(/prepared outside the current verified workflow/)).length).toBeGreaterThan(0);
    expect(screen.queryByRole("button", { name: "Restart and install" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Update everything" })).toBeNull();
  });

  it("puts recovery ahead of restart and update actions", async () => {
    vi.spyOn(api, "systemUpdateStatus").mockResolvedValue({
      ...stagedStatus,
      workflow: {
        ...stagedStatus.workflow!,
        phase: "recovery-needed",
        recoveryRequired: true,
        reason: "recovery-required",
      },
    });
    render(<I18nProvider><SystemUpdatesPage /></I18nProvider>);

    const recovery = await screen.findByRole("button", { name: "View recovery" });
    expect(screen.queryByRole("button", { name: "Restart and install" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Update everything" })).toBeNull();
    fireEvent.click(recovery);
    expect(screen.getByText("The host reported a recovery state. Do not start another update yet.")).toBeTruthy();
  });

  it.each(["failed", "returned"] as const)("allows a fresh revision-bound workflow after a safe terminal %s state", async (phase) => {
    const nextWorkflowId = "9c2d4f18-6ef4-4ac5-a127-f28ee7f74443";
    const terminalStatus: SystemUpdateStatus = {
      ...v2Status,
      revision: 18,
      workflow: {
        ...stagedStatus.workflow!,
        revision: 18,
        phase,
        hostOperationId: null,
        canCancel: false,
        recoveryRequired: false,
        reason: null,
      },
    };
    vi.spyOn(api, "systemUpdateStatus").mockResolvedValue(terminalStatus);
    const operate = vi.spyOn(api, "operateSystemUpdate").mockResolvedValue({
      ...terminalStatus,
      revision: 0,
      workflow: {
        ...terminalStatus.workflow!,
        id: nextWorkflowId,
        revision: 0,
        phase: "preparing",
        requestedAt: "2026-08-04T17:00:00.000Z",
        updatedAt: "2026-08-04T17:00:00.000Z",
      },
    });
    render(<I18nProvider><SystemUpdatesPage /></I18nProvider>);

    fireEvent.click(await screen.findByRole("button", { name: "Update everything" }));

    await waitFor(() => expect(operate).toHaveBeenCalledWith({
      action: "update-everything",
      expectedRevision: 18,
    }));
    expect(await screen.findByRole("heading", { name: "Preparing a safe update" })).toBeTruthy();
  });

  it("accepts a new low-revision workflow after a terminal workflow and advances it while reconnecting", async () => {
    vi.stubGlobal("EventSource", FakeSystemUpdateEventSource);
    const nextWorkflowId = "9c2d4f18-6ef4-4ac5-a127-f28ee7f74443";
    const terminalStatus: SystemUpdateStatus = {
      ...v2Status,
      revision: 18,
      workflow: {
        ...stagedStatus.workflow!,
        revision: 18,
        phase: "complete",
        completedAt: "2026-08-04T16:30:00.000Z",
        hostOperationId: null,
        canCancel: false,
        recoveryRequired: false,
        reason: null,
      },
    };
    const preparingStatus: SystemUpdateStatus = {
      ...v2Status,
      revision: 0,
      workflow: {
        ...stagedStatus.workflow!,
        id: nextWorkflowId,
        revision: 0,
        phase: "preparing",
        requestedAt: "2026-08-04T17:00:00.000Z",
        updatedAt: "2026-08-04T17:00:00.000Z",
        completedAt: null,
        hostOperationId: null,
        steps: [{ id: "backup", state: "active" }],
        canCancel: false,
      },
    };
    const readyStatus: SystemUpdateStatus = {
      ...stagedStatus,
      revision: 1,
      workflow: {
        ...preparingStatus.workflow!,
        revision: 1,
        phase: "awaiting-restart",
        updatedAt: "2026-08-04T17:04:00.000Z",
        hostOperationId: binding.operationId,
        steps: [
          { id: "backup", state: "complete" },
          { id: "stage-host", state: "complete" },
          { id: "restart-host", state: "waiting" },
        ],
        canCancel: true,
      },
    };
    const loadStatus = vi.spyOn(api, "systemUpdateStatus")
      .mockResolvedValueOnce(terminalStatus)
      .mockResolvedValue(readyStatus);
    render(<I18nProvider><SystemUpdatesPage /></I18nProvider>);

    expect(await screen.findByRole("button", { name: "Update everything" })).toBeTruthy();
    await act(async () => {
      FakeSystemUpdateEventSource.latest?.onerror?.(new Event("error"));
      FakeSystemUpdateEventSource.latest?.emit("system-update", preparingStatus);
    });

    await waitFor(() => expect(loadStatus).toHaveBeenCalledTimes(2));
    expect(await screen.findByRole("button", { name: "Restart and install" })).toBeTruthy();
  });

  it("retries only the application after its post-host update fails", async () => {
    const failedStatus: SystemUpdateStatus = {
      ...v2Status,
      revision: 16,
      host: {
        ...v2Status.host!,
        phase: "complete",
        updateAvailable: false,
        readyToRestart: null,
      },
      workflow: {
        ...stagedStatus.workflow!,
        revision: 16,
        phase: "application-failed",
        canCancel: false,
        detail: "The host is healthy; the application update can be retried",
      },
    };
    vi.spyOn(api, "systemUpdateStatus").mockResolvedValue(failedStatus);
    const operate = vi.spyOn(api, "operateSystemUpdate").mockResolvedValue({
      ...failedStatus,
      revision: 17,
      workflow: { ...failedStatus.workflow!, revision: 17, phase: "application-queueing" },
    });
    render(<I18nProvider><SystemUpdatesPage /></I18nProvider>);

    fireEvent.click(await screen.findByRole("button", { name: "Retry application update" }));

    await waitFor(() => expect(operate).toHaveBeenCalledWith({
      action: "retry-application",
      expectedRevision: 16,
      workflowId: failedStatus.workflow!.id,
    }));
    expect(screen.queryByRole("button", { name: "Update application" })).toBeNull();
  });
});
