import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
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
    expect(screen.getByText(/Start the update agent/)).toBeTruthy();
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
        detail: "Waiting for the external update agent",
        previousVersion: "0.5.0",
      },
    });
    render(<I18nProvider><SystemUpdatesPage /></I18nProvider>);

    fireEvent.click(await screen.findByRole("button", { name: "Update now" }));
    await waitFor(() => expect(install).toHaveBeenCalledOnce());
    expect(window.confirm).toHaveBeenCalledWith(expect.stringContaining("0.6.0"));
  });
});
