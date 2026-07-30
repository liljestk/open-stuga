#!/usr/bin/env node

import { randomUUID } from "node:crypto";

import {
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";

import { spawn } from "node:child_process";

import { dirname, join, resolve } from "node:path";

import process from "node:process";

import { pathToFileURL } from "node:url";

import {
  provision as provisionCloudflare,
  validateToken as validateCloudflareToken,
  verifyCoordinator as verifyCloudflareCoordinator,
  verifyDeployment as verifyCloudflareDeployment,
} from "./cloudflare-stugu.mjs";

import { revokeAccessToken } from "./cloudflare-oauth.mjs";

import { main } from "./stugu-update-agent/update-loop.mjs";

export { readAgentConfig } from "./stugu-update-agent/configuration-request.mjs";

export { runCommand } from "./stugu-update-agent/configuration-request.mjs";

export { validatedRequest } from "./stugu-update-agent/configuration-request.mjs";

export { validatedReleaseEnvironment } from "./stugu-update-agent/configuration-request.mjs";

export { validatedCloudflareSetupRequest } from "./stugu-update-agent/configuration-request.mjs";

export { composeArguments } from "./stugu-update-agent/configuration-request.mjs";

export { applyCloudflareSetupRequest } from "./stugu-update-agent/services-cloudflare.mjs";

export { applyRequest } from "./stugu-update-agent/update-loop.mjs";

export { main } from "./stugu-update-agent/update-loop.mjs";

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  });
}
