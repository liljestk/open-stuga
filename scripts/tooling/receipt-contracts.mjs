import { assertSha256, cacheKey, exactKeys } from "./runtime.mjs";
import { validateDraftEvidence } from "./draft-release.mjs";
import { parseVisualViewport } from "./visual-evidence.mjs";

const COMMIT = /^[0-9a-f]{40}$/u;
const TAG = /^v\d+\.\d+\.\d+$/u;
const VERSION = /^\d+\.\d+\.\d+$/u;
const ISO_DATE = /^\d{4}-\d{2}-\d{2}T/u;
const HOST_KEY = /^(?:SHA256:)?[A-Za-z0-9+/]{20,}={0,2}$/u;
const RECEIPT_MAX_FUTURE_SKEW_MS = 5 * 60_000;

export const RELEASE_DOCTOR_RECEIPT_MAX_AGE_MS = 15 * 60_000;
export const RELEASE_VERIFICATION_RECEIPT_MAX_AGE_MS = 15 * 60_000;
export const RPI_DOCTOR_DEFAULT_GATE_IDS = Object.freeze([
  "IDENTITY",
  "SERVICE",
  "HEALTH",
  "CONTAINERS",
  "RESOURCES",
  "EVENT_LOOP",
  "ARCHIVE_DATABASE",
  "QUEUES",
  "INTEGRATIONS",
  "UPDATER",
  "VERSIONS",
]);
export const RPI_DOCTOR_DEEP_GATE_IDS = Object.freeze([
  ...RPI_DOCTOR_DEFAULT_GATE_IDS,
  "INTEGRITY",
  "LOGS",
]);
export const FULL_CI_REQUIRED_GATE_IDS = Object.freeze([
  "TYPECHECK",
  "PYTHON_LINT",
  "PYTHON_FORMAT",
  "HOST_PUBLICATION",
  "UPDATER_LINUX",
  "WORKSPACE_COVERAGE",
  "OPERATIONAL_TOOLING",
  "TP_LINK_COVERAGE",
  "APPLICATION_BUILD",
  "COMPOSE_COMPLETE",
  "COMPOSE_APPLIANCE",
  "CONTAINER_API",
  "CONTAINER_BACKUP",
  "CONTAINER_WEB",
  "CONTAINER_TAPO_EXPORT_RUNNER",
  "CONTAINER_UPDATE_AGENT",
  "CONTAINER_MQTT",
  "CONTAINER_NEXUS433",
  "API_SMOKE",
]);
export const FULL_CI_APPLE_GATE_IDS = Object.freeze([
  "SWIFT_TEST",
  "IOS_BUILD",
  "MAC_CATALYST_BUILD",
]);
export const FULL_CI_APPLE_PLATFORM_LIMITATION =
  "Native iOS and Mac Catalyst checks require macOS with Xcode.";
const COMPATIBILITY_GATE_IDS = Object.freeze([
  "CONTAINER_CONTRACT",
  "FULL_CI",
  "HOST_IMAGES",
  "HOST_SBOM",
  "HOST_PROVENANCE",
]);

function object(value, label) {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`${label} must be an object`);
  return value;
}

function string(value, label, maximum = 1_000) {
  if (typeof value !== "string" || value.length === 0 || value.length > maximum) {
    throw new Error(`${label} must be a non-empty string of at most ${maximum} characters`);
  }
  return value;
}

function integer(value, label) {
  if (!Number.isSafeInteger(value) || value < 0) throw new Error(`${label} must be a non-negative integer`);
  return value;
}

function date(value, label) {
  if (typeof value !== "string" || !ISO_DATE.test(value) || !Number.isFinite(Date.parse(value))) {
    throw new Error(`${label} must be an ISO timestamp`);
  }
  return value;
}

function commit(value, label = "commit") {
  if (!COMMIT.test(value ?? "")) throw new Error(`${label} must be a full Git commit`);
  return value;
}

