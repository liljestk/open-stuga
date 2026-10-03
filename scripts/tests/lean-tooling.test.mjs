import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { parseArguments as parseVerification } from "../verify-local.mjs";
import {
  diagnoseEvidence,
  hostKeyFingerprint,
  main as doctorMain,
  parseArguments as parseDoctor,
  sanitizeSshLogLine,
} from "../rpi-doctor.mjs";
import {
  exactManifestDigest,
  parseArguments as parseReleaseVerification,
} from "../release-verify.mjs";
import { affectedTestPlan } from "../tooling/affected-tests.mjs";
import { validateApplicationReleaseTarget } from "../tooling/application-release-target.mjs";
import {
  releaseBodySha256,
  unexpectedGitHubAssets,
  validateDraftEvidence,
  validateGitHubRelease,
} from "../tooling/draft-release.mjs";
import {
  anonymousRegistryEnvironment,
  inspectMultiPlatformImage,
  multiPlatformImageEvidence,
} from "../tooling/container-registry.mjs";
import {
  FULL_CI_APPLE_GATE_IDS,
  FULL_CI_APPLE_PLATFORM_LIMITATION,
  FULL_CI_REQUIRED_GATE_IDS,
  RELEASE_DOCTOR_RECEIPT_MAX_AGE_MS,
  RELEASE_VERIFICATION_RECEIPT_MAX_AGE_MS,
  localVerificationCacheKey,
  validateCompatibilityProof,
  validateDoctorReceipt,
  validateLocalVerificationReceipt,
  validateReleaseVerificationReceipt,
} from "../tooling/receipt-contracts.mjs";
import { cacheKey } from "../tooling/runtime.mjs";
import { targetSelectorSha256 } from "../tooling/ssh-target.mjs";

const hex = (character = "a") => character.repeat(64);

function fullCiChecks({ includeApple = false, versionGate = "VERSION_BASE" } = {}) {
  return [
    versionGate,
    ...FULL_CI_REQUIRED_GATE_IDS,
    ...(includeApple ? FULL_CI_APPLE_GATE_IDS : []),
  ].map((id) => ({ id, label: id, status: "passed", durationMs: 100 }));
}

function draftAssets(version, factoryUploaded = false) {
  const names = [
    "stugu-release-manifest-v1.json",
    "stugu-release-compatibility-proof-v1.json",
    "stugu-release-compatibility-proof-v1.json.sha256",
    `stugu-nexus433-corresponding-source-${version}.tar.gz`,
    `stugu-nexus433-corresponding-source-${version}.tar.gz.sha256`,
    `stugu-${version}-full-verification.json`,
    `stugu-${version}-full-verification.json.sha256`,
    ...(factoryUploaded ? [
      `stugu-rpi4-${version}.img.zst`,
      `stugu-rpi4-${version}-factory.sha256`,
    ] : []),
  ];
  return Object.fromEntries(names.map((name, index) => [name, hex(String((index % 9) + 1))]));
}

function githubRelease(draft, body = "Reviewed release notes") {
  return {
    name: draft.title,
    tagName: "v1.2.3",
    body,
    isDraft: true,
    isPrerelease: draft.channel === "preview",
    url: "https://example.test/releases/v1.2.3",
    assets: Object.entries(draft.assets).map(([name, digest], index) => ({
      name,
      digest: `sha256:${digest}`,
      apiUrl: `https://api.github.test/repos/example/releases/assets/${index + 1}`,
    })),
  };
}

function releaseVerificationReceipt(verifiedAt) {
  const image = (name) => ({
    reference: `ghcr.io/example/${name}:v1.2.3@sha256:${hex("1")}`,
    indexDigest: `sha256:${hex("1")}`,
    anonymousRead: true,
    amd64ManifestDigest: `sha256:${hex("2")}`,
    amd64ConfigDigest: `sha256:${hex("3")}`,
    amd64DescriptorClosureSha256: hex("4"),
    amd64ProvenanceSha256: hex("5"),
    arm64ManifestDigest: `sha256:${hex("6")}`,
    arm64ConfigDigest: `sha256:${hex("7")}`,
    arm64DescriptorClosureSha256: hex("8"),
    arm64ProvenanceSha256: hex("9"),
  });
  return {
    schema: "stugu-release-verification/v1",
    result: "passed",
    verifiedAt,
    commit: "a".repeat(40),
    worktreeSha256: hex("a"),
    version: "1.2.3",
    tagName: "v1.2.3",
    repository: "example/releases",
    channel: "stable",
    cacheKey: hex("b"),
    inputs: Object.fromEntries([
      "manifestSha256", "fullCiReceiptSha256", "compatibilityProofSha256",
      "draftPreparationSha256", "visualReceiptSha256", "targetReceiptSha256",
      "lockfileSha256", "configurationSha256",
    ].map((key) => [key, hex("c")])),
    draft: {
      title: "Stugu 1.2.3",
      bodySha256: releaseBodySha256("Reviewed release notes"),
      channel: "stable",
      factoryUploaded: false,
      assets: draftAssets("1.2.3"),
    },
    images: Object.fromEntries([
      "api", "web", "backup", "tapo", "updateAgent", "mqtt", "nexus433",
    ].map((name) => [name, image(name)])),
    target: {
      selectorSha256: hex("d"),
      sshHostKeyFingerprint: `SHA256:${"A".repeat(30)}`,
      machineIdSha256: hex("e"),
      hardwareFingerprint: `sha256:${hex("f")}`,
    },
    deployment: null,
  };
}

