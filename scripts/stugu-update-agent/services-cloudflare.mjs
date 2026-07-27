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
} from ".././cloudflare-stugu.mjs";

import { revokeAccessToken } from ".././cloudflare-oauth.mjs";

import { bounded, compose, composeArguments, readJson, runCommand, validatedCloudflareSetupRequest, writeJson, writeTextAtomic } from "./configuration-request.mjs";

export async function activeServices(config, composeCommand = compose) {
  const output = await composeCommand(config, ["ps", "--services", "--filter", "status=running"], 30_000);
  const active = new Set(output.split(/\r?\n/).map((value) => value.trim()).filter(Boolean));
  const missing = ["api", "web"].filter((service) => !active.has(service));
  if (missing.length > 0) {
    const selected = config.composeProjectName
      ? ` "${config.composeProjectName}"`
      : " derived from the project directory";
    throw new Error(`Compose project${selected} is not the running Stugu installation (missing ${missing.join(", ")})`);
  }
  const services = ["api", "web"];
  if (active.has("stugu-backup-scheduler")) services.push("stugu-backup-scheduler");
  if (active.has("tapo-export-runner")) services.push("tapo-export-runner");
  return services;
}

export async function exactApiVersion(config, composeCommand = compose) {
  const script = "fetch('http://127.0.0.1:8787/api/v1/health').then(r=>r.json()).then(x=>process.stdout.write(String(x.systemVersion||'')))";
  return composeCommand(config, ["exec", "-T", "api", "node", "-e", script], 30_000);
}

export function cloudflareOperation(request, phase, detail, completedAt = null) {
  return {
    id: request.id,
    mode: request.mode,
    hostname: request.hostname,
    phase,
    requestedAt: request.requestedAt,
    completedAt,
    detail,
  };
}

export async function claimCloudflareSetup(config, request) {
  const claimScript = [
    "const secret=process.env.STUGA_CLOUDFLARE_CLAIM_SECRET||'';",
    `fetch('http://127.0.0.1:8787/api/v1/internal/cloudflare-setup/claims/${request.id}',`,
    "{headers:{authorization:'Bearer '+secret},signal:AbortSignal.timeout(15000)})",
    ".then(async response=>{const text=await response.text();if(!response.ok)throw new Error('HTTP '+response.status);process.stdout.write(text)})",
    ".catch(error=>{process.stderr.write(String(error.message||error));process.exitCode=1})",
  ].join("");
  const output = await runCommand("docker", [
    ...composeArguments(config),
    "exec",
    "-T",
    "-e",
    `STUGA_CLOUDFLARE_CLAIM_SECRET=${request.claimSecret}`,
    "api",
    "node",
    "-e",
    claimScript,
  ], {
    cwd: config.projectDirectory,
    timeoutMs: 30_000,
    ignoreStderr: true,
  });
  let claim;
  try { claim = JSON.parse(output); } catch {
    throw new Error("The API did not return a valid in-memory Cloudflare setup claim");
  }
  if (!claim || claim.schema !== "stugu-cloudflare-setup-claim/v1"
    || claim.oauthClientId !== request.oauthClientId) {
    throw new Error("The Cloudflare setup claim did not match the queued operation");
  }
  return {
    provisionToken: validateCloudflareToken(claim.provisionToken, "Temporary Cloudflare OAuth approval"),
    accessToken: validateCloudflareToken(claim.accessToken, "Runtime Access token"),
    oauthClientId: claim.oauthClientId,
  };
}

export async function verifyCloudflareWithRetry(config, request, dependencies) {
  const verifier = request.mode === "stuguby-coordinator"
    ? dependencies.verifyCoordinator ?? verifyCloudflareCoordinator
    : dependencies.verifyDeployment ?? verifyCloudflareDeployment;
  const waitForRetry = dependencies.waitForRetry
    ?? ((delayMs) => new Promise((resolveDelay) => setTimeout(resolveDelay, delayMs)));
  let lastError = null;
  for (let attempt = 1; attempt <= 12; attempt += 1) {
    try {
      return await verifier(
        { secretDirectory: config.cloudflareSecretDirectory },
        { logger: { log: () => undefined } },
      );
    } catch (error) {
      lastError = error;
      if (attempt < 12) await waitForRetry(5_000);
    }
  }
  throw lastError ?? new Error("Cloudflare verification failed");
}

