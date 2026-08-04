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
import { dirname, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";

import { buildNexus433SourceBundle } from "./build-nexus433-source-bundle.mjs";
import {
  artifactDefinitions,
  containerTargets,
  imageDefinitions,
} from "./local-release-definition.mjs";
import { releaseManifest } from "./local-release-manifest.mjs";

export { artifactDefinitions, imageDefinitions } from "./local-release-definition.mjs";
export { releaseManifest } from "./local-release-manifest.mjs";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const rpiBuilderImage =
  "debian:trixie-slim@sha256:020c0d20b9880058cbe785a9db107156c3c75c2ac944a6aa7ab59f2add76a7bd";

function usage() {
  return `Build and publish a Stugu release from local Docker.

Usage:
  npm run release:local -- --ssh-public-key PATH --publish [options]

Required for publishing:
  --ssh-public-key PATH    Recovery public key embedded in the factory image
  --host-generation N      Monotonic host generation embedded in both slots
  --host-tuf-root PATH     Offline-approved public TUF root v1
  --host-rauc-ca PATH      Offline-approved public RAUC CA certificate
  --host-update-base-url URL
                           HTTPS base URL of the TUF repository
  --publish                Execute registry and GitHub writes; otherwise preview

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
  --keep-draft             Build, push, and upload, but leave the release draft
  --help                   Show this help

The factory image stays under dist/rpi by default. Never upload a factory image
that contains a Raspberry Pi Connect auth key or another provisioning secret.
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
    reuseContainers: false,
    uploadFactory: false,
  };

  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
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

function buildContainers(images, builder) {
  for (const image of images) {
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
      "--push",
      "--provenance=mode=max",
      "--sbom=true",
      ".",
    ]);
  }
}

function resolveImages(images) {
  return Object.fromEntries(
    images.map((image) => {
      const digest = capture("docker", [
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
    ["release", "view", tag, "--repo", repository, "--json", "isDraft,isPrerelease,url"],
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
    if (existing.isPrerelease !== prerelease) {
      invoke("gh", [
        "release", "edit", tag, "--repo", repository, "--draft",
        `--prerelease=${prerelease ? "true" : "false"}`,
      ]);
    }
    return { ...existing, isPrerelease: prerelease };
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
  return { isDraft: true };
}

function uploadReleaseAssets(
  tag,
  repository,
  artifacts,
  { uploadFactory },
) {
  const paths = [
    artifacts.releaseManifest,
    artifacts.localCiReport,
    artifacts.localCiChecksum,
    artifacts.nexus433Source,
    artifacts.nexus433SourceChecksum,
  ];
  if (uploadFactory) paths.push(artifacts.factory, artifacts.factoryChecksum);
  if (paths.length === 0) return;
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
  const artifacts = artifactDefinitions(root, version);

  console.log(`Local Stugu release plan
  Tag:             ${tag}
  Repository:      ${repository}
  Image platforms: linux/amd64, linux/arm64
  Raspberry Pi:    factory image + signed-host inputs
  Host generation: ${hostGeneration ?? "not supplied"}
  Host activation: ${hostQualification ? "qualification receipt supplied" : "disabled"}
  GitHub release:  ${options.keepDraft ? "draft" : options.prerelease ? "preview" : "stable"}
  Factory upload:  ${options.uploadFactory ? "yes" : "no; retained locally"}`);
  if (!options.publish) {
    console.log("\nPreview only. Add --publish to build, push, and upload this release.");
    return;
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
  const existingRelease = inspectRelease(tag, repository);
  if (existingRelease && !existingRelease.isDraft) {
    throw new Error(`Release ${tag} is already published and immutable`);
  }
  invoke("docker", ["version"]);
  invoke("docker", ["buildx", "version"]);
  ensureBuilder(options.builder);
  registryLogin(env);

  invoke("npm", ["run", "ci:local", "--", "--skip-container-builds"]);
  requireFile(artifacts.localCiReport, "local CI receipt");
  requireFile(artifacts.localCiChecksum, "local CI receipt checksum");
  await prepareNexus433Source(artifacts, version);
  if (!options.reuseContainers) buildContainers(images, options.builder);
  const imageRefs = resolveImages(images);
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

  const release = ensureRelease(tag, version, repository, notesFile, options.prerelease);
  uploadReleaseAssets(tag, repository, artifacts, {
    uploadFactory: options.uploadFactory,
  });
  if (release.isDraft && !options.keepDraft) {
    invoke("gh", [
      "release", "edit", tag, "--repo", repository, "--draft=false",
      `--prerelease=${options.prerelease ? "true" : "false"}`,
    ]);
  }

  const url = capture(
    "gh",
    ["release", "view", tag, "--repo", repository, "--json", "url", "--jq", ".url"],
    { quiet: true },
  );
  const outcome = options.keepDraft ? "Prepared draft" : options.prerelease ? "Published preview" : "Published";
  console.log(`\n${outcome} ${tag} from ${commit}\n${url}`);
  console.log(`Factory image retained at ${artifacts.factory}`);
  console.log(`Host signing inputs retained at ${artifacts.hostInputsDirectory}`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    console.error(`\nRelease failed: ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
  });
}