function resultChecks(checks, label) {
  if (!Array.isArray(checks) || checks.length === 0) throw new Error(`${label} checks are missing`);
  const ids = new Set();
  for (const [index, check] of checks.entries()) {
    exactKeys(object(check, `${label} check ${index}`), ["id", "label", "status", "durationMs"], `${label} check ${index}`);
    string(check.id, `${label} check ${index} id`, 100);
    string(check.label, `${label} check ${index} label`, 300);
    if (!new Set(["passed", "failed", "skipped"]).has(check.status)) throw new Error(`${label} check ${index} status is invalid`);
    integer(check.durationMs, `${label} check ${index} duration`);
    if (ids.has(check.id)) throw new Error(`${label} check ids must be unique`);
    ids.add(check.id);
  }
  return checks;
}

function exactGateIds(checks, expectedIds, label) {
  const actualIds = checks.map((check) => check.id);
  if (actualIds.length !== expectedIds.length
    || actualIds.some((id, index) => id !== expectedIds[index])) {
    throw new Error(`${label} gate ids are incomplete or non-canonical`);
  }
}

function validateFullCiGateSet(receipt) {
  const versionIds = receipt.checks
    .map((check) => check.id)
    .filter((id) => id === "VERSION" || id === "VERSION_BASE");
  if (versionIds.length !== 1) throw new Error("full CI needs exactly one canonical version gate");
  const applePresent = FULL_CI_APPLE_GATE_IDS.filter((id) => (
    receipt.checks.some((check) => check.id === id)
  ));
  if (applePresent.length !== 0 && applePresent.length !== FULL_CI_APPLE_GATE_IDS.length) {
    throw new Error("full CI native Apple gate set is incomplete");
  }
  const hasAppleGates = applePresent.length === FULL_CI_APPLE_GATE_IDS.length;
  if (hasAppleGates) {
    if (receipt.limitations.length !== 0) {
      throw new Error("full CI platform limitations contradict completed native Apple gates");
    }
  } else if (receipt.limitations.length !== 1
    || receipt.limitations[0] !== FULL_CI_APPLE_PLATFORM_LIMITATION) {
    throw new Error("full CI missing native Apple gates needs canonical platform-limitation evidence");
  }
  exactGateIds(receipt.checks, [
    versionIds[0],
    ...FULL_CI_REQUIRED_GATE_IDS,
    ...(hasAppleGates ? FULL_CI_APPLE_GATE_IDS : []),
  ], "full CI");
  if (receipt.checks.some((check) => check.status !== "passed")) {
    throw new Error("full CI canonical gates did not all pass");
  }
}

function validationTime(value) {
  const parsed = value instanceof Date
    ? value.getTime()
    : typeof value === "string"
      ? Date.parse(value)
      : value;
  if (!Number.isFinite(parsed)) throw new Error("receipt validation time is invalid");
  return parsed;
}

export function localVerificationCacheKey({ mode, commit: sourceCommit, worktreeSha256, lockfileSha256,
  configurationSha256, baseCommit, mergeBase }) {
  return cacheKey({
    schema: "stugu-local-verification-cache/v1",
    mode,
    commit: sourceCommit,
    worktreeSha256,
    lockfileSha256,
    configurationSha256,
    baseCommit,
    mergeBase,
  });
}

