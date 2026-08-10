#!/usr/bin/env node

import { createHash, randomBytes } from "node:crypto";
import { spawnSync } from "node:child_process";
import {
  closeSync,
  fsyncSync,
  linkSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  realpathSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { arch, platform, release } from "node:os";
import {
  basename,
  dirname,
  isAbsolute,
  relative,
  resolve,
  sep,
} from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");

function usage() {
  return `Run the authoritative Stugu CI checks on this computer.

Usage:
  npm run ci:local -- [options]

Options:
  --install                 Run npm ci and install Python test dependencies
  --base-ref REF            Compare the product version with this Git ref
  --skip-container-builds   Validate Compose but skip local Docker image builds
  --with-sonar              Send the completed local coverage reports to Sonar
  --report PATH             Write the JSON receipt to this path
  --checksum PATH           Write its SHA-256 checksum to this path
  --help                    Show this help

The command writes a checksummed receipt under dist/ci. Native Apple checks run
automatically on macOS and are recorded as unavailable on other platforms.
`;
}

function optionValue(argv, index, name) {
  const value = argv[index + 1];
  if (!value || value.startsWith("--")) throw new Error(`${name} needs a value`);
  return value;
}

export function parseArguments(argv) {
  const options = {
    help: false,
    install: false,
    skipContainerBuilds: false,
    withSonar: false,
  };

  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    switch (argument) {
      case "--base-ref":
        options.baseRef = optionValue(argv, index, argument);
        index += 1;
        break;
      case "--help":
      case "-h":
        options.help = true;
        break;
      case "--install":
        options.install = true;
        break;
      case "--skip-container-builds":
        options.skipContainerBuilds = true;
        break;
      case "--report":
        options.report = optionValue(argv, index, argument);
        index += 1;
        break;
      case "--checksum":
        options.checksum = optionValue(argv, index, argument);
        index += 1;
        break;
      case "--with-sonar":
        options.withSonar = true;
        break;
      default:
        throw new Error(`Unknown argument: ${argument}`);
    }
  }

  return options;
}

export function platformInvocation(
  command,
  args,
  {
    currentPlatform = process.platform,
    env = process.env,
    execPath = process.execPath,
  } = {},
) {
  if (currentPlatform === "win32" && command === "npm") {
    if (!env.npm_execpath) {
      throw new Error(
        "npm_execpath is required on Windows; run local CI through npm run ci:local",
      );
    }
    return {
      command: execPath,
      args: [env.npm_execpath, ...args],
    };
  }
  return { command, args };
}

