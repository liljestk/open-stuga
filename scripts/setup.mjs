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
} from "./cloudflare-stugu.mjs";

import {
  authorizeCloudflareSetup,
  cloudflareSetupOAuthScopes,
  DEFAULT_CLOUDFLARE_OAUTH_REDIRECT_URI,
  validateCloudflareOAuthClientId,
  validateCloudflareOAuthRedirectUri,
} from "./cloudflare-oauth.mjs";

import { installUpdateAgentService } from "./stugu-update-agent-service.mjs";

import { scriptPath } from "./setup/arguments-environment.mjs";

import { runSetup } from "./setup/execution.mjs";

export { MINIMUM_NODE_VERSION } from "./setup/arguments-environment.mjs";

export { INSTALL_MODES } from "./setup/arguments-environment.mjs";

export { REMOTE_ACCESS_MODES } from "./setup/arguments-environment.mjs";

export { parseVersion } from "./setup/arguments-environment.mjs";

export { supportsNode } from "./setup/arguments-environment.mjs";

export { parseSetupArgs } from "./setup/arguments-environment.mjs";

export { ensureEnvironmentFile } from "./setup/arguments-environment.mjs";

export { environmentValues } from "./setup/arguments-environment.mjs";

export { existingSetupDefaults } from "./setup/arguments-environment.mjs";

export { updateEnvironmentText } from "./setup/arguments-environment.mjs";

export { configureEnvironment } from "./setup/arguments-environment.mjs";

export { basicEnvironmentUpdates } from "./setup/arguments-environment.mjs";

export { containerRuntimeEnvironmentUpdates } from "./setup/arguments-environment.mjs";

export { existingCloudflareConfiguration } from "./setup/interaction-cloudflare.mjs";

export { resolveConfiguration } from "./setup/configuration.mjs";

export { readHiddenValue } from "./setup/configuration.mjs";

export { verifyCloudflareWithRetry } from "./setup/configuration.mjs";

export { activateCloudflare } from "./setup/configuration.mjs";

export { verifyContainerRuntime } from "./setup/runtime-guidance.mjs";

export { runSetup } from "./setup/execution.mjs";

if (process.argv[1] && resolve(process.argv[1]) === scriptPath) {
  process.exitCode = await runSetup();
}
