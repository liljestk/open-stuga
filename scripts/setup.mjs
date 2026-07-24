#!/usr/bin/env node

import { spawnSync } from "node:child_process";
import {
  constants,
  copyFileSync,
  existsSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { dirname, parse as parsePath, resolve } from "node:path";
import { createInterface } from "node:readline/promises";
import { Writable } from "node:stream";
import { fileURLToPath } from "node:url";
import {
  provision as provisionCloudflare,
  validateOptions as validateCloudflareOptions,
  validateToken as validateCloudflareToken,
  verifyDeployment as verifyCloudflareDeployment,
} from "./cloudflare-stuga.mjs";
import { installUpdateAgentService } from "./stuga-update-agent-service.mjs";

export const MINIMUM_NODE_VERSION = Object.freeze([22, 13, 0]);
export const INSTALL_MODES = Object.freeze(["local", "docker", "podman", "rpi"]);
export const REMOTE_ACCESS_MODES = Object.freeze(["none", "remote-ui", "stugby-coordinator"]);

const scriptPath = fileURLToPath(import.meta.url);
const projectRoot = resolve(dirname(scriptPath), "..");
const modeChoices = [
  { value: "local", label: "Local development (Node.js)" },
  { value: "docker", label: "Docker Compose (recommended for a home installation)" },
  { value: "podman", label: "Podman Compose" },
  { value: "rpi", label: "Raspberry Pi 4 appliance" },
];
const remoteAccessChoices = [
  { value: "none", label: "Keep Stuga local only (smallest trust boundary)" },
  { value: "remote-ui", label: "Secure remote access with Cloudflare Tunnel + Access" },
  { value: "stugby-coordinator", label: "Remote access plus a Stugby coordinator" },
];

export function parseVersion(version) {
  const match = /^v?(\d+)\.(\d+)\.(\d+)/u.exec(version);
  return match ? match.slice(1).map(Number) : null;
}

export function supportsNode(version) {
  const parsed = parseVersion(version);
  if (!parsed) return false;

  for (let index = 0; index < MINIMUM_NODE_VERSION.length; index += 1) {
    if (parsed[index] > MINIMUM_NODE_VERSION[index]) return true;
    if (parsed[index] < MINIMUM_NODE_VERSION[index]) return false;
  }
  return true;
}

function normalizedMode(value) {
  const aliases = { node: "local", pi: "rpi", raspberrypi: "rpi" };
  const normalized = aliases[value?.toLowerCase()] ?? value?.toLowerCase();
  if (!INSTALL_MODES.includes(normalized)) {
    throw new Error(`Install mode must be one of: ${INSTALL_MODES.join(", ")}`);
  }
  return normalized;
}

function normalizedRemoteAccessMode(value) {
  const aliases = {
    coordinator: "stugby-coordinator",
    off: "none",
    ui: "remote-ui",
  };
  const normalized = aliases[value?.toLowerCase()] ?? value?.toLowerCase();
  if (!REMOTE_ACCESS_MODES.includes(normalized)) {
    throw new Error(`Cloudflare mode must be one of: ${REMOTE_ACCESS_MODES.join(", ")}`);
  }
  return normalized;
}

function requiredOptionValue(args, index, inlineValue, option) {
  const value = inlineValue ?? args[index + 1];
  if (!value || value.startsWith("--")) throw new Error(`${option} requires a value`);
  return value;
}

export function parseSetupArgs(args) {
  const options = {
    cloudflare: {
      accessTokenFile: null,
      accountId: null,
      hostname: null,
      ownerEmail: null,
      provisionTokenFile: null,
      secretDirectory: null,
      zone: null,
      zoneId: null,
    },
    data: null,
    dryRun: false,
    help: false,
    installUpdateAgent: null,
    mode: null,
    piAction: null,
    port: null,
    remoteAccess: null,
    skipInstall: false,
    start: null,
    yes: false,
  };

  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index];
    const equalsIndex = argument.indexOf("=");
    const option = equalsIndex === -1 ? argument : argument.slice(0, equalsIndex);
    const inlineValue = equalsIndex === -1 ? null : argument.slice(equalsIndex + 1);

    if (option === "--help" || option === "-h") options.help = true;
    else if (option === "--yes" || option === "-y") options.yes = true;
    else if (option === "--dry-run") options.dryRun = true;
    else if (option === "--skip-install") options.skipInstall = true;
    else if (option === "--install-update-agent" || option === "--no-update-agent") {
      const installUpdateAgent = option === "--install-update-agent";
      if (options.installUpdateAgent !== null && options.installUpdateAgent !== installUpdateAgent) {
        throw new Error("--install-update-agent and --no-update-agent cannot be combined");
      }
      options.installUpdateAgent = installUpdateAgent;
    } else if (option === "--no-cloudflare") {
      if (options.remoteAccess && options.remoteAccess !== "none") {
        throw new Error("--cloudflare and --no-cloudflare cannot be combined");
      }
      options.remoteAccess = "none";
    } else if (option === "--cloudflare") {
      const value = normalizedRemoteAccessMode(requiredOptionValue(args, index, inlineValue, option));
      if (value === "none") throw new Error("Use --no-cloudflare instead of --cloudflare none");
      if (options.remoteAccess && options.remoteAccess !== value) {
        throw new Error("Conflicting Cloudflare modes cannot be combined");
      }
      options.remoteAccess = value;
      if (inlineValue === null) index += 1;
    } else if (option === "--demo" || option === "--real") {
      const data = option.slice(2);
      if (options.data && options.data !== data) throw new Error("--demo and --real cannot be combined");
      options.data = data;
    } else if (option === "--start" || option === "--no-start") {
      const start = option === "--start";
      if (options.start !== null && options.start !== start) {
        throw new Error("--start and --no-start cannot be combined");
      }
      options.start = start;
    } else if (option === "--mode") {
      const value = requiredOptionValue(args, index, inlineValue, option);
      options.mode = normalizedMode(value);
      if (inlineValue === null) index += 1;
    } else if (option === "--port") {
      const value = requiredOptionValue(args, index, inlineValue, option);
      const port = Number(value);
      if (!Number.isInteger(port) || port < 1 || port > 65_535) {
        throw new Error("--port must be an integer from 1 through 65535");
      }
      options.port = port;
      if (inlineValue === null) index += 1;
    } else if (option === "--pi-action") {
      const value = requiredOptionValue(args, index, inlineValue, option).toLowerCase();
      if (value !== "flash" && value !== "build") {
        throw new Error("--pi-action must be flash or build");
      }
      options.piAction = value;
      if (inlineValue === null) index += 1;
    } else if (option === "--cloudflare-hostname") {
      options.cloudflare.hostname = requiredOptionValue(args, index, inlineValue, option);
      if (inlineValue === null) index += 1;
    } else if (option === "--cloudflare-zone") {
      options.cloudflare.zone = requiredOptionValue(args, index, inlineValue, option);
      if (inlineValue === null) index += 1;
    } else if (option === "--cloudflare-owner-email") {
      options.cloudflare.ownerEmail = requiredOptionValue(args, index, inlineValue, option);
      if (inlineValue === null) index += 1;
    } else if (option === "--cloudflare-provision-token-file") {
      options.cloudflare.provisionTokenFile = requiredOptionValue(args, index, inlineValue, option);
      if (inlineValue === null) index += 1;
    } else if (option === "--cloudflare-access-token-file") {
      options.cloudflare.accessTokenFile = requiredOptionValue(args, index, inlineValue, option);
      if (inlineValue === null) index += 1;
    } else if (option === "--cloudflare-account-id") {
      options.cloudflare.accountId = requiredOptionValue(args, index, inlineValue, option);
      if (inlineValue === null) index += 1;
    } else if (option === "--cloudflare-zone-id") {
      options.cloudflare.zoneId = requiredOptionValue(args, index, inlineValue, option);
      if (inlineValue === null) index += 1;
    } else if (option === "--cloudflare-secret-dir") {
      options.cloudflare.secretDirectory = requiredOptionValue(args, index, inlineValue, option);
      if (inlineValue === null) index += 1;
    } else {
      throw new Error(`Unknown option: ${argument}`);
    }
  }

  return options;
}