function printable(command, args) {
  const quote = (value) => (/[\s"]/u.test(value) ? JSON.stringify(value) : value);
  return [command, ...args].map(quote).join(" ");
}

function npmCheck(name, script, options = {}) {
  return {
    name,
    command: "npm",
    args: ["run", script, ...(options.args ?? [])],
    env: options.env,
  };
}

export function createCheckPlan({
  baseRef,
  baseVersionCheck,
  commit,
  currentPlatform = process.platform,
  install = false,
  skipContainerBuilds = false,
  withSonar = false,
}) {
  const shortCommit = commit.slice(0, 12);
  const checks = [];
  if (install) {
    checks.push(
      { name: "Install Node.js dependencies", command: "npm", args: ["ci"] },
      {
        name: "Install Python test dependencies",
        command: "python",
        args: [
          "-m",
          "pip",
          "install",
          "-r",
          "apps/api/python/requirements.txt",
          "-r",
          "apps/api/python/requirements-dev.txt",
        ],
      },
    );
  }

  checks.push(
    baseVersionCheck
      ? npmCheck("Check release version against the base", "version:check-pr", {
          env: { VERSION_BASE_REF: baseRef },
        })
      : npmCheck("Check release version consistency", "version:check"),
    npmCheck("Typecheck and architecture checks", "typecheck"),
    {
      name: "Lint Python components",
      command: "python",
      args: [
        "-m",
        "ruff",
        "check",
        "apps/api/python",
        "apps/api/python_tests",
        "deploy/rpi/host-updater",
        "scripts/tooling/rpi-doctor-remote.py",
        "scripts/verify-host-tuf-publication.py",
        "scripts/tests/host-publication-e2e.py",
      ],
    },
    {
      name: "Check Python formatting",
      command: "python",
      args: [
        "-m",
        "ruff",
        "format",
        "--check",
        "apps/api/python",
        "apps/api/python_tests",
        "deploy/rpi/host-updater",
        "scripts/tooling/rpi-doctor-remote.py",
        "scripts/verify-host-tuf-publication.py",
        "scripts/tests/host-publication-e2e.py",
      ],
    },
    {
      name: "Test signed host publication with native RAUC and TUF",
      command: "docker",
      args: [
        "run",
        "--rm",
        "--volume",
        `${root}:/workspace:ro`,
        "--workdir",
        "/workspace",
        "debian:trixie-slim@sha256:020c0d20b9880058cbe785a9db107156c3c75c2ac944a6aa7ab59f2add76a7bd",
        "bash",
        "-lc",
        [
          "set -euo pipefail",
          "apt-get update >/dev/null",
          "DEBIAN_FRONTEND=noninteractive apt-get install --yes --no-install-recommends ca-certificates openssl python3-cryptography python3-securesystemslib python3-tuf rauc squashfs-tools >/dev/null",
          "python3 scripts/tests/host-publication-e2e.py",
        ].join("\n"),
      ],
    },
    {
      name: "Test Linux updater durability and process safety",
      command: "docker",
      args: [
        "run",
        "--rm",
        "--init",
        "--entrypoint",
        "sh",
        "--volume",
        `${root}:/workspace:ro`,
        "--tmpfs",
        "/workspace/data:rw,exec,mode=1777",
        "--volume",
        "/var/run/docker.sock:/var/run/docker.sock",
        "--workdir",
        "/workspace",
        "docker:28-cli@sha256:625d9431a9f54c5a2bc90f24f0e1c3d55b1349fd857dd85035f98c2c9acbdd4d",
        "-lc",
        [
          "set -euo pipefail",
          "apk add --no-cache nodejs >/dev/null",
          "node --test scripts/tests/system-update-agent.test.mjs scripts/tests/host-update-agent-interlock.test.mjs scripts/tests/update-agent-process-safety.test.mjs scripts/tests/update-agent-service.test.mjs scripts/tests/source-profile-agent.test.mjs scripts/tests/storage-agent.test.mjs",
        ].join("\n"),
      ],
    },
    npmCheck("Test application workspaces with coverage", "test:coverage"),
    npmCheck("Test operational tooling", "test:tooling"),
    npmCheck("Test TP-Link bridge with coverage", "test:coverage:python"),
    npmCheck("Build application", "build"),
    {
      name: "Validate complete Compose configuration",
      command: "docker",
      args: [
        "compose",
        "--profile",
        "self-update",
        "--profile",
        "tapo-history",
        "--profile",
        "maintenance",
        "--profile",
        "migration",
        "--profile",
        "cloudflare",
        "config",
        "--quiet",
      ],
    },
    {
      name: "Validate appliance Compose configuration",
      command: "docker",
      args: [
        "compose",
        "--profile",
        "maintenance",
        "--profile",
        "migration",
        "config",
        "--quiet",
      ],
      env: {
        STUGA_HOST_BIND_USER: "0:0",
        STUGA_UPDATE_OPERATIONS_DIRECTORY: "stuga-update-operations",
        STUGA_UPDATE_OPERATIONS_MOUNT_OPTIONS: "rw",
      },
    },
  );

  if (!skipContainerBuilds) {
    for (const image of [
      { name: "api", target: "api", dockerfile: "Dockerfile" },
      { name: "backup", target: "backup", dockerfile: "Dockerfile" },
      { name: "web", target: "web", dockerfile: "Dockerfile" },
      { name: "tapo-export-runner", target: "tapo-export-runner", dockerfile: "Dockerfile" },
      { name: "update-agent", target: "update-agent", dockerfile: "Dockerfile" },
      { name: "mqtt", target: "runtime", dockerfile: "deploy/mqtt/Dockerfile" },
      { name: "nexus433", target: "runtime", dockerfile: "deploy/nexus433/Dockerfile" },
    ]) {
      checks.push({
        name: `Build ${image.name} production container`,
        command: "docker",
        args: [
          "build",
          "--target",
          image.target,
          "--file",
          image.dockerfile,
          "--tag",
          `stugu-${image.name}-local-ci:${shortCommit}`,
          ".",
        ],
      });
    }
  }

  checks.push(npmCheck("Smoke-test built API", "smoke:built-api"));

  if (currentPlatform === "darwin") {
    const derivedData = resolve(root, "dist", "ci", "xcode-derived-data");
    checks.push(
      {
        name: "Test portable Swift core",
        command: "swift",
        args: ["test", "--package-path", "apps/ios"],
      },
      {
        name: "Build iOS companion",
        command: "xcodebuild",
        args: [
          "-project",
          "apps/ios/Stugu.xcodeproj",
          "-scheme",
          "Stugu",
          "-destination",
          "generic/platform=iOS Simulator",
          "-derivedDataPath",
          resolve(derivedData, "ios"),
          "CODE_SIGNING_ALLOWED=NO",
          "build",
        ],
      },
      {
        name: "Build Mac Catalyst companion",
        command: "xcodebuild",
        args: [
          "-project",
          "apps/ios/Stugu.xcodeproj",
          "-scheme",
          "Stugu",
          "-destination",
          "platform=macOS,variant=Mac Catalyst",
          "-derivedDataPath",
          resolve(derivedData, "catalyst"),
          "CODE_SIGNING_ALLOWED=NO",
          "build",
        ],
      },
    );
  }

  if (withSonar) checks.push(npmCheck("Run Sonar quality gate", "sonar:scan"));
  return checks;
}

function pathEntry(path) {
  try {
    return lstatSync(path);
  } catch (error) {
    if (error?.code === "ENOENT" || error?.code === "ENOTDIR") {
      return undefined;
    }
    throw error;
  }
}

function pathKey(path) {
  return resolve(path).toLowerCase();
}

function samePath(left, right) {
  return pathKey(left) === pathKey(right);
}

function containsPath(parent, candidate) {
  const suffix = relative(parent, candidate);
  return (
    suffix === "" ||
    (suffix !== ".." &&
      !suffix.startsWith(`..${sep}`) &&
      !isAbsolute(suffix))
  );
}

function inspectOutputPath(
  path,
  label,
  { repositoryRoot, kind = "file" } = {},
) {
  const absolute = resolve(path);
  const missing = [];
  let existing = absolute;
  let details = pathEntry(existing);

  while (!details) {
    const parent = dirname(existing);
    if (parent === existing) {
      throw new Error(
        `${label} has no existing filesystem ancestor: ${absolute}`,
      );
    }
    missing.unshift(basename(existing));
    existing = parent;
    details = pathEntry(existing);
  }

  const worktree = repositoryRoot ? resolve(repositoryRoot) : undefined;
  const stopAt =
    worktree && containsPath(worktree, absolute) ? worktree : undefined;
  let component = existing;
  while (true) {
    const componentDetails = lstatSync(component);
    if (componentDetails.isSymbolicLink()) {
      throw new Error(
        `${label} must not use a symbolic-link or junction alias: ${component}`,
      );
    }
    if (stopAt && samePath(component, stopAt)) break;
    const parent = dirname(component);
    if (parent === component) break;
    component = parent;
  }

  if (missing.length > 0 && !details.isDirectory()) {
    throw new Error(`${label} has a non-directory parent: ${existing}`);
  }

  const canonical = resolve(realpathSync.native(existing), ...missing);
  if (!samePath(canonical, absolute)) {
    throw new Error(`${label} must not use a filesystem alias: ${absolute}`);
  }

  const destinationDetails = missing.length === 0 ? details : undefined;
  if (destinationDetails) {
    if (kind === "directory" && !destinationDetails.isDirectory()) {
      throw new Error(`${label} must be a directory: ${absolute}`);
    }
    if (kind === "file" && !destinationDetails.isFile()) {
      throw new Error(`${label} must be a regular file: ${absolute}`);
    }
    if (kind === "file" && destinationDetails.nlink > 1) {
      throw new Error(`${label} must not be a hard-link alias: ${absolute}`);
    }
  }

  return {
    canonical,
    details: destinationDetails,
    exists: Boolean(destinationDetails),
    path: absolute,
  };
}

function strictDescendant(parent, candidate) {
  return !samePath(parent, candidate) && containsPath(parent, candidate);
}

export function assertReportPathsSafe(repositoryRoot, paths) {
  const repository = resolve(repositoryRoot);
  const repositoryDetails = pathEntry(repository);
  if (!repositoryDetails?.isDirectory() || repositoryDetails.isSymbolicLink()) {
    throw new Error(`Git worktree must be a real directory: ${repository}`);
  }
  const canonicalRepository = realpathSync.native(repository);
  const defaultDirectory = resolve(repository, "dist", "ci");
  const defaultInfo = inspectOutputPath(
    defaultDirectory,
    "Default local-CI receipt directory",
    { repositoryRoot: repository, kind: "directory" },
  );

  if (!samePath(paths.directory, dirname(paths.report))) {
    throw new Error("Local-CI receipt directory must contain the report");
  }

  const report = inspectOutputPath(paths.report, "Local-CI report", {
    repositoryRoot: repository,
  });
  const checksum = inspectOutputPath(paths.checksum, "Local-CI checksum", {
    repositoryRoot: repository,
  });

  for (const output of [report, checksum]) {
    if (
      containsPath(canonicalRepository, output.canonical) &&
      !strictDescendant(defaultInfo.canonical, output.canonical)
    ) {
      throw new Error(
        `${output.path} must be under ${defaultDirectory} or outside the Git worktree`,
      );
    }
  }

  if (
    samePath(report.canonical, checksum.canonical) ||
    strictDescendant(report.canonical, checksum.canonical) ||
    strictDescendant(checksum.canonical, report.canonical)
  ) {
    throw new Error("Local-CI report and checksum destinations collide");
  }

  if (
    report.details &&
    checksum.details &&
    report.details.dev === checksum.details.dev &&
    report.details.ino === checksum.details.ino
  ) {
    throw new Error("Local-CI report and checksum are filesystem aliases");
  }

  return { report, checksum };
}

export function reportPaths(repositoryRoot, version, overrides = {}) {
  const defaultDirectory = resolve(repositoryRoot, "dist", "ci");
  const report = resolve(
    overrides.report ??
      resolve(defaultDirectory, `stugu-${version}-local-ci.json`),
  );
  const directory = dirname(report);
  const paths = {
    directory,
    report,
    checksum: resolve(overrides.checksum ?? `${report}.sha256`),
  };
  assertReportPathsSafe(repositoryRoot, paths);
  return paths;
}

function captured(command, args, options = {}) {
  const result = spawnSync(command, args, {
    cwd: root,
    encoding: "utf8",
    env: options.env ?? process.env,
    stdio: ["ignore", "pipe", "pipe"],
  });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new Error(
      `${printable(command, args)} failed: ${result.stderr?.trim() || result.status}`,
    );
  }
  return result.stdout.trim();
}

function defaultBaseRef() {
  const remoteMain = spawnSync(
    "git",
    ["rev-parse", "--verify", "--quiet", "origin/main^{commit}"],
    { cwd: root, stdio: "ignore" },
  );
  if (remoteMain.status !== 0) return undefined;
  return captured("git", ["merge-base", "HEAD", "origin/main"]);
}

function differsFromBase(baseRef) {
  if (!baseRef) return false;
  const difference = spawnSync("git", ["diff", "--quiet", baseRef, "--"], {
    cwd: root,
    stdio: "ignore",
  });
  if (difference.status !== 0 && difference.status !== 1) {
    throw new Error(`Could not compare the working tree with ${baseRef}`);
  }
  const untracked = captured("git", [
    "ls-files",
    "--others",
    "--exclude-standard",
  ]);
  return difference.status === 1 || Boolean(untracked);
}

function assertExpectedContents(info, contents, label) {
  if (!info.exists) return true;
  if (readFileSync(info.path, "utf8") !== contents) {
    throw new Error(
      `${label} already exists with different content: ${info.path}`,
    );
  }
  return false;
}

function assertFinalContents(info, contents, label) {
  if (!info.exists) {
    throw new Error(`${label} was not created: ${info.path}`);
  }
  assertExpectedContents(info, contents, label);
}

function atomicCreate(path, contents) {
  const directory = dirname(path);
  const temporary = resolve(
    directory,
    `.${basename(path)}.${process.pid}.${randomBytes(16).toString("hex")}.tmp`,
  );
  let descriptor;

  try {
    descriptor = openSync(temporary, "wx", 0o600);
    writeFileSync(descriptor, contents, "utf8");
    fsyncSync(descriptor);
    closeSync(descriptor);
    descriptor = undefined;

    // This follows the shared runtime helper's durable temporary-file pattern.
    // A hard-link publication is atomic but, unlike rename, cannot replace a
    // destination that appeared after the safety preflight.
    linkSync(temporary, path);
  } finally {
    if (descriptor !== undefined) closeSync(descriptor);
    if (pathEntry(temporary)) unlinkSync(temporary);
  }
}

function createExpectedFile(paths, key, contents, label, repositoryRoot) {
  let safe = assertReportPathsSafe(repositoryRoot, paths);
  if (!assertExpectedContents(safe[key], contents, label)) return;

  try {
    atomicCreate(safe[key].path, contents);
  } catch (error) {
    if (error?.code !== "EEXIST") throw error;
    safe = assertReportPathsSafe(repositoryRoot, paths);
    if (assertExpectedContents(safe[key], contents, label)) {
      throw new Error(`${label} destination changed while it was written`);
    }
  }
}

export function writeReport(paths, report, repositoryRoot = root) {
  const contents = `${JSON.stringify(report, null, 2)}\n`;
  const checksum = createHash("sha256").update(contents).digest("hex");
  const checksumContents = `${checksum}  ${basename(paths.report)}\n`;

  let safe = assertReportPathsSafe(repositoryRoot, paths);
  assertExpectedContents(safe.report, contents, "Local-CI report");
  assertExpectedContents(
    safe.checksum,
    checksumContents,
    "Local-CI checksum",
  );

  for (const directory of new Set([
    dirname(paths.report),
    dirname(paths.checksum),
  ])) {
    mkdirSync(directory, { recursive: true });
  }

  safe = assertReportPathsSafe(repositoryRoot, paths);
  const writeReceipt = assertExpectedContents(
    safe.report,
    contents,
    "Local-CI report",
  );
  const writeChecksum = assertExpectedContents(
    safe.checksum,
    checksumContents,
    "Local-CI checksum",
  );

  if (writeReceipt) {
    createExpectedFile(
      paths,
      "report",
      contents,
      "Local-CI report",
      repositoryRoot,
    );
  }
  if (writeChecksum) {
    createExpectedFile(
      paths,
      "checksum",
      checksumContents,
      "Local-CI checksum",
      repositoryRoot,
    );
  }

  safe = assertReportPathsSafe(repositoryRoot, paths);
  assertFinalContents(safe.report, contents, "Local-CI report");
  assertFinalContents(
    safe.checksum,
    checksumContents,
    "Local-CI checksum",
  );
}

function checkIdentifier(check) {
  const fixed = new Map([
    ["Install Node.js dependencies", "INSTALL_NODE"],
    ["Install Python test dependencies", "INSTALL_PYTHON"],
    ["Check release version against the base", "VERSION_BASE"],
    ["Check release version consistency", "VERSION"],
    ["Typecheck and architecture checks", "TYPECHECK"],
    ["Lint Python components", "PYTHON_LINT"],
    ["Check Python formatting", "PYTHON_FORMAT"],
    ["Test signed host publication with native RAUC and TUF", "HOST_PUBLICATION"],
    ["Test Linux updater durability and process safety", "UPDATER_LINUX"],
    ["Test application workspaces with coverage", "WORKSPACE_COVERAGE"],
    ["Test operational tooling", "OPERATIONAL_TOOLING"],
    ["Test TP-Link bridge with coverage", "TP_LINK_COVERAGE"],
    ["Build application", "APPLICATION_BUILD"],
    ["Validate complete Compose configuration", "COMPOSE_COMPLETE"],
    ["Validate appliance Compose configuration", "COMPOSE_APPLIANCE"],
    ["Smoke-test built API", "API_SMOKE"],
    ["Test portable Swift core", "SWIFT_TEST"],
    ["Build iOS companion", "IOS_BUILD"],
    ["Build Mac Catalyst companion", "MAC_CATALYST_BUILD"],
    ["Run Sonar quality gate", "SONAR"],
  ]);
  if (fixed.has(check.name)) return fixed.get(check.name);
  const container = /^Build (.+) production container$/u.exec(check.name);
  if (container) return `CONTAINER_${container[1].replace(/[^A-Za-z0-9]+/gu, "_").toUpperCase()}`;
  throw new Error(`Local CI check has no stable id: ${check.name}`);
}

function runCheck(check) {
  const invocation = platformInvocation(check.command, check.args);
  const startedAt = new Date();
  console.log(`\n[local CI] ${check.name}\n> ${printable(check.command, check.args)}`);
  const result = spawnSync(invocation.command, invocation.args, {
    cwd: root,
    env: { ...process.env, ...check.env },
    stdio: "inherit",
  });
  const finishedAt = new Date();
  return {
    id: checkIdentifier(check),
    name: check.name,
    command: printable(check.command, check.args),
    startedAt: startedAt.toISOString(),
    finishedAt: finishedAt.toISOString(),
    durationMs: finishedAt.getTime() - startedAt.getTime(),
    status: result.status ?? 1,
    error: result.error?.message,
  };
}

function main(argv = process.argv.slice(2), env = process.env) {
  const options = parseArguments(argv);
  if (options.help) {
    console.log(usage());
    return;
  }

  const version = JSON.parse(
    readFileSync(resolve(root, "package.json"), "utf8"),
  ).version;
  const commit = captured("git", ["rev-parse", "HEAD"]);
  const workingTreeDirty = Boolean(captured("git", ["status", "--porcelain"]));
  const baseRef = options.baseRef ?? env.VERSION_BASE_REF ?? defaultBaseRef();
  const baseVersionCheck = differsFromBase(baseRef);
  const paths = reportPaths(root, version, {
    report: options.report,
    checksum: options.checksum,
  });
  // Docker needs the nested mountpoint to exist before it can place the
  // writable tmpfs beneath the read-only source bind in a fresh checkout.
  mkdirSync(resolve(root, "data"), { recursive: true });
  const checks = createCheckPlan({
    ...options,
    baseRef,
    baseVersionCheck,
    commit,
  });
  const startedAt = new Date();
  const results = [];
  let result = "passed";

  for (const check of checks) {
    const checkResult = runCheck(check);
    results.push(checkResult);
    if (checkResult.status !== 0) {
      result = "failed";
      break;
    }
  }

  const finishedAt = new Date();
  writeReport(paths, {
    schemaVersion: 1,
    projectVersion: version,
    commit,
    workingTreeDirty,
    baseRef: baseRef ?? null,
    baseVersionCheck,
    result,
    startedAt: startedAt.toISOString(),
    finishedAt: finishedAt.toISOString(),
    durationMs: finishedAt.getTime() - startedAt.getTime(),
    host: {
      platform: platform(),
      release: release(),
      architecture: arch(),
      node: process.version,
    },
    options: {
      install: options.install,
      skipContainerBuilds: options.skipContainerBuilds,
      withSonar: options.withSonar,
    },
    limitations:
      process.platform === "darwin"
        ? []
        : ["Native iOS and Mac Catalyst checks require macOS with Xcode."],
    checks: results,
  });

  console.log(`\nLocal CI ${result}. Receipt: ${paths.report}`);
  if (result !== "passed") process.exitCode = 1;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    main();
  } catch (error) {
    console.error(
      `\nLocal CI could not start: ${error instanceof Error ? error.message : String(error)}`,
    );
    process.exitCode = 1;
  }
}
