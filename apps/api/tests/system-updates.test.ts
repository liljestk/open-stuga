import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  compareSystemVersions,
  SystemUpdateError,
  SystemUpdateService,
} from "../src/system-updates.js";
import { fetchReleaseManifest } from "../src/system-update-release-manifest.js";

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

function releaseManifest(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    schema: "stugu-release-manifest/v1",
    repository: "liljestk/open-stuga",
    version: "0.6.0",
    tagName: "v0.6.0",
    compatibility: {
      updateAgent: 3,
      compose: 2,
    },
    images: {
      api: `ghcr.io/liljestk/open-stuga-api:v0.6.0@sha256:${"a".repeat(64)}`,
      web: `ghcr.io/liljestk/open-stuga-web:v0.6.0@sha256:${"b".repeat(64)}`,
      backup: `ghcr.io/liljestk/open-stuga-backup:v0.6.0@sha256:${"c".repeat(64)}`,
      tapo: `ghcr.io/liljestk/open-stuga-tapo-export-runner:v0.6.0@sha256:${"d".repeat(64)}`,
      updateAgent: `ghcr.io/liljestk/open-stuga-update-agent:v0.6.0@sha256:${"e".repeat(64)}`,
      mqtt: `ghcr.io/liljestk/open-stuga-mqtt:v0.6.0@sha256:${"f".repeat(64)}`,
      nexus433: `ghcr.io/liljestk/open-stuga-nexus433:v0.6.0@sha256:${"0".repeat(64)}`,
    },
    ...overrides,
  };
}

