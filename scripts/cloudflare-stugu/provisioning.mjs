import { chmodSync, existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";

import { parse as parsePath, resolve } from "node:path";

import { pathToFileURL } from "node:url";

import { CloudflareApiError, UsageError, cloudflareClient, findAccount, findZone, readToken, validateOptions, validateToken } from "./configuration-client.mjs";

import { ensureApplication, ensureApplicationPolicy, ensureGroup, ensureIdentityProvider, findIdentityProvider, humanApplicationSpec, humanPolicySpec, inspectApplication, inspectApplicationPolicy, inspectGroup, invitationHandoffApplicationSpec, invitationHandoffPolicySpec } from "./access-resources.mjs";

import { recordedResourceIds } from "./managed-names.mjs";

import { assistantConnectorApplicationSpec, assistantConnectorPolicySpec, ensureDns, ensureTunnel, inspectDns, inspectTunnel, readExistingDeployment, renderRuntimeEnvironment, stugubyProtocolApplicationSpec, stugubyProtocolPolicySpec, writeProtected } from "./tunnel-runtime.mjs";

/**
 * The Access applications this deployment needs, each keyed by the
 * deployment.json field that records its ID. Specs take the identity provider
 * and group IDs, which are unknown until those exist.
 */
function accessApplications(hostname, coordinator) {
  const applications = [
    {
      key: "accessApplicationId",
      application: (ids) => humanApplicationSpec(hostname, ids.identityProviderId),
      policy: (ids) => humanPolicySpec(hostname, ids),
    },
    {
      key: "invitationHandoffApplicationId",
      application: () => invitationHandoffApplicationSpec(hostname),
      policy: () => invitationHandoffPolicySpec(hostname),
    },
  ];
  if (coordinator) {
    applications.push({
      key: "stugubyProtocolApplicationId",
      application: () => stugubyProtocolApplicationSpec(hostname),
      policy: () => stugubyProtocolPolicySpec(hostname),
    });
  }
  applications.push({
    key: "assistantConnectorApplicationId",
    application: () => assistantConnectorApplicationSpec(hostname),
    policy: () => assistantConnectorPolicySpec(hostname),
  });
  return applications;
}

/**
 * Reads every resource an earlier run may have created (by recorded ID, current
 * name or pre-rebrand name) and refuses anything Stugu does not own. It makes no
 * change, so a refusal leaves Cloudflare exactly as it was.
 */
async function inspectDeployment({ api, accessApi, accountId, zoneId, hostname, coordinator, recorded }) {
  const identityProvider = await findIdentityProvider(accessApi, accountId);
  const group = await inspectGroup(accessApi, accountId, {
    name: `Stugu (${hostname}) members`,
    recordedId: recorded.accessGroupId,
  });
  const ids = { identityProviderId: identityProvider?.id ?? null, groupId: group?.id ?? null };
  const applications = [];
  for (const entry of accessApplications(hostname, coordinator)) {
    const existing = await inspectApplication(api, accountId, entry.application(ids), recorded[entry.key]);
    const policy = existing
      ? await inspectApplicationPolicy(api, accountId, existing.id, entry.policy(ids))
      : null;
    applications.push({ ...entry, existing, existingPolicy: policy });
  }
  const tunnelName = `stugu-${hostname.replace(/[^a-z0-9]+/g, "-")}`;
  const tunnel = await inspectTunnel(api, accountId, { name: tunnelName, recordedId: recorded.tunnelId, hostname });
  const dnsRecord = await inspectDns(api, zoneId, hostname, tunnel?.id ?? null);
  return { identityProvider, group, applications, tunnelName, tunnel, dnsRecord };
}

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
  const api = cloudflareClient(provisionToken, dependencies.fetcher);
  const accessApi = cloudflareClient(accessToken, dependencies.fetcher);
  const accountId = await findAccount(api, options.accountId);
  const zoneId = await findZone(api, accountId, options.zone, options.zoneId);
  if (previous?.accountId && previous.accountId !== accountId) {
    throw new UsageError("The existing deployment belongs to a different Cloudflare account");
  }
  if (previous?.zoneId && previous.zoneId !== zoneId) {
    throw new UsageError("The existing deployment belongs to a different Cloudflare zone");
  }
  const hostname = options.hostname;

  logger.log("Checking existing Cloudflare resources before changing anything…");
  const plan = await inspectDeployment({
    api,
    accessApi,
    accountId,
    zoneId,
    hostname,
    coordinator,
    recorded: recordedResourceIds(previous),
  });

  logger.log("Configuring Cloudflare One-time PIN login and managed member group…");
  const otp = await ensureIdentityProvider(accessApi, accountId, plan.identityProvider);
  const group = await ensureGroup(accessApi, accountId, plan.group, {
    name: `Stugu (${hostname}) members`,
    ownerEmail: options.ownerEmail,
  });

  logger.log(coordinator
    ? "Configuring the protected application, invitation handoff, signed Stuguby machine path and assistant connector paths…"
    : "Configuring the protected application, invitation handoff and assistant connector paths…");
  const ids = { identityProviderId: otp.id, groupId: group.id };
  const applicationIds = {};
  for (const entry of plan.applications) {
    const application = await ensureApplication(api, accountId, entry.existing, entry.application(ids));
    await ensureApplicationPolicy(api, accountId, application.id, entry.existingPolicy, entry.policy(ids));
    applicationIds[entry.key] = application.id;
  }

  logger.log("Configuring named Tunnel and proxied DNS record…");
  const tunnel = await ensureTunnel(api, accountId, plan.tunnel, { name: plan.tunnelName, hostname });
  await ensureDns(api, zoneId, plan.dnsRecord, { hostname, tunnelId: tunnel.id });
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
    groupName: group.name,
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
    accessApplicationId: applicationIds.accessApplicationId,
    invitationHandoffApplicationId: applicationIds.invitationHandoffApplicationId,
    stugubyProtocolApplicationId: applicationIds.stugubyProtocolApplicationId ?? null,
    assistantConnectorApplicationId: applicationIds.assistantConnectorApplicationId,
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
