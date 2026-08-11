#!/usr/bin/env node

import { lstatSync, readFileSync } from "node:fs";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { validateContainerReleaseManifest } from "./host-release-contract.mjs";
import { artifactDefinitions } from "./local-release-definition.mjs";
import {
  assetDigestsForPaths,
  validateDraftPreparation,
  validateGitHubRelease,
} from "./tooling/draft-release.mjs";
import {
  inspectMultiPlatformImage,
  withAnonymousRegistryEnvironment,
} from "./tooling/container-registry.mjs";
import {
  RELEASE_DOCTOR_RECEIPT_MAX_AGE_MS,
  validateCompatibilityProof,
  validateDoctorReceipt,
  validateLocalVerificationReceipt,
  validateReleaseVerificationReceipt,
  validateVisualAcceptanceReceipt,
} from "./tooling/receipt-contracts.mjs";
import {
  ToolFailure,
  appendLog,
  assertOutsideRepository,
  boundedJson,
  cacheKey,
  capture,
  changedFiles,
  failureText,
  logPathFor,
  repositorySnapshot,
  runLogged,
  sha256,
  sha256File,
  stateDirectory,
  verifyReceiptChecksum,
  writeJsonReceipt,
} from "./tooling/runtime.mjs";
import { targetSelectorSha256, validateSshTarget } from "./tooling/ssh-target.mjs";
import {
  assertPngDimensionsMatchViewport,
  parseVisualViewport,
} from "./tooling/visual-evidence.mjs";
import { findMatchingFullReceipt } from "./verify-local.mjs";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");

function usage() {
  return `Verify an already-built Stugu release without rebuilding or rerunning CI.

Usage:
  npm run release:verify -- --target USER@HOST \\
    --target-receipt PATH --visual-receipt PATH [options]

Options:
  --manifest PATH             Container artifact manifest (default: dist/rpi/release)
  --compatibility-proof PATH  Host/container compatibility proof (default: dist/rpi/release)
  --draft-preparation PATH    Exact prepared GitHub draft record (default: dist/rpi/release)
  --full-ci-receipt PATH      Exact full-CI receipt (default: exact local receipt cache)
  --base-ref REF              Base used to locate full CI (default: origin/main)
  --channel stable|preview    Intended release channel (default: stable)
  --deployment-artifact PATH  Optional legacy Connect artifact to bind
  --deployment-uri URL        HTTPS URI paired with that artifact
  --deployment-device-id UUID Connect device paired with the verified target

This command only reads files, Git state, the prepared GitHub draft, the
explicit doctor receipt, and digest-addressed registry manifests. It never runs
CI, builds, publishes, or connects to the appliance.
`;
}

function optionValue(argv, index, name) {
  const value = argv[index + 1];
  if (!value || value.startsWith("--")) throw new Error(`${name} needs a value`);
  return value;
}

export function parseArguments(argv) {
  const options = { baseRef: "origin/main", channel: "stable", help: false };
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    const values = new Map([
      ["--base-ref", "baseRef"],
      ["--compatibility-proof", "compatibilityProof"],
      ["--draft-preparation", "draftPreparation"],
      ["--full-ci-receipt", "fullCiReceipt"],
      ["--manifest", "manifest"],
      ["--target", "target"],
      ["--target-receipt", "targetReceipt"],
      ["--visual-receipt", "visualReceipt"],
      ["--channel", "channel"],
      ["--deployment-artifact", "deploymentArtifact"],
      ["--deployment-uri", "deploymentUri"],
      ["--deployment-device-id", "deploymentDeviceId"],
    ]);
    if (values.has(argument)) {
      options[values.get(argument)] = optionValue(argv, index, argument);
      index += 1;
    } else if (argument === "--help" || argument === "-h") {
      options.help = true;
    } else {
      throw new Error(`Unknown argument: ${argument}`);
    }
  }
  if (!options.help) {
    for (const name of ["target", "targetReceipt", "visualReceipt"]) {
      if (!options[name]) throw new Error(`--${name.replace(/[A-Z]/gu, (letter) => `-${letter.toLowerCase()}`)} is required`);
    }
    validateSshTarget(options.target);
    if (!new Set(["stable", "preview"]).has(options.channel)) throw new Error("--channel must be stable or preview");
    const deploymentValues = [options.deploymentArtifact, options.deploymentUri, options.deploymentDeviceId];
    if (deploymentValues.some(Boolean) && !deploymentValues.every(Boolean)) {
      throw new Error("deployment artifact, URI, and device ID must be supplied together");
    }
    if (options.deploymentDeviceId
      && !/^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/iu.test(options.deploymentDeviceId)) {
      throw new Error("--deployment-device-id must be a UUID");
    }
    if (options.deploymentUri) {
      const uri = new URL(options.deploymentUri);
      if (uri.protocol !== "https:" || uri.username || uri.password) {
        throw new Error("--deployment-uri must use HTTPS without credentials");
      }
    }
  }
  return options;
}