export function ensureEnvironmentFile(root) {
  const examplePath = resolve(root, ".env.example");
  const environmentPath = resolve(root, ".env");

  if (existsSync(environmentPath)) return "existing";
  if (!existsSync(examplePath)) {
    throw new Error(`Missing environment template: ${examplePath}`);
  }

  try {
    copyFileSync(examplePath, environmentPath, constants.COPYFILE_EXCL);
    return "created";
  } catch (error) {
    if (error && typeof error === "object" && error.code === "EEXIST") {
      return "existing";
    }
    throw error;
  }
}

export function environmentValues(source) {
  const values = {};
  for (const line of source.split(/\r?\n/u)) {
    const match = /^([A-Z][A-Z0-9_]*)=(.*)$/u.exec(line);
    if (match) values[match[1]] = match[2];
  }
  return values;
}

export function updateEnvironmentText(source, updates) {
  const newline = source.includes("\r\n") ? "\r\n" : "\n";
  const lines = source.replace(/\r?\n$/u, "").split(/\r?\n/u);
  const seen = new Set();
  const updated = lines.map((line) => {
    const match = /^([A-Z][A-Z0-9_]*)=.*$/u.exec(line);
    if (!match || !Object.hasOwn(updates, match[1])) return line;
    seen.add(match[1]);
    return `${match[1]}=${updates[match[1]]}`;
  });

  const missing = Object.entries(updates).filter(([key]) => !seen.has(key));
  if (missing.length > 0 && updated.at(-1) !== "") updated.push("");
  for (const [key, value] of missing) updated.push(`${key}=${value}`);
  return `${updated.join(newline)}${newline}`;
}

