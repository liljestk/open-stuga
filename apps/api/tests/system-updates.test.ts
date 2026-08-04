import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
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

function writeAgentHeartbeat(
  operationsDirectory: string,
  now: Date,
  overrides: Record<string, unknown> = {},
): void {
  writeFileSync(join(operationsDirectory, "agent-status.json"), JSON.stringify({
    schema: "stugu-update-agent/v1",
    runtime: "raspberry-pi",
    agentVersion: "3.1.0",
    updateAgentContract: 3,
    composeContract: 2,
    capabilities: ["system-update", "unified-host-update-v1"],
    ready: true,
    detail: null,
    systemUpdateReason: null,
    updatedAt: now.toISOString(),
    ...overrides,
  }));
}

function writeBridgeStatus(
  operationsDirectory: string,
  now: Date,
  overrides: Record<string, unknown> = {},
): void {
  const statusDirectory = join(operationsDirectory, "host-bridge", "status");
  mkdirSync(statusDirectory, { recursive: true });
  writeFileSync(join(statusDirectory, "status.json"), JSON.stringify({
    schema: "stugu-host-update-bridge-status/v1",
    bridgeVersion: "1.0.0",
    available: true,
    currentGeneration: 5,
    updatedAt: now.toISOString(),
    requestId: null,
    workflowId: null,
    requestOperation: null,
    phase: "available",
    detail: "Stugu 0.6.0 is available",
    operationId: null,
    targetVersion: "0.6.0",
    targetGeneration: 6,
    targetSlot: null,
    manifestSha256: "9".repeat(64),
    error: null,
    ...overrides,
  }));
}

function workflowStatus(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    schema: "stugu-system-update-workflow-status/v1",
    revision: 7,
    id: "11111111-1111-4111-8111-111111111111",
    action: "update-everything",
    phase: "awaiting-restart",
    requestedAt: "2026-07-23T20:00:00.000Z",
    startedAt: "2026-07-23T20:00:01.000Z",
    updatedAt: "2026-07-23T20:05:00.000Z",
    completedAt: null,
    detail: "Host update is ready to restart",
    backup: {
      phase: "verified",
      verified: true,
      completedAt: "2026-07-23T20:01:00.000Z",
      receipt: { manifestSha256: "8".repeat(64), verifiedAt: "2026-07-23T20:01:00.000Z" },
    },
    host: {
      targetVersion: "0.6.0",
      targetGeneration: 6,
      manifestSha256: "9".repeat(64),
      operationId: "22222222-2222-4222-8222-222222222222",
      phase: "ready-to-restart",
    },
    app: null,
    cancellationEligible: true,
    recoveryRequired: false,
    error: null,
    ...overrides,
  };
}

