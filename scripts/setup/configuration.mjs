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

import { existingSetupDefaults, modeChoices, projectRoot } from "./arguments-environment.mjs";

import { askChoice, askPort, askYesNo, hasCloudflareDetails, resolveCloudflareConfiguration } from "./interaction-cloudflare.mjs";

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
      ? await askChoice(readline, "How do you want to install Stugu?", modeChoices, "docker")
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
Secure sharing from Stugu's UI needs the trusted host update agent. It can
administer Docker and replace this Stugu installation. Install it only under a
Docker-authorized user account on this trusted host.` : `
The update agent can administer Docker and replace this Stugu installation.
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

export function run(command, args, options = {}) {
  return spawnSync(command, args, {
    cwd: options.cwd ?? projectRoot,
    encoding: options.capture ? "utf8" : undefined,
    stdio: options.capture ? ["ignore", "pipe", "pipe"] : options.quiet ? "ignore" : "inherit",
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

export function wait(milliseconds) {
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

export function stopCloudflare(runtime, runner) {
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

    logger.log(`[setup] Recreating Stugu and starting the ${configuration.mode} Tunnel connector`);
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
          ? "The public connector was stopped; local Stugu is still available."
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
          "[setup] Warning: Cloudflare did not confirm access-token revocation. Revoke Stugu Setup under https://dash.cloudflare.com/profile/oauth-authorizations",
        );
      }
    }
  }
}

export function runtimeHelp(mode) {
  if (mode === "docker") {
    return "Install Docker Desktop or Docker Engine: https://docs.docker.com/get-docker/";
  }
  return "Install Podman and a Compose provider: https://podman.io/docs/installation";
}
