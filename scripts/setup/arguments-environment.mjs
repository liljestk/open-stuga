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
} from ".././cloudflare-stugu.mjs";

import {
  authorizeCloudflareSetup,
  cloudflareSetupOAuthScopes,
  DEFAULT_CLOUDFLARE_OAUTH_REDIRECT_URI,
  validateCloudflareOAuthClientId,
  validateCloudflareOAuthRedirectUri,
} from ".././cloudflare-oauth.mjs";

import { installUpdateAgentService } from ".././stugu-update-agent-service.mjs";

import { composeSecretDirectory, configuredCloudflareSecretDirectory, environmentScalar } from "./interaction-cloudflare.mjs";

export const MINIMUM_NODE_VERSION = Object.freeze([22, 13, 0]);

export const INSTALL_MODES = Object.freeze(["local", "docker", "podman", "rpi"]);

export const REMOTE_ACCESS_MODES = Object.freeze(["none", "remote-ui", "stuguby-coordinator"]);

export const scriptPath = fileURLToPath(new URL("../setup.mjs", import.meta.url));

export const projectRoot = resolve(dirname(scriptPath), "..");

export const modeChoices = [
  { value: "local", label: "Local development (Node.js)" },
  { value: "docker", label: "Docker Compose (recommended for a home installation)" },
  { value: "podman", label: "Podman Compose" },
  { value: "rpi", label: "Raspberry Pi 4 appliance" },
];