test("GitHub draft evidence rejects changed notes and incomplete or stale compliance assets", () => {
  const draft = {
    title: "Stugu 1.2.3",
    bodySha256: releaseBodySha256("Reviewed release notes\n"),
    channel: "stable",
    factoryUploaded: false,
    assets: draftAssets("1.2.3"),
  };
  validateDraftEvidence(draft, "1.2.3");
  assert.equal(validateGitHubRelease(githubRelease(draft), draft, {
    tagName: "v1.2.3",
  }).name, draft.title);

  assert.throws(
    () => validateGitHubRelease(githubRelease(draft, "Changed release notes"), draft),
    /notes differ/u,
  );

  const nexusName = "stugu-nexus433-corresponding-source-1.2.3.tar.gz";
  const missingNexus = githubRelease(draft);
  missingNexus.assets = missingNexus.assets.filter((asset) => asset.name !== nexusName);
  assert.throws(() => validateGitHubRelease(missingNexus, draft), /asset set differs/u);

  const wrongNexus = githubRelease(draft);
  wrongNexus.assets.find((asset) => asset.name === nexusName).digest = `sha256:${hex("f")}`;
  assert.throws(() => validateGitHubRelease(wrongNexus, draft), /digest differs.*nexus433/u);

  const staleFactory = githubRelease(draft);
  staleFactory.assets.push({
    name: "stugu-rpi4-1.2.3.img.zst",
    digest: `sha256:${hex("e")}`,
    apiUrl: "https://api.github.test/repos/example/releases/assets/99",
  });
  assert.deepEqual(unexpectedGitHubAssets(staleFactory, draft.assets).map((asset) => asset.name), [
    "stugu-rpi4-1.2.3.img.zst",
  ]);
  assert.throws(() => validateGitHubRelease(staleFactory, draft), /asset set differs/u);

  assert.throws(
    () => validateDraftEvidence({
      ...draft,
      assets: {
        ...draft.assets,
        "stugu-rpi4-1.2.3.img.zst": hex("d"),
        "stugu-rpi4-1.2.3-factory.sha256": hex("c"),
      },
    }, "1.2.3"),
    /unexpectedly include/u,
  );
});

test("canonical command options reject ambiguous modes and unsafe targets", () => {
  assert.deepEqual(parseVerification(["--fast"]), { help: false, baseRef: "origin/main", mode: "fast" });
  assert.deepEqual(parseVerification(["--full", "--base-ref", "release/base"]), {
    help: false, baseRef: "release/base", mode: "full",
  });
  assert.throws(() => parseVerification(["--fast", "--full"]), /exactly one/u);

  assert.deepEqual(parseDoctor(["--target", "operator@stugu.local", "--deep", "--json"]), {
    deep: true, help: false, json: "-", target: "operator@stugu.local",
  });
  assert.throws(() => parseDoctor(["--target", "-oProxyCommand=bad"]), /without spaces or options/u);

  assert.deepEqual(
    parseReleaseVerification([
      "--target", "stugu.local",
      "--target-receipt", "doctor.json",
      "--visual-receipt", "visual.json",
      "--channel", "preview",
    ]),
    {
      baseRef: "origin/main",
      channel: "preview",
      help: false,
      target: "stugu.local",
      targetReceipt: "doctor.json",
      visualReceipt: "visual.json",
    },
  );
});

test("fast verification selects bounded affected tests", () => {
  const web = affectedTestPlan(["apps/web/src/App.tsx"], "a".repeat(40));
  assert.equal(web.length, 1);
  assert.deepEqual(web[0].args.slice(0, 4), ["test", "-w", "@climate-twin/web", "--"]);
  assert.ok(web[0].args.includes("--changed"));
  assert.ok(web[0].args.includes("--passWithNoTests"));

  const tooling = affectedTestPlan(["scripts/release-verify.mjs"], "a".repeat(40));
  assert.ok(tooling.some((step) => step.args.join(" ").includes("test:lean-tooling")));
  assert.ok(tooling.some((step) => step.args.join(" ").includes("test:rpi-ota")));
});

function healthyEvidence() {
  return {
    schema: "stugu-rpi-doctor-evidence/v1",
    collectedAt: "2026-08-09T10:00:00Z",
    durationMs: 800,
    deep: false,
    identity: {
      machineIdSha256: hex("1"),
      hostnameSha256: hex("2"),
      hardwareFingerprint: `sha256:${hex("3")}`,
    },
    system: {
      cpuCount: 4,
      loadAverage: [0.4, 0.3, 0.2],
      memoryTotalBytes: 8_000,
      memoryAvailableBytes: 4_000,
      rootTotalBytes: 10_000,
      rootAvailableBytes: 6_000,
    },
    service: {
      available: true,
      ActiveState: "active",
      SubState: "running",
      NRestarts: "0",
      ExecMainStatus: "0",
    },
    docker: {
      available: true,
      containers: [{ name: "stugu-api-1", state: "running", health: "healthy", restartCount: 0 }],
      stats: [],
    },
    health: {
      available: true,
      status: "ok",
      database: "ready",
      systemVersion: "1.2.3",
      eventLoopLagMs: 1.5,
      telemetryArchive: { enabled: true, required: false, phase: "ready", caughtUp: true, timescaleAvailable: true },
    },
    database: {
      available: true,
      queues: {
        alertEvaluation: { count: 0, capped: false },
        notifications: { count: 0, capped: false, deadLettered: 0 },
        tapoExports: { count: 0, capped: false, needsAttention: 0 },
      },
      integrations: {
        homeAssistantMetrics: 2,
        tpLinkMetrics: 3,
        heatPumpConnections: 1,
        connectedDevices: 1,
      },
    },
    updater: { available: true, hardwareFingerprint: `sha256:${hex("3")}`, status: { phase: "idle" } },
    versions: { host: "1.2.3", release: { version: "1.2.3" } },
  };
}