export function validateLocalVerificationReceipt(value, {
  mode, snapshot, requireClean = false, projectVersion,
} = {}) {
  const receipt = exactKeys(object(value, "local verification receipt"), [
    "schema", "mode", "result", "projectVersion", "commit", "worktree", "inputs",
    "base", "cacheKey", "startedAt", "finishedAt", "durationMs", "authoritativeCi",
    "checks", "affectedFiles", "limitations",
  ], "local verification receipt");
  if (receipt.schema !== "stugu-local-verification/v1") throw new Error("local verification receipt schema is invalid");
  if (!new Set(["fast", "full"]).has(receipt.mode) || (mode && receipt.mode !== mode)) {
    throw new Error("local verification receipt mode is invalid");
  }
  if (receipt.result !== "passed") throw new Error("local verification receipt did not pass");
  if (!VERSION.test(receipt.projectVersion ?? "")) throw new Error("local verification project version is invalid");
  if (projectVersion && receipt.projectVersion !== projectVersion) {
    throw new Error("local verification project version does not match");
  }
  commit(receipt.commit);
  exactKeys(object(receipt.worktree, "verification worktree"), [
    "sha256", "dirty", "statusSha256", "trackedDiffSha256",
  ], "verification worktree");
  assertSha256(receipt.worktree.sha256, "verification worktree sha256");
  assertSha256(receipt.worktree.statusSha256, "verification status sha256");
  assertSha256(receipt.worktree.trackedDiffSha256, "verification diff sha256");
  if (typeof receipt.worktree.dirty !== "boolean") throw new Error("verification dirty state is invalid");
  if (requireClean && receipt.worktree.dirty) throw new Error("verification receipt was produced from a dirty worktree");
  exactKeys(object(receipt.inputs, "verification inputs"), ["lockfileSha256", "configurationSha256"], "verification inputs");
  assertSha256(receipt.inputs.lockfileSha256, "verification lockfile sha256");
  assertSha256(receipt.inputs.configurationSha256, "verification configuration sha256");
  if (receipt.base !== null) {
    exactKeys(object(receipt.base, "verification base"), ["ref", "commit", "mergeBase"], "verification base");
    string(receipt.base.ref, "verification base ref", 300);
    commit(receipt.base.commit, "verification base commit");
    commit(receipt.base.mergeBase, "verification merge base");
  }
  assertSha256(receipt.cacheKey, "verification cache key");
  const expectedCacheKey = localVerificationCacheKey({
    mode: receipt.mode,
    commit: receipt.commit,
    worktreeSha256: receipt.worktree.sha256,
    lockfileSha256: receipt.inputs.lockfileSha256,
    configurationSha256: receipt.inputs.configurationSha256,
    baseCommit: receipt.base?.commit ?? null,
    mergeBase: receipt.base?.mergeBase ?? null,
  });
  if (receipt.cacheKey !== expectedCacheKey) throw new Error("local verification cache key is invalid");
  date(receipt.startedAt, "verification start");
  date(receipt.finishedAt, "verification finish");
  integer(receipt.durationMs, "verification duration");
  resultChecks(receipt.checks, "verification");
  if (receipt.checks.some((check) => check.status === "failed")) {
    throw new Error("passed verification receipt contains a failed check");
  }
  if (!Array.isArray(receipt.affectedFiles) || receipt.affectedFiles.some((path) => typeof path !== "string" || path.length > 500)) {
    throw new Error("verification affected files are invalid");
  }
  if (!Array.isArray(receipt.limitations) || receipt.limitations.some((item) => typeof item !== "string" || item.length > 500)) {
    throw new Error("verification limitations are invalid");
  }
  if (receipt.mode === "full") {
    exactKeys(object(receipt.authoritativeCi, "authoritative CI evidence"), [
      "schemaVersion", "receiptSha256", "result",
    ], "authoritative CI evidence");
    if (receipt.authoritativeCi.schemaVersion !== 1 || receipt.authoritativeCi.result !== "passed") {
      throw new Error("authoritative CI evidence is invalid");
    }
    assertSha256(receipt.authoritativeCi.receiptSha256, "authoritative CI receipt sha256");
    validateFullCiGateSet(receipt);
  } else if (receipt.authoritativeCi !== null) {
    throw new Error("fast verification cannot contain authoritative CI evidence");
  }
  if (snapshot) {
    if (receipt.commit !== snapshot.commit
      || receipt.worktree.sha256 !== snapshot.worktreeSha256
      || receipt.worktree.dirty !== snapshot.dirty
      || receipt.worktree.statusSha256 !== snapshot.statusSha256
      || receipt.worktree.trackedDiffSha256 !== snapshot.trackedDiffSha256
      || receipt.inputs.lockfileSha256 !== snapshot.lockfileSha256
      || receipt.inputs.configurationSha256 !== snapshot.configurationSha256) {
      throw new Error("verification receipt does not match the current commit and worktree");
    }
  }
  return receipt;
}