export function configureEnvironment(root, updates, dryRun = false) {
  const environmentPath = resolve(root, ".env");
  const examplePath = resolve(root, ".env.example");
  const exists = existsSync(environmentPath);
  if (!exists && !existsSync(examplePath)) {
    throw new Error(`Missing environment template: ${examplePath}`);
  }

  const original = readFileSync(exists ? environmentPath : examplePath, "utf8");
  const updated = updateEnvironmentText(original, updates);
  if (dryRun) {
    return { changed: updated !== original, state: exists ? "existing" : "would-create" };
  }

  const state = ensureEnvironmentFile(root);
  const current = readFileSync(environmentPath, "utf8");
  const next = updateEnvironmentText(current, updates);
  if (next === current) return { changed: false, state };

  const temporaryPath = `${environmentPath}.${process.pid}.${Date.now()}.tmp`;
  try {
    writeFileSync(temporaryPath, next, {
      encoding: "utf8",
      mode: statSync(environmentPath).mode,
    });
    renameSync(temporaryPath, environmentPath);
  } finally {
    if (existsSync(temporaryPath)) rmSync(temporaryPath, { force: true });
  }
  return { changed: true, state };
}

export function basicEnvironmentUpdates(configuration) {
  if (configuration.mode === "rpi") return {};
  const updates = {
    MOCK_ENABLED: configuration.data === "demo" ? "true" : "false",
  };
  if (configuration.mode === "docker" || configuration.mode === "podman") {
    updates.APP_PORT = String(configuration.port);
    if (configuration.cloudflare) {
      updates.BIND_ADDRESS = "127.0.0.1";
      updates.STUGA_CLOUDFLARE_SECRET_DIR = configuration.cloudflare.composeSecretDirectory;
      updates.STUGA_CLOUDFLARE_ENV_FILE = `${configuration.cloudflare.composeSecretDirectory}/config.env`;
    }
  }
  if (configuration.mode === "podman") {
    // The Docker-socket self-update helper is intentionally unavailable here.
    updates.COMPOSE_PROFILES = "";
  }
  if (configuration.mode === "docker"
    && configuration.installUpdateAgent
    && Number.isInteger(configuration.updateAgentGroupId)) {
    updates.STUGA_UPDATE_OPERATIONS_GID = String(configuration.updateAgentGroupId);
  }
  return updates;
}

function printHelp() {
  console.log(`Configure a minimal Stuga installation.

Usage:
  npm run setup
  npm run setup -- --mode <local|docker|podman|rpi> [options]

Options:
  --mode <mode>       Choose local, Docker, Podman, or Raspberry Pi.
  --demo | --real     Select disposable demo data or a real-home setup.
  --port <number>     Container web port (default: 8080).
  --start             Start Docker/Podman containers after configuration.
  --no-start          Configure containers without starting them.
  --install-update-agent
                      Install and start the per-user Docker update service.
  --no-update-agent   Do not install the update service (the secure default).
  --cloudflare <mode> Provision and verify remote-ui or stugby-coordinator.
  --no-cloudflare     Keep the installation local only.
  --cloudflare-hostname <host>        Public hostname, such as stuga.example.com.
  --cloudflare-zone <zone>            Cloudflare DNS zone, such as example.com.
  --cloudflare-owner-email <email>    Permanent Access recovery operator.
  --cloudflare-provision-token-file <path>
  --cloudflare-access-token-file <path>
                       Read two different tokens from protected files.
  --cloudflare-account-id <id>        Optional unambiguous account selection.
  --cloudflare-zone-id <id>           Optional unambiguous zone selection.
  --cloudflare-secret-dir <path>      Generated runtime directory.
  --skip-install      Do not run npm ci for local development.
  --pi-action <type>  Show flash or local image-build steps.
  --yes               Accept recommended answers without prompting.
  --dry-run           Show the plan without writing files or running commands.
  --help              Show this help.

New installs bind to loopback, including when Tunnel access is enabled.
Interactive token entry is hidden and never stored in shell history or .env.
Configure Home/device credentials later in Stuga's guided web setup.`);
}

function npmInvocation() {
  if (process.env.npm_execpath && existsSync(process.env.npm_execpath)) {
    return [process.execPath, [process.env.npm_execpath, "ci"]];
  }
  return [process.platform === "win32" ? "npm.cmd" : "npm", ["ci"]];
}

