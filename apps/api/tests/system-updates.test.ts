import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  compareSystemVersions,
  SystemUpdateError,
  SystemUpdateService,
} from "../src/system-updates.js";

const releasePayload = [
  {
    tag_name: "v0.6.0",
    name: "Safer updates",
    body: "Adds release controls and rollback.",
    html_url: "https://github.com/liljestk/open-stuga/releases/tag/v0.6.0",
    published_at: "2026-07-23T18:00:00Z",
    prerelease: false,
    draft: false,
  },
  {
    tag_name: "v0.7.0-beta.1",
    name: "Preview",
    body: "Preview notes",
    html_url: "https://github.com/liljestk/open-stuga/releases/tag/v0.7.0-beta.1",
    published_at: "2026-07-23T19:00:00Z",
    prerelease: true,
    draft: false,
  },
  {
    tag_name: "0.9.0",
    name: "Unprefixed tag",
    body: "Not produced by the trusted release workflow.",
    html_url: "https://github.com/liljestk/open-stuga/releases/tag/0.9.0",
    published_at: "2026-07-23T19:30:00Z",
    prerelease: false,
    draft: false,
  },
  {
    tag_name: "nightly",
    html_url: "https://github.com/liljestk/open-stuga/releases/tag/nightly",
    published_at: "2026-07-23T20:00:00Z",
  },
];

function githubResponse(payload: unknown = releasePayload): Response {
  return new Response(JSON.stringify(payload), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}

describe("system update service", () => {
  const directories: string[] = [];

  afterEach(() => {
    vi.restoreAllMocks();
    for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
  });

  function directory(): string {
    const value = mkdtempSync(join(tmpdir(), "stuga-system-updates-"));
    directories.push(value);
    return value;
  }

  it("orders semantic releases and keeps stable as the default channel", async () => {
    const service = new SystemUpdateService({
      currentVersion: "0.5.0",
      repository: "liljestk/open-stuga",
      imagePrefix: "ghcr.io/liljestk/open-stuga",
      operationsDirectory: directory(),
      fetchImpl: vi.fn().mockResolvedValue(githubResponse()),
      now: () => new Date("2026-07-23T20:30:00Z"),
    });

    const stable = await service.check();
    expect(stable).toMatchObject({
      currentVersion: "0.5.0",
      latestVersion: "0.6.0",
      updateAvailable: true,
      checkError: null,
    });
    expect(stable.latestRelease?.notes).toContain("release controls");

    service.updateSettings({ ...stable.settings, includePrereleases: true });
    expect(service.status().latestVersion).toBe("0.7.0-beta.1");
  });

  it("preserves cached release details when GitHub is temporarily unavailable", async () => {
    const fetchImpl = vi.fn()
      .mockResolvedValueOnce(githubResponse())
      .mockResolvedValueOnce(new Response("rate limited", { status: 403 }));
    const service = new SystemUpdateService({
      currentVersion: "0.5.0",
      repository: "liljestk/open-stuga",
      imagePrefix: "ghcr.io/liljestk/open-stuga",
      operationsDirectory: directory(),
      fetchImpl,
    });

    await service.check();
    const degraded = await service.check();
    expect(degraded.latestVersion).toBe("0.6.0");
    expect(degraded.checkError).toContain("HTTP 403");
  });

  it("requires a fresh external-agent heartbeat before queuing an update", async () => {
    const operationsDirectory = directory();
    const now = new Date("2026-07-23T20:30:00Z");
    const service = new SystemUpdateService({
      currentVersion: "0.5.0",
      repository: "liljestk/open-stuga",
      imagePrefix: "ghcr.io/liljestk/open-stuga",
      operationsDirectory,
      fetchImpl: vi.fn().mockResolvedValue(githubResponse()),
      now: () => now,
    });
    await service.check();

    await expect(service.queueLatest()).rejects.toMatchObject<SystemUpdateError>({
      code: "UPDATE_AGENT_UNAVAILABLE",
      status: 503,
    });

    writeFileSync(join(operationsDirectory, "agent-status.json"), JSON.stringify({
      schema: "stuga-update-agent/v1",
      runtime: "docker",
      agentVersion: "0.1.0",
      ready: true,
      updatedAt: now.toISOString(),
    }));
    const queued = await service.queueLatest();
    expect(queued.operation).toMatchObject({
      version: "0.6.0",
      previousVersion: "0.5.0",
      phase: "queued",
    });
    const requestFile = readdirSync(operationsDirectory).find((name) => name.startsWith("request-"));
    const request = JSON.parse(readFileSync(join(operationsDirectory, requestFile!), "utf8")) as {
      images: { api: string; web: string };
    };
    expect(request.images).toEqual(expect.objectContaining({
      api: "ghcr.io/liljestk/open-stuga-api:v0.6.0",
      web: "ghcr.io/liljestk/open-stuga-web:v0.6.0",
    }));
  });

  it("validates schedule settings and calculates the next local maintenance window", () => {
    const service = new SystemUpdateService({
      currentVersion: "0.5.0",
      repository: "liljestk/open-stuga",
      imagePrefix: "ghcr.io/liljestk/open-stuga",
      operationsDirectory: directory(),
      now: () => new Date("2026-07-23T20:30:00Z"),
    });

    const status = service.updateSettings({
      mode: "automatic",
      includePrereleases: false,
      checkIntervalHours: 12,
      updateTime: "03:00",
      updateDays: ["fri"],
      timezone: "Europe/Helsinki",
    });
    expect(status.nextUpdateWindowAt).toBe("2026-07-24T00:00:00.000Z");
    expect(() => service.updateSettings({ ...status.settings, updateTime: "25:90" })).toThrow(/HH:mm/);
    expect(() => service.updateSettings({ ...status.settings, timezone: "Not/AZone" })).toThrow(/IANA/);
  });
});

describe("system version comparison", () => {
  it("treats stable builds as newer than prereleases of the same version", () => {
    expect(compareSystemVersions("1.2.3", "1.2.3-beta.2")).toBeGreaterThan(0);
    expect(compareSystemVersions("1.2.4", "1.2.3")).toBeGreaterThan(0);
    expect(compareSystemVersions("1.2.3-beta.10", "1.2.3-beta.2")).toBeGreaterThan(0);
  });
});