export function validateCompatibilityProof(value, expected = {}) {
  const proof = exactKeys(object(value, "compatibility proof"), [
    "schema", "result", "commit", "version", "manifestSha256", "fullCiReceiptSha256",
    "contracts", "hostInputs", "checks",
  ], "compatibility proof");
  if (proof.schema !== "stugu-release-compatibility-proof/v1" || proof.result !== "passed") {
    throw new Error("compatibility proof did not pass");
  }
  commit(proof.commit);
  if (!VERSION.test(proof.version ?? "")) throw new Error("compatibility proof version is invalid");
  assertSha256(proof.manifestSha256, "compatibility manifest sha256");
  assertSha256(proof.fullCiReceiptSha256, "compatibility full CI sha256");
  exactKeys(object(proof.contracts, "compatibility contracts"), ["updateAgent", "compose"], "compatibility contracts");
  if (proof.contracts.updateAgent !== 3 || proof.contracts.compose !== 2) throw new Error("compatibility contracts are unsupported");
  exactKeys(object(proof.hostInputs, "compatibility host inputs"), [
    "containerManifestSha256", "bootSha256", "rootSha256", "sbomSha256",
    "provenanceSha256", "sourceCommit", "hostGeneration", "tufRootSha256",
    "raucCaSha256",
  ], "compatibility host inputs");
  for (const key of [
    "containerManifestSha256", "bootSha256", "rootSha256", "sbomSha256",
    "provenanceSha256", "tufRootSha256", "raucCaSha256",
  ]) {
    assertSha256(proof.hostInputs[key], `compatibility ${key}`);
  }
  commit(proof.hostInputs.sourceCommit, "compatibility source commit");
  if (integer(proof.hostInputs.hostGeneration, "compatibility host generation") < 1) {
    throw new Error("compatibility host generation must be positive");
  }
  resultChecks(proof.checks, "compatibility");
  exactGateIds(proof.checks, COMPATIBILITY_GATE_IDS, "compatibility");
  if (proof.checks.some((check) => check.status !== "passed")) throw new Error("compatibility checks did not all pass");
  for (const [key, expectedValue] of Object.entries(expected)) {
    if (expectedValue !== undefined && proof[key] !== expectedValue) throw new Error(`compatibility proof ${key} does not match`);
  }
  return proof;
}

