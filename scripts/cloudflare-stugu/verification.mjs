import { chmodSync, existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";

import { parse as parsePath, resolve } from "node:path";

import { pathToFileURL } from "node:url";

import { provision, readCoordinatorDeployment, readDeployment } from "./provisioning.mjs";

import { UsageError, parseArguments, usage } from "./configuration-client.mjs";

export function isAccessChallenge(response) {
  if ([301, 302, 303, 307, 308].includes(response.status)) {
    const location = response.headers.get("location") ?? "";
    return location.includes("cloudflareaccess.com") || location.includes("/cdn-cgi/access/");
  }
  if (![401, 403].includes(response.status)) return false;
  const contentType = response.headers.get("content-type") ?? "";
  return Boolean(response.headers.get("cf-ray")) && !contentType.includes("application/json");
}

/** Claude and ChatGPT reach OAuth discovery and the MCP challenge without Access; the consent page stays protected. */
async function verifyAssistantConnector(probe, origin) {
  const consent = await probe("/connect/assistant", { headers: { accept: "text/html" } });
  if (!isAccessChallenge(consent)) {
    throw new Error(`Assistant consent page is not protected by Cloudflare Access (HTTP ${consent.status})`);
  }
  const metadata = await probe("/.well-known/oauth-authorization-server");
  let issuer = null;
  try { issuer = (await metadata.json())?.issuer ?? null; } catch { /* Reported below without echoing a body. */ }
  if (metadata.status !== 200 || issuer !== origin) {
    throw new Error(`Assistant OAuth discovery did not reach Stugu (HTTP ${metadata.status})`);
  }
  const mcp = await probe("/api/v1/mcp", { method: "POST", body: "{}" });
  if (mcp.status !== 401 || !(mcp.headers.get("www-authenticate") ?? "").includes("resource_metadata=")) {
    throw new Error(`Assistant MCP endpoint did not answer with Stugu's OAuth challenge (HTTP ${mcp.status})`);
  }
  return { consentStatus: consent.status, metadataStatus: metadata.status, mcpStatus: mcp.status };
}

export async function verifyBoundary(deployment, dependencies = {}) {
  const fetcher = dependencies.fetcher ?? fetch;
  const logger = dependencies.logger ?? console;
  const composeCommand = dependencies.composeCommand ?? "docker compose";
  const origin = `https://${deployment.hostname}`;
  const probe = (path, init = {}) => fetcher(`${origin}${path}`, {
    ...init,
    redirect: "manual",
    signal: AbortSignal.timeout(20_000),
    headers: {
      accept: "application/json",
      ...(init.body ? { "content-type": "application/json" } : {}),
      ...(init.headers ?? {}),
    },
  });

  const root = await probe("/");
  if (!isAccessChallenge(root)) {
    throw new Error(`Human root is not protected by Cloudflare Access (HTTP ${root.status})`);
  }
  const administration = await probe("/api/v1/stugbys");
  if (!isAccessChallenge(administration)) {
    throw new Error(`Stuguby administration is not protected by Cloudflare Access (HTTP ${administration.status})`);
  }
  const handoff = await probe("/invite-bootstrap", { headers: { accept: "text/html" } });
  if (handoff.status !== 200 || !handoff.headers.get("content-type")?.includes("text/html")) {
    throw new Error(`Invitation handoff page is not publicly reachable (HTTP ${handoff.status})`);
  }
  const handoffScript = await probe("/invite-bootstrap.js", { headers: { accept: "application/javascript" } });
  if (handoffScript.status !== 200 || !/(?:java|ecma)script/u.test(handoffScript.headers.get("content-type") ?? "")) {
    throw new Error(`Invitation handoff script is not publicly reachable (HTTP ${handoffScript.status})`);
  }
  const machine = await probe("/api/v1/stugby-protocol/join", { method: "POST", body: "{}" });
  if (deployment.mode === "stuguby-coordinator") {
    let payload = null;
    try { payload = await machine.json(); } catch { /* Report the boundary failure below without echoing a body. */ }
    const errorCode = payload?.error?.code;
    if (machine.status !== 400 || typeof errorCode !== "string" || errorCode === "STUGBY_DISABLED") {
      throw new Error(
        `Signed Stuguby machine path did not reach the coordinator's validation boundary (HTTP ${machine.status})`,
      );
    }
  } else if (!isAccessChallenge(machine)) {
    throw new Error(`Stuguby machine path is not protected by Cloudflare Access (HTTP ${machine.status})`);
  }
  const assistantConnector = deployment.assistantConnectorApplicationId
    ? await verifyAssistantConnector(probe, origin)
    : null;
  logger.log(`Verified Cloudflare boundary for ${origin}`);
  logger.log("  protected: / and /api/v1/stugbys");
  logger.log("  public: /invite-bootstrap and /invite-bootstrap.js");
  logger.log(deployment.mode === "stuguby-coordinator"
    ? "  reachable but application-authenticated: /api/v1/stugby-protocol/*"
    : "  protected: /api/v1/stugby-protocol/*");
  logger.log(assistantConnector
    ? "  reachable but OAuth-authenticated: /api/v1/mcp, /api/v1/oauth/*, /.well-known/oauth-*; protected: /connect/assistant"
    : "  assistant connector not configured: rerun provisioning to let Claude and ChatGPT connect");
  logger.log(`Rollback: ${composeCommand} stop cloudflared`);
  return {
    origin,
    rootStatus: root.status,
    administrationStatus: administration.status,
    handoffStatus: handoff.status,
    handoffScriptStatus: handoffScript.status,
    machineStatus: machine.status,
    assistantConnector,
  };
}

export async function verifyDeployment(options, dependencies = {}) {
  return verifyBoundary(readDeployment(options.secretDirectory), dependencies);
}

export async function verifyCoordinator(options, dependencies = {}) {
  return verifyBoundary(readCoordinatorDeployment(options.secretDirectory), dependencies);
}

export async function main() {
  try {
    const options = parseArguments(process.argv.slice(2));
    if (options.help) {
      console.log(usage());
      return;
    }
    if (options.command === "verify-coordinator") await verifyCoordinator(options);
    else if (options.command === "verify") await verifyDeployment(options);
    else await provision(options);
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unknown provisioning failure";
    console.error(`Cloudflare setup failed: ${message}`);
    if (error instanceof UsageError) console.error(usage());
    process.exitCode = 1;
  }
}
