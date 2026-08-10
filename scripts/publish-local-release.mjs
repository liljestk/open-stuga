#!/usr/bin/env node

import { createHash } from "node:crypto";
import {
  copyFileSync,
  createReadStream,
  existsSync,
  mkdirSync,
  readFileSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { basename, dirname, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";

import { buildNexus433SourceBundle } from "./build-nexus433-source-bundle.mjs";
import {
  artifactDefinitions,
  containerTargets,
  imageDefinitions,
} from "./local-release-definition.mjs";
import { releaseManifest } from "./local-release-manifest.mjs";
import { validateContainerReleaseManifest } from "./host-release-contract.mjs";
import {
  RELEASE_VERIFICATION_RECEIPT_MAX_AGE_MS,
  validateLocalVerificationReceipt,
  validateReleaseVerificationReceipt,
} from "./tooling/receipt-contracts.mjs";
import { writeCompatibilityProof } from "./tooling/compatibility-proof.mjs";
import {
  inspectMultiPlatformImage,
  withAnonymousRegistryEnvironment,
} from "./tooling/container-registry.mjs";
import {
  assetDigestsForPaths,
  createDraftPreparation,
  normalizeReleaseBody,
  unexpectedGitHubAssets,
  validateDraftPreparation,
  validateGitHubRelease,
} from "./tooling/draft-release.mjs";
import {
  assertOutsideRepository,
  boundedJson as toolingBoundedJson,
  cacheKey as toolingCacheKey,
  repositorySnapshot,
  sha256File as toolingSha256File,
  verifyReceiptChecksum,
  writeJsonReceipt as toolingWriteJsonReceipt,
} from "./tooling/runtime.mjs";

export { artifactDefinitions, imageDefinitions } from "./local-release-definition.mjs";
export { releaseManifest } from "./local-release-manifest.mjs";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const rpiBuilderImage =
  "debian:trixie-slim@sha256:020c0d20b9880058cbe785a9db107156c3c75c2ac944a6aa7ab59f2add76a7bd";

function usage() {
  return `Build and publish a Stugu release from local Docker.

Usage:
  npm run release:local -- --ssh-public-key PATH --full-ci-receipt PATH --keep-draft --publish [options]
  npm run release:local -- --verification-receipt PATH --publish

Required for publishing:
  --ssh-public-key PATH    Recovery public key embedded in the factory image
  --host-generation N      Monotonic host generation embedded in both slots
  --host-tuf-root PATH     Offline-approved public TUF root v1
  --host-rauc-ca PATH      Offline-approved public RAUC CA certificate
  --host-update-base-url URL
                           HTTPS base URL of the TUF repository
  --publish                Execute registry and GitHub writes; otherwise print plan only

Options:
  --tag TAG                Release tag (default: v<package.json version>)
  --notes-file PATH        Release notes; required for a separate artifact repo
  --repository OWNER/REPO  Public artifact repository (default: origin)
  --image-prefix PREFIX    GHCR prefix (default: ghcr.io/<owner>/<repo>)
  --builder NAME           Buildx builder (default: stugu-release-local)
  --reuse-containers       Reuse and resolve already-published image tags
  --host-qualification PATH
                           Immutable lab receipt; omit to disable activation
  --upload-factory         Also attach the factory image to the public release
  --prerelease             Mark the published GitHub release as a preview
  --keep-draft             Push public image tags/assets; leave release draft
  --full-ci-receipt PATH   Exact clean-worktree receipt from verify:local --full
  --verification-receipt PATH
                           Final release:verify receipt; publishes an existing draft only
  --help                   Show this help

The factory image stays under dist/rpi by default. Never upload a factory image
that contains a Raspberry Pi Connect auth key or another provisioning secret.
Preparation always leaves a draft. Final publication only consumes a matching
release:verify receipt and never rebuilds or reruns CI.
Plan-only mode does not validate tags, files, credentials, CI, or artifacts.
`;
}

function optionValue(argv, index, name) {
  const value = argv[index + 1];
  if (!value || value.startsWith("--")) throw new Error(`${name} needs a value`);
  return value;
}

export function parseArguments(argv) {
  const options = {
    builder: "stugu-release-local",
    help: false,
    keepDraft: false,
    prerelease: false,
    publish: false,
    providedArguments: [],
    reuseContainers: false,
    uploadFactory: false,
  };

  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument.startsWith("--")) options.providedArguments.push(argument.split("=", 1)[0]);
    switch (argument) {
      case "--builder":
        options.builder = optionValue(argv, index, argument);
        index += 1;
        break;
      case "--help":
      case "-h":
        options.help = true;
        break;
      case "--image-prefix":
        options.imagePrefix = optionValue(argv, index, argument);
        index += 1;
        break;
      case "--host-generation":
        options.hostGeneration = optionValue(argv, index, argument);
        index += 1;
        break;
      case "--full-ci-receipt":
        options.fullCiReceipt = optionValue(argv, index, argument);
        index += 1;
        break;
      case "--host-qualification":
        options.hostQualification = optionValue(argv, index, argument);
        index += 1;
        break;
      case "--host-rauc-ca":
        options.hostRaucCa = optionValue(argv, index, argument);
        index += 1;
        break;
      case "--host-tuf-root":
        options.hostTufRoot = optionValue(argv, index, argument);
        index += 1;
        break;
      case "--host-update-base-url":
        options.hostUpdateBaseUrl = optionValue(argv, index, argument);
        index += 1;
        break;
      case "--notes-file":
        options.notesFile = optionValue(argv, index, argument);
        index += 1;
        break;
      case "--keep-draft":
        options.keepDraft = true;
        break;
      case "--prerelease":
        options.prerelease = true;
        break;
      case "--publish":
        options.publish = true;
        break;
      case "--repository":
        options.repository = optionValue(argv, index, argument);
        index += 1;
        break;
      case "--reuse-containers":
        options.reuseContainers = true;
        break;
      case "--ssh-public-key":
        options.sshPublicKey = optionValue(argv, index, argument);
        index += 1;
        break;
      case "--tag":
        options.tag = optionValue(argv, index, argument);
        index += 1;
        break;
      case "--upload-factory":
        options.uploadFactory = true;
        break;
      case "--verification-receipt":
        options.verificationReceipt = optionValue(argv, index, argument);
        index += 1;
        break;
      default:
        throw new Error(`Unknown argument: ${argument}`);
    }
  }

  return options;
}

