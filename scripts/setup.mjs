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
import { dirname, resolve } from "node:path";
import { createInterface } from "node:readline/promises";
import { fileURLToPath } from "node:url";

export const MINIMUM_NODE_VERSION = Object.freeze([22, 13, 0]);
export const INSTALL_MODES = Object.freeze(["local", "docker", "podman", "rpi"]);

const scriptPath = fileURLToPath(import.meta.url);
const projectRoot = resolve(dirname(scriptPath), "..");
const modeChoices = [
  { value: "local", label: "Local development (Node.js)" },
  { value: "docker", label: "Docker Compose" },
  { value: "podman", label: "Podman Compose" },
  { value: "rpi", label: "Raspberry Pi 4 appliance" },
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

function requiredOptionValue(args, index, inlineValue, option) {
  const value = inlineValue ?? args[index + 1];
  if (!value || value.startsWith("--")) throw new Error(`${option} requires a value`);
  return value;
}

export function parseSetupArgs(args) {
  const options = {
    data: null,
    dryRun: false,
    help: false,
    mode: null,
    piAction: null,
    port: null,
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
    else if (option === "--demo" || option === "--real") {
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
  }
  if (configuration.mode === "podman") {
    // The Docker-socket self-update helper is intentionally unavailable here.
    updates.COMPOSE_PROFILES = "";
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
  --skip-install      Do not run npm ci for local development.
  --pi-action <type>  Show flash or local image-build steps.
  --yes               Accept recommended answers without prompting.
  --dry-run           Show the plan without writing files or running commands.
  --help              Show this help.

New installs bind to loopback. Existing network settings are preserved.
Configure credentials later in Stuga's guided web setup.`);
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

export async function resolveConfiguration(options, interaction = {}) {
  const interactive = interaction.interactive
    ?? (!options.yes && Boolean(process.stdin.isTTY && process.stdout.isTTY));
  const readline = interactive
    ? interaction.readline ?? createInterface({ input: process.stdin, output: process.stdout })
    : null;
  try {
    const mode = options.mode ?? (readline
      ? await askChoice(readline, "How do you want to install Stuga?", modeChoices, "local")
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
    if (options.piAction && mode !== "rpi") {
      throw new Error("--pi-action is only valid with --mode rpi");
    }
    if (options.data && mode === "rpi") {
      throw new Error("Raspberry Pi data mode is configured on the appliance before its first start");
    }

    if (mode === "rpi") {
      const piAction = options.piAction ?? (readline
        ? await askChoice(readline, "Which Raspberry Pi path do you need?", [
          { value: "flash", label: "Flash an existing factory image" },
          { value: "build", label: "Build a factory image on a supported ARM64 Linux host" },
        ], "flash")
        : "flash");
      return { mode, piAction };
    }

    const data = options.data ?? (readline
      ? (await askYesNo(readline, "Start with disposable demo data?", false) ? "demo" : "real")
      : "real");
    const port = mode === "docker" || mode === "podman"
      ? options.port ?? (readline ? await askPort(readline, 8080) : 8080)
      : null;
    const start = mode === "docker" || mode === "podman"
      ? options.start ?? (readline ? await askYesNo(readline, "Start the containers now?", true) : options.yes)
      : false;
    const installDependencies = mode === "local"
      ? !options.skipInstall && (readline
        ? await askYesNo(readline, "Install exact Node.js dependencies now?", true)
        : true)
      : false;

    return { data, installDependencies, mode, port, start };
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
          ? "Would update only the basic settings in .env"
          : "Would keep the existing .env"
      : environment.state === "created"
        ? "Created .env from .env.example"
        : environment.changed
          ? "Updated only the basic settings in .env"
          : "Kept the existing .env";
    console.log(`[setup] ${action}`);
  } catch (error) {
    console.error(`[setup] ${error instanceof Error ? error.message : String(error)}`);
    return 1;
  }

  if (options.dryRun) {
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

  if (configuration.start) {
    console.log(`[setup] Starting with ${configuration.mode} compose`);
    const result = run(configuration.mode, ["compose", "up", "--build", "-d"]);
    if (result.error || result.status !== 0) {
      console.error(`[setup] ${configuration.mode} compose could not start Stuga`);
      return result.status ?? 1;
    }
  }

  printNextSteps(configuration, configuration.start);
  return 0;
}

if (process.argv[1] && resolve(process.argv[1]) === scriptPath) {
  process.exitCode = await runSetup();
}