export const remoteAccessChoices = [
  { value: "none", label: "Use Stugu only while at home" },
  { value: "remote-ui", label: "Open Stugu securely while away from home" },
  { value: "stuguby-coordinator", label: "Create a shared Stuguby for several homes (includes remote access)" },
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

export function normalizedMode(value) {
  const aliases = { node: "local", pi: "rpi", raspberrypi: "rpi" };
  const normalized = aliases[value?.toLowerCase()] ?? value?.toLowerCase();
  if (!INSTALL_MODES.includes(normalized)) {
    throw new Error(`Install mode must be one of: ${INSTALL_MODES.join(", ")}`);
  }
  return normalized;
}

export function normalizedRemoteAccessMode(value) {
  const aliases = {
    coordinator: "stuguby-coordinator",
    off: "none",
    ui: "remote-ui",
  };
  const normalized = aliases[value?.toLowerCase()] ?? value?.toLowerCase();
  if (!REMOTE_ACCESS_MODES.includes(normalized)) {
    throw new Error(`Cloudflare mode must be one of: ${REMOTE_ACCESS_MODES.join(", ")}`);
  }
  return normalized;
}

export function requiredOptionValue(args, index, inlineValue, option) {
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
      oauthClientId: null,
      oauthRedirectUri: null,
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
    } else if (option === "--cloudflare-hostname" || option === "--hostname") {
      options.cloudflare.hostname = requiredOptionValue(args, index, inlineValue, option);
      if (inlineValue === null) index += 1;
    } else if (option === "--cloudflare-zone" || option === "--zone") {
      options.cloudflare.zone = requiredOptionValue(args, index, inlineValue, option);
      if (inlineValue === null) index += 1;
    } else if (option === "--cloudflare-owner-email" || option === "--owner-email") {
      options.cloudflare.ownerEmail = requiredOptionValue(args, index, inlineValue, option);
      if (inlineValue === null) index += 1;
    } else if (option === "--cloudflare-oauth-client-id") {
      options.cloudflare.oauthClientId = requiredOptionValue(args, index, inlineValue, option);
      if (inlineValue === null) index += 1;
    } else if (option === "--cloudflare-oauth-redirect-uri") {
      options.cloudflare.oauthRedirectUri = requiredOptionValue(args, index, inlineValue, option);
      if (inlineValue === null) index += 1;
    } else if (option === "--cloudflare-provision-token-file" || option === "--provision-token-file") {
      options.cloudflare.provisionTokenFile = requiredOptionValue(args, index, inlineValue, option);
      if (inlineValue === null) index += 1;
    } else if (option === "--cloudflare-access-token-file" || option === "--access-token-file") {
      options.cloudflare.accessTokenFile = requiredOptionValue(args, index, inlineValue, option);
      if (inlineValue === null) index += 1;
    } else if (option === "--cloudflare-account-id" || option === "--account-id") {
      options.cloudflare.accountId = requiredOptionValue(args, index, inlineValue, option);
      if (inlineValue === null) index += 1;
    } else if (option === "--cloudflare-zone-id" || option === "--zone-id") {
      options.cloudflare.zoneId = requiredOptionValue(args, index, inlineValue, option);
      if (inlineValue === null) index += 1;
    } else if (option === "--cloudflare-secret-dir" || option === "--secret-dir") {
      options.cloudflare.secretDirectory = requiredOptionValue(args, index, inlineValue, option);
      if (inlineValue === null) index += 1;
    } else if (!argument.startsWith("-")
      && options.remoteAccess !== null
      && options.cloudflare.hostname === null) {
      // npm consumes `--hostname` unless the caller adds `--`. Keep the
      // coordinator shortcut forgiving by accepting the remaining hostname.
      options.cloudflare.hostname = argument;
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

export function existingSetupDefaults(root) {
  const environmentPath = resolve(root, ".env");
  if (!existsSync(environmentPath)) {
    return { data: null, mode: null, port: null, updateAgentConnected: false };
  }
  const environment = environmentValues(readFileSync(environmentPath, "utf8"));
  const data = environment.MOCK_ENABLED === "true"
    ? "demo"
    : environment.MOCK_ENABLED === "false"
      ? "real"
      : null;
  const parsedPort = Number(environment.APP_PORT);
  const port = Number.isInteger(parsedPort) && parsedPort >= 1 && parsedPort <= 65_535
    ? parsedPort
    : null;
  const cloudflareDirectory = resolve(
    root,
    configuredCloudflareSecretDirectory(root, null),
  );
  const mode = existsSync(resolve(cloudflareDirectory, "deployment.json"))
    ? environment.COMPOSE_PROFILES === ""
      ? "podman"
      : "docker"
    : null;
  const operationsDirectory = resolve(
    root,
    environmentScalar(environment.SYSTEM_UPDATE_OPERATIONS_DIRECTORY)
      ?? "./data/update-operations",
  );
  const heartbeatPath = resolve(operationsDirectory, "agent-status.json");
  let updateAgentConnected = false;
  if (existsSync(heartbeatPath) && statSync(heartbeatPath).size <= 256 * 1024) {
    try {
      const heartbeat = JSON.parse(readFileSync(heartbeatPath, "utf8"));
      const updatedAt = Date.parse(heartbeat?.updatedAt);
      updateAgentConnected = heartbeat?.schema === "stugu-update-agent/v1"
        && heartbeat?.ready === true
        && heartbeat?.updateAgentContract === 3
        && heartbeat?.composeContract === 2
        && Number.isFinite(updatedAt)
        && Math.abs(Date.now() - updatedAt) <= 2 * 60_000;
    } catch {
      updateAgentConnected = false;
    }
  }
  return { data, mode, port, updateAgentConnected };
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
    if (configuration.cloudflare || configuration.cloudflareUiPending) {
      updates.BIND_ADDRESS = "127.0.0.1";
    }
    if (configuration.cloudflare) {
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

export function containerRuntimeEnvironmentUpdates(mode, runtime = {}) {
  if (mode !== "docker" && mode !== "podman") return {};
  const rootless = runtime.rootless === true;
  return {
    STUGA_HOST_BIND_USER: rootless ? "0:0" : "1000:1000",
    STUGA_UPDATE_OPERATIONS_DIRECTORY: rootless
      ? "stuga-update-operations"
      : "./data/update-operations",
    STUGA_UPDATE_OPERATIONS_MOUNT_OPTIONS: rootless ? "rw" : "z",
  };
}

export function printHelp() {
  console.log(`Configure a minimal Stugu installation.

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
  --cloudflare <mode> Provision and verify remote-ui or stuguby-coordinator.
  --no-cloudflare     Keep the installation local only.
  --cloudflare-hostname <host>        Public hostname, such as stugu.example.com.
  --cloudflare-zone <zone>            Cloudflare DNS zone, such as example.com.
  --cloudflare-owner-email <email>    Permanent Access recovery operator.
  --cloudflare-oauth-client-id <id>   Approve temporary setup in a browser.
  --cloudflare-oauth-redirect-uri <url>
                       Registered loopback callback for the OAuth client.
  --cloudflare-provision-token-file <path>
  --cloudflare-access-token-file <path>
                       Read the required separate tokens from protected files.
  --cloudflare-account-id <id>        Optional unambiguous account selection.
  --cloudflare-zone-id <id>           Optional unambiguous zone selection.
  --cloudflare-secret-dir <path>      Generated runtime directory.
  --skip-install      Do not run npm ci for local development.
  --pi-action <type>  Show flash or local image-build steps.
  --yes               Accept recommended answers without prompting.
  --dry-run           Show the plan without writing files or running commands.
  --help              Show this help.

New installs bind to loopback, including when Tunnel access is enabled.
Interactive Docker Stuguby setup continues in the authenticated local UI;
explicit --cloudflare flags keep the advanced CLI path.
Browser approval is temporary; pasted token entry is hidden and never stored
in shell history or .env.
Configure Home/device credentials later in Stugu's guided web setup.`);
}
