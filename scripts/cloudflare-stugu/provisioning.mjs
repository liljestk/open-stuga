import { chmodSync, existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";

import { parse as parsePath, resolve } from "node:path";

import { pathToFileURL } from "node:url";

import { CloudflareApiError, UsageError, cloudflareClient, ensureApplication, ensureApplicationPolicy, ensureGroup, ensureOtp, findAccount, findZone, readToken, validateOptions, validateToken } from "./configuration-client.mjs";

import { assistantConnectorApplicationSpec, assistantConnectorPolicySpec, ensureDns, ensureTunnel, readExistingDeployment, renderRuntimeEnvironment, stugubyProtocolApplicationSpec, stugubyProtocolPolicySpec, writeProtected } from "./tunnel-runtime.mjs";

export async function provision(options, dependencies = {}) {
  validateOptions(options);
  const coordinator = options.command === "provision-coordinator";
  const deploymentPath = resolve(options.secretDirectory, "deployment.json");
  const previous = readExistingDeployment(deploymentPath, options);
  const provisionToken = dependencies.provisionToken === undefined
    ? readToken(options.provisionTokenFile, "Provisioning token file")
    : validateToken(dependencies.provisionToken, "Provisioning token");
  const accessToken = dependencies.accessToken === undefined
    ? readToken(options.accessTokenFile, "Runtime Access token file")
    : validateToken(dependencies.accessToken, "Runtime Access token");
  if (provisionToken === accessToken) {
    throw new UsageError("Provisioning and runtime Access tokens must be different");
  }
  const logger = dependencies.logger ?? console;
  const composeCommand = dependencies.composeCommand ?? "docker compose";
  const api = cloudflareClient(provisionToken);
  const accessApi = cloudflareClient(accessToken);
  const accountId = await findAccount(api, options.accountId);
  const zoneId = await findZone(api, accountId, options.zone, options.zoneId);
  if (previous?.accountId && previous.accountId !== accountId) {
    throw new UsageError("The existing deployment belongs to a different Cloudflare account");
  }
  if (previous?.zoneId && previous.zoneId !== zoneId) {
    throw new UsageError("The existing deployment belongs to a different Cloudflare zone");
  }
  const hostname = options.hostname;
  const groupName = `Stugu (${hostname}) members`;
  const applicationName = `Stugu (${hostname})`;
  const handoffName = `Stugu (${hostname}) invitation handoff`;
  const tunnelName = `stugu-${hostname.replace(/[^a-z0-9]+/g, "-")}`;

  logger.log("Configuring Cloudflare One-time PIN login and managed member group…");
  const otp = await ensureOtp(accessApi, accountId);
  const group = await ensureGroup(accessApi, accessApi, accountId, groupName, options.ownerEmail);

  logger.log("Configuring protected application and invitation handoff…");
  const application = await ensureApplication(api, accountId, {
    name: applicationName,
    type: "self_hosted",
    domain: hostname,
    destinations: [{ type: "public", uri: hostname }],
    session_duration: "24h",
    allowed_idps: [otp.id],
    auto_redirect_to_identity: true,
    allow_authenticate_via_warp: false,
    app_launcher_visible: true,
  });
  await ensureApplicationPolicy(api, accountId, application.id, {
    name: `${applicationName} allow managed members`,
    decision: "allow",
    precedence: 1,
    include: [{ group: { id: group.id } }],
    exclude: [],
    require: [{ login_method: { id: otp.id } }],
    session_duration: "24h",
  });
  const handoff = await ensureApplication(api, accountId, {
    name: handoffName,
    type: "self_hosted",
    domain: `${hostname}/invite-bootstrap`,
    destinations: [
      { type: "public", uri: `${hostname}/invite-bootstrap` },
      { type: "public", uri: `${hostname}/invite-bootstrap.js` },
    ],
    app_launcher_visible: false,
  });
  await ensureApplicationPolicy(api, accountId, handoff.id, {
    name: `${handoffName} public static files`,
    decision: "bypass",
    precedence: 1,
    include: [{ everyone: {} }],
    exclude: [],
    require: [],
  });
  let protocolApplication = null;
  if (coordinator) {
    logger.log("Configuring the narrowly scoped signed Stuguby machine path...");
    const applicationSpec = stugubyProtocolApplicationSpec(hostname);
    protocolApplication = await ensureApplication(api, accountId, applicationSpec);
    await ensureApplicationPolicy(
      api,
      accountId,
      protocolApplication.id,
      stugubyProtocolPolicySpec(hostname),
    );
  }

  logger.log("Configuring the OAuth-authenticated assistant connector paths...");
  const assistantApplication = await ensureApplication(api, accountId, assistantConnectorApplicationSpec(hostname));
  await ensureApplicationPolicy(api, accountId, assistantApplication.id, assistantConnectorPolicySpec(hostname));

  logger.log("Configuring named Tunnel and proxied DNS record…");
  const tunnel = await ensureTunnel(api, accountId, tunnelName, hostname);
  await ensureDns(api, zoneId, hostname, tunnel.id);
  const tunnelToken = await api(`/accounts/${accountId}/cfd_tunnel/${tunnel.id}/token`);
  if (typeof tunnelToken !== "string" || tunnelToken.length < 32) {
    throw new CloudflareApiError("Cloudflare did not return a valid Tunnel token", 500);
  }

  mkdirSync(options.secretDirectory, { recursive: true, mode: 0o700 });
  try { chmodSync(options.secretDirectory, 0o700); } catch { /* Windows uses inherited user ACLs. */ }
  writeProtected(resolve(options.secretDirectory, "access-group-token"), `${accessToken}\n`);
  writeProtected(resolve(options.secretDirectory, "tunnel-token"), `${tunnelToken}\n`);
  writeProtected(resolve(options.secretDirectory, "config.env"), renderRuntimeEnvironment({
    accountId,
    groupId: group.id,
    groupName,
    operatorEmails: [options.ownerEmail],
    hostname,
    coordinator,
  }));
  writeProtected(resolve(options.secretDirectory, "deployment.json"), `${JSON.stringify({
    version: 2,
    mode: coordinator ? "stuguby-coordinator" : "remote-ui",
    hostname,
    accountId,
    zoneId,
    tunnelId: tunnel.id,
    accessApplicationId: application.id,
    invitationHandoffApplicationId: handoff.id,
    stugubyProtocolApplicationId: protocolApplication?.id ?? null,
    assistantConnectorApplicationId: assistantApplication.id,
    accessGroupId: group.id,
    identityProviderId: otp.id,
    oauthClientId: options.oauthClientId ?? previous?.oauthClientId ?? null,
    oauthRedirectUri: options.oauthRedirectUri ?? previous?.oauthRedirectUri ?? null,
  }, null, 2)}\n`);

  logger.log(`Cloudflare is configured for https://${hostname}`);
  if (dependencies.printGuidance !== false) {
    logger.log("Recreate the services that consume the generated runtime with:");
    logger.log(`  ${composeCommand} up -d --build --force-recreate api web cloudflared`);
    if (coordinator) {
      logger.log(`Then verify the security boundary with: node scripts/cloudflare-stugu.mjs verify-coordinator --secret-dir ${options.secretDirectory}`);
    } else {
      logger.log(`Then verify the security boundary with: node scripts/cloudflare-stugu.mjs verify --secret-dir ${options.secretDirectory}`);
    }
    logger.log(`Rollback the public connection at any time with: ${composeCommand} stop cloudflared`);
  }
}

export function readDeployment(secretDirectory) {
  let deployment;
  try {
    deployment = JSON.parse(readFileSync(resolve(secretDirectory, "deployment.json"), "utf8"));
  } catch {
    throw new UsageError(`Could not read a valid deployment.json from ${secretDirectory}`);
  }
  const storedMode = deployment?.mode === "stugby-coordinator"
    ? "stuguby-coordinator"
    : deployment?.mode;
  const mode = deployment?.version === 1
    ? "remote-ui"
    : deployment?.version === 2 && ["remote-ui", "stuguby-coordinator"].includes(storedMode)
      ? storedMode
      : null;
  if (!mode || typeof deployment.hostname !== "string") {
    throw new UsageError("deployment.json is not a supported Cloudflare deployment");
  }
  const options = {
    hostname: deployment.hostname.trim().toLowerCase(),
    zone: deployment.hostname.trim().toLowerCase(),
    ownerEmail: "verify@example.invalid",
    accountId: null,
    zoneId: null,
  };
  validateOptions(options);
  return { ...deployment, mode, hostname: options.hostname };
}

export function readCoordinatorDeployment(secretDirectory) {
  const deployment = readDeployment(secretDirectory);
  if (deployment.mode !== "stuguby-coordinator") {
    throw new UsageError("deployment.json is not a version 2 Stuguby coordinator deployment");
  }
  return deployment;
}