async function askChoice(readline, title, choices, defaultValue) {
  console.log(`\n${title}`);
  choices.forEach((choice, index) => console.log(`  ${index + 1}. ${choice.label}`));
  const defaultIndex = choices.findIndex((choice) => choice.value === defaultValue);

  while (true) {
    const answer = (await readline.question(`Choose [${defaultIndex + 1}]: `)).trim().toLowerCase();
    if (!answer) return defaultValue;
    const numeric = Number(answer);
    if (Number.isInteger(numeric) && choices[numeric - 1]) return choices[numeric - 1].value;
    const exact = choices.find((choice) => choice.value === answer);
    if (exact) return exact.value;
    console.log("Choose one of the listed options.");
  }
}

async function askYesNo(readline, question, defaultValue) {
  const hint = defaultValue ? "Y/n" : "y/N";
  while (true) {
    const answer = (await readline.question(`${question} [${hint}]: `)).trim().toLowerCase();
    if (!answer) return defaultValue;
    if (answer === "y" || answer === "yes") return true;
    if (answer === "n" || answer === "no") return false;
    console.log("Answer yes or no.");
  }
}

async function askPort(readline, defaultPort) {
  while (true) {
    const answer = (await readline.question(`Web port [${defaultPort}]: `)).trim();
    if (!answer) return defaultPort;
    const port = Number(answer);
    if (Number.isInteger(port) && port >= 1 && port <= 65_535) return port;
    console.log("Enter a port from 1 through 65535.");
  }
}

async function askRequired(readline, label, defaultValue = null) {
  while (true) {
    const suffix = defaultValue ? ` [${defaultValue}]` : "";
    const answer = (await readline.question(`${label}${suffix}: `)).trim();
    if (answer) return answer;
    if (defaultValue) return defaultValue;
    console.log("Enter a value to continue.");
  }
}

function guessedZone(hostname) {
  const labels = hostname.split(".");
  return labels.length > 2 ? labels.slice(-2).join(".") : hostname;
}

function hasCloudflareDetails(options) {
  return Object.values(options.cloudflare).some((value) => value !== null);
}

