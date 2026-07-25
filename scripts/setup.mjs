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
import {
  authorizeCloudflareSetup,
  cloudflareSetupOAuthScopes,
  DEFAULT_CLOUDFLARE_OAUTH_REDIRECT_URI,
  validateCloudflareOAuthClientId,
  validateCloudflareOAuthRedirectUri,
} from "./cloudflare-oauth.mjs";
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
  { value: "none", label: "Use Stuga only while at home" },
  { value: "remote-ui", label: "Open Stuga securely while away from home" },
  { value: "stugby-coordinator", label: "Create a shared Stugby for several homes (includes remote access)" },
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
      updateAgentConnected = heartbeat?.schema === "stuga-update-agent/v1"
        && heartbeat?.ready === true
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
Interactive Docker Stugby setup continues in the authenticated local UI;
explicit --cloudflare flags keep the advanced CLI path.
Browser approval is temporary; pasted token entry is hidden and never stored
in shell history or .env.
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

function environmentScalar(value) {
  if (typeof value !== "string") return null;
  const normalized = value.trim();
  if (!normalized) return null;
  if (normalized.startsWith("\"")) {
    try {
      const parsed = JSON.parse(normalized);
      return typeof parsed === "string" && parsed.trim() ? parsed.trim() : null;
    } catch {
      return null;
    }
  }
  return normalized;
}

function configuredCloudflareSecretDirectory(root, requested) {
  if (requested) return requested;
  const environmentPath = resolve(root, ".env");
  if (!existsSync(environmentPath)) return "./secrets/cloudflare";
  const configured = environmentScalar(
    environmentValues(readFileSync(environmentPath, "utf8")).STUGA_CLOUDFLARE_SECRET_DIR,
  );
  return configured ?? "./secrets/cloudflare";
}

function configuredCloudflareOAuth(root, options, environment = process.env) {
  const environmentPath = resolve(root, ".env");
  const localEnvironment = existsSync(environmentPath)
    ? environmentValues(readFileSync(environmentPath, "utf8"))
    : {};
  const clientIdValue = options.oauthClientId
    ?? environment.STUGA_CLOUDFLARE_OAUTH_CLIENT_ID
    ?? environmentScalar(localEnvironment.STUGA_CLOUDFLARE_OAUTH_CLIENT_ID);
  const redirectValue = options.oauthRedirectUri
    ?? environment.STUGA_CLOUDFLARE_OAUTH_REDIRECT_URI
    ?? environmentScalar(localEnvironment.STUGA_CLOUDFLARE_OAUTH_REDIRECT_URI);
  const clientId = environmentScalar(clientIdValue);
  if (!clientId) {
    if (environmentScalar(redirectValue)) {
      throw new Error("Cloudflare OAuth redirect URI requires a Cloudflare OAuth client ID");
    }
    return null;
  }
  return {
    clientId: validateCloudflareOAuthClientId(clientId),
    redirectUri: validateCloudflareOAuthRedirectUri(
      environmentScalar(redirectValue) ?? DEFAULT_CLOUDFLARE_OAUTH_REDIRECT_URI,
    ).href,
  };
}