describe("system update service", () => {
  const directories: string[] = [];

  afterEach(() => {
    vi.restoreAllMocks();
    for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
  });

  function directory(): string {
    const value = mkdtempSync(join(tmpdir(), "stugu-system-updates-"));
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
      fetchImpl: vi.fn().mockImplementation(async (input: string | URL | Request) => (
        String(input).endsWith("/stugu-release-manifest-v1.json")
          ? githubResponse(releaseManifest())
          : githubResponse()
      )),
      now: () => now,
    });
    await service.check();

    await expect(service.queueLatest()).rejects.toMatchObject<SystemUpdateError>({
      code: "UPDATE_AGENT_UNAVAILABLE",
      status: 503,
    });

    writeFileSync(join(operationsDirectory, "agent-status.json"), JSON.stringify({
      schema: "stugu-update-agent/v1",
      runtime: "docker",
      agentVersion: "3.0.0",
      updateAgentContract: 3,
      composeContract: 2,
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
      schema: string;
      compatibility: { updateAgent: number; compose: number };
      images: { api: string; web: string; mqtt: string; nexus433: string };
    };
    expect(request.schema).toBe("stugu-system-update-request/v3");
    expect(request.compatibility).toEqual({ updateAgent: 3, compose: 2 });
    expect(request.images).toEqual(expect.objectContaining({
      api: `ghcr.io/liljestk/open-stuga-api:v0.6.0@sha256:${"a".repeat(64)}`,
      web: `ghcr.io/liljestk/open-stuga-web:v0.6.0@sha256:${"b".repeat(64)}`,
      mqtt: `ghcr.io/liljestk/open-stuga-mqtt:v0.6.0@sha256:${"f".repeat(64)}`,
      nexus433: `ghcr.io/liljestk/open-stuga-nexus433:v0.6.0@sha256:${"0".repeat(64)}`,
    }));
  });

  it("reports legacy agent and appliance contracts without queuing an incompatible request", async () => {
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

    writeFileSync(join(operationsDirectory, "agent-status.json"), JSON.stringify({
      schema: "stugu-update-agent/v1",
      runtime: "docker",
      agentVersion: "1.2.0",
      ready: true,
      updatedAt: now.toISOString(),
    }));
    expect(service.status().capability).toEqual({
      available: false,
      runtime: "docker",
      agentLastSeenAt: now.toISOString(),
      reason: "agent-upgrade-required",
    });
    await expect(service.queueLatest()).rejects.toMatchObject<SystemUpdateError>({
      code: "UPDATE_AGENT_UPGRADE_REQUIRED",
      status: 503,
    });

    writeFileSync(join(operationsDirectory, "agent-status.json"), JSON.stringify({
      schema: "stugu-update-agent/v1",
      runtime: "raspberry-pi",
      agentVersion: "3.0.0",
      updateAgentContract: 3,
      composeContract: 2,
      ready: true,
      systemUpdateReason: "appliance-upgrade-required",
      updatedAt: now.toISOString(),
    }));
    expect(service.status().capability).toEqual({
      available: false,
      runtime: "raspberry-pi",
      agentLastSeenAt: now.toISOString(),
      reason: "appliance-upgrade-required",
    });
    await expect(service.queueLatest()).rejects.toMatchObject<SystemUpdateError>({
      code: "APPLIANCE_UPGRADE_REQUIRED",
      status: 503,
    });
    expect(readdirSync(operationsDirectory).some((name) => name.startsWith("request-"))).toBe(false);
  });

  it("fails closed when a release has no compatible immutable manifest", async () => {
    const operationsDirectory = directory();
    const now = new Date("2026-07-23T20:30:00Z");
    const fetchImpl = vi.fn().mockImplementation(async (input: string | URL | Request) => (
      String(input).endsWith("/stugu-release-manifest-v1.json")
        ? githubResponse(releaseManifest({
          compatibility: { updateAgent: 4, compose: 2 },
        }))
        : githubResponse()
    ));
    const service = new SystemUpdateService({
      currentVersion: "0.5.0",
      repository: "liljestk/open-stuga",
      imagePrefix: "ghcr.io/liljestk/open-stuga",
      operationsDirectory,
      fetchImpl,
      now: () => now,
    });
    await service.check();
    writeFileSync(join(operationsDirectory, "agent-status.json"), JSON.stringify({
      schema: "stugu-update-agent/v1",
      runtime: "docker",
      agentVersion: "3.0.0",
      updateAgentContract: 3,
      composeContract: 2,
      ready: true,
      updatedAt: now.toISOString(),
    }));

    await expect(service.queueLatest()).rejects.toMatchObject<SystemUpdateError>({
      code: "RELEASE_MANIFEST_INVALID",
      status: 502,
    });
    expect(readdirSync(operationsDirectory).some((name) => name.startsWith("request-"))).toBe(false);
  });

  it("normalizes legacy agent status for the live progress UI", () => {
    const operationsDirectory = directory();
    writeFileSync(join(operationsDirectory, "status.json"), JSON.stringify({
      id: "27974c49-f62e-4365-9ee7-802c7488557e",
      version: "0.6.0",
      tagName: "v0.6.0",
      phase: "pulling",
      requestedAt: "2026-07-23T20:01:00.000Z",
      startedAt: "2026-07-23T20:01:02.000Z",
      completedAt: null,
      detail: "Pulling Stugu 0.6.0 images",
      previousVersion: "0.5.0",
    }));
    const service = new SystemUpdateService({
      currentVersion: "0.5.0",
      repository: "liljestk/open-stuga",
      imagePrefix: "ghcr.io/liljestk/open-stuga",
      operationsDirectory,
    });

    expect(service.status().operation).toMatchObject({
      phase: "pulling",
      updatedAt: "2026-07-23T20:01:02.000Z",
      phaseStartedAt: "2026-07-23T20:01:02.000Z",
      activity: [{
        phase: "pulling",
        at: "2026-07-23T20:01:02.000Z",
        detail: "Pulling Stugu 0.6.0 images",
      }],
    });
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

  it("skips nonexistent local times during a DST spring-forward gap", () => {
    const service = new SystemUpdateService({
      currentVersion: "0.5.0",
      repository: "liljestk/open-stuga",
      imagePrefix: "ghcr.io/liljestk/open-stuga",
      now: () => new Date("2026-03-28T12:00:00Z"),
    });

    const status = service.updateSettings({
      mode: "automatic",
      includePrereleases: false,
      checkIntervalHours: 24,
      updateTime: "03:30",
      updateDays: ["sun"],
      timezone: "Europe/Helsinki",
    });

    expect(status.nextUpdateWindowAt).toBe("2026-04-05T00:30:00.000Z");
  });

  it("selects the next occurrence of an overlapping local time during DST fall-back", () => {
    const settings = {
      mode: "automatic" as const,
      includePrereleases: false,
      checkIntervalHours: 24 as const,
      updateTime: "03:30",
      updateDays: ["sun"] as const,
      timezone: "Europe/Helsinki",
    };
    const beforeBoth = new SystemUpdateService({
      currentVersion: "0.5.0",
      repository: "liljestk/open-stuga",
      imagePrefix: "ghcr.io/liljestk/open-stuga",
      now: () => new Date("2026-10-25T00:00:00Z"),
    });
    const betweenOccurrences = new SystemUpdateService({
      currentVersion: "0.5.0",
      repository: "liljestk/open-stuga",
      imagePrefix: "ghcr.io/liljestk/open-stuga",
      now: () => new Date("2026-10-25T01:00:00Z"),
    });

    expect(beforeBoth.updateSettings(settings).nextUpdateWindowAt).toBe("2026-10-25T00:30:00.000Z");
    expect(betweenOccurrences.updateSettings(settings).nextUpdateWindowAt).toBe("2026-10-25T01:30:00.000Z");
  });

  it("calculates update windows in a fractional-offset timezone", () => {
    const service = new SystemUpdateService({
      currentVersion: "0.5.0",
      repository: "liljestk/open-stuga",
      imagePrefix: "ghcr.io/liljestk/open-stuga",
      now: () => new Date("2026-07-30T20:00:00Z"),
    });

    const status = service.updateSettings({
      mode: "automatic",
      includePrereleases: false,
      checkIntervalHours: 24,
      updateTime: "03:00",
      updateDays: ["fri"],
      timezone: "Asia/Kathmandu",
    });

    expect(status.nextUpdateWindowAt).toBe("2026-07-30T21:15:00.000Z");
  });

  it("bounds formatter work and caches, invalidates, and expires the next window", () => {
    let now = new Date("2026-03-28T12:00:00Z");
    let formatterCreations = 0;
    let formatCalls = 0;
    const service = new SystemUpdateService({
      currentVersion: "0.5.0",
      repository: "liljestk/open-stuga",
      imagePrefix: "ghcr.io/liljestk/open-stuga",
      now: () => now,
      dateTimeFormatFactory: (timezone) => {
        formatterCreations += 1;
        const formatter = new Intl.DateTimeFormat("en-US-u-ca-gregory-nu-latn", {
          timeZone: timezone,
          weekday: "short",
          year: "numeric",
          month: "2-digit",
          day: "2-digit",
          hour: "2-digit",
          minute: "2-digit",
          second: "2-digit",
          hourCycle: "h23",
        });
        return {
          formatToParts: (date) => {
            formatCalls += 1;
            return formatter.formatToParts(date);
          },
        };
      },
    });

    const initial = service.updateSettings({
      mode: "automatic",
      includePrereleases: false,
      checkIntervalHours: 24,
      updateTime: "03:30",
      updateDays: ["sun"],
      timezone: "Europe/Helsinki",
    });
    expect(initial.nextUpdateWindowAt).toBe("2026-04-05T00:30:00.000Z");
    expect(formatterCreations).toBe(1);
    expect(formatCalls).toBeLessThanOrEqual(13);

    const callsAfterInitialCalculation = formatCalls;
    expect(service.status().nextUpdateWindowAt).toBe(initial.nextUpdateWindowAt);
    expect(formatCalls).toBe(callsAfterInitialCalculation);

    const changed = service.updateSettings({ ...initial.settings, updateTime: "04:30" });
    expect(changed.nextUpdateWindowAt).toBe("2026-03-29T01:30:00.000Z");
    expect(formatCalls).toBeGreaterThan(callsAfterInitialCalculation);
    const callsAfterInvalidation = formatCalls;
    expect(service.status().nextUpdateWindowAt).toBe(changed.nextUpdateWindowAt);
    expect(formatCalls).toBe(callsAfterInvalidation);

    now = new Date(now.getTime() + 60_001);
    expect(service.status().nextUpdateWindowAt).toBe(changed.nextUpdateWindowAt);
    expect(formatCalls).toBeGreaterThan(callsAfterInvalidation);
    expect(formatterCreations).toBe(1);
  });
});

describe("system version comparison", () => {
  it("treats stable builds as newer than prereleases of the same version", () => {
    expect(compareSystemVersions("1.2.3", "1.2.3-beta.2")).toBeGreaterThan(0);
    expect(compareSystemVersions("1.2.4", "1.2.3")).toBeGreaterThan(0);
    expect(compareSystemVersions("1.2.3-beta.10", "1.2.3-beta.2")).toBeGreaterThan(0);
  });
});

describe("release manifest transport bounds", () => {
  const options = {
    currentVersion: "0.5.0",
    repository: "liljestk/open-stuga",
    imagePrefix: "ghcr.io/liljestk/open-stuga",
    release: { version: "0.6.0", tagName: "v0.6.0" },
  };

  it("rejects an oversized declared body before reading it", async () => {
    let cancelled = false;
    const body = new ReadableStream<Uint8Array>({
      cancel: () => { cancelled = true; },
      start: (controller) => controller.enqueue(new Uint8Array([123])),
    });
    const fetchImpl = vi.fn().mockResolvedValue(new Response(body, {
      headers: { "content-length": String(32 * 1024 + 1) },
    }));

    await expect(fetchReleaseManifest({ ...options, fetchImpl }))
      .rejects.toThrow("exceeded the size limit");
    expect(cancelled).toBe(true);
  });

  it("cancels a streamed body when the decoded payload limit is crossed", async () => {
    let pulls = 0;
    let cancelled = false;
    const body = new ReadableStream<Uint8Array>({
      cancel: () => { cancelled = true; },
      pull: (controller) => {
        pulls += 1;
        controller.enqueue(new Uint8Array(20 * 1024));
      },
    });
    const fetchImpl = vi.fn().mockResolvedValue(new Response(body));

    await expect(fetchReleaseManifest({ ...options, fetchImpl }))
      .rejects.toThrow("exceeded the size limit");
    expect(pulls).toBeLessThanOrEqual(3);
    expect(cancelled).toBe(true);
  });
});