function composeSecretDirectory(value) {
  const normalized = value.trim().replaceAll("\\", "/").replace(/\/+$/u, "");
  if (!normalized || /[\r\n#]/u.test(normalized)) {
    throw new Error("--cloudflare-secret-dir contains unsupported characters");
  }
  return normalized;
}

function printCloudflarePrerequisites() {
  console.log(`
Cloudflare will keep the host port on loopback and publish only through Access.
The DNS zone must already be active in that account. Open Zero Trust once and
finish its initial account setup, then create two different API tokens at:
https://dash.cloudflare.com/profile/api-tokens

  1. Temporary setup token: Access Apps and Policies Write, Cloudflare Tunnel
     Write, and DNS Write for the exact zone. Add Zone Read when letting this
     wizard discover the zone.
  2. Runtime token: Access Organizations, Identity Providers, and Groups Write
     only. Stuga retains this token to reconcile invited members.

The temporary token is never saved. Revoke it after verification.`);
}

async function resolveCloudflareConfiguration(options, mode, readline, root) {
  const supported = mode === "docker" || mode === "podman";
  let remoteAccess = options.remoteAccess;
  if (remoteAccess === null && readline && supported) {
    remoteAccess = await askChoice(
      readline,
      "Do you need secure access from outside this network?",
      remoteAccessChoices,
      "none",
    );
  }
  remoteAccess ??= "none";

  if (remoteAccess === "none") {
    if (hasCloudflareDetails(options)) {
      throw new Error("Cloudflare details require --cloudflare remote-ui or --cloudflare stugby-coordinator");
    }
    return null;
  }
  if (!supported) {
    throw new Error("Guided Cloudflare setup requires Docker or Podman Compose");
  }
  if (options.start === false) {
    throw new Error("Guided Cloudflare setup must start and verify the connector; remove --no-start");
  }

  if (readline) printCloudflarePrerequisites();
  const hostname = (options.cloudflare.hostname ?? (readline
    ? await askRequired(readline, "Public hostname (no https://)")
    : "")).trim().toLowerCase();
  const zone = (options.cloudflare.zone ?? (readline
    ? await askRequired(readline, "Cloudflare DNS zone", guessedZone(hostname))
    : "")).trim().toLowerCase();
  const ownerEmail = (options.cloudflare.ownerEmail ?? (readline
    ? await askRequired(readline, "Email allowed through Cloudflare Access")
    : "")).trim().toLowerCase();
  if (!hostname) throw new Error("--cloudflare-hostname is required");
  if (!zone) throw new Error("--cloudflare-zone is required");
  if (!ownerEmail) throw new Error("--cloudflare-owner-email is required");

  let provisionTokenFile = options.cloudflare.provisionTokenFile;
  let accessTokenFile = options.cloudflare.accessTokenFile;
  if (Boolean(provisionTokenFile) !== Boolean(accessTokenFile)) {
    throw new Error("Both Cloudflare token-file options are required when either is used");
  }
  let tokenInput = provisionTokenFile ? "files" : "prompt";
  if (!provisionTokenFile && readline) {
    tokenInput = await askChoice(readline, "How should the two API tokens be supplied?", [
      { value: "prompt", label: "Paste into hidden prompts (recommended)" },
      { value: "files", label: "Read existing protected token files" },
    ], "prompt");
    if (tokenInput === "files") {
      provisionTokenFile = await askRequired(readline, "Temporary setup token file");
      accessTokenFile = await askRequired(readline, "Runtime Access token file");
    }
  } else if (!provisionTokenFile && !options.dryRun) {
    throw new Error(
      "Non-interactive Cloudflare setup requires both --cloudflare-provision-token-file and --cloudflare-access-token-file",
    );
  }

  const secretDirectoryInput = options.cloudflare.secretDirectory ?? "./secrets/cloudflare";
  const absoluteSecretDirectory = resolve(root, secretDirectoryInput);
  if (absoluteSecretDirectory === resolve(root)
    || absoluteSecretDirectory === parsePath(absoluteSecretDirectory).root) {
    throw new Error("--cloudflare-secret-dir must be a dedicated subdirectory");
  }
  const cloudflare = {
    accessTokenFile: accessTokenFile ? resolve(root, accessTokenFile) : null,
    accountId: options.cloudflare.accountId?.trim() ?? null,
    command: remoteAccess === "stugby-coordinator" ? "provision-coordinator" : "provision",
    composeSecretDirectory: composeSecretDirectory(secretDirectoryInput),
    hostname,
    mode: remoteAccess,
    ownerEmail,
    provisionTokenFile: provisionTokenFile ? resolve(root, provisionTokenFile) : null,
    secretDirectory: absoluteSecretDirectory,
    tokenInput,
    zone,
    zoneId: options.cloudflare.zoneId?.trim() ?? null,
  };
  validateCloudflareOptions(cloudflare);
  if (cloudflare.provisionTokenFile === cloudflare.accessTokenFile
    && cloudflare.provisionTokenFile !== null) {
    throw new Error("Cloudflare setup and runtime tokens must use different files");
  }
  return cloudflare;
}

export async function resolveConfiguration(options, interaction = {}) {
  const interactive = interaction.interactive
    ?? (!options.yes && Boolean(process.stdin.isTTY && process.stdout.isTTY));
  const readline = interactive
    ? interaction.readline ?? createInterface({ input: process.stdin, output: process.stdout })
    : null;
  try {
    const mode = options.mode ?? (readline
      ? await askChoice(readline, "How do you want to install Stuga?", modeChoices, "docker")
      : "local");

    if (options.skipInstall && mode !== "local") {
      throw new Error("--skip-install is only valid with --mode local");
    }
    if (options.port !== null && mode !== "docker" && mode !== "podman") {
      throw new Error("--port is only valid with Docker or Podman");
    }
    if (options.start !== null && mode !== "docker" && mode !== "podman") {
      throw new Error("--start and --no-start are only valid with Docker or Podman");
    }
    if (options.installUpdateAgent !== null && mode !== "docker") {
      throw new Error("--install-update-agent and --no-update-agent are only valid with Docker");
    }
    if (options.piAction && mode !== "rpi") {
      throw new Error("--pi-action is only valid with --mode rpi");
    }
    if (options.data && mode === "rpi") {
      throw new Error("Raspberry Pi data mode is configured on the appliance before its first start");
    }
    if (mode === "rpi" && (options.remoteAccess && options.remoteAccess !== "none"
      || hasCloudflareDetails(options))) {
      throw new Error("Raspberry Pi Cloudflare access is configured on the appliance, not this workstation");
    }

    if (mode === "rpi") {
      const piAction = options.piAction ?? (readline
        ? await askChoice(readline, "Which Raspberry Pi path do you need?", [
          { value: "flash", label: "Flash an existing factory image" },
          { value: "build", label: "Build a factory image on a supported ARM64 Linux host" },
        ], "flash")
        : "flash");
      return { cloudflare: null, mode, piAction };
    }

    const data = options.data ?? (readline
      ? (await askYesNo(readline, "Start with disposable demo data?", false) ? "demo" : "real")
      : "real");
    const port = mode === "docker" || mode === "podman"
      ? options.port ?? (readline ? await askPort(readline, 8080) : 8080)
      : null;
    const cloudflare = await resolveCloudflareConfiguration(
      options,
      mode,
      readline,
      interaction.root ?? projectRoot,
    );
    const start = mode === "docker" || mode === "podman"
      ? cloudflare
        ? true
        : options.start ?? (readline ? await askYesNo(readline, "Start the containers now?", true) : options.yes)
      : false;
    let installUpdateAgent = false;
    if (mode === "docker") {
      if (options.installUpdateAgent !== null) {
        installUpdateAgent = options.installUpdateAgent;
      } else if (readline) {
        console.log(`
The update agent can administer Docker and replace this Stuga installation.
Install it only on a trusted host under a Docker-authorized user account.`);
        installUpdateAgent = await askYesNo(
          readline,
          "Install and start the automatic update agent as a per-user service?",
          false,
        );
      }
    }
    const installDependencies = mode === "local"
      ? !options.skipInstall && (readline
        ? await askYesNo(readline, "Install exact Node.js dependencies now?", true)
        : true)
      : false;

    const updateAgentGroupId = mode === "docker"
      && installUpdateAgent
      && (interaction.platform ?? process.platform) === "linux"
      ? interaction.groupId ?? process.getgid?.() ?? null
      : null;
    return {
      cloudflare,
      data,
      installDependencies,
      installUpdateAgent,
      mode,
      port,
      start,
      updateAgentGroupId,
    };
  } finally {
    readline?.close();
  }
}

function run(command, args, options = {}) {
  return spawnSync(command, args, {
    cwd: options.cwd ?? projectRoot,
    stdio: options.quiet ? "ignore" : "inherit",
    windowsHide: true,
  });
}

export async function readHiddenValue(prompt, interaction = {}) {
  const input = interaction.input ?? process.stdin;
  const output = interaction.output ?? process.stdout;
  if (!input.isTTY || !output.isTTY) {
    throw new Error("Hidden token entry needs an interactive terminal; use protected token files instead");
  }

  const mutedOutput = new Writable({
    write(_chunk, _encoding, callback) {
      callback();
    },
  });
  const readline = createInterface({ input, output: mutedOutput, terminal: true });
  output.write(prompt);
  try {
    return (await readline.question("")).trim();
  } finally {
    output.write("\n");
    readline.close();
  }
}

function wait(milliseconds) {
  return new Promise((resolveWait) => setTimeout(resolveWait, milliseconds));
}

export async function verifyCloudflareWithRetry(cloudflare, dependencies = {}) {
  const verifier = dependencies.verifier ?? verifyCloudflareDeployment;
  const logger = dependencies.logger ?? console;
  const attempts = dependencies.attempts ?? 12;
  const delayMs = dependencies.delayMs ?? 5_000;
  const waitForRetry = dependencies.waitForRetry ?? wait;
  let lastError = null;

  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      return await verifier(
        { secretDirectory: cloudflare.secretDirectory },
        {
          composeCommand: dependencies.composeCommand,
          logger,
        },
      );
    } catch (error) {
      lastError = error;
      if (attempt < attempts) {
        const message = error instanceof Error ? error.message : "Cloudflare is not ready";
        logger.log(`[setup] Waiting for the Cloudflare boundary (${attempt}/${attempts}): ${message}`);
        await waitForRetry(delayMs);
      }
    }
  }
  throw lastError ?? new Error("Cloudflare boundary verification failed");
}

