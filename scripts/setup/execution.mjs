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

import { MINIMUM_NODE_VERSION, basicEnvironmentUpdates, configureEnvironment, containerRuntimeEnvironmentUpdates, parseSetupArgs, printHelp, projectRoot, supportsNode } from "./arguments-environment.mjs";

import { activateCloudflare, resolveConfiguration, run } from "./configuration.mjs";

import { printCloudflareDryRun, printNextSteps, printPiPlan, printUpdateAgentDryRun, verifyContainerRuntime } from "./runtime-guidance.mjs";

import { npmInvocation } from "./interaction-cloudflare.mjs";

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

  let runtime;
  try {
    runtime = verifyContainerRuntime(configuration.mode);
  } catch (error) {
    console.error(`[setup] ${error instanceof Error ? error.message : String(error)}`);
    console.error(`[setup] Configuration is saved; install the runtime, then rerun with --mode ${configuration.mode}.`);
    return 1;
  }

  if (runtime.rootless && configuration.installUpdateAgent) {
    console.error("[setup] The host update-agent service requires a shared host directory and is unavailable with rootless Docker.");
    console.error("[setup] Rerun with --no-update-agent and update by fetching the release and rerunning Compose.");
    return 1;
  }

  try {
    const environment = configureEnvironment(
      projectRoot,
      containerRuntimeEnvironmentUpdates(configuration.mode, runtime),
    );
    if (environment.changed) {
      console.log(`[setup] Configured ${runtime.rootless ? "rootless" : "rootful"} container mount ownership`);
    }
  } catch (error) {
    console.error(`[setup] ${error instanceof Error ? error.message : String(error)}`);
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
      console.error(`[setup] ${configuration.mode} compose could not start Stugu`);
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
      console.error("[setup] Stugu remains configured; rerun setup or start the agent manually with npm run update-agent.");
      return 1;
    }
  }

  printNextSteps(configuration, started);
  return 0;
}
