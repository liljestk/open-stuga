import { mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  normalizedSystemStorageSettings,
  SystemStorageError,
  SystemStorageService,
  systemStorageRevision,
  type SystemStorageSettings,
} from "../src/system-storage.js";

const managed: SystemStorageSettings = {
  timeseries: { kind: "managed", path: null },
  backups: { kind: "managed", path: null },
};

describe("system storage service", () => {
  const directories: string[] = [];
  afterEach(() => {
    for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
  });

  function directory(): string {
    const value = mkdtempSync(join(tmpdir(), "stugu-system-storage-"));
    directories.push(value);
    return value;
  }

  function readyService(operationsDirectory: string): SystemStorageService {
    const now = new Date("2026-08-02T10:00:00.000Z");
    writeFileSync(join(operationsDirectory, "agent-status.json"), JSON.stringify({
      schema: "stugu-update-agent/v1",
      runtime: "raspberry-pi",
      updatedAt: now.toISOString(),
      agentVersion: "3.0.0",
      updateAgentContract: 3,
      composeContract: 2,
      capabilities: ["system-update", "storage-settings"],
      ready: true,
    }));
    writeFileSync(join(operationsDirectory, "storage-status.json"), JSON.stringify({
      schema: "stugu-storage-status/v1",
      settings: managed,
      revision: systemStorageRevision(managed),
      allowedRoots: ["/mnt/stugu"],
      configurationError: null,
      updatedAt: now.toISOString(),
      operation: null,
    }));
    return new SystemStorageService({ operationsDirectory, now: () => now });
  }

  it("requires a fresh agent with the explicit storage capability", () => {
    const operationsDirectory = directory();
    const service = new SystemStorageService({ operationsDirectory });
    expect(service.status()).toMatchObject({
      settings: managed,
      capability: { available: false, reason: "agent-not-connected" },
    });
  });

  it("queues an optimistic, confirmed NAS recovery-target change", () => {
    const operationsDirectory = directory();
    const service = readyService(operationsDirectory);
    const target: SystemStorageSettings = {
      ...managed,
      backups: { kind: "nas-path", path: "/mnt/stugu/nas-backups" },
    };
    const queued = service.queue({
      settings: target,
      expectedRevision: service.status().revision,
      confirmation: "APPLY_STORAGE",
    });
    expect(queued.operation).toMatchObject({ phase: "queued", previous: managed, target });
    expect(readdirSync(operationsDirectory).some((name) => name.startsWith("storage-request-"))).toBe(true);
  });

  it("requires the stronger confirmation for primary telemetry moves", () => {
    const operationsDirectory = directory();
    const service = readyService(operationsDirectory);
    const target: SystemStorageSettings = {
      ...managed,
      timeseries: { kind: "local-path", path: "/mnt/stugu/telemetry" },
    };
    expect(() => service.queue({
      settings: target,
      expectedRevision: service.status().revision,
      confirmation: "APPLY_STORAGE",
    })).toThrow(/MOVE_STORAGE/u);
  });

  it("rejects stale writes, NAS PGDATA, unsafe paths, and nested targets", () => {
    const operationsDirectory = directory();
    const service = readyService(operationsDirectory);
    expect(() => service.queue({
      settings: { ...managed, backups: { kind: "local-path", path: "/mnt/stugu/backups" } },
      expectedRevision: "0".repeat(64),
      confirmation: "APPLY_STORAGE",
    })).toThrowError(SystemStorageError);
    expect(() => normalizedSystemStorageSettings({
      ...managed,
      timeseries: { kind: "nas-path", path: "/mnt/stugu/telemetry" },
    })).toThrow(/cannot use NAS/u);
    expect(() => normalizedSystemStorageSettings({
      ...managed,
      backups: { kind: "local-path", path: "/mnt/stugu/$(touch-pwned)" },
    })).toThrow(/safe absolute/u);
    expect(() => normalizedSystemStorageSettings({
      timeseries: { kind: "local-path", path: "/mnt/stugu/data" },
      backups: { kind: "local-path", path: "/mnt/stugu/data/backups" },
    })).toThrow(/separate directories/u);
    expect(() => service.queue({
      settings: { ...managed, backups: { kind: "local-path", path: "/srv/outside/backups" } },
      expectedRevision: service.status().revision,
      confirmation: "APPLY_STORAGE",
    })).toThrow(/configured host storage roots/u);
  });
});