export function repositoryFromRemote(remote) {
  const normalized = remote.trim().replace(/\.git$/u, "");
  const match = /github\.com(?::|\/)([^/:\s]+\/[^/\s]+)$/u.exec(normalized);
  if (!match) throw new Error(`Could not identify a GitHub repository from origin: ${remote}`);
  return match[1];
}

export function requirePublicReleaseRepository(repository, visibility) {
  if (visibility !== "PUBLIC") {
    throw new Error(
      `Release repository ${repository} must be public; pass --repository OWNER/PUBLIC-REPO`,
    );
  }
}

export function requireReleaseRepositoryTag(repository, tag, status) {
  if (status !== 0) {
    throw new Error(
      `Public release repository ${repository} must already contain its own ${tag} tag`,
    );
  }
}

function printable(command, args) {
  const quote = (value) => (/[\s"]/u.test(value) ? JSON.stringify(value) : value);
  return [command, ...args].map(quote).join(" ");
}

export function platformInvocation(
  command,
  args,
  {
    platform = process.platform,
    env = process.env,
    execPath = process.execPath,
  } = {},
) {
  if (platform === "win32" && command === "npm") {
    if (!env.npm_execpath) {
      throw new Error(
        "npm_execpath is required on Windows; run the publisher through npm run release:local",
      );
    }
    return {
      command: execPath,
      args: [env.npm_execpath, ...args],
    };
  }
  return { command, args };
}

function invoke(command, args, options = {}) {
  if (!options.quiet) console.log(`\n> ${printable(command, args)}`);
  const invocation = platformInvocation(command, args);
  const result = spawnSync(invocation.command, invocation.args, {
    cwd: options.cwd ?? root,
    encoding: "utf8",
    env: options.env ?? process.env,
    input: options.input,
    stdio: options.capture
      ? ["pipe", "pipe", "pipe"]
      : options.input === undefined
        ? "inherit"
        : ["pipe", "inherit", "inherit"],
  });
  if (result.error) throw result.error;
  if (result.status !== 0 && !options.allowFailure) {
    const detail = result.stderr?.trim();
    throw new Error(
      `${command} exited with status ${result.status}${detail ? `: ${detail}` : ""}`,
    );
  }
  return result;
}

function capture(command, args, options = {}) {
  return invoke(command, args, { ...options, capture: true }).stdout.trim();
}

function requireFile(path, description) {
  if (!existsSync(path) || !statSync(path).isFile() || statSync(path).size === 0) {
    throw new Error(`${description} is missing or empty: ${path}`);
  }
}

function fullCiEvidence(path, snapshot, version) {
  const absolute = assertOutsideRepository(resolve(path), root, "full CI receipt");
  const receipt = validateLocalVerificationReceipt(
    toolingBoundedJson(absolute, "full CI receipt", 8 * 1024 * 1024),
    { mode: "full", snapshot, requireClean: true },
  );
  if (receipt.projectVersion !== version) throw new Error("full CI receipt version differs from the release");
  const checksum = verifyReceiptChecksum(absolute, "full CI receipt");
  return { path: absolute, receipt, digest: checksum.sha256, checksumPath: checksum.checksumPath };
}

function releaseVerificationEvidence(path, snapshot, { version, repository, artifacts }) {
  const absolute = assertOutsideRepository(resolve(path), root, "release verification receipt");
  const receipt = validateReleaseVerificationReceipt(
    toolingBoundedJson(absolute, "release verification receipt", 4 * 1024 * 1024),
    {
      commit: snapshot.commit,
      worktreeSha256: snapshot.worktreeSha256,
      version,
      repository,
      maximumAgeMs: RELEASE_VERIFICATION_RECEIPT_MAX_AGE_MS,
      now: Date.now(),
    },
  );
  const expectedCacheKey = toolingCacheKey({
    schema: "stugu-release-verification-cache/v1",
    commit: receipt.commit,
    worktreeSha256: receipt.worktreeSha256,
    repository: receipt.repository,
    channel: receipt.channel,
    inputs: receipt.inputs,
    targetSelectorSha256: receipt.target.selectorSha256,
    deployment: receipt.deployment,
  });
  if (receipt.cacheKey !== expectedCacheKey) throw new Error("release verification cache key is invalid");
  const manifest = validateContainerReleaseManifest(
    toolingBoundedJson(artifacts.releaseManifest, "container release manifest", 128 * 1024),
    version,
  );
  if (toolingSha256File(artifacts.releaseManifest) !== receipt.inputs.manifestSha256) {
    throw new Error("local release manifest differs from the verified manifest");
  }
  verifyReceiptChecksum(artifacts.compatibilityProof, "compatibility proof");
  if (toolingSha256File(artifacts.compatibilityProof) !== receipt.inputs.compatibilityProofSha256) {
    throw new Error("local compatibility proof differs from the verified proof");
  }
  const preparation = validateDraftPreparation(
    toolingBoundedJson(artifacts.draftPreparation, "draft preparation", 512 * 1024),
    { commit: snapshot.commit, version, repository, channel: receipt.channel },
  );
  const preparationChecksum = verifyReceiptChecksum(artifacts.draftPreparation, "draft preparation");
  if (preparationChecksum.sha256 !== receipt.inputs.draftPreparationSha256) {
    throw new Error("local draft preparation differs from the verified draft");
  }
  if (toolingCacheKey(preparation.draft) !== toolingCacheKey(receipt.draft)) {
    throw new Error("verified draft evidence differs from the local draft preparation");
  }
  const receiptImages = Object.fromEntries(
    Object.entries(receipt.images).map(([name, image]) => [name, image.reference]),
  );
  if (toolingCacheKey(receiptImages) !== toolingCacheKey(manifest.images)) {
    throw new Error("verified images differ from the local release manifest");
  }
  const checksum = verifyReceiptChecksum(absolute, "release verification receipt");
  const expectedName = `stugu-${version}-release-verification.json`;
  if (basename(absolute) !== expectedName || basename(checksum.checksumPath) !== `${expectedName}.sha256`) {
    throw new Error(`release verification receipt must retain its canonical filename ${expectedName}`);
  }
  return {
    path: absolute,
    receipt,
    manifest,
    digest: checksum.sha256,
    checksumPath: checksum.checksumPath,
  };
}

function validatePublicKey(path) {
  requireFile(path, "SSH public key");
  const key = readFileSync(path, "utf8").trim();
  if (!/^(ssh-ed25519|ssh-rsa|ecdsa-sha2-nistp\d+)\s+\S+/u.test(key)) {
    throw new Error("The recovery key must be an OpenSSH public key");
  }
}

export function validateHostReleaseSettings({ generation, baseUrl }) {
  const parsedGeneration = Number(generation);
  if (!/^[1-9][0-9]*$/u.test(generation ?? "")
    || !Number.isSafeInteger(parsedGeneration)
    || parsedGeneration < 1) {
    throw new Error("Host generation must be a positive monotonic integer");
  }
  let parsed;
  try {
    parsed = new URL(baseUrl);
  } catch {
    throw new Error("Host update base URL must be HTTPS");
  }
  if (parsed.protocol !== "https:" || parsed.username || parsed.password
    || parsed.search || parsed.hash) {
    throw new Error("Host update base URL must be HTTPS without credentials, query, or fragment");
  }
}

async function sha256(path) {
  return new Promise((resolveHash, reject) => {
    const hash = createHash("sha256");
    const stream = createReadStream(path);
    stream.on("error", reject);
    stream.on("data", (chunk) => hash.update(chunk));
    stream.on("end", () => resolveHash(hash.digest("hex")));
  });
}

function verifyGitRelease(tag) {
  invoke("git", ["fetch", "origin", "main", "--tags"]);
  const status = capture("git", ["status", "--porcelain"]);
  if (status) throw new Error("Release publishing requires a clean worktree");

  const head = capture("git", ["rev-parse", "HEAD"]);
  const tagCommit = capture("git", ["rev-parse", `${tag}^{commit}`]);
  if (head !== tagCommit) throw new Error(`${tag} does not point to the checked-out commit`);

  const onMain = invoke(
    "git",
    ["merge-base", "--is-ancestor", head, "origin/main"],
    { allowFailure: true, capture: true, quiet: true },
  );
  if (onMain.status !== 0) throw new Error(`${tag} is not contained in origin/main`);

  const remoteRefs = capture("git", [
    "ls-remote",
    "--tags",
    "origin",
    `refs/tags/${tag}`,
    `refs/tags/${tag}^{}`,
  ]);
  const remoteCommits = remoteRefs
    .split(/\r?\n/u)
    .filter(Boolean)
    .map((line) => line.split(/\s+/u)[0]);
  if (!remoteCommits.includes(head)) throw new Error(`${tag} is not pushed to origin`);

  return head;
}

function ensureBuilder(builder) {
  const inspected = invoke("docker", ["buildx", "inspect", builder], {
    allowFailure: true,
    capture: true,
    quiet: true,
  });
  if (inspected.status !== 0) {
    invoke("docker", [
      "buildx",
      "create",
      "--name",
      builder,
      "--driver",
      "docker-container",
    ]);
  }
  invoke("docker", ["buildx", "inspect", builder, "--bootstrap"]);
}

function registryLogin(env) {
  const token = env.GHCR_TOKEN?.trim() || capture("gh", ["auth", "token"], { quiet: true });
  const username =
    env.GHCR_USERNAME?.trim() ||
    capture("gh", ["api", "user", "--jq", ".login"], { quiet: true });
  if (!token || !username) throw new Error("GHCR authentication is unavailable");
  invoke(
    "docker",
    ["login", "ghcr.io", "--username", username, "--password-stdin"],
    { input: `${token}\n` },
  );
}

function inspectContainerTag(image, environment = process.env) {
  const result = invoke("docker", [
    "buildx", "imagetools", "inspect", image.ref,
    "--format", "{{.Manifest.Digest}}",
  ], { allowFailure: true, capture: true, quiet: true, env: environment });
  if (result.status === 0) {
    const digest = result.stdout.trim();
    if (!/^sha256:[0-9a-f]{64}$/u.test(digest)) {
      throw new Error(`Registry returned an invalid digest for ${image.ref}: ${digest}`);
    }
    return { ref: image.ref, status: "present", digest };
  }
  const detail = `${result.stderr ?? ""}\n${result.stdout ?? ""}`;
  if (/not found|manifest unknown|no such manifest|does not exist|\b404\b/iu.test(detail)) {
    return { ref: image.ref, status: "absent" };
  }
  throw new Error(`Could not safely inventory ${image.ref}: ${detail.trim() || result.status}`);
}

export function containerInventoryDecision(inventory, reuseContainers) {
  if (!Array.isArray(inventory) || inventory.length !== containerTargets.length) {
    throw new Error("container inventory must cover all seven release tags");
  }
  const present = inventory.filter((item) => item?.status === "present");
  const absent = inventory.filter((item) => item?.status === "absent");
  if (present.length + absent.length !== inventory.length) {
    throw new Error("container inventory contains an unknown state");
  }
  if (new Set(inventory.map((item) => item.ref)).size !== inventory.length
    || present.some((item) => !/^sha256:[0-9a-f]{64}$/u.test(item.digest ?? ""))) {
    throw new Error("container inventory references or digests are invalid");
  }
  if (present.length === 0) {
    if (reuseContainers) throw new Error("--reuse-containers requires all seven version tags to exist");
    return "build";
  }
  if (absent.length > 0) {
    throw new Error(`partial container inventory is immutable: ${present.length} present, ${absent.length} absent`);
  }
  if (!reuseContainers) {
    throw new Error("all seven version tags already exist; refusing to overwrite them without --reuse-containers");
  }
  return "reuse";
}

function registryManifestForReuse(reference, expectedDigest, label, environment) {
  const result = invoke("docker", [
    "buildx", "imagetools", "inspect", "--raw", reference,
  ], { capture: true, quiet: true, env: environment });
  const raw = result.stdout;
  const expected = expectedDigest.slice("sha256:".length);
  const candidates = [raw, raw.endsWith("\r\n") ? raw.slice(0, -2) : null, raw.endsWith("\n") ? raw.slice(0, -1) : null]
    .filter((value) => value !== null);
  if (!candidates.some((value) => createHash("sha256").update(value).digest("hex") === expected)) {
    throw new Error(`${label} bytes do not match ${expectedDigest}`);
  }
  try {
    return JSON.parse(raw);
  } catch (error) {
    throw new Error(`${label} is invalid JSON`, { cause: error });
  }
}

function registryProvenanceForReuse(reference, label, environment) {
  const raw = capture("docker", [
    "buildx", "imagetools", "inspect", "--format", "{{json .Provenance}}", reference,
  ], { quiet: true, env: environment });
  try {
    return JSON.parse(raw);
  } catch (error) {
    throw new Error(`${label} is invalid JSON`, { cause: error });
  }
}

async function verifyContainerReferences(images, references, commit, environment) {
  for (const image of images) {
    const reference = references[image.target];
    const expectedDigest = reference.slice(reference.lastIndexOf("@") + 1);
    const tag = inspectContainerTag(image, environment);
    if (tag.status !== "present" || tag.digest !== expectedDigest) {
      throw new Error(`version tag ${image.ref} does not point to its verified immutable index`);
    }
    await inspectMultiPlatformImage(image.target, references[image.target], commit, {
      manifest: (candidate, digest, label) => registryManifestForReuse(
        candidate,
        digest,
        label,
        environment,
      ),
      provenance: (candidate, label) => registryProvenanceForReuse(
        candidate,
        label,
        environment,
      ),
    });
  }
}

async function verifyReusableContainers(images, inventory, commit, environment) {
  const byReference = new Map(inventory.map((item) => [item.ref, item]));
  const references = Object.fromEntries(images.map((image) => [
    image.target,
    `${image.ref}@${byReference.get(image.ref)?.digest}`,
  ]));
  await verifyContainerReferences(images, references, commit, environment);
}

function buildContainers(images, builder, commit, sourceRepository) {
  for (const image of images) {
    if (inspectContainerTag(image).status !== "absent") {
      throw new Error(`refusing to overwrite container version tag ${image.ref}`);
    }
    invoke("docker", [
      "buildx",
      "build",
      "--builder",
      builder,
      "--file",
      image.dockerfile,
      "--target",
      image.buildTarget,
      "--platform",
      "linux/amd64,linux/arm64",
      "--tag",
      image.ref,
      "--label",
      `org.opencontainers.image.revision=${commit}`,
      "--label",
      `org.opencontainers.image.source=https://github.com/${sourceRepository}`,
      "--push",
      "--provenance=mode=max,version=v1",
      "--sbom=true",
      ".",
    ], {
      env: {
        ...process.env,
        BUILDX_GIT_CHECK_DIRTY: "1",
        BUILDX_GIT_INFO: "1",
        BUILDX_GIT_LABELS: "full",
      },
    });
  }
}

function resolveImages(images, inventory = null) {
  const known = new Map((inventory ?? []).map((item) => [item.ref, item.digest]));
  return Object.fromEntries(
    images.map((image) => {
      const digest = known.get(image.ref) ?? capture("docker", [
        "buildx",
        "imagetools",
        "inspect",
        image.ref,
        "--format",
        "{{.Manifest.Digest}}",
      ]);
      if (!/^sha256:[0-9a-f]{64}$/u.test(digest)) {
        throw new Error(`Registry returned an invalid digest for ${image.ref}: ${digest}`);
      }
      return [image.target, `${image.ref}@${digest}`];
    }),
  );
}

function buildRaspberryPi({
  artifacts,
  hostGeneration,
  hostQualification,
  hostRaucCa,
  hostTufRoot,
  hostUpdateBaseUrl,
  imagePrefix,
  imageRefs,
  repository,
  sshPublicKey,
  tag,
}) {
  mkdirSync(artifacts.directory, { recursive: true });
  for (const path of [
    artifacts.ota,
    artifacts.factory,
    artifacts.combinedChecksum,
    artifacts.releaseChecksum,
    artifacts.factoryChecksum,
    artifacts.compatibilityProof,
    `${artifacts.compatibilityProof}.sha256`,
    artifacts.draftPreparation,
    `${artifacts.draftPreparation}.sha256`,
  ]) {
    if (existsSync(path)) unlinkSync(path);
  }

  const dockerArguments = [
    "run",
    "--rm",
    "--privileged",
    "--platform",
    "linux/amd64",
    "--volume",
    `${root}:/workspace`,
    // Debian packages contain case-distinct paths that Windows bind mounts collapse.
    "--volume",
    "/rpi-build",
    "--volume",
    `${sshPublicKey}:/run/secrets/stugu-appliance.pub:ro`,
    "--volume",
    `${hostTufRoot}:/run/secrets/stugu-host-tuf-root.json:ro`,
    "--volume",
    `${hostRaucCa}:/run/secrets/stugu-host-rauc-ca.pem:ro`,
    "--workdir",
    "/workspace",
  ];
  if (hostQualification) {
    dockerArguments.push(
      "--volume",
      `${hostQualification}:/run/secrets/stugu-host-qualification.json:ro`,
    );
  }
  const variables = {
    STUGA_VERSION: tag,
    STUGA_IMAGE_TAG: tag,
    STUGA_RELEASE_REPOSITORY: repository,
    STUGA_IMAGE_REGISTRY_PREFIX: imagePrefix,
    STUGA_API_IMAGE: imageRefs.api,
    STUGA_WEB_IMAGE: imageRefs.web,
    STUGA_BACKUP_IMAGE: imageRefs.backup,
    STUGA_TAPO_RUNNER_IMAGE: imageRefs["tapo-export-runner"],
    STUGA_UPDATE_AGENT_IMAGE: imageRefs["update-agent"],
    STUGA_MQTT_IMAGE: imageRefs.mqtt,
    STUGA_NEXUS433_IMAGE: imageRefs.nexus433,
    STUGA_HOST_GENERATION: hostGeneration,
    RPI_FACTORY_BUILD: "1",
    RPI_BUILD_ROOT: "/rpi-build",
    RPI_EXPORT_FACTORY_IMAGE: "1",
    RPI_IMAGE_GEN_INSTALL_DEPS: "1",
    RPI_SSH_PUBLIC_KEY_FILE: "/run/secrets/stugu-appliance.pub",
    RPI_HOST_TUF_ROOT_FILE: "/run/secrets/stugu-host-tuf-root.json",
    RPI_HOST_RAUC_CA_FILE: "/run/secrets/stugu-host-rauc-ca.pem",
    RPI_HOST_UPDATE_BASE_URL: hostUpdateBaseUrl,
    ARCH: "arm64",
  };
  if (hostQualification) {
    variables.RPI_HOST_HARDWARE_QUALIFICATION_FILE =
      "/run/secrets/stugu-host-qualification.json";
  }
  if (typeof process.getuid === "function" && typeof process.getgid === "function") {
    variables.HOST_UID = String(process.getuid());
    variables.HOST_GID = String(process.getgid());
  }
  for (const [name, value] of Object.entries(variables)) {
    dockerArguments.push("--env", `${name}=${value}`);
  }
  dockerArguments.push(
    rpiBuilderImage,
    "bash",
    "-c",
    [
      "set -Eeuo pipefail",
      "apt-get update",
      "apt-get install --yes --no-install-recommends binfmt-support ca-certificates debian-archive-keyring erofs-utils gcc-aarch64-linux-gnu git libc6-dev-arm64-cross openssl python3-cryptography python3-tuf qemu-user-static zstd",
      "mountpoint --quiet /proc/sys/fs/binfmt_misc || mount -t binfmt_misc binfmt_misc /proc/sys/fs/binfmt_misc",
      "test -r /proc/sys/fs/binfmt_misc/aarch64 || test -r /proc/sys/fs/binfmt_misc/qemu-aarch64",
      "bash scripts/build-rpi-image.sh",
      'if [[ -n "${HOST_UID:-}" ]]; then chown -R "$HOST_UID:$HOST_GID" dist/rpi; fi',
    ].join("\n"),
  );
  invoke("docker", dockerArguments);
  requireFile(artifacts.ota, "OTA artifact");
  requireFile(artifacts.factory, "factory image");
  requireFile(artifacts.combinedChecksum, "local checksum");
  requireFile(artifacts.hostBoot, "host boot image");
  requireFile(artifacts.hostRoot, "host root image");
  requireFile(artifacts.hostSbom, "host SBOM");
  requireFile(artifacts.hostProvenance, "host provenance");
  copyFileSync(artifacts.releaseManifest, artifacts.hostContainerManifest);
  requireFile(artifacts.hostContainerManifest, "host container release manifest");
}

async function prepareReleaseChecksums(artifacts, uploadFactory) {
  mkdirSync(artifacts.releaseDirectory, { recursive: true });
  if (uploadFactory) {
    const factoryHash = await sha256(artifacts.factory);
    writeFileSync(
      artifacts.factoryChecksum,
      `${factoryHash}  ${artifacts.factory.split(/[\\/]/u).at(-1)}\n`,
      "utf8",
    );
  }
}

async function prepareNexus433Source(artifacts, version) {
  const generated = await buildNexus433SourceBundle({
    repositoryRoot: root,
    releaseVersion: version,
    outputDirectory: artifacts.releaseDirectory,
  });
  if (
    generated.bundlePath !== artifacts.nexus433Source
    || generated.checksumPath !== artifacts.nexus433SourceChecksum
  ) {
    throw new Error("Nexus433 corresponding-source artifact path mismatch");
  }
  requireFile(artifacts.nexus433Source, "Nexus433 corresponding source");
  requireFile(artifacts.nexus433SourceChecksum, "Nexus433 source checksum");
}

function writeReleaseManifest(artifacts, repository, version, tag, imageRefs) {
  mkdirSync(artifacts.releaseDirectory, { recursive: true });
  writeFileSync(
    artifacts.releaseManifest,
    `${JSON.stringify(releaseManifest(repository, version, tag, imageRefs), null, 2)}\n`,
    "utf8",
  );
  requireFile(artifacts.releaseManifest, "immutable release manifest");
}

function inspectRelease(tag, repository) {
  const viewed = invoke(
    "gh",
    [
      "release", "view", tag, "--repo", repository,
      "--json", "assets,body,isDraft,isPrerelease,name,tagName,url",
    ],
    { allowFailure: true, capture: true, quiet: true },
  );
  if (viewed.status === 0) return JSON.parse(viewed.stdout);
  if (!/release not found|HTTP 404/iu.test(viewed.stderr ?? "")) {
    throw new Error(viewed.stderr?.trim() || `Could not inspect release ${tag}`);
  }
  return null;
}

function ensureRelease(tag, version, repository, notesFile, prerelease) {
  const existing = inspectRelease(tag, repository);
  if (existing && !existing.isDraft) {
    throw new Error(`Release ${tag} is already published and immutable`);
  }
  if (existing) {
    const arguments_ = [
      "release", "edit", tag, "--repo", repository, "--draft",
      `--prerelease=${prerelease ? "true" : "false"}`,
      "--title", `Stugu ${version}`,
    ];
    if (notesFile) arguments_.push("--notes-file", notesFile);
    invoke("gh", arguments_);
    return inspectRelease(tag, repository);
  }
  const arguments_ = [
    "release",
    "create",
    tag,
    "--repo",
    repository,
    "--verify-tag",
    "--draft",
    "--title",
    `Stugu ${version}`,
  ];
  if (prerelease) arguments_.push("--prerelease");
  if (notesFile) arguments_.push("--notes-file", notesFile);
  else arguments_.push("--generate-notes");
  invoke("gh", arguments_);
  return inspectRelease(tag, repository);
}

function releaseAssetPaths(artifacts, { uploadFactory, fullCi }) {
  const paths = [
    artifacts.releaseManifest,
    fullCi.path,
    fullCi.checksumPath,
    artifacts.compatibilityProof,
    `${artifacts.compatibilityProof}.sha256`,
    artifacts.nexus433Source,
    artifacts.nexus433SourceChecksum,
  ];
  if (uploadFactory) paths.push(artifacts.factory, artifacts.factoryChecksum);
  return paths;
}

function uploadReleaseAssets(tag, repository, paths) {
  invoke("gh", [
    "release",
    "upload",
    tag,
    ...paths,
    "--repo",
    repository,
    "--clobber",
  ]);
}

function writeDraftPreparationRecord(path, input) {
  for (const candidate of [path, `${path}.sha256`]) {
    if (existsSync(candidate)) unlinkSync(candidate);
  }
  const preparation = createDraftPreparation(input);
  return { preparation, written: toolingWriteJsonReceipt(path, preparation) };
}

export function draftAssetDeletionPlan(release, expectedAssets) {
  if (release?.isDraft !== true) throw new Error("refusing to remove assets from a non-draft release");
  return unexpectedGitHubAssets(release, expectedAssets).map((asset) => {
    const match = /\/releases\/assets\/(\d+)$/u.exec(asset.apiUrl ?? "");
    if (!match) throw new Error(`cannot safely remove unexpected draft asset ${asset.name ?? "unknown"}`);
    return { id: match[1], name: asset.name };
  });
}

function deleteUnexpectedDraftAssets(tag, repository, release, expectedAssets) {
  let current = release;
  while (true) {
    const [asset] = draftAssetDeletionPlan(current, expectedAssets);
    if (!asset) return current;
    invoke("gh", [
      "api", "--method", "DELETE",
      `repos/${repository}/releases/assets/${asset.id}`,
    ]);
    current = inspectRelease(tag, repository);
  }
}

function verifyPublicRepository(repository, tag) {
  invoke("gh", ["auth", "status"]);
  const visibility = capture(
    "gh",
    ["repo", "view", repository, "--json", "visibility", "--jq", ".visibility"],
    { quiet: true },
  );
  requirePublicReleaseRepository(repository, visibility);
  const targetTag = invoke(
    "gh",
    ["api", `repos/${repository}/git/ref/tags/${tag}`, "--silent"],
    { allowFailure: true, capture: true, quiet: true },
  );
  requireReleaseRepositoryTag(repository, tag, targetTag.status);
}

const FINALIZATION_ARGUMENTS = new Set([
  "--publish",
  "--repository",
  "--tag",
  "--verification-receipt",
]);

export function assertFinalizationArguments(options) {
  const invalid = (options.providedArguments ?? []).filter((name) => !FINALIZATION_ARGUMENTS.has(name));
  if (invalid.length > 0) {
    throw new Error(`draft-preparation options cannot be combined with --verification-receipt: ${invalid.join(", ")}`);
  }
}

async function finalizeDraft({ options, repository, tag, version, artifacts, env }) {
  assertFinalizationArguments(options);
  if (!options.publish) {
    console.log(`Local Stugu release finalization plan
  Tag:          ${tag}
  Repository:   ${repository}
  Action:       publish existing verified draft

Plan only. Add --publish to consume the receipt and publish the draft.`);
    return;
  }
  const commit = verifyGitRelease(tag);
  const snapshot = repositorySnapshot(root);
  const evidence = releaseVerificationEvidence(options.verificationReceipt, snapshot, {
    version, repository, artifacts,
  });
  verifyPublicRepository(repository, tag);
  const finalAssets = assetDigestsForPaths([evidence.path, evidence.checksumPath]);
  const release = inspectRelease(tag, repository);
  try {
    validateGitHubRelease(release, evidence.receipt.draft, {
      tagName: tag,
      requireDraft: true,
    });
  } catch (baseError) {
    try {
      validateGitHubRelease(release, evidence.receipt.draft, {
        tagName: tag,
        requireDraft: true,
        additionalAssets: finalAssets,
      });
    } catch {
      throw baseError;
    }
  }
  invoke("gh", [
    "release", "upload", tag, evidence.path, evidence.checksumPath,
    "--repo", repository, "--clobber",
  ]);
  validateGitHubRelease(inspectRelease(tag, repository), evidence.receipt.draft, {
    tagName: tag,
    requireDraft: true,
    additionalAssets: finalAssets,
  });
  const releaseImages = Object.entries(evidence.manifest.images).map(([target, reference]) => ({
    target,
    ref: reference.slice(0, reference.lastIndexOf("@")),
  }));
  await withAnonymousRegistryEnvironment(env, (anonymousEnvironment) => (
    verifyContainerReferences(
      releaseImages,
      evidence.manifest.images,
      snapshot.commit,
      anonymousEnvironment,
    )
  ));
  validateReleaseVerificationReceipt(evidence.receipt, {
    commit: snapshot.commit,
    worktreeSha256: snapshot.worktreeSha256,
    version,
    repository,
    maximumAgeMs: RELEASE_VERIFICATION_RECEIPT_MAX_AGE_MS,
    now: Date.now(),
  });
  validateGitHubRelease(inspectRelease(tag, repository), evidence.receipt.draft, {
    tagName: tag,
    requireDraft: true,
    additionalAssets: finalAssets,
  });
  invoke("gh", [
    "release", "edit", tag, "--repo", repository, "--draft=false",
    `--prerelease=${evidence.receipt.channel === "preview" ? "true" : "false"}`,
  ]);
  const published = inspectRelease(tag, repository);
  validateGitHubRelease(published, evidence.receipt.draft, {
    tagName: tag,
    requireDraft: false,
    additionalAssets: finalAssets,
  });
  const url = published.url;
  console.log(`\nPublished ${evidence.receipt.channel} ${tag} from ${commit}\n${url}`);
}

async function main(argv = process.argv.slice(2), env = process.env) {
  const options = parseArguments(argv);
  if (options.help) {
    console.log(usage());
    return;
  }

  const packageVersion = JSON.parse(readFileSync(resolve(root, "package.json"), "utf8")).version;
  const tag = options.tag ?? `v${packageVersion}`;
  if (tag !== `v${packageVersion}` || !/^v\d+\.\d+\.\d+$/u.test(tag)) {
    throw new Error(`Release tag must be v${packageVersion}`);
  }
  const version = tag.slice(1);
  const sourceRepository = repositoryFromRemote(
    capture("git", ["remote", "get-url", "origin"], { quiet: true }),
  );
  const repository = options.repository ?? sourceRepository;
  if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/u.test(repository)) {
    throw new Error(`Invalid GitHub repository: ${repository}`);
  }
  const artifacts = artifactDefinitions(root, version);
  if (options.verificationReceipt) {
    await finalizeDraft({ options, repository, tag, version, artifacts, env });
    return;
  }
  const imagePrefix = options.imagePrefix ?? `ghcr.io/${repository.toLowerCase()}`;
  if (!/^ghcr\.io\/[a-z0-9_.-]{1,100}\/[a-z0-9_.-]{1,100}$/u.test(imagePrefix)) {
    throw new Error(`Invalid lower-case GHCR image prefix: ${imagePrefix}`);
  }
  const sshPublicKey = resolve(
    options.sshPublicKey ?? env.RPI_FACTORY_SSH_PUBLIC_KEY_FILE ?? "",
  );
  const hostGeneration = options.hostGeneration ?? env.STUGA_HOST_GENERATION;
  const hostTufRoot = resolve(
    options.hostTufRoot ?? env.RPI_HOST_TUF_ROOT_FILE ?? "",
  );
  const hostRaucCa = resolve(
    options.hostRaucCa ?? env.RPI_HOST_RAUC_CA_FILE ?? "",
  );
  const hostUpdateBaseUrl =
    options.hostUpdateBaseUrl ?? env.RPI_HOST_UPDATE_BASE_URL;
  const hostQualificationValue =
    options.hostQualification ?? env.RPI_HOST_HARDWARE_QUALIFICATION_FILE;
  const hostQualification = hostQualificationValue
    ? resolve(hostQualificationValue)
    : undefined;
  const notesFile = options.notesFile ? resolve(options.notesFile) : undefined;
  if (repository !== sourceRepository && !notesFile) {
    throw new Error("--notes-file is required when publishing to a separate artifact repository");
  }
  const images = imageDefinitions(imagePrefix, tag);

  console.log(`Local Stugu release plan
  Tag:             ${tag}
  Repository:      ${repository}
  Image platforms: linux/amd64, linux/arm64
  Raspberry Pi:    factory image + host-signing inputs
  Host generation: ${hostGeneration ?? "not supplied"}
  Host activation: ${hostQualification ? "qualification receipt supplied" : "disabled"}
  GitHub release:  draft (${options.prerelease ? "preview" : "stable"} channel after verification)
  Factory upload:  ${options.uploadFactory ? "yes" : "no; retained locally"}`);
  if (!options.publish) {
    console.log(
      "\nPlan only. No tag, file, credential, CI, build, push, or artifact validation ran.\n"
      + "Add --publish to build, push, and upload this release.",
    );
    return;
  }

  if (!options.keepDraft) {
    throw new Error("draft preparation requires --keep-draft; publish later with --verification-receipt");
  }
  if (!options.fullCiReceipt) {
    throw new Error("--full-ci-receipt is required with draft preparation");
  }
  if (!options.sshPublicKey && !env.RPI_FACTORY_SSH_PUBLIC_KEY_FILE) {
    throw new Error("--ssh-public-key is required with --publish");
  }
  if ((!options.hostTufRoot && !env.RPI_HOST_TUF_ROOT_FILE)
    || (!options.hostRaucCa && !env.RPI_HOST_RAUC_CA_FILE)
    || !hostGeneration
    || !hostUpdateBaseUrl) {
    throw new Error(
      "--host-generation, --host-tuf-root, --host-rauc-ca, and --host-update-base-url are required with --publish",
    );
  }
  validatePublicKey(sshPublicKey);
  validateHostReleaseSettings({ generation: hostGeneration, baseUrl: hostUpdateBaseUrl });
  requireFile(hostTufRoot, "TUF root v1");
  requireFile(hostRaucCa, "RAUC CA certificate");
  if (hostQualification) requireFile(hostQualification, "hardware qualification receipt");
  if (notesFile) requireFile(notesFile, "release notes");

  const commit = verifyGitRelease(tag);
  const snapshot = repositorySnapshot(root);
  const fullCi = fullCiEvidence(options.fullCiReceipt, snapshot, version);
  verifyPublicRepository(repository, tag);
  const existingRelease = inspectRelease(tag, repository);
  if (existingRelease && !existingRelease.isDraft) {
    throw new Error(`Release ${tag} is already published and immutable`);
  }
  invoke("docker", ["version"]);
  invoke("docker", ["buildx", "version"]);
  let containerInventory;
  let containerAction;
  await withAnonymousRegistryEnvironment(env, async (anonymousEnvironment) => {
    containerInventory = images.map((image) => inspectContainerTag(image, anonymousEnvironment));
    containerAction = containerInventoryDecision(
      containerInventory,
      options.reuseContainers,
    );
    if (containerAction === "reuse") {
      await verifyReusableContainers(images, containerInventory, commit, anonymousEnvironment);
    }
  });
  if (containerAction === "build") {
    registryLogin(env);
    ensureBuilder(options.builder);
  }

  await prepareNexus433Source(artifacts, version);
  if (containerAction === "build") {
    buildContainers(images, options.builder, commit, sourceRepository);
  }
  const imageRefs = resolveImages(
    images,
    containerAction === "reuse" ? containerInventory : null,
  );
  if (containerAction === "build") {
    await withAnonymousRegistryEnvironment(env, (anonymousEnvironment) => (
      verifyContainerReferences(images, imageRefs, commit, anonymousEnvironment)
    ));
  }
  writeReleaseManifest(artifacts, repository, version, tag, imageRefs);
  buildRaspberryPi({
    artifacts,
    hostGeneration,
    hostQualification,
    hostRaucCa,
    hostTufRoot,
    hostUpdateBaseUrl,
    imagePrefix,
    imageRefs,
    repository,
    sshPublicKey,
    tag,
  });
  await prepareReleaseChecksums(artifacts, options.uploadFactory);
  const afterBuild = repositorySnapshot(root);
  if (afterBuild.commit !== snapshot.commit || afterBuild.worktreeSha256 !== snapshot.worktreeSha256) {
    throw new Error("commit or worktree changed while preparing release artifacts");
  }
  writeCompatibilityProof({
    artifacts,
    version,
    snapshot,
    fullCiReceiptPath: fullCi.path,
    hostGeneration: Number(hostGeneration),
    tufRootSha256: toolingSha256File(hostTufRoot),
    raucCaSha256: toolingSha256File(hostRaucCa),
  });

  const preparedRelease = ensureRelease(tag, version, repository, notesFile, options.prerelease);
  if (preparedRelease?.isDraft !== true) {
    throw new Error("GitHub release stopped being a draft before asset upload");
  }
  const expectedBody = notesFile ? readFileSync(notesFile, "utf8") : preparedRelease.body;
  if (normalizeReleaseBody(preparedRelease.body) !== normalizeReleaseBody(expectedBody)) {
    throw new Error("GitHub draft release notes differ from the requested notes file");
  }
  const assetPaths = releaseAssetPaths(artifacts, {
    uploadFactory: options.uploadFactory,
    fullCi,
  });
  const { preparation } = writeDraftPreparationRecord(artifacts.draftPreparation, {
    commit: snapshot.commit,
    version,
    repository,
    channel: options.prerelease ? "preview" : "stable",
    factoryUploaded: options.uploadFactory,
    body: expectedBody,
    assetPaths,
  });
  uploadReleaseAssets(tag, repository, assetPaths);
  let reconciledRelease = inspectRelease(tag, repository);
  reconciledRelease = deleteUnexpectedDraftAssets(
    tag,
    repository,
    reconciledRelease,
    preparation.draft.assets,
  );
  validateGitHubRelease(reconciledRelease, preparation.draft, {
    tagName: tag,
    requireDraft: true,
  });

  const url = reconciledRelease.url;
  console.log(`\nPrepared draft ${tag} from ${commit}\n${url}`);
  console.log(`Compatibility proof: ${artifacts.compatibilityProof}`);
  console.log(`Draft preparation: ${artifacts.draftPreparation}`);
  console.log(`Factory image retained at ${artifacts.factory}`);
  console.log(`Host signing inputs retained at ${artifacts.hostInputsDirectory}`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    console.error(`\nRelease failed: ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
  });
}