test("Pi diagnosis is stable, concise, and target-bound", () => {
  const evidence = healthyEvidence();
  const diagnosis = diagnoseEvidence(evidence);
  assert.equal(diagnosis.result, "healthy");
  assert.ok(diagnosis.checks.every((check) => check.status === "pass"));
  assert.equal(diagnosis.checks.at(0).id, "IDENTITY");

  const selectorSha256 = targetSelectorSha256("operator@stugu.local");
  const receipt = {
    schema: "stugu-rpi-doctor/v1",
    result: diagnosis.result,
    mode: "default",
    collectedAt: evidence.collectedAt,
    durationMs: evidence.durationMs,
    target: { selectorSha256, sshHostKeyFingerprint: `SHA256:${"A".repeat(30)}` },
    identity: evidence.identity,
    summary: diagnosis.summary,
    checks: diagnosis.checks,
    evidenceSha256: cacheKey(evidence),
  };
  assert.equal(validateDoctorReceipt(receipt, { selectorSha256, requireHealthy: true }), receipt);
  assert.equal(validateDoctorReceipt(receipt, {
    selectorSha256,
    requireHealthy: true,
    maximumAgeMs: RELEASE_DOCTOR_RECEIPT_MAX_AGE_MS,
    now: "2026-08-09T10:15:00.000Z",
  }), receipt);
  assert.throws(
    () => validateDoctorReceipt(receipt, {
      maximumAgeMs: RELEASE_DOCTOR_RECEIPT_MAX_AGE_MS,
      now: "2026-08-09T10:15:00.001Z",
    }),
    /receipt is stale/u,
  );
  assert.throws(
    () => validateDoctorReceipt(receipt, {
      maximumAgeMs: RELEASE_DOCTOR_RECEIPT_MAX_AGE_MS,
      now: "2026-08-09T09:54:59.999Z",
    }),
    /too far in the future/u,
  );
  assert.throws(
    () => validateDoctorReceipt(receipt, { selectorSha256: hex("f") }),
    /target does not match/u,
  );
  assert.throws(
    () => validateDoctorReceipt({
      ...receipt,
      checks: receipt.checks.map((item, index) => index === 0 ? { ...item, status: "fail" } : item),
    }),
    /contradicts its checks/u,
  );
  assert.throws(
    () => validateDoctorReceipt({ ...receipt, checks: receipt.checks.slice(0, -1) }),
    /gate ids are incomplete or non-canonical/u,
  );
  assert.equal(
    hostKeyFingerprint(`debug1: Server host key: ssh-ed25519 SHA256:${"B".repeat(30)}`),
    `SHA256:${"B".repeat(30)}`,
  );
  assert.equal(sanitizeSshLogLine("remote evidence", "stdout"), null);
  assert.equal(sanitizeSshLogLine("debug: connected to 192.168.1.20", "stderr"), null);
  assert.equal(
    sanitizeSshLogLine("ssh: Connection refused from 192.168.1.20", "stderr"),
    "ssh: Connection refused from [REDACTED IP]",
  );
  assert.equal(sanitizeSshLogLine("debug: identity file C:\\Users\\person\\.ssh\\id_ed25519", "stderr"), null);
});

test("application release accepts only an isolated idle host-feed warning", () => {
  const makeReceipt = (evidence) => {
    const diagnosis = diagnoseEvidence(evidence);
    return {
      schema: "stugu-rpi-doctor/v1", ...diagnosis, mode: "default",
      collectedAt: evidence.collectedAt, durationMs: evidence.durationMs,
      target: { selectorSha256: hex("a"), sshHostKeyFingerprint: `SHA256:${"A".repeat(30)}` },
      identity: evidence.identity, evidenceSha256: cacheKey(evidence),
    };
  };
  const healthy = makeReceipt(healthyEvidence());
  assert.equal(validateApplicationReleaseTarget(healthy), healthy);
  for (const errorCode of ["TRUST_VERIFICATION_FAILED", "METADATA_FETCH_FAILED"]) {
    const evidence = healthyEvidence();
    evidence.updater.status = { phase: "failed", errorCode };
    const receipt = makeReceipt(evidence);
    assert.equal(receipt.result, "attention");
    assert.equal(validateApplicationReleaseTarget(receipt), receipt);
    assert.throws(() => validateDoctorReceipt(receipt, { requireHealthy: true }), /healthy target/u);
    assert.throws(() => validateApplicationReleaseTarget(receipt, { selectorSha256: hex("f") }), /target does not match/u);
    assert.throws(() => validateApplicationReleaseTarget(receipt, {
      maximumAgeMs: RELEASE_DOCTOR_RECEIPT_MAX_AGE_MS, now: "2026-08-09T10:16:00Z",
    }), /stale/u);
    // Human-readable text and old receipts cannot supply the exception.
    const old = structuredClone(receipt);
    old.summary.updater = { phase: "failed" };
    assert.throws(() => validateApplicationReleaseTarget(old), /idle host-feed warning/u);
    for (const change of [
      (e) => { e.updater.available = false; },
      (e) => { e.updater.status.phase = "installing"; },
      (e) => { e.updater.status.phase = "recovery-needed"; },
      (e) => { e.updater.status.errorCode = "SIGNATURE_INVALID"; },
      (e) => { e.updater.status.journalPhase = "staged"; },
      (e) => { e.updater.status.journalPhase = "returned"; },
      (e) => { e.updater.status.rollbackReason = "health-failed"; },
      (e) => { e.updater.status.rollbackError = "restore-failed"; },
      (e) => { e.health.telemetryArchive.caughtUp = false; },
      (e) => { e.docker.containers[0].health = "unhealthy"; },
      (e) => { e.versions.release.version = "1.2.2"; },
    ]) {
      const unsafe = structuredClone(evidence);
      change(unsafe);
      assert.throws(() => validateApplicationReleaseTarget(makeReceipt(unsafe)), /idle host-feed warning/u);
    }
  }
});