function readInput(path, label, maximumBytes = 2 * 1024 * 1024) {
  try {
    return boundedJson(path, label, maximumBytes);
  } catch (error) {
    throw new Error(`${label} is unavailable or invalid: ${error instanceof Error ? error.message : String(error)}`);
  }
}

function resolveReceipt(path, label) {
  const absolute = resolve(path);
  return assertOutsideRepository(absolute, root, label);
}

function inspectDraftRelease(tag, repository) {
  const raw = capture("gh", [
    "release", "view", tag, "--repo", repository,
    "--json", "assets,body,isDraft,isPrerelease,name,tagName,url",
  ], { cwd: root });
  try {
    return JSON.parse(raw);
  } catch (error) {
    throw new Error(`GitHub draft response is invalid: ${error instanceof Error ? error.message : String(error)}`);
  }
}

function repositoryRelativePaths(baseCommit, commit) {
  const output = capture("git", ["diff", "--name-only", "--diff-filter=ACDMRTUXB", `${baseCommit}..${commit}`, "--"], {
    cwd: root,
  });
  return String(output).split(/\r?\n/u).filter(Boolean).map((path) => path.replaceAll("\\", "/"));
}

function renderedSurface(path) {
  if (/^apps\/web\/(?:src\/|public\/|index\.html$)/u.test(path)
    && !/(?:^|\/)(?:tests?|__tests__)\//u.test(path)
    && !/\.(?:test|spec)\.[cm]?[jt]sx?$/u.test(path)) return "web";
  if (/^apps\/ios\/(?:Sources|Resources)\//u.test(path)) return "native";
  return null;
}

function hasMaterialRenderedChange(baseCommit, commit, path) {
  const output = capture(
    "git",
    ["diff", "--ignore-all-space", "--ignore-blank-lines", "--numstat", `${baseCommit}..${commit}`, "--", path],
    { cwd: root },
  );
  return Boolean(String(output).trim());
}

function verifyVisualEvidence(receipt, receiptPath, snapshot) {
  const mergeBase = String(capture("git", ["merge-base", receipt.baseCommit, snapshot.commit], { cwd: root })).trim();
  if (mergeBase !== receipt.baseCommit) throw new Error("visual acceptance base is not an ancestor of the release commit");
  const changes = repositoryRelativePaths(receipt.baseCommit, snapshot.commit);
  const obviousSurfaces = new Set(changes
    .filter((path) => renderedSurface(path)
      && hasMaterialRenderedChange(receipt.baseCommit, snapshot.commit, path))
    .map(renderedSurface)
    .filter(Boolean));
  if (!receipt.renderedScreenChanges && obviousSurfaces.size > 0) {
    throw new Error(`visual acceptance says not applicable despite ${[...obviousSurfaces].join(" and ")} screen changes`);
  }
  const scenarioSurfaces = new Set(receipt.scenarios.map((scenario) => scenario.surface));
  for (const surface of obviousSurfaces) {
    if (!scenarioSurfaces.has(surface)) throw new Error(`visual acceptance lacks a ${surface} scenario`);
  }
  if (scenarioSurfaces.has("web")) {
    const combinations = new Set(receipt.scenarios
      .filter((scenario) => scenario.surface === "web")
      .map((scenario) => `${parseVisualViewport(scenario.viewport).width}:${scenario.theme}`));
    for (const required of ["320:light", "320:dark", "1440:light", "1440:dark"]) {
      if (!combinations.has(required)) throw new Error(`visual acceptance lacks web coverage for ${required}`);
    }
  }
  const receiptDirectory = dirname(receiptPath);
  for (const scenario of receipt.scenarios) {
    const screenshotPath = scenario.screenshot.path;
    if (isAbsolute(screenshotPath) || screenshotPath.split(/[\\/]/u).includes("..")) {
      throw new Error("visual screenshot paths must be relative to the receipt without traversal");
    }
    const absolute = resolve(receiptDirectory, screenshotPath);
    const local = relative(receiptDirectory, absolute);
    if (local === ".." || local.startsWith(`..${sep}`)) throw new Error("visual screenshot escapes its receipt directory");
    const details = lstatSync(absolute);
    if (!details.isFile() || details.isSymbolicLink()) throw new Error(`visual screenshot is not a regular file: ${screenshotPath}`);
    if (sha256File(absolute) !== scenario.screenshot.sha256) throw new Error(`visual screenshot hash differs: ${screenshotPath}`);
    assertPngDimensionsMatchViewport(absolute, scenario.viewport, `visual screenshot ${screenshotPath}`);
  }
  return changes;
}

export function exactManifestDigest(raw, expected) {
  const digest = expected.slice("sha256:".length);
  if (sha256(raw) === digest) return true;
  if (raw.endsWith("\r\n") && sha256(raw.slice(0, -2)) === digest) return true;
  if (raw.endsWith("\n") && sha256(raw.slice(0, -1)) === digest) return true;
  return false;
}

function parseRegistryJson(raw, label) {
  try {
    const value = JSON.parse(raw);
    if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("body is not an object");
    return value;
  } catch (error) {
    throw new Error(`${label} is not valid JSON: ${error instanceof Error ? error.message : String(error)}`);
  }
}

async function registryManifest(reference, expectedDigest, label, logPath, environment) {
  const result = await runLogged({
    command: "docker",
    args: ["buildx", "imagetools", "inspect", "--raw", reference],
    cwd: root,
    env: environment,
    logPath,
    timeoutMs: 30_000,
    capture: true,
  });
  if (result.status !== 0) {
    throw new Error(`${label} could not be read anonymously from the registry${result.timedOut ? " before timeout" : ""}`);
  }
  if (!exactManifestDigest(result.stdoutRaw, expectedDigest)) {
    throw new Error(`${label} bytes do not match ${expectedDigest}`);
  }
  return parseRegistryJson(result.stdoutRaw, label);
}

async function registryProvenance(reference, label, logPath, environment) {
  const result = await runLogged({
    command: "docker",
    args: ["buildx", "imagetools", "inspect", "--format", "{{json .Provenance}}", reference],
    cwd: root,
    env: environment,
    logPath,
    timeoutMs: 30_000,
    capture: true,
    sanitizeLogLine: () => null,
  });
  if (result.status !== 0) throw new Error(`${label} could not be read anonymously from the registry`);
  return parseRegistryJson(result.stdoutRaw, label);
}

export async function inspectReleaseImage(name, reference, commit, logPath, environment) {
  const separator = reference.lastIndexOf("@sha256:");
  if (separator < 1) throw new Error(`${name} image is not digest-pinned`);
  const tagReference = reference.slice(0, separator);
  const expectedDigest = reference.slice(separator + 1);
  const tagResult = await runLogged({
    command: "docker",
    args: ["buildx", "imagetools", "inspect", "--format", "{{.Manifest.Digest}}", tagReference],
    cwd: root,
    env: environment,
    logPath,
    timeoutMs: 30_000,
    capture: true,
  });
  if (tagResult.status !== 0) throw new Error(`${name} version tag is not anonymously readable`);
  if (tagResult.stdout.trim() !== expectedDigest) {
    throw new Error(`${name} version tag does not point to the pinned image index`);
  }
  return inspectMultiPlatformImage(name, reference, commit, {
    manifest: (candidate, digest, label) => registryManifest(
      candidate,
      digest,
      label,
      logPath,
      environment,
    ),
    provenance: (candidate, label) => registryProvenance(
      candidate,
      label,
      logPath,
      environment,
    ),
  });
}

function receiptPath(version, snapshot, key, env) {
  return join(
    stateDirectory(root, env),
    "receipts",
    "release",
    snapshot.commit,
    key,
    `stugu-${version}-release-verification.json`,
  );
}

function sameObject(left, right) {
  return cacheKey(left) === cacheKey(right);
}

function failure(code, cause, next, logPath, source) {
  appendLog(logPath, `${source instanceof Error ? source.message : String(source ?? cause)}\n`);
  return new ToolFailure(code, cause, next, logPath, source ? { cause: source } : {});
}

export async function main(argv = process.argv.slice(2), env = process.env) {
  const logPath = logPathFor(root, "release-verify", env);
  try {
  let options;
  try {
    options = parseArguments(argv);
  } catch (error) {
    throw failure("RELEASE_VERIFY_USAGE", error.message, "npm run release:verify -- --help", logPath, error);
  }
  if (options.help) {
    console.log(usage());
    return null;
  }
  const packageVersion = JSON.parse(readFileSync(resolve(root, "package.json"), "utf8")).version;
  const artifacts = artifactDefinitions(root, packageVersion);
  const manifestPath = resolve(options.manifest ?? artifacts.releaseManifest);
  const compatibilityPath = resolve(
    options.compatibilityProof ?? join(artifacts.releaseDirectory, "stugu-release-compatibility-proof-v1.json"),
  );
  const draftPreparationPath = resolve(options.draftPreparation ?? artifacts.draftPreparation);
  const visualPath = resolveReceipt(options.visualReceipt, "visual acceptance receipt");
  const targetPath = resolveReceipt(options.targetReceipt, "Raspberry Pi doctor receipt");
  let snapshot;
  try {
    snapshot = repositorySnapshot(root);
    if (snapshot.dirty) throw new Error("release verification requires a clean worktree");
  } catch (error) {
    throw failure(
      "RELEASE_VERIFY_WORKTREE",
      error.message,
      "Use a fresh checkout at the intended release commit, then rerun release:verify.",
      logPath,
      error,
    );
  }

  let fullPath = options.fullCiReceipt ? resolveReceipt(options.fullCiReceipt, "full CI receipt") : null;
  if (!fullPath) {
    try {
      fullPath = findMatchingFullReceipt(root, snapshot, options.baseRef, env)?.path ?? null;
    } catch (error) {
      throw failure(
        "RELEASE_VERIFY_FULL_CI",
        `The exact full-CI receipt could not be located: ${error.message}`,
        "npm run verify:local -- --full",
        logPath,
        error,
      );
    }
  }
  if (!fullPath) {
    throw failure(
      "RELEASE_VERIFY_FULL_CI",
      "No valid full-CI receipt matches this exact commit and clean worktree.",
      "npm run verify:local -- --full",
      logPath,
    );
  }

  let manifest;
  let compatibility;
  let draftPreparation;
  let visual;
  let target;
  let manifestSha256;
  let fullCiReceiptSha256;
  let compatibilityProofSha256;
  let draftPreparationSha256;
  let fullCiChecksumPath;
  let visualReceiptSha256;
  let targetReceiptSha256;
  try {
    manifest = validateContainerReleaseManifest(readInput(manifestPath, "artifact manifest"), packageVersion);
    manifestSha256 = sha256File(manifestPath);
  } catch (error) {
    throw failure("RELEASE_VERIFY_MANIFEST", error.message, "Prepare the draft artifacts, then rerun release:verify.", logPath, error);
  }
  try {
    const fullCi = validateLocalVerificationReceipt(readInput(fullPath, "full CI receipt"), {
      mode: "full", snapshot, requireClean: true, projectVersion: packageVersion,
    });
    const expectedBase = changedFiles(root, options.baseRef);
    if (fullCi.base?.ref !== expectedBase.baseRef
      || fullCi.base?.commit !== expectedBase.baseCommit
      || fullCi.base?.mergeBase !== expectedBase.mergeBase) {
      throw new Error("full CI receipt does not match the requested current base");
    }
    const fullCiChecksum = verifyReceiptChecksum(fullPath, "full CI receipt");
    fullCiReceiptSha256 = fullCiChecksum.sha256;
    fullCiChecksumPath = fullCiChecksum.checksumPath;
  } catch (error) {
    throw failure("RELEASE_VERIFY_FULL_CI", error.message, "npm run verify:local -- --full", logPath, error);
  }
  try {
    compatibility = validateCompatibilityProof(readInput(compatibilityPath, "compatibility proof"), {
      commit: snapshot.commit,
      version: packageVersion,
      manifestSha256,
      fullCiReceiptSha256,
    });
    if (compatibility.hostInputs.containerManifestSha256 !== manifestSha256
      || compatibility.hostInputs.sourceCommit !== snapshot.commit) {
      throw new Error("compatibility host inputs do not bind the artifact manifest and release commit");
    }
    compatibilityProofSha256 = sha256File(compatibilityPath);
    verifyReceiptChecksum(compatibilityPath, "compatibility proof");
  } catch (error) {
    throw failure(
      "RELEASE_VERIFY_COMPATIBILITY",
      error.message,
      "Regenerate the compatibility proof from the exact prepared host inputs.",
      logPath,
      error,
    );
  }

  try {
    draftPreparation = validateDraftPreparation(
      readInput(draftPreparationPath, "draft preparation", 512 * 1024),
      {
        commit: snapshot.commit,
        version: packageVersion,
        repository: manifest.repository,
        channel: options.channel,
      },
    );
    draftPreparationSha256 = verifyReceiptChecksum(
      draftPreparationPath,
      "draft preparation",
    ).sha256;
    const assetPaths = [
      manifestPath,
      fullPath,
      fullCiChecksumPath,
      compatibilityPath,
      `${compatibilityPath}.sha256`,
      artifacts.nexus433Source,
      artifacts.nexus433SourceChecksum,
    ];
    if (draftPreparation.draft.factoryUploaded) {
      assetPaths.push(artifacts.factory, artifacts.factoryChecksum);
    }
    const localAssets = assetDigestsForPaths(assetPaths);
    if (!sameObject(localAssets, draftPreparation.draft.assets)) {
      throw new Error("prepared local release assets differ from the reviewed draft asset set");
    }
    validateGitHubRelease(
      inspectDraftRelease(manifest.tagName, manifest.repository),
      draftPreparation.draft,
      { tagName: manifest.tagName, requireDraft: true },
    );
  } catch (error) {
    throw failure(
      "RELEASE_VERIFY_DRAFT",
      error.message,
      "Restore the exact prepared draft metadata and assets, then rerun release:verify.",
      logPath,
      error,
    );
  }
  try {
    visual = validateVisualAcceptanceReceipt(readInput(visualPath, "visual acceptance receipt"), snapshot.commit);
    verifyVisualEvidence(visual, visualPath, snapshot);
    visualReceiptSha256 = sha256File(visualPath);
  } catch (error) {
    throw failure(
      "RELEASE_VERIFY_VISUAL",
      error.message,
      "Complete the visual-acceptance contract for this commit and rerun release:verify.",
      logPath,
      error,
    );
  }
  const selectorSha256 = targetSelectorSha256(options.target);
  try {
    target = validateDoctorReceipt(readInput(targetPath, "Raspberry Pi doctor receipt"), {
      selectorSha256,
      requireHealthy: true,
      maximumAgeMs: RELEASE_DOCTOR_RECEIPT_MAX_AGE_MS,
      now: Date.now(),
    });
    targetReceiptSha256 = verifyReceiptChecksum(targetPath, "Raspberry Pi doctor receipt").sha256;
  } catch (error) {
    throw failure(
      "RELEASE_VERIFY_TARGET",
      error.message,
      "npm run rpi:doctor -- --target USER@HOST",
      logPath,
      error,
    );
  }

  let deployment = null;
  if (options.deploymentArtifact) {
    try {
      const artifactPath = resolve(options.deploymentArtifact);
      const details = lstatSync(artifactPath);
      if (!details.isFile() || details.isSymbolicLink() || details.size === 0) {
        throw new Error("deployment artifact must be a non-empty regular file");
      }
      deployment = {
        artifactSha256: sha256File(artifactPath),
        uriSha256: sha256(options.deploymentUri),
        deviceIdSha256: sha256(options.deploymentDeviceId.toLowerCase()),
      };
    } catch (error) {
      throw failure(
        "RELEASE_VERIFY_DEPLOYMENT",
        error.message,
        "Correct the deployment artifact, HTTPS URI, and target device ID, then rerun release:verify.",
        logPath,
        error,
      );
    }
  }

  const inputDigests = {
    manifestSha256,
    fullCiReceiptSha256,
    compatibilityProofSha256,
    draftPreparationSha256,
    visualReceiptSha256,
    targetReceiptSha256,
    lockfileSha256: snapshot.lockfileSha256,
    configurationSha256: snapshot.configurationSha256,
  };

  const key = cacheKey({
    schema: "stugu-release-verification-cache/v1",
    commit: snapshot.commit,
    worktreeSha256: snapshot.worktreeSha256,
    repository: manifest.repository,
    channel: options.channel,
    inputs: inputDigests,
    targetSelectorSha256: selectorSha256,
    deployment,
  });
  const outputPath = receiptPath(packageVersion, snapshot, key, env);
  let cachedReceipt = null;
  try {
    verifyReceiptChecksum(outputPath, "release verification receipt");
    const cached = validateReleaseVerificationReceipt(readInput(outputPath, "release verification receipt"), {
      commit: snapshot.commit,
      worktreeSha256: snapshot.worktreeSha256,
      version: packageVersion,
      repository: manifest.repository,
      channel: options.channel,
      cacheKey: key,
    });
    if (!sameObject(cached.inputs, inputDigests)
      || !sameObject(cached.draft, draftPreparation.draft)
      || cached.target.selectorSha256 !== selectorSha256
      || !sameObject(cached.deployment, deployment)
      || !sameObject(Object.fromEntries(Object.entries(cached.images).map(([name, image]) => [name, image.reference])), manifest.images)) {
      throw new Error("cached release verification does not bind the exact current inputs");
    }
    cachedReceipt = cached;
  } catch {
    // No valid exact-input cache receipt. Registry evidence is always inspected below
    // because anonymous package readability is mutable even when digests are not.
  }

  const images = {};
  await withAnonymousRegistryEnvironment(env, async (anonymousEnvironment) => {
    for (const [name, reference] of Object.entries(manifest.images)) {
      console.log(`[release:verify] ${name} anonymous AMD64/ARM64 identity and provenance`);
      try {
        images[name] = await inspectReleaseImage(
          name,
          reference,
          snapshot.commit,
          logPath,
          anonymousEnvironment,
        );
      } catch (error) {
        throw failure(
          `RELEASE_VERIFY_IMAGE_${name.replace(/([a-z])([A-Z])/gu, "$1_$2").toUpperCase()}`,
          error.message,
          `Make the immutable ${name} package public and correct its platform provenance, then rerun release:verify.`,
          logPath,
          error,
        );
      }
    }
  });
  const after = repositorySnapshot(root);
  if (after.commit !== snapshot.commit || after.worktreeSha256 !== snapshot.worktreeSha256) {
    throw failure(
      "RELEASE_VERIFY_WORKTREE_CHANGED",
      "The commit or worktree changed while release verification was running.",
      "Stop concurrent edits, restore the fresh checkout, then rerun release:verify.",
      logPath,
    );
  }
  if (cachedReceipt) {
    if (!sameObject(cachedReceipt.images, images)) {
      throw failure(
        "RELEASE_VERIFY_REGISTRY_CHANGED",
        "Current anonymous registry evidence differs from the cached release receipt.",
        "Inspect package visibility and immutable manifests, then rerun release:verify.",
        logPath,
      );
    }
    console.log(`Release verification reused after current anonymous registry checks for ${snapshot.commit.slice(0, 12)}.`);
    console.log(`Receipt: ${outputPath}`);
    return { receipt: cachedReceipt, path: outputPath, reused: true };
  }
  const receipt = {
    schema: "stugu-release-verification/v1",
    result: "passed",
    verifiedAt: new Date().toISOString(),
    commit: snapshot.commit,
    worktreeSha256: snapshot.worktreeSha256,
    version: packageVersion,
    tagName: manifest.tagName,
    repository: manifest.repository,
    channel: options.channel,
    cacheKey: key,
    inputs: inputDigests,
    draft: draftPreparation.draft,
    images,
    target: {
      selectorSha256,
      sshHostKeyFingerprint: target.target.sshHostKeyFingerprint,
      machineIdSha256: target.identity.machineIdSha256,
      hardwareFingerprint: target.identity.hardwareFingerprint,
    },
    deployment,
  };
  validateReleaseVerificationReceipt(receipt, {
    commit: snapshot.commit,
    worktreeSha256: snapshot.worktreeSha256,
    version: packageVersion,
    repository: manifest.repository,
    channel: options.channel,
    cacheKey: key,
  });
  const written = writeJsonReceipt(outputPath, receipt);
  console.log(`Release ${manifest.tagName} verified for ${snapshot.commit.slice(0, 12)} and the selected appliance.`);
  console.log(`Receipt: ${written.path}`);
  return { receipt, path: written.path, reused: false };
  } catch (error) {
    if (error instanceof ToolFailure) throw error;
    appendLog(logPath, `${error instanceof Error ? error.stack : String(error)}\n`);
    throw new ToolFailure(
      "RELEASE_VERIFY_INTERNAL",
      error instanceof Error ? error.message : String(error),
      "Inspect the detailed log, correct the first invalid input, then rerun release:verify.",
      logPath,
      { cause: error },
    );
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    console.error(failureText(error, {
      code: "RELEASE_VERIFY_FAILED",
      next: "Inspect the detailed log, correct the first failed input, then rerun release:verify.",
    }));
    process.exitCode = 1;
  });
}