export async function applyCloudflareSetupRequest(config, requestPath, dependencies = {}) {
  const composeCommand = dependencies.compose ?? compose;
  const provisioner = dependencies.provisioner ?? provisionCloudflare;
  const claimer = dependencies.claim ?? claimCloudflareSetup;
  const revoker = dependencies.revoke ?? revokeAccessToken;
  const statusPath = join(config.operationsDirectory, "cloudflare-status.json");
  const raw = readJson(requestPath);
  let request;
  try {
    request = validatedCloudflareSetupRequest(raw);
  } catch (error) {
    const completedAt = new Date().toISOString();
    writeJson(statusPath, {
      id: typeof raw?.id === "string" ? raw.id : randomUUID(),
      mode: raw?.mode === "remote-ui" ? "remote-ui" : "stuguby-coordinator",
      hostname: typeof raw?.hostname === "string" ? raw.hostname : "invalid.example",
      phase: "failed",
      requestedAt: typeof raw?.requestedAt === "string" ? raw.requestedAt : completedAt,
      completedAt,
      detail: error instanceof Error ? bounded(error.message) : "Invalid Cloudflare setup request",
    });
    rmSync(requestPath, { force: true });
    return;
  }

  const setStatus = (phase, detail, completedAt = null) => writeJson(
    statusPath,
    cloudflareOperation(request, phase, detail, completedAt),
  );
  let claim = null;
  let finalPhase = "failed";
  let finalDetail = "Cloudflare setup did not complete";
  try {
    setStatus("provisioning", "Configuring the secure Cloudflare connection");
    claim = await claimer(config, request);
    await provisioner({
      command: request.command,
      hostname: request.hostname,
      zone: request.zone,
      ownerEmail: request.ownerEmail,
      accountId: request.accountId,
      zoneId: request.zoneId,
      secretDirectory: config.cloudflareSecretDirectory,
      provisionTokenFile: null,
      accessTokenFile: null,
      oauthClientId: request.oauthClientId,
      oauthRedirectUri: request.oauthRedirectUri,
    }, {
      provisionToken: claim.provisionToken,
      accessToken: claim.accessToken,
      composeCommand: "docker compose",
      logger: { log: () => undefined },
      printGuidance: false,
    });

    setStatus("applying", "Restarting Stugu with the secure connection");
    await composeCommand(config, [
      "up",
      "--detach",
      "--no-deps",
      "--force-recreate",
      "--wait",
      "--wait-timeout",
      "600",
      "api",
      "web",
      "cloudflared",
    ]);

    setStatus("verifying", "Checking every public and protected path");
    await verifyCloudflareWithRetry(config, request, dependencies);
    finalPhase = "complete";
    finalDetail = `Secure connection verified at https://${request.hostname}`;
  } catch (error) {
    finalDetail = error instanceof Error ? bounded(error.message) : "Cloudflare setup failed";
    if (!claim) {
      finalDetail = `${finalDetail} Stugu could not confirm approval revocation; revoke Stugu Setup from the Cloudflare OAuth authorizations page.`;
    }
    try { await composeCommand(config, ["stop", "cloudflared"], 30_000); } catch { /* Keep the original failure. */ }
  }

  if (claim) {
    try {
      await revoker({
        accessToken: claim.provisionToken,
        clientId: claim.oauthClientId,
      });
    } catch {
      finalDetail = `${finalDetail} Cloudflare did not confirm approval revocation; revoke Stugu Setup from the Cloudflare OAuth authorizations page.`;
    }
  }
  setStatus(finalPhase, finalDetail, new Date().toISOString());
  claim = null;
  rmSync(requestPath, { force: true });
}

export async function restoreReleaseEnvironment(path, previous) {
  if (previous === null) {
    if (existsSync(path)) rmSync(path);
    return;
  }
  writeTextAtomic(path, previous);
}