test("Pi diagnosis accepts the appliance oneshot service and successful init containers", () => {
  const evidence = healthyEvidence();
  evidence.service.SubState = "exited";
  evidence.docker.containers.push({
    name: "stugu-runtime-secrets-1",
    state: "exited",
    health: "none",
    restartCount: 0,
    restartPolicy: "no",
    exitCode: 0,
  });
  evidence.docker.containers.push({
    name: "stugu-update-operations-init-1",
    state: "exited",
    status: "Exited (0) 10 minutes ago",
    health: "none",
    restartCount: 0,
  });
  const diagnosis = diagnoseEvidence(evidence);
  assert.equal(diagnosis.result, "healthy");
  assert.equal(diagnosis.summary.containers.stopped, 0);
  assert.equal(diagnosis.summary.containers.completedOneShot, 2);

  evidence.docker.containers.at(-2).exitCode = 1;
  const failed = diagnoseEvidence(evidence);
  assert.equal(failed.checks.find((item) => item.id === "CONTAINERS")?.status, "fail");
});

test("Pi diagnosis measures writable persistent capacity behind an immutable EROFS root", () => {
  const evidence = healthyEvidence();
  Object.assign(evidence.system, {
    rootTotalBytes: 3_000,
    rootAvailableBytes: 0,
    rootFilesystemType: "erofs",
    rootReadOnly: true,
    persistentTotalBytes: 100_000,
    persistentAvailableBytes: 84_000,
    persistentFilesystemType: "ext4",
    persistentReadOnly: false,
  });

  const healthy = diagnoseEvidence(evidence);
  const resources = healthy.checks.find((item) => item.id === "RESOURCES");
  assert.equal(resources?.status, "pass");
  assert.match(resources?.summary ?? "", /immutable EROFS root; persistent storage 84% available/u);
  assert.deepEqual(healthy.summary.resources, {
    memoryAvailablePercent: 50,
    rootAvailablePercent: 0,
    persistentAvailablePercent: 84,
    storageAvailablePercent: 84,
    rootFilesystemType: "erofs",
    persistentFilesystemType: "ext4",
    rootImmutable: true,
    storageReadOnly: false,
    loadPerCpu: 0.1,
    eventLoopLagMs: 1.5,
  });

  evidence.system.persistentAvailableBytes = 4_000;
  assert.equal(
    diagnoseEvidence(evidence).checks.find((item) => item.id === "RESOURCES")?.status,
    "fail",
  );
  evidence.system.persistentAvailableBytes = 84_000;
  evidence.system.persistentReadOnly = true;
  assert.equal(
    diagnoseEvidence(evidence).checks.find((item) => item.id === "RESOURCES")?.status,
    "fail",
  );
});

test("Pi diagnosis reports terminal notification dead letters without treating them as pending work", () => {
  const evidence = healthyEvidence();
  evidence.database.queues.notifications = {
    count: 0,
    capped: false,
    deadLettered: 100,
    deadLetteredCapped: true,
  };
  const queues = diagnoseEvidence(evidence).checks.find((item) => item.id === "QUEUES");
  assert.equal(queues?.status, "pass");
  assert.match(queues?.summary ?? "", /notification 0, Tapo export 0 pending; 100 notification dead-lettered/u);
});

test("Pi diagnosis accepts a completed host check with no newer signed target", () => {
  const evidence = healthyEvidence();
  evidence.updater.status = { phase: "failed", errorCode: "UPDATE_NOT_FOUND" };
  const updater = diagnoseEvidence(evidence).checks.find((item) => item.id === "UPDATER");
  assert.equal(updater?.status, "pass");
  assert.match(updater?.summary ?? "", /no newer signed target is available/u);

  // Since 0.40.0 stale feed trust metadata pauses host updates with a
  // warning instead of failing the machine check; application updates never
  // consult the failing metadata.
  evidence.updater.status = { phase: "failed", errorCode: "TRUST_VERIFICATION_FAILED" };
  const feedDegraded = diagnoseEvidence(evidence).checks.find((item) => item.id === "UPDATER");
  assert.equal(feedDegraded?.status, "warning");
  assert.match(feedDegraded?.summary ?? "", /host updates are paused, application updates are unaffected/u);

  evidence.updater.status = { phase: "rollback-failed", errorCode: null };
  assert.equal(
    diagnoseEvidence(evidence).checks.find((item) => item.id === "UPDATER")?.status,
    "fail",
  );
});

