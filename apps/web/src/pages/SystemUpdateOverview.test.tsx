import { render, screen, within } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import type { SystemUpdateStatus } from "../api";
import { I18nProvider } from "../i18n";
import { SystemUpdateOverview } from "./SystemUpdateOverview";

const capability = {
  available: true,
  runtime: "raspberry-pi",
  agentLastSeenAt: "2026-08-05T12:03:30.000Z",
  reason: "ready",
} as const;

const status: SystemUpdateStatus = {
  schema: "stugu-system-updates/v2",
  revision: 14,
  currentVersion: "0.35.6",
  latestVersion: "0.31.0",
  updateAvailable: false,
  latestRelease: {
    version: "0.31.0",
    tagName: "v0.31.0",
    name: "Stugu 0.31.0",
    notes: "Latest stable release notes.",
    publishedAt: "2026-08-03T00:26:00.000Z",
    url: "https://github.com/liljestk/stugu-releases/releases/tag/v0.31.0",
    prerelease: false,
  },
  releases: [],
  lastCheckedAt: "2026-08-05T12:03:30.000Z",
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
  capability,
  operation: null,
  application: {
    currentVersion: "0.35.6",
    latestVersion: "0.31.0",
    updateAvailable: false,
    capability,
    operation: null,
  },
  host: {
    supported: true,
    phase: "complete",
    reason: null,
    detail: "Host update completed successfully",
    currentVersion: null,
    currentGeneration: 14,
    activeSlot: "a",
    updateAvailable: false,
    targetVersion: null,
    targetGeneration: 14,
    targetDigest: `sha256:${"d".repeat(64)}`,
    updatedAt: "2026-08-05T12:03:30.000Z",
    readyToRestart: null,
  },
  workflow: null,
};

describe("SystemUpdateOverview", () => {
  it("labels an older release as stable context and hides redundant host target data", async () => {
    render(
      <I18nProvider>
        <SystemUpdateOverview
          status={status}
          busy={null}
          streamState="live"
          onCheck={vi.fn()}
          onUpdateEverything={vi.fn()}
          onActivateHost={vi.fn()}
          onCancelHost={vi.fn()}
          onRetryApplication={vi.fn()}
        />
      </I18nProvider>,
    );

    const application = (await screen.findByRole("heading", { name: "Application", level: 3 })).closest("article")!;
    expect(within(application).getByText("Latest stable")).toBeTruthy();
    expect(within(application).getByText("v0.31.0")).toBeTruthy();
    expect(within(application).queryByText("Available")).toBeNull();

    const host = screen.getByRole("heading", { name: "Host system", level: 3 }).closest("article")!;
    expect(within(host).queryByText("Target")).toBeNull();
    expect(within(host).queryByText("Available")).toBeNull();
  });
});