export function validateVisualAcceptanceReceipt(value, expectedCommit) {
  const receipt = exactKeys(object(value, "visual acceptance receipt"), [
    "schema", "result", "commit", "baseCommit", "renderedScreenChanges", "reason", "scenarios",
  ], "visual acceptance receipt");
  if (receipt.schema !== "stugu-visual-acceptance/v1") throw new Error("visual acceptance receipt schema is invalid");
  if (!new Set(["passed", "not-applicable"]).has(receipt.result)) throw new Error("visual acceptance result is invalid");
  commit(receipt.commit, "visual acceptance commit");
  commit(receipt.baseCommit, "visual acceptance base commit");
  if (expectedCommit && receipt.commit !== expectedCommit) throw new Error("visual acceptance receipt names another commit");
  if (typeof receipt.renderedScreenChanges !== "boolean") throw new Error("visual acceptance screen-change flag is invalid");
  if (receipt.reason !== null) string(receipt.reason, "visual acceptance reason", 2_000);
  if (!Array.isArray(receipt.scenarios)) throw new Error("visual acceptance scenarios are invalid");
  for (const [index, scenario] of receipt.scenarios.entries()) {
    exactKeys(object(scenario, `visual scenario ${index}`), [
      "surface", "route", "dataScenario", "viewport", "theme", "screenshot", "workflow", "result",
    ], `visual scenario ${index}`);
    if (!new Set(["web", "native"]).has(scenario.surface)) throw new Error(`visual scenario ${index} surface is invalid`);
    string(scenario.route, `visual scenario ${index} route`, 500);
    string(scenario.dataScenario, `visual scenario ${index} data`, 1_000);
    parseVisualViewport(
      scenario.viewport,
      `visual scenario ${index} viewport`,
    );
    if (!new Set(["light", "dark"]).has(scenario.theme)) throw new Error(`visual scenario ${index} theme is invalid`);
    exactKeys(object(scenario.screenshot, `visual scenario ${index} screenshot`), ["path", "sha256"], `visual scenario ${index} screenshot`);
    string(scenario.screenshot.path, `visual scenario ${index} screenshot path`, 1_000);
    assertSha256(scenario.screenshot.sha256, `visual scenario ${index} screenshot sha256`);
    string(scenario.workflow, `visual scenario ${index} workflow`, 2_000);
    if (scenario.result !== "passed") throw new Error(`visual scenario ${index} did not pass`);
  }
  if (receipt.renderedScreenChanges) {
    if (receipt.result !== "passed" || receipt.scenarios.length === 0) throw new Error("screen changes need passed visual scenarios");
  } else if (receipt.result !== "not-applicable" || receipt.scenarios.length !== 0 || !receipt.reason) {
    throw new Error("non-visual changes need a reason and no visual scenarios");
  }
  return receipt;
}

