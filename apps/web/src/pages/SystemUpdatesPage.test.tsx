import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { HostSystemHealth } from "@climate-twin/contracts";
import { api, type SystemUpdateStatus } from "../api";
import { I18nProvider } from "../i18n";
import { SystemUpdatesPage } from "./SystemUpdatesPage";

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
    logicalCores: 4,
    loadAverage: [0.42, 0.35, 0.3],
    temperatureCelsius: 51.2,
    usageThresholds: thresholds,
    temperatureThresholds: { ...thresholds, warningPercent: 75, criticalPercent: 85 },
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
  },
  alerts: [],
};

beforeEach(() => {
  vi.spyOn(api, "hostSystemHealth").mockResolvedValue(hostHealth);
});
afterEach(() => vi.restoreAllMocks());

describe("system updates page", () => {
  it("shows installed/latest versions and readable release notes", async () => {
    vi.spyOn(api, "systemUpdateStatus").mockResolvedValue(status);
    render(<I18nProvider><SystemUpdatesPage /></I18nProvider>);

    expect(await screen.findByText("Safer system updates")).toBeTruthy();
    expect(screen.getByText("v0.5.0")).toBeTruthy();
    expect(screen.getByText("v0.6.0")).toBeTruthy();
    expect(screen.getByText(/Rollback on failed health checks/)).toBeTruthy();
    expect(
      (screen.getByRole("button", { name: "Update now" }) as HTMLButtonElement).disabled
    ).toBe(false);
    expect(screen.getByRole("heading", { name: "System", level: 1 })).toBeTruthy();
    expect(screen.getByText("24.5%")).toBeTruthy();
    fireEvent.click(screen.getByText("Metrics and alert thresholds"));
    expect(screen.getByRole("link", { name: "/api/v1/system/metrics" }).getAttribute("href")).toBe("/api/v1/system/metrics");
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
    fireEvent.click(screen.getByRole("radio", { name: /Automatic/ }));
    fireEvent.click(screen.getByRole("checkbox", { name: "Mon" }));
    fireEvent.click(screen.getByRole("button", { name: "Save update schedule" }));
    await waitFor(() => expect(save).toHaveBeenCalledWith(expect.objectContaining({
      mode: "automatic",
      updateDays: expect.arrayContaining(["sun", "mon"]),
      timezone: "Europe/Helsinki",
    })));
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
    vi.spyOn(window, "confirm").mockReturnValue(true);
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
    expect(window.confirm).toHaveBeenCalledWith(expect.stringContaining("0.6.0"));
    expect(await screen.findByText("Waiting for the update agent")).toBeTruthy();
    expect(screen.getByText("Prepare")).toBeTruthy();
    expect(screen.getByText("Live activity")).toBeTruthy();
  });
});