function stopCloudflare(runtime, runner) {
  const result = runner(runtime, ["compose", "stop", "cloudflared"]);
  return !result.error && result.status === 0;
}

export async function activateCloudflare(configuration, dependencies = {}) {
  const cloudflare = configuration.cloudflare;
  if (!cloudflare) return null;
  const runner = dependencies.runner ?? run;
  const provisioner = dependencies.provisioner ?? provisionCloudflare;
  const logger = dependencies.logger ?? console;
  const composeCommand = `${configuration.mode} compose`;
  let tokens = {};

  if (cloudflare.tokenInput === "prompt") {
    const tokenReader = dependencies.tokenReader ?? readHiddenValue;
    logger.log("[setup] Paste each token below. Input is hidden and is not written to .env or shell history.");
    const provisionToken = validateCloudflareToken(
      await tokenReader("Temporary setup token: "),
      "Temporary setup token",
    );
    const accessToken = validateCloudflareToken(
      await tokenReader("Runtime Access token: "),
      "Runtime Access token",
    );
    if (provisionToken === accessToken) {
      throw new Error("Temporary setup and runtime Access tokens must be different");
    }
    tokens = { accessToken, provisionToken };
  }

  await provisioner(cloudflare, {
    ...tokens,
    composeCommand,
    logger,
    printGuidance: false,
  });

  logger.log(`[setup] Recreating Stuga and starting the ${configuration.mode} Tunnel connector`);
  const started = runner(configuration.mode, [
    "compose",
    "up",
    "-d",
    "--build",
    "--force-recreate",
    "api",
    "web",
    "cloudflared",
  ]);
  if (started.error || started.status !== 0) {
    const stopped = stopCloudflare(configuration.mode, runner);
    throw new Error(
      `Containers could not start; ${stopped
        ? "the public connector was stopped"
        : `automatic rollback failed, so run '${composeCommand} stop cloudflared' now`}`,
    );
  }

  try {
    return await verifyCloudflareWithRetry(cloudflare, {
      attempts: dependencies.verifyAttempts,
      composeCommand,
      delayMs: dependencies.verifyDelayMs,
      logger,
      verifier: dependencies.verifier,
      waitForRetry: dependencies.waitForRetry,
    });
  } catch (error) {
    const stopped = stopCloudflare(configuration.mode, runner);
    const reason = error instanceof Error ? error.message : "unknown verification failure";
    throw new Error(
      `Cloudflare security verification failed: ${reason}. ${stopped
        ? "The public connector was stopped; local Stuga is still available."
        : `Automatic rollback failed; run '${composeCommand} stop cloudflared' immediately.`}`,
    );
  }
}