export function validateDoctorReceipt(value, {
  selectorSha256,
  requireHealthy = false,
  maximumAgeMs,
  now,
} = {}) {
  const receipt = exactKeys(object(value, "Raspberry Pi doctor receipt"), [
    "schema", "result", "mode", "collectedAt", "durationMs", "target", "identity",
    "summary", "checks", "evidenceSha256",
  ], "Raspberry Pi doctor receipt");
  if (receipt.schema !== "stugu-rpi-doctor/v1") throw new Error("Raspberry Pi doctor schema is invalid");
  if (!new Set(["healthy", "attention", "failed"]).has(receipt.result)) throw new Error("Raspberry Pi doctor result is invalid");
  if (requireHealthy && receipt.result !== "healthy") throw new Error("Raspberry Pi doctor did not report a healthy target");
  if (!new Set(["default", "deep"]).has(receipt.mode)) throw new Error("Raspberry Pi doctor mode is invalid");
  date(receipt.collectedAt, "Raspberry Pi doctor collection time");
  if (maximumAgeMs !== undefined) {
    if (!Number.isSafeInteger(maximumAgeMs) || maximumAgeMs <= 0) {
      throw new Error("Raspberry Pi doctor maximum age is invalid");
    }
    const nowMs = validationTime(now ?? Date.now());
    const collectedAtMs = Date.parse(receipt.collectedAt);
    if (collectedAtMs > nowMs + RECEIPT_MAX_FUTURE_SKEW_MS) {
      throw new Error("Raspberry Pi doctor receipt is dated too far in the future");
    }
    if (nowMs - collectedAtMs > maximumAgeMs) {
      throw new Error("Raspberry Pi doctor receipt is stale");
    }
  }
  integer(receipt.durationMs, "Raspberry Pi doctor duration");
  exactKeys(object(receipt.target, "Raspberry Pi doctor target"), ["selectorSha256", "sshHostKeyFingerprint"], "Raspberry Pi doctor target");
  assertSha256(receipt.target.selectorSha256, "Raspberry Pi target selector sha256");
  if (selectorSha256 && receipt.target.selectorSha256 !== selectorSha256) throw new Error("Raspberry Pi doctor target does not match");
  if (!HOST_KEY.test(receipt.target.sshHostKeyFingerprint ?? "")) throw new Error("Raspberry Pi SSH host key fingerprint is missing");
  exactKeys(object(receipt.identity, "Raspberry Pi identity"), [
    "machineIdSha256", "hardwareFingerprint", "hostnameSha256",
  ], "Raspberry Pi identity");
  assertSha256(receipt.identity.machineIdSha256, "Raspberry Pi machine id sha256");
  if (!/^sha256:[0-9a-f]{64}$/u.test(receipt.identity.hardwareFingerprint ?? "")) {
    throw new Error("Raspberry Pi hardware fingerprint is invalid");
  }
  assertSha256(receipt.identity.hostnameSha256, "Raspberry Pi hostname sha256");
  object(receipt.summary, "Raspberry Pi doctor summary");
  if (!Array.isArray(receipt.checks) || receipt.checks.length === 0) throw new Error("Raspberry Pi doctor checks are missing");
  const ids = new Set();
  for (const [index, check] of receipt.checks.entries()) {
    exactKeys(object(check, `Raspberry Pi check ${index}`), ["id", "status", "summary"], `Raspberry Pi check ${index}`);
    string(check.id, `Raspberry Pi check ${index} id`, 100);
    if (!new Set(["pass", "warning", "fail"]).has(check.status)) throw new Error(`Raspberry Pi check ${index} status is invalid`);
    string(check.summary, `Raspberry Pi check ${index} summary`, 500);
    if (ids.has(check.id)) throw new Error("Raspberry Pi doctor check ids must be unique");
    ids.add(check.id);
  }
  exactGateIds(
    receipt.checks,
    receipt.mode === "deep" ? RPI_DOCTOR_DEEP_GATE_IDS : RPI_DOCTOR_DEFAULT_GATE_IDS,
    `Raspberry Pi doctor ${receipt.mode}`,
  );
  const diagnosedResult = receipt.checks.some((check) => check.status === "fail")
    ? "failed" : receipt.checks.some((check) => check.status === "warning") ? "attention" : "healthy";
  if (receipt.result !== diagnosedResult) throw new Error("Raspberry Pi doctor result contradicts its checks");
  assertSha256(receipt.evidenceSha256, "Raspberry Pi evidence sha256");
  return receipt;
}

