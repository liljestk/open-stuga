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

import { REMOTE_ACCESS_MODES, environmentValues, remoteAccessChoices } from "./arguments-environment.mjs";

export function npmInvocation() {
  if (process.env.npm_execpath && existsSync(process.env.npm_execpath)) {
    return [process.execPath, [process.env.npm_execpath, "ci"]];
  }
  return [process.platform === "win32" ? "npm.cmd" : "npm", ["ci"]];
}

export async function askChoice(readline, title, choices, defaultValue) {
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

export async function askYesNo(readline, question, defaultValue) {
  const hint = defaultValue ? "Y/n" : "y/N";
  while (true) {
    const answer = (await readline.question(`${question} [${hint}]: `)).trim().toLowerCase();
    if (!answer) return defaultValue;
    if (answer === "y" || answer === "yes") return true;
    if (answer === "n" || answer === "no") return false;
    console.log("Answer yes or no.");
  }
}

export async function askPort(readline, defaultPort) {
  while (true) {
    const answer = (await readline.question(`Web port [${defaultPort}]: `)).trim();
    if (!answer) return defaultPort;
    const port = Number(answer);
    if (Number.isInteger(port) && port >= 1 && port <= 65_535) return port;
    console.log("Enter a port from 1 through 65535.");
  }
}

export async function askRequired(readline, label, defaultValue = null) {
  while (true) {
    const suffix = defaultValue ? ` [${defaultValue}]` : "";
    const answer = (await readline.question(`${label}${suffix}: `)).trim();
    if (answer) return answer;
    if (defaultValue) return defaultValue;
    console.log("Enter a value to continue.");
  }
}

export function guessedZone(hostname) {
  const labels = hostname.split(".");
  return labels.length > 2 ? labels.slice(-2).join(".") : hostname;
}

export function environmentScalar(value) {
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

export function configuredCloudflareSecretDirectory(root, requested) {
  if (requested) return requested;
  const environmentPath = resolve(root, ".env");
  if (!existsSync(environmentPath)) return "./secrets/cloudflare";
  const configured = environmentScalar(
    environmentValues(readFileSync(environmentPath, "utf8")).STUGA_CLOUDFLARE_SECRET_DIR,
  );
  return configured ?? "./secrets/cloudflare";
}

export function configuredCloudflareOAuth(root, options, environment = process.env) {
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

export function hasCloudflareDetails(options) {
  return Object.values(options.cloudflare).some((value) => value !== null);
}

export function composeSecretDirectory(value) {
  const normalized = value.trim().replaceAll("\\", "/").replace(/\/+$/u, "");
  if (!normalized || /[\r\n#]/u.test(normalized)) {
    throw new Error("--cloudflare-secret-dir contains unsupported characters");
  }
  return normalized;
}

export function printCloudflarePrerequisites(reusesRuntimeApproval = false, oauthAvailable = false) {
  if (reusesRuntimeApproval) {
    if (oauthAvailable) {
      console.log(`
Stugu already retained its limited day-to-day Cloudflare approval. It will open
Cloudflare for one temporary setup approval, provision the selected account,
verify the connection, and revoke the temporary access automatically.

Cloudflare OAuth currently selects an account rather than one exact DNS zone.
Choose manual token entry if this account contains other sensitive zones.`);
      return;
    }
    console.log(`
Stugu already knows its public address and retained its limited day-to-day
Cloudflare approval. To add secure Stuguby sharing, Cloudflare needs one
temporary approval from the account owner.

Create a custom API token at:
https://dash.cloudflare.com/profile/api-tokens

Give it Access Apps and Policies Write, Cloudflare Tunnel Write, and DNS Write
for this Stugu's zone. Add Zone Read only if setup must discover the zone.
Stugu uses the token once, checks the connection, and does not save it.`);
    return;
  }
  if (oauthAvailable) {
    console.log(`
Cloudflare will keep the host port on loopback and publish only through Access.
Stugu can request the temporary setup approval in Cloudflare's browser UI.

Create one runtime API token at:
https://dash.cloudflare.com/profile/api-tokens

Give it only Access Organizations, Identity Providers, and Groups Write for
the intended account. Stugu retains it to reconcile invited members. The
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
     only. Stugu retains this token to reconcile invited members.

The temporary token is never saved. Revoke it after verification.`);
}

export async function resolveCloudflareConfiguration(options, mode, readline, root, environment) {
  const supported = mode === "docker" || mode === "podman";
  const explicitCloudflareRequest = options.remoteAccess !== null || hasCloudflareDetails(options);
  const existing = supported
    ? existingCloudflareConfiguration(root, options.cloudflare.secretDirectory)
    : null;
  let remoteAccess = options.remoteAccess;
  if (remoteAccess === null && readline && supported) {
    if (existing?.mode === "stuguby-coordinator") {
      console.log(`\nSecure Stuguby sharing is already set up at https://${existing.hostname}.`);
      remoteAccess = existing.mode;
    } else if (existing?.mode === "remote-ui") {
      console.log(`\nStugu is already available securely at https://${existing.hostname}.`);
      remoteAccess = await askYesNo(
        readline,
        "Will this Stugu create a shared Stuguby for other homes?",
        false,
      )
        ? "stuguby-coordinator"
        : "remote-ui";
    } else {
      remoteAccess = await askChoice(
        readline,
        "How will people use this Stugu?",
        remoteAccessChoices,
        "none",
      );
    }
  }
  remoteAccess ??= existing?.mode ?? "none";

  if (remoteAccess === "none") {
    if (hasCloudflareDetails(options)) {
      throw new Error("Cloudflare details require --cloudflare remote-ui or --cloudflare stuguby-coordinator");
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
    && remoteAccess === "stuguby-coordinator"
    && existing?.mode !== "stuguby-coordinator") {
    console.log(`
Stugu will start on this computer first. After the owner signs in, open
Stugubys and choose "Set up secure sharing". Cloudflare approval, provisioning,
verification, and recovery guidance then stay in Stugu's UI.`);
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
      command: remoteAccess === "stuguby-coordinator" ? "provision-coordinator" : "provision",
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
    ? await askRequired(readline, "Email address used to sign in to Stugu")
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
    command: remoteAccess === "stuguby-coordinator" ? "provision-coordinator" : "provision",
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