test("default Pi doctor uses exactly one bounded SSH invocation", async () => {
  const state = mkdtempSync(join(tmpdir(), "stugu-doctor-test-"));
  let calls = 0;
  try {
    const output = await doctorMain(
      ["--target", "operator@stugu.local"],
      { ...process.env, STUGU_TOOLING_STATE_DIR: state },
      {
        runRemote: async (options) => {
          calls += 1;
          assert.equal(options.command, "ssh");
          assert.equal(options.timeoutMs, 14_000);
          assert.ok(options.args.includes("BatchMode=yes"));
          assert.ok(options.args.includes("StrictHostKeyChecking=yes"));
          assert.match(options.input, /stugu-rpi-doctor-evidence\/v1/u);
          return {
            status: 0,
            timedOut: false,
            stdout: JSON.stringify(healthyEvidence()),
            stderr: `debug1: Server host key: ssh-ed25519 SHA256:${"C".repeat(30)}`,
          };
        },
      },
    );
    assert.equal(calls, 1);
    assert.equal(output.receipt.result, "healthy");
    assert.match(output.path, /stugu-rpi-doctor\.json$/u);
  } finally {
    rmSync(state, { recursive: true, force: true });
  }
});

test("full verification receipts are exact-worktree and clean-worktree aware", () => {
  const snapshot = {
    commit: "a".repeat(40),
    worktreeSha256: hex("1"),
    dirty: false,
    statusSha256: hex("2"),
    trackedDiffSha256: hex("3"),
    lockfileSha256: hex("4"),
    configurationSha256: hex("5"),
  };
  const receipt = {
    schema: "stugu-local-verification/v1",
    mode: "full",
    result: "passed",
    projectVersion: "1.2.3",
    commit: snapshot.commit,
    worktree: {
      sha256: snapshot.worktreeSha256,
      dirty: false,
      statusSha256: snapshot.statusSha256,
      trackedDiffSha256: snapshot.trackedDiffSha256,
    },
    inputs: { lockfileSha256: snapshot.lockfileSha256, configurationSha256: snapshot.configurationSha256 },
    base: { ref: "origin/main", commit: "b".repeat(40), mergeBase: "b".repeat(40) },
    cacheKey: localVerificationCacheKey({
      mode: "full",
      commit: snapshot.commit,
      worktreeSha256: snapshot.worktreeSha256,
      lockfileSha256: snapshot.lockfileSha256,
      configurationSha256: snapshot.configurationSha256,
      baseCommit: "b".repeat(40),
      mergeBase: "b".repeat(40),
    }),
    startedAt: "2026-08-09T10:00:00.000Z",
    finishedAt: "2026-08-09T10:00:01.000Z",
    durationMs: 1_000,
    authoritativeCi: { schemaVersion: 1, receiptSha256: hex("7"), result: "passed" },
    checks: fullCiChecks(),
    affectedFiles: [],
    limitations: [FULL_CI_APPLE_PLATFORM_LIMITATION],
  };
  assert.equal(validateLocalVerificationReceipt(receipt, { mode: "full", snapshot, requireClean: true }), receipt);
  assert.throws(
    () => validateLocalVerificationReceipt({
      ...receipt,
      checks: [receipt.checks.find((check) => check.id === "TYPECHECK")],
    }),
    /full CI/u,
  );
  assert.throws(
    () => validateLocalVerificationReceipt({ ...receipt, limitations: [] }),
    /platform-limitation evidence/u,
  );
  const appleReceipt = {
    ...receipt,
    checks: fullCiChecks({ includeApple: true }),
    limitations: [],
  };
  assert.equal(validateLocalVerificationReceipt(appleReceipt, { mode: "full", snapshot }), appleReceipt);
  assert.throws(
    () => validateLocalVerificationReceipt({
      ...receipt,
      checks: receipt.checks.map((check) => (
        check.id === "API_SMOKE" ? { ...check, status: "skipped" } : check
      )),
    }),
    /canonical gates did not all pass/u,
  );
  assert.throws(
    () => validateLocalVerificationReceipt({ ...receipt, worktree: { ...receipt.worktree, dirty: true } }, { requireClean: true }),
    /dirty worktree/u,
  );
  assert.throws(
    () => validateLocalVerificationReceipt({
      ...receipt,
      checks: [{ ...receipt.checks[0], status: "failed" }],
    }),
    /contains a failed check/u,
  );
});