function runtimeHelp(mode) {
  if (mode === "docker") {
    return "Install Docker Desktop or Docker Engine: https://docs.docker.com/get-docker/";
  }
  return "Install Podman and a Compose provider: https://podman.io/docs/installation";
}

export function verifyContainerRuntime(mode, runner = run) {
  const command = mode;
  const version = runner(command, ["--version"], { quiet: true });
  if (version.error || version.status !== 0) {
    throw new Error(`${mode === "docker" ? "Docker" : "Podman"} is not available. ${runtimeHelp(mode)}`);
  }
  const validation = runner(command, ["compose", "config"], { quiet: true });
  if (validation.error || validation.status !== 0) {
    const recovery = mode === "docker"
      ? "Start Docker and check that Docker Compose is installed."
      : "Install a Compose provider and, on Windows/macOS, start the Podman machine.";
    throw new Error(`${mode === "docker" ? "Docker" : "Podman"} Compose could not validate docker-compose.yml. ${recovery}`);
  }
}

function printPiPlan(action) {
  console.log("\nRaspberry Pi keeps its configuration on the appliance, so the local .env was not changed.");
  if (action === "build") {
    console.log(`
Build on 64-bit Raspberry Pi OS Trixie, Debian Trixie, or Debian Bookworm:

  sudo apt update
  sudo apt install --yes git zstd
  ssh-keygen -t ed25519 -f ~/.ssh/stuga_appliance
  RPI_IMAGE_GEN_INSTALL_DEPS=1 \\
  RPI_SSH_PUBLIC_KEY_FILE="$HOME/.ssh/stuga_appliance.pub" \\
  bash scripts/build-rpi-image.sh

Then flash dist/rpi/stuga-rpi4-<version>.img.zst with Raspberry Pi Imager.`);
  } else {
    console.log(`
1. Verify the factory image checksum.
2. Flash the .img.zst file to a 16 GB or larger USB SSD with Raspberry Pi Imager.
3. Boot the Pi with Ethernet attached.
4. Connect securely:

   ssh -L 8080:127.0.0.1:8080 stuga@stuga.local

5. Open http://127.0.0.1:8080 and create the first owner.`);
  }
  console.log("\nFull guide: docs/raspberry-pi-appliance.md");
}

function printNextSteps(configuration, started) {
  if (configuration.mode === "local") {
    console.log(`
Stuga is configured for ${configuration.data === "demo" ? "disposable demo data" : "a real home"}.
Run:  npm run dev
Open: http://localhost:5173`);
    return;
  }

  const runtime = configuration.mode;
  if (configuration.cloudflare) {
    if (!started) {
      console.log(`
Cloudflare plan is ready for https://${configuration.cloudflare.hostname}.
Rerun interactively to paste hidden tokens, or supply both protected token-file
options for non-interactive setup. Local recovery remains on:
http://localhost:${configuration.port}`);
      return;
    }
    console.log(`
Stuga is online and the Cloudflare security boundary was verified.
Open:           https://${configuration.cloudflare.hostname}
Local recovery: http://localhost:${configuration.port}
Stop public:    ${runtime} compose stop cloudflared

Revoke the temporary setup token now. Keep the generated Cloudflare secret
directory protected and keep the runtime Access token active.`);
    if (configuration.cloudflare.mode === "stugby-coordinator") {
      console.log("Create new Stugby invitations only from the verified HTTPS address.");
    }
    return;
  }

  console.log(`
Stuga is configured for ${configuration.data === "demo" ? "disposable demo data" : "a real home"}.
${started ? "Started" : "Start"}: ${runtime} compose up --build -d
Open:    http://localhost:${configuration.port}
Stop:    ${runtime} compose down`);
  if (configuration.mode === "podman") {
    console.log("Note: the core stack is enabled; Docker-socket self-update is disabled under Podman.");
  }
  console.log("Keep a new install on loopback until the first owner account exists.");
}