export function existingCloudflareConfiguration(root, requestedSecretDirectory = null) {
  const composeDirectory = composeSecretDirectory(
    configuredCloudflareSecretDirectory(root, requestedSecretDirectory),
  );
  const secretDirectory = resolve(root, composeDirectory);
  const deploymentPath = resolve(secretDirectory, "deployment.json");
  if (!existsSync(deploymentPath)) return null;

  let deployment;
  try {
    deployment = JSON.parse(readFileSync(deploymentPath, "utf8"));
  } catch {
    throw new Error(`Existing Cloudflare setup is unreadable: ${deploymentPath}`);
  }
  const version = deployment?.version;
  const mode = version === 1
    ? "remote-ui"
    : version === 2 && REMOTE_ACCESS_MODES.includes(deployment?.mode)
      ? deployment.mode
      : null;
  const hostname = typeof deployment?.hostname === "string"
    ? deployment.hostname.trim().toLowerCase()
    : "";
  if (!mode || mode === "none" || !hostname) {
    throw new Error(`Existing Cloudflare setup is not supported: ${deploymentPath}`);
  }

  const runtimeEnvironmentPath = resolve(secretDirectory, "config.env");
  const runtimeEnvironment = existsSync(runtimeEnvironmentPath)
    ? environmentValues(readFileSync(runtimeEnvironmentPath, "utf8"))
    : {};
  const operatorEmails = environmentScalar(runtimeEnvironment.CLOUDFLARE_ACCESS_STATIC_EMAILS)
    ?.split(",")
    .map((email) => email.trim().toLowerCase())
    .filter(Boolean) ?? [];
  const accessTokenFile = resolve(secretDirectory, "access-group-token");
  const reusableAccessToken = existsSync(accessTokenFile) && statSync(accessTokenFile).size >= 32
    ? accessTokenFile
    : null;

  return {
    accessTokenFile: reusableAccessToken,
    accountId: typeof deployment.accountId === "string" ? deployment.accountId : null,
    composeSecretDirectory: composeDirectory,
    hostname,
    mode,
    ownerEmail: operatorEmails[0] ?? null,
    secretDirectory,
    zone: guessedZone(hostname),
    zoneId: typeof deployment.zoneId === "string" ? deployment.zoneId : null,
  };
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

function printCloudflarePrerequisites(reusesRuntimeApproval = false, oauthAvailable = false) {
  if (reusesRuntimeApproval) {
    if (oauthAvailable) {
      console.log(`
Stuga already retained its limited day-to-day Cloudflare approval. It will open
Cloudflare for one temporary setup approval, provision the selected account,
verify the connection, and revoke the temporary access automatically.

Cloudflare OAuth currently selects an account rather than one exact DNS zone.
Choose manual token entry if this account contains other sensitive zones.`);
      return;
    }
    console.log(`
Stuga already knows its public address and retained its limited day-to-day
Cloudflare approval. To add secure Stugby sharing, Cloudflare needs one
temporary approval from the account owner.

Create a custom API token at:
https://dash.cloudflare.com/profile/api-tokens

Give it Access Apps and Policies Write, Cloudflare Tunnel Write, and DNS Write
for this Stuga's zone. Add Zone Read only if setup must discover the zone.
Stuga uses the token once, checks the connection, and does not save it.`);
    return;
  }
  if (oauthAvailable) {
    console.log(`
Cloudflare will keep the host port on loopback and publish only through Access.
Stuga can request the temporary setup approval in Cloudflare's browser UI.

Create one runtime API token at:
https://dash.cloudflare.com/profile/api-tokens

Give it only Access Organizations, Identity Providers, and Groups Write for
the intended account. Stuga retains it to reconcile invited members. The
broader browser approval is revoked automatically after verification.`);
    return;
  }
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

async function resolveCloudflareConfiguration(options, mode, readline, root, environment) {
  const supported = mode === "docker" || mode === "podman";
  const explicitCloudflareRequest = options.remoteAccess !== null || hasCloudflareDetails(options);
  const existing = supported
    ? existingCloudflareConfiguration(root, options.cloudflare.secretDirectory)
    : null;
  let remoteAccess = options.remoteAccess;
  if (remoteAccess === null && readline && supported) {
    if (existing?.mode === "stugby-coordinator") {
      console.log(`\nSecure Stugby sharing is already set up at https://${existing.hostname}.`);
      remoteAccess = existing.mode;
    } else if (existing?.mode === "remote-ui") {
      console.log(`\nStuga is already available securely at https://${existing.hostname}.`);
      remoteAccess = await askYesNo(
        readline,
        "Will this Stuga create a shared Stugby for other homes?",
        false,
      )
        ? "stugby-coordinator"
        : "remote-ui";
    } else {
      remoteAccess = await askChoice(
        readline,
        "How will people use this Stuga?",
        remoteAccessChoices,
        "none",
      );
    }
  }
  remoteAccess ??= existing?.mode ?? "none";

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

  if (mode === "docker"
    && readline
    && !explicitCloudflareRequest
    && remoteAccess === "stugby-coordinator"
    && existing?.mode !== "stugby-coordinator") {
    console.log(`
Stuga will start on this computer first. After the owner signs in, open
Stugbys and choose "Set up secure sharing". Cloudflare approval, provisioning,
verification, and recovery guidance then stay in Stuga's UI.`);
    return {
      deferredToUi: true,
      hostname: existing?.hostname ?? null,
      mode: remoteAccess,
    };
  }

  const provisioningOverride = Object.entries(options.cloudflare).some(([key, value]) => (
    !["oauthClientId", "oauthRedirectUri", "secretDirectory"].includes(key) && value !== null
  ));
  const provisionRequired = existing?.mode !== remoteAccess || provisioningOverride;
  if (!provisionRequired && existing) {
    return {
      ...existing,
      command: remoteAccess === "stugby-coordinator" ? "provision-coordinator" : "provision",
      provisionRequired: false,
      provisionTokenFile: null,
      tokenInput: "none",
    };
  }

  const oauth = configuredCloudflareOAuth(root, options.cloudflare, environment);
  const reusesRuntimeApproval = Boolean(options.cloudflare.accessTokenFile ?? existing?.accessTokenFile);
  if (readline) printCloudflarePrerequisites(reusesRuntimeApproval, Boolean(oauth));
  const hostname = (options.cloudflare.hostname ?? existing?.hostname ?? (readline
    ? await askRequired(readline, "Public hostname (no https://)")
    : "")).trim().toLowerCase();
  const zone = (options.cloudflare.zone ?? existing?.zone ?? (readline
    ? await askRequired(readline, "Cloudflare DNS zone", guessedZone(hostname))
    : "")).trim().toLowerCase();
  const ownerEmail = (options.cloudflare.ownerEmail ?? existing?.ownerEmail ?? (readline
    ? await askRequired(readline, "Email address used to sign in to Stuga")
    : "")).trim().toLowerCase();
  if (!hostname) throw new Error("--cloudflare-hostname is required");
  if (!zone) throw new Error("--cloudflare-zone is required");
  if (!ownerEmail) throw new Error("--cloudflare-owner-email is required");

  let provisionTokenFile = options.cloudflare.provisionTokenFile;
  let accessTokenFile = options.cloudflare.accessTokenFile ?? existing?.accessTokenFile ?? null;
  if (!accessTokenFile && Boolean(provisionTokenFile) !== Boolean(options.cloudflare.accessTokenFile)) {
    throw new Error("Both Cloudflare token-file options are required when either is used");
  }
  let tokenInput = provisionTokenFile
    ? "files"
    : oauth
      ? reusesRuntimeApproval ? "oauth" : "oauth-prompt"
      : reusesRuntimeApproval ? "provision-prompt" : "prompt";
  if (!provisionTokenFile && readline && oauth) {
    tokenInput = await askChoice(
      readline,
      reusesRuntimeApproval
        ? "How should the temporary Cloudflare approval be supplied?"
        : "How should Cloudflare setup be approved?",
      reusesRuntimeApproval
        ? [
            { value: "oauth", label: "Approve in Cloudflare's browser UI (recommended)" },
            { value: "provision-prompt", label: "Paste an exact-zone token into a hidden prompt" },
            { value: "files", label: "Read an exact-zone token from a protected file" },
          ]
        : [
            { value: "oauth-prompt", label: "Approve setup in Cloudflare, then paste the limited runtime token (recommended)" },
            { value: "prompt", label: "Paste both tokens into hidden prompts" },
            { value: "files", label: "Read both tokens from protected files" },
          ],
      reusesRuntimeApproval ? "oauth" : "oauth-prompt",
    );
    if (tokenInput === "files") {
      provisionTokenFile = await askRequired(readline, "Temporary setup token file");
      if (!accessTokenFile) {
        accessTokenFile = await askRequired(readline, "Runtime Access token file");
      }
    }
  } else if (!provisionTokenFile && readline && !reusesRuntimeApproval) {
    tokenInput = await askChoice(readline, "How should the two API tokens be supplied?", [
      { value: "prompt", label: "Paste into hidden prompts (recommended)" },
      { value: "files", label: "Read existing protected token files" },
    ], "prompt");
    if (tokenInput === "files") {
      provisionTokenFile = await askRequired(readline, "Temporary setup token file");
      accessTokenFile = await askRequired(readline, "Runtime Access token file");
    }
  } else if (!provisionTokenFile && !readline && !options.dryRun) {
    if (oauth && reusesRuntimeApproval) {
      tokenInput = "oauth";
    } else if (reusesRuntimeApproval) {
      throw new Error(
        "Non-interactive coordinator upgrade requires --cloudflare-provision-token-file",
      );
    } else if (oauth) {
      throw new Error(
        "Non-interactive Cloudflare OAuth setup requires --cloudflare-access-token-file",
      );
    } else {
      throw new Error(
        "Non-interactive Cloudflare setup requires both --cloudflare-provision-token-file and --cloudflare-access-token-file",
      );
    }
  }

  const secretDirectoryInput = existing?.composeSecretDirectory
    ?? options.cloudflare.secretDirectory
    ?? "./secrets/cloudflare";
  const absoluteSecretDirectory = resolve(root, secretDirectoryInput);
  if (absoluteSecretDirectory === resolve(root)
    || absoluteSecretDirectory === parsePath(absoluteSecretDirectory).root) {
    throw new Error("--cloudflare-secret-dir must be a dedicated subdirectory");
  }
  const cloudflare = {
    accessTokenFile: accessTokenFile ? resolve(root, accessTokenFile) : null,
    accountId: options.cloudflare.accountId?.trim() ?? existing?.accountId ?? null,
    command: remoteAccess === "stugby-coordinator" ? "provision-coordinator" : "provision",
    composeSecretDirectory: composeSecretDirectory(secretDirectoryInput),
    hostname,
    mode: remoteAccess,
    ownerEmail,
    provisionRequired: true,
    provisionTokenFile: provisionTokenFile ? resolve(root, provisionTokenFile) : null,
    secretDirectory: absoluteSecretDirectory,
    tokenInput,
    zone,
    zoneId: options.cloudflare.zoneId?.trim() ?? existing?.zoneId ?? null,
    ...(tokenInput.startsWith("oauth") ? {
      oauthClientId: oauth.clientId,
      oauthRedirectUri: oauth.redirectUri,
    } : {}),
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
  const root = interaction.root ?? projectRoot;
  const existingDefaults = existingSetupDefaults(root);
  try {
    const mode = options.mode ?? existingDefaults.mode ?? (readline
      ? await askChoice(readline, "How do you want to install Stuga?", modeChoices, "docker")
      : "local");
    if (!options.mode && existingDefaults.mode && readline) {
      console.log(`\nKeeping the existing ${existingDefaults.mode === "docker" ? "Docker" : "Podman"} installation.`);
    }

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

    const data = options.data ?? existingDefaults.data ?? (readline
      ? (await askYesNo(readline, "Start with disposable demo data?", false) ? "demo" : "real")
      : "real");
    if (!options.data && existingDefaults.data && readline) {
      console.log(`Keeping the existing ${existingDefaults.data === "demo" ? "demo" : "real-home"} data mode.`);
    }
    const port = mode === "docker" || mode === "podman"
      ? options.port ?? existingDefaults.port ?? (readline ? await askPort(readline, 8080) : 8080)
      : null;
    if (options.port === null && existingDefaults.port !== null && readline) {
      console.log(`Keeping the existing web port ${existingDefaults.port}.`);
    }
    const cloudflareResolution = await resolveCloudflareConfiguration(
      options,
      mode,
      readline,
      root,
      interaction.environment ?? process.env,
    );
    const cloudflareUiPending = cloudflareResolution?.deferredToUi === true;
    const cloudflare = cloudflareUiPending ? null : cloudflareResolution;
    const start = mode === "docker" || mode === "podman"
      ? cloudflare || cloudflareUiPending
        ? true
        : options.start ?? (readline ? await askYesNo(readline, "Start the containers now?", true) : options.yes)
      : false;
    let installUpdateAgent = false;
    if (mode === "docker") {
      if (options.installUpdateAgent !== null) {
        installUpdateAgent = options.installUpdateAgent;
      } else if (existingDefaults.updateAgentConnected) {
        if (readline) console.log("Automatic updates are already connected.");
      } else if (readline) {
        console.log(cloudflareUiPending ? `
Secure sharing from Stuga's UI needs the trusted host update agent. It can
administer Docker and replace this Stuga installation. Install it only under a
Docker-authorized user account on this trusted host.` : `
The update agent can administer Docker and replace this Stuga installation.
Install it only on a trusted host under a Docker-authorized user account.`);
        installUpdateAgent = await askYesNo(
          readline,
          cloudflareUiPending
            ? "Install the host agent required for UI setup?"
            : "Install and start the automatic update agent as a per-user service?",
          cloudflareUiPending,
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
      cloudflareUiPending,
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
  let oauthGrant = null;

  try {
    if (cloudflare.tokenInput === "oauth" || cloudflare.tokenInput === "oauth-prompt") {
      const oauthAuthorizer = dependencies.oauthAuthorizer ?? authorizeCloudflareSetup;
      logger.log("[setup] Opening Cloudflare for one-time setup approval.");
      oauthGrant = await oauthAuthorizer({
        clientId: cloudflare.oauthClientId,
        redirectUri: cloudflare.oauthRedirectUri,
        scopes: cloudflareSetupOAuthScopes(!cloudflare.zoneId),
      }, {
        ...(dependencies.oauthDependencies ?? {}),
        logger,
      });
      if (!oauthGrant || typeof oauthGrant.revoke !== "function") {
        throw new Error("Cloudflare OAuth access could not be revoked safely");
      }
      const provisionToken = validateCloudflareToken(
        oauthGrant.accessToken,
        "Temporary Cloudflare OAuth approval",
      );
      if (cloudflare.tokenInput === "oauth-prompt") {
        const tokenReader = dependencies.tokenReader ?? readHiddenValue;
        logger.log("[setup] Paste the limited runtime Access token below. Input is hidden and is not written to .env or shell history.");
        const accessToken = validateCloudflareToken(
          await tokenReader("Runtime Access token: "),
          "Runtime Access token",
        );
        if (provisionToken === accessToken) {
          throw new Error("Temporary setup and runtime Access tokens must be different");
        }
        tokens = { accessToken, provisionToken };
      } else {
        tokens = { provisionToken };
      }
    } else if (cloudflare.tokenInput === "prompt") {
      const tokenReader = dependencies.tokenReader ?? readHiddenValue;
      logger.log("[setup] Paste each approval below. Input is hidden and is not written to .env or shell history.");
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
    } else if (cloudflare.tokenInput === "provision-prompt") {
      const tokenReader = dependencies.tokenReader ?? readHiddenValue;
      logger.log("[setup] Paste the one-time Cloudflare approval below. Input is hidden and is never saved.");
      tokens = {
        provisionToken: validateCloudflareToken(
          await tokenReader("Temporary setup token: "),
          "Temporary setup token",
        ),
      };
    }

    if (cloudflare.provisionRequired !== false) {
      await provisioner(cloudflare, {
        ...tokens,
        composeCommand,
        logger,
        printGuidance: false,
      });
      tokens = {};
    } else {
      logger.log(`[setup] Reusing the existing secure connection at https://${cloudflare.hostname}`);
    }

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
  } finally {
    tokens = {};
    if (oauthGrant && typeof oauthGrant.revoke === "function") {
      try {
        await oauthGrant.revoke();
        logger.log("[setup] One-time Cloudflare OAuth access token revoked.");
      } catch {
        logger.log(
          "[setup] Warning: Cloudflare did not confirm access-token revocation. Revoke Stuga Setup under https://dash.cloudflare.com/profile/oauth-authorizations",
        );
      }
    }
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
  if (configuration.cloudflareUiPending) {
    console.log(`
Stuga is ready for secure-sharing setup in its UI.
Open locally: http://127.0.0.1:${configuration.port}
Then: create or sign in as the owner → Stugbys → Set up secure sharing.

${configuration.installUpdateAgent
    ? "The required host agent was installed."
    : "Before using UI setup, install the required host agent:\n  npm run update-agent:service:install"}
Keep Stuga on loopback until Cloudflare setup reports a verified connection.`);
    return;
  }

  if (configuration.cloudflare) {
    if (!started) {
      const approvalGuidance = configuration.cloudflare.tokenInput.startsWith("oauth")
        ? "Rerun setup to approve the temporary Cloudflare access in your browser."
        : configuration.cloudflare.tokenInput === "provision-prompt"
          ? "Rerun interactively to paste the one temporary approval, or supply\n--cloudflare-provision-token-file for non-interactive setup."
          : "Rerun interactively to paste hidden tokens, or supply both protected token-file\noptions for non-interactive setup.";
      console.log(`
Cloudflare plan is ready for https://${configuration.cloudflare.hostname}.
${approvalGuidance} Local recovery remains on:
http://localhost:${configuration.port}`);
      return;
    }
    console.log(`
Stuga is online and the Cloudflare security boundary was verified.
Open:           https://${configuration.cloudflare.hostname}
Local recovery: http://localhost:${configuration.port}
Stop public:    ${runtime} compose stop cloudflared

${configuration.cloudflare.provisionRequired === false
    ? "No new Cloudflare approval was retained."
    : configuration.cloudflare.tokenInput.startsWith("oauth")
      ? "The one-time Cloudflare OAuth access token was revoked automatically."
      : "Revoke the temporary setup token now."}
Keep the generated Cloudflare secret directory protected and keep the runtime
Access token active.`);
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
  if (configuration.cloudflareUiPending) {
    console.log("[setup] Would start Stuga on loopback and defer secure-sharing setup to the authenticated local UI");
    return;
  }
  if (!configuration.cloudflare) return;
  const cloudflare = configuration.cloudflare;
  console.log(`[setup] Would ${cloudflare.provisionRequired === false ? "reuse" : "provision"} ${cloudflare.mode} at https://${cloudflare.hostname}`);
  if (cloudflare.provisionRequired !== false) {
    console.log(`[setup] Would ${cloudflare.tokenInput === "files"
      ? "read the required protected token file or files"
      : cloudflare.tokenInput === "oauth"
        ? "request and revoke one temporary approval in Cloudflare's browser UI"
        : cloudflare.tokenInput === "oauth-prompt"
          ? "request temporary browser approval and prompt for the limited runtime token"
          : cloudflare.tokenInput === "provision-prompt"
            ? "reuse the retained runtime approval and request one temporary approval"
            : "request two different approvals through hidden prompts or protected files"}`);
  }
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