test("compatibility proof binds canonical host identity and trust inputs", () => {
  const checks = [
    "CONTAINER_CONTRACT",
    "FULL_CI",
    "HOST_IMAGES",
    "HOST_SBOM",
    "HOST_PROVENANCE",
  ].map((id) => ({ id, label: id, status: "passed", durationMs: 0 }));
  const proof = {
    schema: "stugu-release-compatibility-proof/v1",
    result: "passed",
    commit: "a".repeat(40),
    version: "1.2.3",
    manifestSha256: hex("1"),
    fullCiReceiptSha256: hex("2"),
    contracts: { updateAgent: 3, compose: 2 },
    hostInputs: {
      containerManifestSha256: hex("3"),
      bootSha256: hex("4"),
      rootSha256: hex("5"),
      sbomSha256: hex("6"),
      provenanceSha256: hex("7"),
      sourceCommit: "a".repeat(40),
      hostGeneration: 42,
      tufRootSha256: hex("8"),
      raucCaSha256: hex("9"),
    },
    checks,
  };
  assert.equal(validateCompatibilityProof(proof), proof);
  assert.throws(
    () => validateCompatibilityProof({
      ...proof,
      hostInputs: { ...proof.hostInputs, hostGeneration: 0 },
    }),
    /host generation must be positive/u,
  );
  assert.throws(
    () => validateCompatibilityProof({ ...proof, checks: checks.slice(0, -1) }),
    /gate ids are incomplete or non-canonical/u,
  );
});

test("release finalization evidence has a bounded freshness window", () => {
  const receipt = releaseVerificationReceipt("2026-08-09T10:00:00.000Z");
  assert.equal(validateReleaseVerificationReceipt(receipt, {
    maximumAgeMs: RELEASE_VERIFICATION_RECEIPT_MAX_AGE_MS,
    now: "2026-08-09T10:15:00.000Z",
  }), receipt);
  assert.throws(
    () => validateReleaseVerificationReceipt(receipt, {
      maximumAgeMs: RELEASE_VERIFICATION_RECEIPT_MAX_AGE_MS,
      now: "2026-08-09T10:15:00.001Z",
    }),
    /receipt is stale/u,
  );
  assert.throws(
    () => validateReleaseVerificationReceipt(receipt, {
      maximumAgeMs: RELEASE_VERIFICATION_RECEIPT_MAX_AGE_MS,
      now: "2026-08-09T09:54:59.999Z",
    }),
    /too far in the future/u,
  );
});

test("anonymous multi-platform evidence rejects unreadable AMD64, private-only credentials, and provenance mismatch", async () => {
  const commit = "1".repeat(40);
  const indexDigest = `sha256:${hex("a")}`;
  const amdDigest = `sha256:${hex("c")}`;
  const armDigest = `sha256:${hex("b")}`;
  const reference = `ghcr.io/example/stugu-api:v1.2.3@${indexDigest}`;
  const index = {
    schemaVersion: 2,
    mediaType: "application/vnd.oci.image.index.v1+json",
    manifests: [
      { mediaType: "application/vnd.oci.image.manifest.v1+json", digest: amdDigest, size: 500, platform: { os: "linux", architecture: "amd64" } },
      { mediaType: "application/vnd.oci.image.manifest.v1+json", digest: armDigest, size: 501, platform: { os: "linux", architecture: "arm64" } },
    ],
  };
  const manifest = (configCharacter, layerCharacter) => ({
    schemaVersion: 2,
    mediaType: "application/vnd.oci.image.manifest.v1+json",
    config: { mediaType: "application/vnd.oci.image.config.v1+json", digest: `sha256:${hex(configCharacter)}`, size: 200 },
    layers: [{ mediaType: "application/vnd.oci.image.layer.v1.tar+gzip", digest: `sha256:${hex(layerCharacter)}`, size: 300 }],
  });
  const provenance = {
    "linux/amd64": { SLSA: { invocation: { environment: { platform: "linux/amd64", vcs: { revision: commit } } } } },
    "linux/arm64": { SLSA: { invocation: { environment: { platform: "linux/arm64", vcs: { revision: commit } } } } },
  };
  const manifests = {
    "linux/amd64": manifest("d", "e"),
    "linux/arm64": manifest("f", "2"),
  };
  const result = multiPlatformImageEvidence("api", reference, commit, { index, manifests, provenance });
  assert.equal(result.indexDigest, indexDigest);
  assert.equal(result.anonymousRead, true);
  assert.equal(result.amd64ManifestDigest, amdDigest);
  assert.equal(result.arm64ManifestDigest, armDigest);
  assert.match(result.amd64DescriptorClosureSha256, /^[0-9a-f]{64}$/u);
  assert.match(result.arm64ProvenanceSha256, /^[0-9a-f]{64}$/u);

  assert.throws(
    () => multiPlatformImageEvidence("api", reference, commit, {
      index,
      manifests,
      provenance: {
        ...provenance,
        "linux/arm64": { SLSA: { invocation: { environment: { platform: "linux/arm64", vcs: { revision: "2".repeat(40) } } } } },
      },
    }),
    /provenance does not bind source commit/u,
  );
  await assert.rejects(
    () => inspectMultiPlatformImage("api", reference, commit, {
      manifest: async (candidate) => {
        if (candidate === reference) return index;
        if (candidate.endsWith(amdDigest)) throw new Error("linux/amd64 manifest is unreadable");
        return manifests["linux/arm64"];
      },
      provenance: async () => provenance,
    }),
    /amd64 manifest is unreadable/u,
  );

  const anonymous = anonymousRegistryEnvironment({
    PATH: "safe",
    DOCKER_CONFIG: "ambient",
    DOCKER_AUTH_CONFIG: "secret",
    GHCR_TOKEN: "secret",
    GITHUB_TOKEN: "secret",
  }, "empty-config");
  assert.deepEqual(anonymous, { PATH: "safe", DOCKER_CONFIG: "empty-config" });

  const raw = JSON.stringify(index);
  const rawDigest = `sha256:${createHash("sha256").update(raw).digest("hex")}`;
  assert.equal(exactManifestDigest(raw, rawDigest), true);
  assert.equal(exactManifestDigest(`${raw}\n`, rawDigest), true);
});

