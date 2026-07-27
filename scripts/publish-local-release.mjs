#!/usr/bin/env node

import { createHash } from "node:crypto";
import {
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

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const rpiBuilderImage =
  "debian:trixie-slim@sha256:020c0d20b9880058cbe785a9db107156c3c75c2ac944a6aa7ab59f2add76a7bd";
const containerTargets = [
  ["api", "api"],
  ["web", "web"],
  ["backup", "backup"],
  ["tapo-export-runner", "tapo-export-runner"],
  ["update-agent", "update-agent"],
];

function usage() {
  return `Build and publish a Stugu release from local Docker.

Usage:
  npm run release:local -- --ssh-public-key PATH --publish [options]

Required for publishing:
  --ssh-public-key PATH    Recovery public key embedded in the factory image
  --publish                Execute registry and GitHub writes; otherwise preview

Options:
  --tag TAG                Release tag (default: v<package.json version>)
  --notes-file PATH        Release notes; otherwise GitHub generates notes
  --repository OWNER/REPO  GitHub repository (default: origin)
  --image-prefix PREFIX    GHCR prefix (default: ghcr.io/<owner>/<repo>)
  --builder NAME           Buildx builder (default: stugu-release-local)
  --reuse-containers       Reuse and resolve already-published image tags
  --upload-factory         Also attach the factory image to the public release
  --deploy                 Deploy the uploaded OTA through Raspberry Pi Connect
  --skip-checks            Skip local typecheck, tests, build, and API smoke test
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
    deploy: false,
    help: false,
    publish: false,
    reuseContainers: false,
    skipChecks: false,
    uploadFactory: false,
  };

  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    switch (argument) {
      case "--builder":
        options.builder = optionValue(argv, index, argument);
        index += 1;
        break;
      case "--deploy":
        options.deploy = true;
        break;
      case "--help":
      case "-h":
        options.help = true;
        break;
      case "--image-prefix":
        options.imagePrefix = optionValue(argv, index, argument);
        index += 1;
        break;
      case "--notes-file":
        options.notesFile = optionValue(argv, index, argument);
        index += 1;
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
      case "--skip-checks":
        options.skipChecks = true;
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

export function imageDefinitions(prefix, tag) {
  return containerTargets.map(([target, suffix]) => ({
    target,
    ref: `${prefix}-${suffix}:${tag}`,
  }));
}

export function artifactDefinitions(repositoryRoot, version) {
  const directory = resolve(repositoryRoot, "dist", "rpi");
  const releaseDirectory = resolve(directory, "release");
  return {
    directory,
    releaseDirectory,
    ota: resolve(directory, `stugu-rpi4-${version}-ota.tar.zst`),
    factory: resolve(directory, `stugu-rpi4-${version}.img.zst`),
    combinedChecksum: resolve(directory, `stugu-rpi4-${version}.sha256`),
    releaseChecksum: resolve(releaseDirectory, `stugu-rpi4-${version}.sha256`),
    factoryChecksum: resolve(
      releaseDirectory,
      `stugu-rpi4-${version}-factory.sha256`,
    ),
  };
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
      "Dockerfile",
      "--target",
      image.target,
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
  imagePrefix,
  imageRefs,
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
    "--workdir",
    "/workspace",
  ];
  const variables = {
    STUGA_VERSION: tag,
    STUGA_IMAGE_TAG: tag,
    STUGA_IMAGE_REGISTRY_PREFIX: imagePrefix,
    STUGA_API_IMAGE: imageRefs.api,
    STUGA_WEB_IMAGE: imageRefs.web,
    STUGA_BACKUP_IMAGE: imageRefs.backup,
    STUGA_TAPO_RUNNER_IMAGE: imageRefs["tapo-export-runner"],
    STUGA_UPDATE_AGENT_IMAGE: imageRefs["update-agent"],
    RPI_FACTORY_BUILD: "1",
    RPI_BUILD_ROOT: "/rpi-build",
    RPI_EXPORT_FACTORY_IMAGE: "1",
    RPI_IMAGE_GEN_INSTALL_DEPS: "1",
    RPI_SSH_PUBLIC_KEY_FILE: "/run/secrets/stugu-appliance.pub",
    ARCH: "arm64",
  };
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
      "apt-get install --yes --no-install-recommends binfmt-support ca-certificates debian-archive-keyring git qemu-user-static zstd",
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
}

async function prepareReleaseChecksums(artifacts, uploadFactory) {
  mkdirSync(artifacts.releaseDirectory, { recursive: true });
  const otaHash = await sha256(artifacts.ota);
  writeFileSync(
    artifacts.releaseChecksum,
    `${otaHash}  ${artifacts.ota.split(/[\\/]/u).at(-1)}\n`,
    "utf8",
  );
  if (uploadFactory) {
    const factoryHash = await sha256(artifacts.factory);
    writeFileSync(
      artifacts.factoryChecksum,
      `${factoryHash}  ${artifacts.factory.split(/[\\/]/u).at(-1)}\n`,
      "utf8",
    );
  }
  return otaHash;
}

function ensureRelease(tag, version, repository, notesFile) {
  const viewed = invoke(
    "gh",
    ["release", "view", tag, "--repo", repository, "--json", "isDraft,url"],
    { allowFailure: true, capture: true, quiet: true },
  );
  if (viewed.status === 0) return JSON.parse(viewed.stdout);
  if (!/release not found|HTTP 404/iu.test(viewed.stderr ?? "")) {
    throw new Error(viewed.stderr?.trim() || `Could not inspect release ${tag}`);
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
  if (notesFile) arguments_.push("--notes-file", notesFile);
  else arguments_.push("--generate-notes");
  invoke("gh", arguments_);
  return { isDraft: true };
}

function uploadReleaseAssets(tag, repository, artifacts, uploadFactory) {
  const paths = [artifacts.ota, artifacts.releaseChecksum];
  if (uploadFactory) paths.push(artifacts.factory, artifacts.factoryChecksum);
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
  const repository =
    options.repository ??
    repositoryFromRemote(capture("git", ["remote", "get-url", "origin"], { quiet: true }));
  if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/u.test(repository)) {
    throw new Error(`Invalid GitHub repository: ${repository}`);
  }
  const imagePrefix = options.imagePrefix ?? `ghcr.io/${repository.toLowerCase()}`;
  if (!imagePrefix || /\s/u.test(imagePrefix)) {
    throw new Error(`Invalid image prefix: ${imagePrefix}`);
  }
  const sshPublicKey = resolve(
    options.sshPublicKey ?? env.RPI_FACTORY_SSH_PUBLIC_KEY_FILE ?? "",
  );
  const notesFile = options.notesFile ? resolve(options.notesFile) : undefined;
  const images = imageDefinitions(imagePrefix, tag);
  const artifacts = artifactDefinitions(root, version);

  console.log(`Local Stugu release plan
  Tag:             ${tag}
  Repository:      ${repository}
  Image platforms: linux/amd64, linux/arm64
  Raspberry Pi:    OTA + factory image
  Factory upload:  ${options.uploadFactory ? "yes" : "no; retained locally"}
  Deploy OTA:      ${options.deploy ? "yes" : "no"}`);
  if (!options.publish) {
    console.log("\nPreview only. Add --publish to build, push, and upload this release.");
    return;
  }

  if (!options.sshPublicKey && !env.RPI_FACTORY_SSH_PUBLIC_KEY_FILE) {
    throw new Error("--ssh-public-key is required with --publish");
  }
  validatePublicKey(sshPublicKey);
  if (notesFile) requireFile(notesFile, "release notes");

  const commit = verifyGitRelease(tag);
  invoke("gh", ["auth", "status"]);
  invoke("docker", ["version"]);
  invoke("docker", ["buildx", "version"]);
  ensureBuilder(options.builder);
  registryLogin(env);

  if (!options.skipChecks) {
    invoke("npm", ["run", "version:check"]);
    invoke("npm", ["run", "typecheck"]);
    invoke("npm", ["test"]);
    invoke("npm", ["run", "build"]);
    invoke("npm", ["run", "smoke:built-api"]);
  }
  if (!options.reuseContainers) buildContainers(images, options.builder);
  const imageRefs = resolveImages(images);
  buildRaspberryPi({
    artifacts,
    imagePrefix,
    imageRefs,
    sshPublicKey,
    tag,
  });
  const otaHash = await prepareReleaseChecksums(artifacts, options.uploadFactory);

  const release = ensureRelease(tag, version, repository, notesFile);
  uploadReleaseAssets(tag, repository, artifacts, options.uploadFactory);
  if (release.isDraft) {
    invoke("gh", ["release", "edit", tag, "--repo", repository, "--draft=false"]);
  }

  if (options.deploy) {
    const otaName = artifacts.ota.split(/[\\/]/u).at(-1);
    invoke("node", ["scripts/deploy-rpi-ota.mjs"], {
      env: {
        ...env,
        RPI_OTA_VERSION: version,
        RPI_OTA_URI: `https://github.com/${repository}/releases/download/${tag}/${otaName}`,
        RPI_OTA_CHECKSUM: otaHash,
        RPI_OTA_DEPLOY: "true",
      },
    });
  }

  const url = capture(
    "gh",
    ["release", "view", tag, "--repo", repository, "--json", "url", "--jq", ".url"],
    { quiet: true },
  );
  console.log(`\nPublished ${tag} from ${commit}\n${url}`);
  console.log(`Factory image retained at ${artifacts.factory}`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    console.error(`\nRelease failed: ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
  });
}