function failedApplicationWorkflow(): Record<string, unknown> {
  return workflowStatus({
    revision: 12,
    phase: "application-failed",
    detail: "Application verification failed",
    host: {
      targetVersion: "0.6.0",
      targetGeneration: 6,
      manifestSha256: "9".repeat(64),
      operationId: "22222222-2222-4222-8222-222222222222",
      phase: "complete",
    },
    app: {
      targetVersion: "0.6.0",
      operationId: "33333333-3333-4333-8333-333333333333",
      phase: "failed",
    },
    cancellationEligible: false,
    error: { code: "APPLICATION_UPDATE_FAILED", message: "Application verification failed" },
  });
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

  it("preserves a fresh not-ready agent reason instead of reporting a disconnect", () => {
    const operationsDirectory = directory();
    const now = new Date("2026-07-23T20:30:00Z");
    writeAgentHeartbeat(operationsDirectory, now, {
      runtime: "docker",
      ready: false,
      detail: "A host update is active",
      systemUpdateReason: "host-update-active",
    });
    const service = new SystemUpdateService({
      currentVersion: "0.5.0",
      repository: "liljestk/open-stuga",
      imagePrefix: "ghcr.io/liljestk/open-stuga",
      operationsDirectory,
      now: () => now,
    });

    expect(service.status().capability).toEqual({
      available: false,
      runtime: "docker",
      agentLastSeenAt: now.toISOString(),
      reason: "host-update-active",
      detail: "A host update is active",
    });
  });

  it("serializes concurrent app-only install requests into one durable request", async () => {
    const operationsDirectory = directory();
    const now = new Date("2026-07-23T20:30:00Z");
    const fetchImpl = vi.fn().mockImplementation(async (input: string | URL | Request) => (
      String(input).endsWith("/stugu-release-manifest-v1.json")
        ? githubResponse(releaseManifest())
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
    writeAgentHeartbeat(operationsDirectory, now, { runtime: "docker" });

    const statuses = await Promise.all([service.queueLatest(), service.queueLatest(), service.queueLatest()]);
    expect(new Set(statuses.map((status) => status.operation?.id)).size).toBe(1);
    expect(readdirSync(operationsDirectory).filter((name) => name.startsWith("request-"))).toHaveLength(1);
    expect(fetchImpl.mock.calls.filter(([input]) => String(input).endsWith("/stugu-release-manifest-v1.json"))).toHaveLength(1);
  });

  it("serializes install against update-everything so exactly one request family wins", async () => {
    for (const first of ["install", "update-everything"] as const) {
      const operationsDirectory = directory();
      const now = new Date("2026-07-23T20:30:00Z");
      let markManifestStarted!: () => void;
      let releaseManifestResponse!: (response: Response) => void;
      const manifestStarted = new Promise<void>((resolve) => { markManifestStarted = resolve; });
      const manifestResponse = new Promise<Response>((resolve) => { releaseManifestResponse = resolve; });
      const fetchImpl = vi.fn().mockImplementation(async (input: string | URL | Request) => {
        if (String(input).endsWith("/stugu-release-manifest-v1.json")) {
          markManifestStarted();
          return manifestResponse;
        }
        return githubResponse();
      });
      const service = new SystemUpdateService({
        currentVersion: "0.5.0",
        repository: "liljestk/open-stuga",
        imagePrefix: "ghcr.io/liljestk/open-stuga",
        operationsDirectory,
        fetchImpl,
        now: () => now,
      });
      writeAgentHeartbeat(operationsDirectory, now);
      writeBridgeStatus(operationsDirectory, now);
      await service.check();

      const updateEverything = () => service.requestOperation({
        action: "update-everything",
        expectedRevision: 0,
      });
      const firstRequest = first === "install" ? service.queueLatest() : updateEverything();
      await manifestStarted;
      const secondRequest = first === "install" ? updateEverything() : service.queueLatest();
      const outcomes = Promise.allSettled([firstRequest, secondRequest]);
      releaseManifestResponse(githubResponse(releaseManifest()));
      const [firstOutcome, secondOutcome] = await outcomes;

      expect(firstOutcome.status).toBe("fulfilled");
      expect(secondOutcome.status).toBe("rejected");
      if (secondOutcome.status === "rejected") {
        expect(secondOutcome.reason).toMatchObject<SystemUpdateError>({
          code: first === "install" ? "UPDATE_IN_PROGRESS" : "SYSTEM_UPDATE_IN_PROGRESS",
          status: 409,
        });
      }
      const appRequests = readdirSync(operationsDirectory).filter((name) => /^request-.*\.json$/.test(name));
      const workflowInbox = join(operationsDirectory, "system-workflow-requests");
      const workflowRequests = existsSync(workflowInbox) ? readdirSync(workflowInbox) : [];
      expect(appRequests).toHaveLength(first === "install" ? 1 : 0);
      expect(workflowRequests).toHaveLength(first === "update-everything" ? 1 : 0);
    }
  });

  it("queues one strictly bound update-everything workflow with the complete v3 app request", async () => {
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
    writeAgentHeartbeat(operationsDirectory, now);
    writeBridgeStatus(operationsDirectory, now);
    await service.check();

    await service.requestOperation({ action: "update-everything", expectedRevision: 0 });
    const inbox = join(operationsDirectory, "system-workflow-requests");
    const names = readdirSync(inbox);
    expect(names).toHaveLength(1);
    const request = JSON.parse(readFileSync(join(inbox, names[0]!), "utf8")) as Record<string, unknown>;
    expect(Object.keys(request).sort()).toEqual(["action", "app", "host", "id", "requestedAt", "schema"].sort());
    expect(request).toMatchObject({
      schema: "stugu-system-update-workflow-request/v1",
      action: "update-everything",
      host: { version: "0.6.0", generation: 6, manifestSha256: "9".repeat(64) },
      app: {
        schema: "stugu-system-update-request/v3",
        version: "0.6.0",
        previousVersion: "0.5.0",
        releaseManifestSchema: "stugu-release-manifest/v1",
        compatibility: { updateAgent: 3, compose: 2 },
      },
    });
    expect(names[0]).toBe(`request-${request.id}.json`);
    expect(readdirSync(operationsDirectory).some((name) => name.startsWith("request-") && name.endsWith(".json"))).toBe(false);
  });

  it("keeps the independently bound application target null when it already matches the host release", async () => {
    const operationsDirectory = directory();
    const now = new Date("2026-07-23T20:30:00Z");
    const fetchImpl = vi.fn().mockResolvedValue(githubResponse());
    const service = new SystemUpdateService({
      currentVersion: "0.6.0",
      repository: "liljestk/open-stuga",
      imagePrefix: "ghcr.io/liljestk/open-stuga",
      operationsDirectory,
      fetchImpl,
      now: () => now,
    });
    writeAgentHeartbeat(operationsDirectory, now);
    writeBridgeStatus(operationsDirectory, now);
    await service.check();

    await service.requestOperation({ action: "update-everything", expectedRevision: 0 });
    const inbox = join(operationsDirectory, "system-workflow-requests");
    const request = JSON.parse(readFileSync(join(inbox, readdirSync(inbox)[0]!), "utf8")) as Record<string, unknown>;
    expect(request.app).toBeNull();
    expect(fetchImpl.mock.calls.some(([input]) => String(input).endsWith("/stugu-release-manifest-v1.json"))).toBe(false);
  });

  it("gates unified updates on the exact agent capability while preserving app-only installs", async () => {
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
    writeAgentHeartbeat(operationsDirectory, now, { capabilities: ["system-update"] });
    writeBridgeStatus(operationsDirectory, now, { currentGeneration: 6, targetGeneration: 7 });
    await service.check();

    expect(service.status().host).toMatchObject({ supported: false, reason: "agent-upgrade-required" });
    await expect(service.requestOperation({ action: "update-everything", expectedRevision: 0 }))
      .rejects.toMatchObject<SystemUpdateError>({ code: "UPDATE_AGENT_UPGRADE_REQUIRED", status: 503 });
    await expect(service.queueLatest()).resolves.toMatchObject({ operation: { version: "0.6.0", phase: "queued" } });
  });

  it("requires exact workflow and bridge identity before restart and writes the narrow bridge intent", async () => {
    const operationsDirectory = directory();
    const now = new Date("2026-07-23T20:30:00Z");
    writeAgentHeartbeat(operationsDirectory, now);
    writeFileSync(join(operationsDirectory, "workflow-status.json"), JSON.stringify(workflowStatus()));
    writeBridgeStatus(operationsDirectory, now, {
      phase: "ready-to-restart",
      operationId: "22222222-2222-4222-8222-222222222222",
      workflowId: "11111111-1111-4111-8111-111111111111",
      requestOperation: "stage",
    });
    const service = new SystemUpdateService({
      currentVersion: "0.5.0",
      repository: "liljestk/open-stuga",
      imagePrefix: "ghcr.io/liljestk/open-stuga",
      operationsDirectory,
      now: () => now,
    });
    const base = {
      action: "activate-host" as const,
      expectedRevision: 7,
      workflowId: "11111111-1111-4111-8111-111111111111",
      hostOperationId: "22222222-2222-4222-8222-222222222222",
      targetVersion: "0.6.0",
      targetGeneration: 6,
      targetDigest: "9".repeat(64),
      confirmation: "RESTART_AND_INSTALL" as const,
    };

    await expect(service.requestOperation({ ...base, targetDigest: "a".repeat(64) }))
      .rejects.toMatchObject<SystemUpdateError>({ code: "HOST_UPDATE_BINDING_MISMATCH", status: 409 });
    await service.requestOperation(base);
    const requests = join(operationsDirectory, "host-bridge", "requests");
    const requestName = readdirSync(requests)[0]!;
    const request = JSON.parse(readFileSync(join(requests, requestName), "utf8")) as Record<string, unknown>;
    expect(Object.keys(request).sort()).toEqual([
      "schema", "id", "requestedAt", "operation", "workflowId", "confirmation", "expectedOperationId",
      "expectedVersion", "expectedGeneration", "expectedManifestSha256",
    ].sort());
    expect(request).toMatchObject({
      schema: "stugu-host-update-bridge-request/v1",
      operation: "activate",
      workflowId: base.workflowId,
      confirmation: "RESTART_AND_INSTALL",
      expectedOperationId: base.hostOperationId,
      expectedVersion: base.targetVersion,
      expectedGeneration: base.targetGeneration,
      expectedManifestSha256: base.targetDigest,
    });
  });

  it("cancels only the exact cancellable host operation and rejects stale revisions", async () => {
    const operationsDirectory = directory();
    const now = new Date("2026-07-23T20:30:00Z");
    writeAgentHeartbeat(operationsDirectory, now);
    writeFileSync(join(operationsDirectory, "workflow-status.json"), JSON.stringify(workflowStatus()));
    writeBridgeStatus(operationsDirectory, now, {
      phase: "ready-to-restart",
      operationId: "22222222-2222-4222-8222-222222222222",
      workflowId: "11111111-1111-4111-8111-111111111111",
      requestOperation: "stage",
    });
    const service = new SystemUpdateService({
      currentVersion: "0.5.0",
      repository: "liljestk/open-stuga",
      imagePrefix: "ghcr.io/liljestk/open-stuga",
      operationsDirectory,
      now: () => now,
    });
    const request = {
      action: "cancel-host" as const,
      expectedRevision: 7,
      workflowId: "11111111-1111-4111-8111-111111111111",
      hostOperationId: "22222222-2222-4222-8222-222222222222",
      targetVersion: "0.6.0",
      targetGeneration: 6,
      targetDigest: "9".repeat(64),
    };

    await expect(service.requestOperation({ ...request, expectedRevision: 6 }))
      .rejects.toMatchObject<SystemUpdateError>({ code: "SYSTEM_UPDATE_REVISION_CONFLICT", status: 409 });
    await service.requestOperation(request);
    const requests = join(operationsDirectory, "host-bridge", "requests");
    const intent = JSON.parse(readFileSync(join(requests, readdirSync(requests)[0]!), "utf8")) as Record<string, unknown>;
    expect(intent.operation).toBe("cancel");
    expect(intent).not.toHaveProperty("confirmation");
    expect(() => service.requestOperation({ ...request, unexpected: true })).toThrow(/exact host identity bindings/);
  });

  it.each([
    { name: "the compatible agent is ready", heartbeat: {} },
    {
      name: "the bound workflow owns the mutation lock",
      heartbeat: {
        ready: false,
        detail: "The unified system update owns the shared mutation lock",
        systemUpdateReason: "system-update-workflow-active",
      },
    },
  ])("queues only the minimal retry intent after a bound application failure when $name", async ({ heartbeat }) => {
    const operationsDirectory = directory();
    const now = new Date("2026-07-23T20:30:00Z");
    writeAgentHeartbeat(operationsDirectory, now, heartbeat);
    const failed = failedApplicationWorkflow();
    writeFileSync(join(operationsDirectory, "workflow-status.json"), JSON.stringify(failed));
    const service = new SystemUpdateService({
      currentVersion: "0.5.0",
      repository: "liljestk/open-stuga",
      imagePrefix: "ghcr.io/liljestk/open-stuga",
      operationsDirectory,
      now: () => now,
    });

    await service.requestOperation({
      action: "retry-application",
      expectedRevision: 12,
      workflowId: "11111111-1111-4111-8111-111111111111",
    });
    const inbox = join(operationsDirectory, "system-workflow-requests");
    const name = readdirSync(inbox)[0]!;
    const request = JSON.parse(readFileSync(join(inbox, name), "utf8")) as Record<string, unknown>;
    expect(Object.keys(request).sort()).toEqual(["schema", "id", "action", "requestedAt", "workflowId"].sort());
    expect(request).toMatchObject({
      schema: "stugu-system-update-workflow-request/v1",
      action: "retry-application",
      workflowId: "11111111-1111-4111-8111-111111111111",
    });
  });

  it.each([
    {
      name: "a host update owns the mutation lock",
      heartbeat: { ready: false, systemUpdateReason: "host-update-active", detail: "A host update is active" },
      expectedCode: "UPDATE_AGENT_BUSY",
    },
    {
      name: "workflow recovery is required",
      heartbeat: {
        ready: false,
        systemUpdateReason: "system-update-recovery-needed",
        detail: "Recover the interrupted workflow first",
      },
      expectedCode: "UPDATE_AGENT_BUSY",
    },
    {
      name: "the agent is generically busy",
      heartbeat: { ready: false, systemUpdateReason: null, detail: "Another mutation is active" },
      expectedCode: "UPDATE_AGENT_BUSY",
    },
    {
      name: "the agent is disconnected",
      heartbeat: null,
      expectedCode: "UPDATE_AGENT_UNAVAILABLE",
    },
    {
      name: "the heartbeat is stale",
      heartbeat: { updatedAt: "2026-07-23T20:27:59.000Z" },
      expectedCode: "UPDATE_AGENT_UNAVAILABLE",
    },
    {
      name: "the request names a different workflow",
      heartbeat: { ready: false, systemUpdateReason: "system-update-workflow-active" },
      workflowId: "44444444-4444-4444-8444-444444444444",
      expectedCode: "SYSTEM_UPDATE_WORKFLOW_MISMATCH",
    },
    {
      name: "the request revision is stale",
      heartbeat: { ready: false, systemUpdateReason: "system-update-workflow-active" },
      expectedRevision: 11,
      expectedCode: "SYSTEM_UPDATE_REVISION_CONFLICT",
    },
    {
      name: "the agent is not running on the Raspberry Pi host",
      heartbeat: {
        runtime: "docker",
        ready: false,
        systemUpdateReason: "system-update-workflow-active",
      },
      expectedCode: "HOST_UPDATE_UNSUPPORTED",
    },
    {
      name: "the agent lacks the unified update capability",
      heartbeat: {
        capabilities: ["system-update"],
        ready: false,
        systemUpdateReason: "system-update-workflow-active",
      },
      expectedCode: "UPDATE_AGENT_UPGRADE_REQUIRED",
    },
    {
      name: "the agent contract is incompatible",
      heartbeat: {
        updateAgentContract: 2,
        ready: false,
        systemUpdateReason: "system-update-workflow-active",
      },
      expectedCode: "UPDATE_AGENT_UPGRADE_REQUIRED",
    },
  ])("rejects application retry when $name", async ({
    heartbeat,
    workflowId = "11111111-1111-4111-8111-111111111111",
    expectedRevision = 12,
    expectedCode,
  }) => {
    const operationsDirectory = directory();
    const now = new Date("2026-07-23T20:30:00Z");
    if (heartbeat) writeAgentHeartbeat(operationsDirectory, now, heartbeat);
    writeFileSync(
      join(operationsDirectory, "workflow-status.json"),
      JSON.stringify(failedApplicationWorkflow()),
    );
    const service = new SystemUpdateService({
      currentVersion: "0.5.0",
      repository: "liljestk/open-stuga",
      imagePrefix: "ghcr.io/liljestk/open-stuga",
      operationsDirectory,
      now: () => now,
    });

    await expect(service.requestOperation({
      action: "retry-application",
      expectedRevision,
      workflowId,
    })).rejects.toMatchObject<SystemUpdateError>({ code: expectedCode });
    expect(existsSync(join(operationsDirectory, "system-workflow-requests"))).toBe(false);
  });

  it("keeps targetless failed workflow recovery visible but rejects malformed target objects", () => {
    const operationsDirectory = directory();
    const failed = workflowStatus({
      revision: 0,
      phase: "failed",
      completedAt: "2026-07-23T20:05:00.000Z",
      detail: "Workflow request was invalid",
      backup: { phase: "failed", verified: false, completedAt: null, receipt: null },
      host: null,
      cancellationEligible: false,
      error: { code: "WORKFLOW_REQUEST_INVALID", message: "Workflow request was invalid" },
    });
    writeFileSync(join(operationsDirectory, "workflow-status.json"), JSON.stringify(failed));
    const service = new SystemUpdateService({
      currentVersion: "0.5.0",
      repository: "liljestk/open-stuga",
      imagePrefix: "ghcr.io/liljestk/open-stuga",
      operationsDirectory,
    });

    expect(service.status().workflow).toMatchObject({
      phase: "failed",
      targets: { hostVersion: null, hostGeneration: null, hostDigest: null },
      reason: "WORKFLOW_REQUEST_INVALID",
    });
    writeFileSync(join(operationsDirectory, "workflow-status.json"), JSON.stringify({
      ...failed,
      host: { targetVersion: "unknown", targetGeneration: null, manifestSha256: null, operationId: null, phase: "failed" },
    }));
    expect(service.status().workflow).toBeNull();
  });

  it("fails closed on a stale host bridge projection", () => {
    const operationsDirectory = directory();
    const now = new Date("2026-07-23T20:30:00Z");
    writeAgentHeartbeat(operationsDirectory, now);
    writeBridgeStatus(operationsDirectory, now, { updatedAt: "2026-07-23T20:00:00.000Z" });
    const service = new SystemUpdateService({
      currentVersion: "0.5.0",
      repository: "liljestk/open-stuga",
      imagePrefix: "ghcr.io/liljestk/open-stuga",
      operationsDirectory,
      now: () => now,
    });

    expect(service.status().host).toMatchObject({
      supported: false,
      phase: "unavailable",
      reason: "bridge-not-connected",
      updateAvailable: false,
    });
    writeBridgeStatus(operationsDirectory, now, { manifestSha256: null });
    expect(service.status().host).toMatchObject({
      supported: false,
      reason: "bridge-not-connected",
      updateAvailable: false,
    });
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
