import { existsSync, mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { withIntegrationSecretsLock } from "../src/integration-secrets-lock.js";

const directories: string[] = [];

function secretsPath(): string {
  const directory = mkdtempSync(join(tmpdir(), "stugu-secrets-lock-"));
  directories.push(directory);
  return join(directory, "integration-secrets.json");
}

function ageLock(lockPath: string, ageMs: number): void {
  const when = new Date(Date.now() - ageMs);
  utimesSync(lockPath, when, when);
}

afterEach(() => {
  vi.restoreAllMocks();
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

describe("withIntegrationSecretsLock", () => {
  it("reclaims a lock whose recorded owner process no longer exists", () => {
    const path = secretsPath();
    writeFileSync(`${path}.lock`, "2147483646:abandoned\n");
    expect(withIntegrationSecretsLock(path, () => "ran")).toBe("ran");
    expect(existsSync(`${path}.lock`)).toBe(false);
  });

  it("times out behind a fresh lock held by a live process and leaves it in place", () => {
    const path = secretsPath();
    const held = `${process.pid}:held-by-this-test\n`;
    writeFileSync(`${path}.lock`, held);
    const start = Date.now();
    let calls = 0;
    // The first reading sets the deadline; every later one is past it.
    vi.spyOn(Date, "now").mockImplementation(() => start + (calls++ === 0 ? 0 : 6_000));
    const operation = vi.fn();
    expect(() => withIntegrationSecretsLock(path, operation)).toThrow("Timed out waiting to update the integration secrets file");
    expect(operation).not.toHaveBeenCalled();
    expect(readFileSync(`${path}.lock`, "utf8")).toBe(held);
  });

  it("reclaims an empty lock once it is older than the wait timeout", () => {
    const path = secretsPath();
    writeFileSync(`${path}.lock`, "");
    ageLock(`${path}.lock`, 10_000);
    expect(withIntegrationSecretsLock(path, () => "ran")).toBe("ran");
    expect(existsSync(`${path}.lock`)).toBe(false);
  });

  it("reclaims a live process's lock once it is older than the stale-lock limit", () => {
    const path = secretsPath();
    writeFileSync(`${path}.lock`, `${process.pid}:wedged\n`);
    ageLock(`${path}.lock`, 120_000);
    expect(withIntegrationSecretsLock(path, () => "ran")).toBe("ran");
  });

  it("releases the lock when the operation throws", () => {
    const path = secretsPath();
    expect(() => withIntegrationSecretsLock(path, () => { throw new Error("write failed"); })).toThrow("write failed");
    expect(existsSync(`${path}.lock`)).toBe(false);
    expect(withIntegrationSecretsLock(path, () => "next")).toBe("next");
  });
});