export function validateReleaseVerificationReceipt(value, {
  maximumAgeMs,
  now,
  ...expected
} = {}) {
  const receipt = exactKeys(object(value, "release verification receipt"), [
    "schema", "result", "verifiedAt", "commit", "worktreeSha256", "version", "tagName",
    "repository", "channel", "cacheKey", "inputs", "draft", "images", "target",
    "deployment",
  ], "release verification receipt");
  if (receipt.schema !== "stugu-release-verification/v1" || receipt.result !== "passed") {
    throw new Error("release verification receipt did not pass");
  }
  date(receipt.verifiedAt, "release verification time");
  if (maximumAgeMs !== undefined) {
    if (!Number.isSafeInteger(maximumAgeMs) || maximumAgeMs <= 0) {
      throw new Error("release verification maximum age is invalid");
    }
    const nowMs = validationTime(now ?? Date.now());
    const verifiedAtMs = Date.parse(receipt.verifiedAt);
    if (verifiedAtMs > nowMs + RECEIPT_MAX_FUTURE_SKEW_MS) {
      throw new Error("release verification receipt is dated too far in the future");
    }
    if (nowMs - verifiedAtMs > maximumAgeMs) {
      throw new Error("release verification receipt is stale");
    }
  }
  commit(receipt.commit);
  assertSha256(receipt.worktreeSha256, "release worktree sha256");
  if (!VERSION.test(receipt.version ?? "") || receipt.tagName !== `v${receipt.version}` || !TAG.test(receipt.tagName)) {
    throw new Error("release version or tag is invalid");
  }
  if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/u.test(receipt.repository ?? "")) throw new Error("release repository is invalid");
  if (!new Set(["stable", "preview"]).has(receipt.channel)) throw new Error("release channel is invalid");
  assertSha256(receipt.cacheKey, "release cache key");
  exactKeys(object(receipt.inputs, "release inputs"), [
    "manifestSha256", "fullCiReceiptSha256", "compatibilityProofSha256",
    "draftPreparationSha256", "visualReceiptSha256", "targetReceiptSha256",
    "lockfileSha256", "configurationSha256",
  ], "release inputs");
  for (const [key, digest] of Object.entries(receipt.inputs)) assertSha256(digest, `release input ${key}`);
  validateDraftEvidence(receipt.draft, receipt.version);
  if (receipt.draft.channel !== receipt.channel) throw new Error("release draft channel does not match");
  const images = object(receipt.images, "release images");
  const expectedImages = ["api", "web", "backup", "tapo", "updateAgent", "mqtt", "nexus433"];
  exactKeys(images, expectedImages, "release images");
  for (const [name, image] of Object.entries(images)) {
    exactKeys(object(image, `release image ${name}`), [
      "reference", "indexDigest", "anonymousRead",
      "amd64ManifestDigest", "amd64ConfigDigest", "amd64DescriptorClosureSha256",
      "amd64ProvenanceSha256", "arm64ManifestDigest", "arm64ConfigDigest",
      "arm64DescriptorClosureSha256", "arm64ProvenanceSha256",
    ], `release image ${name}`);
    string(image.reference, `release image ${name} reference`, 500);
    if (image.anonymousRead !== true) throw new Error(`release image ${name} was not read anonymously`);
    for (const key of [
      "indexDigest", "amd64ManifestDigest", "amd64ConfigDigest",
      "arm64ManifestDigest", "arm64ConfigDigest",
    ]) {
      if (!/^sha256:[0-9a-f]{64}$/u.test(image[key] ?? "")) throw new Error(`release image ${name} ${key} is invalid`);
    }
    if (!image.reference.endsWith(`@${image.indexDigest}`)) {
      throw new Error(`release image ${name} reference does not match its index digest`);
    }
    for (const key of [
      "amd64DescriptorClosureSha256", "amd64ProvenanceSha256",
      "arm64DescriptorClosureSha256", "arm64ProvenanceSha256",
    ]) assertSha256(image[key], `release image ${name} ${key}`);
  }
  exactKeys(object(receipt.target, "release target"), [
    "selectorSha256", "sshHostKeyFingerprint", "machineIdSha256", "hardwareFingerprint",
  ], "release target");
  assertSha256(receipt.target.selectorSha256, "release target selector sha256");
  if (!HOST_KEY.test(receipt.target.sshHostKeyFingerprint ?? "")) throw new Error("release target host key is invalid");
  assertSha256(receipt.target.machineIdSha256, "release target machine id sha256");
  if (!/^sha256:[0-9a-f]{64}$/u.test(receipt.target.hardwareFingerprint ?? "")) throw new Error("release target hardware fingerprint is invalid");
  if (receipt.deployment !== null) {
    exactKeys(object(receipt.deployment, "release deployment binding"), [
      "artifactSha256", "uriSha256", "deviceIdSha256",
    ], "release deployment binding");
    assertSha256(receipt.deployment.artifactSha256, "release deployment artifact sha256");
    assertSha256(receipt.deployment.uriSha256, "release deployment URI sha256");
    assertSha256(receipt.deployment.deviceIdSha256, "release deployment device id sha256");
  }
  for (const [key, expectedValue] of Object.entries(expected)) {
    if (expectedValue !== undefined && receipt[key] !== expectedValue) throw new Error(`release receipt ${key} does not match`);
  }
  return receipt;
}
