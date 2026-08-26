import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  CURRENT_SYSTEM_UPDATE_REASON_CODE_GROUPS,
  FEED_SCOPED_SYSTEM_UPDATE_REASONS,
  canonicalSystemUpdateReason,
} from "../src/system-update-reasons.js";
import { SystemUpdateService } from "../src/system-updates.js";

const currentReasonMappings = Object.entries(CURRENT_SYSTEM_UPDATE_REASON_CODE_GROUPS)
  .flatMap(([canonicalReason, codes]) => codes.map((code) => [code, canonicalReason] as const));
const currentMappedCodes = new Set(currentReasonMappings.map(([code]) => code));
const repositoryRoot = fileURLToPath(new URL("../../../", import.meta.url));

function upperCaseStringTokens(source: string): string[] {
  return [...source.matchAll(/"([A-Z][A-Z0-9_]{2,})"/gu)].map((match) => match[1]!);
}

describe("system update reason normalization", () => {
  const directories: string[] = [];

  afterEach(() => {
    for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
  });

  function operationsDirectory(): string {
    const directory = mkdtempSync(join(tmpdir(), "stugu-update-reasons-"));
    directories.push(directory);
    return directory;
  }

  function serviceWithBridgeError(code: string): SystemUpdateService {
    const directory = operationsDirectory();
    const now = new Date("2026-08-12T09:00:00.000Z");
    writeFileSync(join(directory, "agent-status.json"), JSON.stringify({
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
    }));
    const statusDirectory = join(directory, "host-bridge", "status");
    mkdirSync(statusDirectory, { recursive: true });
    writeFileSync(join(statusDirectory, "status.json"), JSON.stringify({
      schema: "stugu-host-update-bridge-status/v1",
      bridgeVersion: "1.0.0",
      available: true,
      currentGeneration: 15,
      updatedAt: now.toISOString(),
      requestId: null,
      workflowId: null,
      requestOperation: null,
      phase: "recovery-needed",
      detail: "The native updater stopped before completion",
      operationId: null,
      targetVersion: null,
      targetGeneration: null,
      targetSlot: null,
      manifestSha256: null,
      error: { code, message: "The native updater stopped before completion" },
    }));
    return new SystemUpdateService({
      currentVersion: "0.39.3",
      repository: "liljestk/open-stuga",
      imagePrefix: "ghcr.io/liljestk/open-stuga",
      operationsDirectory: directory,
      fetchImpl: vi.fn(),
      now: () => now,
    });
  }

  it.each(currentReasonMappings)("maps current updater code %s to %s", (emittedCode, canonicalReason) => {
    expect(canonicalSystemUpdateReason(emittedCode)).toBe(canonicalReason);
  });

  it("keeps the current emitted-code inventory unambiguous", () => {
    const emittedCodes = currentReasonMappings.map(([code]) => code);
    expect(emittedCodes).toHaveLength(106);
    expect(new Set(emittedCodes).size).toBe(emittedCodes.length);
  });

  it("covers codes emitted by the native updater, bridge, coordinator, and workflow", () => {
    const nativeDirectory = join(repositoryRoot, "deploy", "rpi", "host-updater", "stugu_host_updater");
    const nativeSource = readdirSync(nativeDirectory)
      .filter((name) => name.endsWith(".py"))
      .map((name) => readFileSync(join(nativeDirectory, name), "utf8"))
      .join("\n");
    const constructorCodes = [...nativeSource.matchAll(
      /\b(?:UpdaterError|PreflightError)\(\s*"([A-Z][A-Z0-9_]+)"/gu,
    )].map((match) => match[1]!);
    const projectionSources = [
      join(nativeDirectory, "bridge.py"),
      join(nativeDirectory, "coordinator.py"),
      join(repositoryRoot, "scripts", "stugu-update-agent", "system-update-workflow.mjs"),
    ].map((path) => readFileSync(path, "utf8")).join("\n");
    const sourceCodes = new Set([
      ...constructorCodes,
      ...upperCaseStringTokens(projectionSources).filter((code) => code !== "RESTART_AND_INSTALL"),
      "ACTIVATION_NOT_QUALIFIED",
      "CONTRACT_INVALID",
      "TRUST_VERIFICATION_FAILED",
    ]);
    expect([...sourceCodes].filter((code) => !currentMappedCodes.has(code))).toEqual([]);
  });

  it("scopes remote-feed faults away from machine trust faults", () => {
    // Expired or unreachable feed metadata pauses host updates only; the
    // appliance is healthy and container updates never read the TUF chain.
    expect(canonicalSystemUpdateReason("TRUST_VERIFICATION_FAILED")).toBe("feed-trust-stale");
    expect(canonicalSystemUpdateReason("METADATA_FETCH_FAILED")).toBe("metadata-unavailable");
    expect(FEED_SCOPED_SYSTEM_UPDATE_REASONS.has("feed-trust-stale")).toBe(true);
    expect(FEED_SCOPED_SYSTEM_UPDATE_REASONS.has("metadata-unavailable")).toBe(true);
    // Machine trust faults must never be treated as feed-scoped.
    for (const code of ["CLOCK_ROLLBACK", "TIME_UNTRUSTED", "HOST_GENERATION_EQUIVOCATION"]) {
      const reason = canonicalSystemUpdateReason(code);
      expect(reason).toBe("trust-verification-failed");
      expect(FEED_SCOPED_SYSTEM_UPDATE_REASONS.has(reason!)).toBe(false);
    }
  });

  it.each([
    ["SOURCE_MANIFEST_UNBOUND", "recovery-required"],
    ["LEGACY_SOURCE_MANIFEST_UNBOUND", "recovery-required"],
    ["SLOT_READBACK_FAILED", "verification-failed"],
    ["TRUST_VERIFICATION_FAILED", "feed-trust-stale"],
  ])("projects bridge code %s through the API as %s", (bridgeCode, expectedReason) => {
    expect(serviceWithBridgeError(bridgeCode).status().host).toMatchObject({
      phase: "recovery-needed",
      reason: expectedReason,
    });
  });

  it("preserves canonical reasons and fails closed on unknown future codes", () => {
    expect(canonicalSystemUpdateReason("mutation-busy")).toBe("mutation-busy");
    expect(canonicalSystemUpdateReason("verification-failed")).toBe("verification-failed");
    expect(canonicalSystemUpdateReason("FUTURE_SAFETY_STATE")).toBe("FUTURE_SAFETY_STATE");
    expect(canonicalSystemUpdateReason("constructor")).toBe("constructor");
    expect(canonicalSystemUpdateReason("toString")).toBe("toString");
    expect(canonicalSystemUpdateReason("__proto__")).toBe("__proto__");
    expect(canonicalSystemUpdateReason(null)).toBeNull();
  });
});