function printCloudflareDryRun(configuration) {
  if (!configuration.cloudflare) return;
  const cloudflare = configuration.cloudflare;
  console.log(`[setup] Would provision ${cloudflare.mode} at https://${cloudflare.hostname}`);
  console.log(`[setup] Would ${cloudflare.tokenInput === "files"
    ? "read two different protected token files"
    : "require two different tokens through hidden prompts or protected files"}`);
  console.log(`[setup] Would recreate api, web, and cloudflared, verify every public/protected path, and stop the connector if verification failed`);
}

function printUpdateAgentDryRun(configuration) {
  if (!configuration.installUpdateAgent) return;
  console.log("[setup] Would install and start a per-user update-agent service with this account's Docker access");
}

export async function runSetup(args = process.argv.slice(2)) {
  let options;
  try {
    options = parseSetupArgs(args);
  } catch (error) {
    console.error(`[setup] ${error instanceof Error ? error.message : String(error)}`);
    printHelp();
    return 1;
  }

  if (options.help) {
    printHelp();
    return 0;
  }

  let configuration;
  try {
    configuration = await resolveConfiguration(options);
  } catch (error) {
    console.error(`[setup] ${error instanceof Error ? error.message : String(error)}`);
    return 1;
  }

  console.log(`[setup] Install mode: ${configuration.mode}`);

  if (configuration.mode === "rpi") {
    printPiPlan(configuration.piAction);
    return 0;
  }

  if (configuration.mode === "local" && !supportsNode(process.versions.node)) {
    console.error(
      `[setup] Local development requires Node.js ${MINIMUM_NODE_VERSION.join(".")} or newer; found ${process.versions.node}.`,
    );
    console.error("Install Node.js from https://nodejs.org/en/download and rerun setup.");
    return 1;
  }

  try {
    const environment = configureEnvironment(
      projectRoot,
      basicEnvironmentUpdates(configuration),
      options.dryRun,
    );
    const action = options.dryRun
      ? environment.state === "would-create"
        ? "Would create .env from .env.example"
        : environment.changed
          ? "Would update only setup-managed settings in .env"
          : "Would keep the existing .env"
      : environment.state === "created"
        ? "Created .env from .env.example"
        : environment.changed
          ? "Updated only setup-managed settings in .env"
          : "Kept the existing .env";
    console.log(`[setup] ${action}`);
  } catch (error) {
    console.error(`[setup] ${error instanceof Error ? error.message : String(error)}`);
    return 1;
  }

  if (options.dryRun) {
    printCloudflareDryRun(configuration);
    printUpdateAgentDryRun(configuration);
    console.log("[setup] Dry run: no files, packages, or containers were changed");
    printNextSteps(configuration, false);
    return 0;
  }

  if (configuration.mode === "local") {
    console.log(`[setup] Node.js ${process.versions.node}`);
    if (configuration.installDependencies) {
      console.log("[setup] Installing lockfile dependencies with npm ci");
      const [command, commandArguments] = npmInvocation();
      const result = run(command, commandArguments);
      if (result.error) {
        console.error(`[setup] Could not start npm: ${result.error.message}`);
        return 1;
      }
      if (result.status !== 0) {
        console.error("[setup] Dependency installation failed");
        return result.status ?? 1;
      }
    } else {
      console.log("[setup] Skipped dependency installation");
    }
    printNextSteps(configuration, false);
    return 0;
  }

  try {
    verifyContainerRuntime(configuration.mode);
  } catch (error) {
    console.error(`[setup] ${error instanceof Error ? error.message : String(error)}`);
    console.error(`[setup] Configuration is saved; install the runtime, then rerun with --mode ${configuration.mode}.`);
    return 1;
  }

  let started = false;
  if (configuration.cloudflare) {
    try {
      await activateCloudflare(configuration);
    } catch (error) {
      console.error(`[setup] ${error instanceof Error ? error.message : String(error)}`);
      return 1;
    }
    started = true;
  } else if (configuration.start) {
    console.log(`[setup] Starting with ${configuration.mode} compose`);
    const result = run(configuration.mode, ["compose", "up", "--build", "-d"]);
    if (result.error || result.status !== 0) {
      console.error(`[setup] ${configuration.mode} compose could not start Stuga`);
      return result.status ?? 1;
    }
    started = true;
  }

  if (configuration.installUpdateAgent) {
    try {
      const service = installUpdateAgentService(projectRoot);
      console.log(`[setup] Installed and started ${service.kind}: ${service.name}`);
    } catch (error) {
      console.error(`[setup] Could not install the update-agent service: ${error instanceof Error ? error.message : String(error)}`);
      console.error("[setup] Stuga remains configured; rerun setup or start the agent manually with npm run update-agent.");
      return 1;
    }
  }

  printNextSteps(configuration, started);
  return 0;
}

if (process.argv[1] && resolve(process.argv[1]) === scriptPath) {
  process.exitCode = await runSetup();
}
