#!/usr/bin/env node

import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { arch, platform, release } from "node:os";
import { basename, dirname, resolve } from "node:path";
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

export function reportPaths(repositoryRoot, version) {
  const directory = resolve(repositoryRoot, "dist", "ci");
  const report = resolve(directory, `stugu-${version}-local-ci.json`);
  return {
    directory,
    report,
    checksum: `${report}.sha256`,
  };
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

function writeReport(paths, report) {
  mkdirSync(paths.directory, { recursive: true });
  const contents = `${JSON.stringify(report, null, 2)}\n`;
  writeFileSync(paths.report, contents, "utf8");
  const checksum = createHash("sha256").update(contents).digest("hex");
  writeFileSync(
    paths.checksum,
    `${checksum}  ${basename(paths.report)}\n`,
    "utf8",
  );
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
  const paths = reportPaths(root, version);
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