test("canonical release and doctor paths do not hide expensive or mutating work", () => {
  const release = readFileSync(new URL("../release-verify.mjs", import.meta.url), "utf8");
  const doctor = readFileSync(new URL("../tooling/rpi-doctor-remote.py", import.meta.url), "utf8");
  const publisher = readFileSync(new URL("../publish-local-release.mjs", import.meta.url), "utf8");
  assert.doesNotMatch(release, /ci:local|buildx["',\s]+build/u);
  assert.match(release, /imagetools["',\s]+inspect/u);
  assert.match(release, /--ignore-blank-lines/u);
  assert.match(doctor, /"stats",\s+"--no-stream"/u);
  assert.match(doctor, /line\.partition\(":"\)/u);
  assert.match(doctor, /filesystem_snapshot\("\/persistent"\)/u);
  assert.match(doctor, /delivered_at IS NULL AND dead_lettered_at IS NULL AND abandoned_at IS NULL/u);
  assert.match(doctor, /deadLetteredNotifications/u);
  assert.match(doctor, /"errorCode"/u);
  assert.doesNotMatch(doctor, /docker stats(?!.*--no-stream)/u);
  assert.doesNotMatch(publisher, /invoke\("npm", \["run", "ci:local"/u);
  assert.match(publisher, /--full-ci-receipt/u);
  assert.match(publisher, /--verification-receipt/u);
  assert.match(publisher, /RELEASE_VERIFICATION_RECEIPT_MAX_AGE_MS/u);
  assert.match(publisher, /verifyContainerReferences/u);
  assert.match(publisher, /BUILDX_GIT_CHECK_DIRTY:\s*"0"/u);
  assert.match(publisher, /BUILDX_GIT_INFO:\s*"1"/u);
  assert.match(publisher, /BUILDX_GIT_LABELS:\s*"full"/u);
});

test("the documented development command starts tsx in watch mode", () => {
  const apiPackage = JSON.parse(readFileSync(new URL("../../apps/api/package.json", import.meta.url), "utf8"));
  assert.match(apiPackage.scripts.dev, /tsx watch --env-file-if-exists=\.env apps\/api\/src\/index\.ts/u);
});


test("Pi diagnostic receipts keep only bounded probe and API log classifications", () => {
  const evidence = healthyEvidence();
  evidence.deep = true;
  evidence.health = { available: false, probe: { outcome: "timeout", durationMs: 2501, httpStatus: null, message: "private token" } };
  evidence.logs = { available: true, priorities: { "3": 2 } };
  evidence.apiLogs = { available: true, records: 800, capped: true, categories: { "sqlite-lock": 2, "private token": 9 }, raw: "secret log" };
  evidence.docker.probes = {
    dockerList: { outcome: "success", durationMs: 85, exitCode: 0, stdout: "secret log" },
    dockerInspect: { outcome: "permission-denied", durationMs: 51, exitCode: 1, stderr: "private token" },
    dockerStats: { outcome: "timeout", durationMs: 4001, exitCode: null },
    "private token": { outcome: "success" },
  };
  evidence.docker.inspectAvailable = false;
  evidence.updater.probes = { updaterHardware: { outcome: "not-found", durationMs: 12, exitCode: 127 } };
  evidence.logs.probes = { journal: { outcome: "private token", durationMs: 1 } };
  const diagnosis = diagnoseEvidence(evidence);
  assert.deepEqual(diagnosis.summary.healthProbe, { outcome: "timeout", durationMs: 2501, httpStatus: null });
  assert.deepEqual(diagnosis.summary.apiLogs, {
    available: true, windowMinutes: 15, records: 160, capped: true, categories: { "sqlite-lock": 2 },
  });
  assert.match(diagnosis.checks.find((item) => item.id === "HEALTH").summary, /timeout, 2501 ms, HTTP unavailable/u);
  assert.deepEqual(diagnosis.summary.commandProbes, {
    dockerList: { outcome: "success", durationMs: 85, exitCode: 0 },
    dockerInspect: { outcome: "permission-denied", durationMs: 51, exitCode: 1 },
    dockerStats: { outcome: "timeout", durationMs: 4001, exitCode: null },
    updaterHardware: { outcome: "not-found", durationMs: 12, exitCode: 127 },
  });
  assert.equal(diagnosis.checks.find((item) => item.id === "CONTAINERS").status, "fail");
  assert.doesNotMatch(JSON.stringify(diagnosis), /private token|secret log/u);
});

test("Pi remote collector classifies health failures and logs without retaining raw content", () => {
  const collector = new URL("../tooling/rpi-doctor-remote.py", import.meta.url);
  const program = String.raw`
import io
import json
import runpy
import subprocess
import urllib.error
from unittest.mock import patch
import sys
module = runpy.run_path(sys.argv[1])
health = module["health_snapshot"]
secret = "private-token-and-hostname"
command = module["run"]
for status, stderr, outcome in [
    (0, secret, "success"),
    (1, "sudo: a password is required " + secret, "permission-denied"),
    (1, "permission denied " + secret, "permission-denied"),
    (127, secret, "not-found"),
    (1, secret, "failed"),
]:
    completed = subprocess.CompletedProcess(["private-command"], status, secret, stderr)
    with patch("subprocess.run", return_value=completed):
        result = command(["private-command"])
        assert result["probe"]["outcome"] == outcome
        assert result["probe"]["exitCode"] == status
        assert result["probe"]["durationMs"] >= 0
        assert secret not in json.dumps(result["probe"])
for error, outcome in [
    (subprocess.TimeoutExpired("private-command", 3), "timeout"),
    (FileNotFoundError(secret), "not-found"),
    (PermissionError(secret), "permission-denied"),
    (OSError(secret), "failed"),
]:
    with patch("subprocess.run", side_effect=error):
        result = command(["private-command"])
        assert result["probe"]["outcome"] == outcome
        assert result["probe"]["exitCode"] is None
        assert secret not in json.dumps(result)
def response(body, status=200):
    result = io.BytesIO(body)
    result.status = status
    return result
with patch("urllib.request.urlopen", return_value=response(b'{"status":"ok","database":"ready","private":"secret"}')):
    result = health()
    assert result["probe"]["outcome"] == "success"
    assert result["probe"]["httpStatus"] == 200
    assert result["available"] is True and "private" not in result
for error in [TimeoutError(secret), urllib.error.URLError(TimeoutError(secret))]:
    with patch("urllib.request.urlopen", side_effect=error):
        result = health()
        assert result["probe"]["outcome"] == "timeout"
        assert result["probe"]["durationMs"] >= 0
        assert secret not in json.dumps(result)
with patch("urllib.request.urlopen", side_effect=urllib.error.URLError(ConnectionRefusedError(secret))):
    assert health()["probe"]["outcome"] == "connection-error"
error = urllib.error.HTTPError("http://private", 503, secret, {}, io.BytesIO(b'{"status":"degraded","database":"ready"}'))
with patch("urllib.request.urlopen", side_effect=error):
    result = health()
    assert result["available"] is True and result["status"] == "degraded"
    assert result["probe"]["httpStatus"] == 503 and result["probe"]["outcome"] == "http-error"
with patch("urllib.request.urlopen", return_value=response(b"<html>")):
    assert health()["probe"]["outcome"] == "invalid-response"
summary = module["summarize_api_logs"]("SQLITE_BUSY " + secret + "\nheap out of memory /private/path\nstatement timeout token=secret\nError: " + secret)
assert summary["categories"] == {"sqlite-lock": 1, "memory": 1, "database-timeout": 1, "other-error": 1}
assert secret not in json.dumps(summary) and "/private" not in json.dumps(summary)
assert module["summarize_api_logs"]("SQLITE_BUSY\n" * 200)["records"] == 160
assert module["summarize_api_logs"]("SQLITE_BUSY\n" * 200)["capped"] is True
snapshot = module["api_logs_snapshot"]
commands = []
def fake_run(arguments, timeout=3):
    commands.append((arguments, timeout))
    return {"ok": True, "stdout": "", "stderr": "SQLITE_BUSY " + secret, "probe": {"outcome": "success", "durationMs": 1, "exitCode": 0}}
with patch.dict(snapshot.__globals__, {"api_container_lookup": lambda: ("api-fixture", {"outcome": "success", "durationMs": 1, "exitCode": 0}), "run": fake_run}):
    result = snapshot()
    assert result["categories"] == {"sqlite-lock": 1}
    assert commands == [(["docker", "logs", "--since=15m", "--tail=160", "api-fixture"], 4.0)]
    assert secret not in json.dumps(result)
    assert result["probes"]["apiLogsRead"]["outcome"] == "success"
    assert result["probes"]["apiLogsLookup"]["outcome"] == "success"
lookup_failure = {"outcome": "timeout", "durationMs": 3001, "exitCode": None}
with patch.dict(snapshot.__globals__, {"api_container_lookup": lambda: ("", lookup_failure)}):
    result = snapshot()
    assert result["available"] is False and result["probes"]["apiLogsLookup"] == lookup_failure
    result = module["database_snapshot"](False)
    assert result["available"] is False and result["probes"]["databaseLookup"] == lookup_failure
for deep, inside, outside in [(False, "2.5s", 3.5), (True, "10s", 12.0)]:
    def database_run(arguments, timeout=3):
        assert arguments[:6] == ["docker", "exec", "api-fixture", "timeout", "--signal=KILL", inside]
        assert arguments[6:8] == ["node", "-e"]
        assert arguments[8] == module["DATABASE_SCRIPT"]
        assert arguments[9:] == (["--", "--deep"] if deep else [])
        assert timeout == outside
        return {"ok": True, "stdout": '{"available":true}', "probe": {"outcome": "success", "durationMs": 1, "exitCode": 0}}
    with patch.dict(snapshot.__globals__, {"api_container_lookup": lambda: ("api-fixture", {"outcome": "success", "durationMs": 1, "exitCode": 0}), "run": database_run}):
        assert module["database_snapshot"](deep)["available"] is True
print("collector classifications passed")
`;
  const result = spawnSync("python", ["-B", "-", fileURLToPath(collector)], {
    input: program, encoding: "utf8", windowsHide: true, timeout: 10_000,
  });
  assert.equal(result.status, 0, result.stderr || result.error?.message);
  assert.match(result.stdout, /collector classifications passed/u);
});
