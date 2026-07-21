#!/usr/bin/env node

import { chmodSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

const API_BASE = "https://api.cloudflare.com/client/v4";
const MANAGED_COMMENT = "Managed by Stuga cloudflare-stuga.mjs";

class UsageError extends Error {}

class CloudflareApiError extends Error {
  constructor(message, status, codes = []) {
    super(message);
    this.name = "CloudflareApiError";
    this.status = status;
    this.codes = codes;
  }
}

function usage() {
  return `Usage:
  node scripts/cloudflare-stuga.mjs provision \\
    --hostname stuga.example.com \\
    --zone example.com \\
    --owner-email owner@example.com \\
    --provision-token-file <temporary-token-file> \\
    --access-token-file <runtime-access-group-token-file> \\
    [--account-id <32-hex-id>] [--zone-id <32-hex-id>] \\
    [--secret-dir ./secrets/cloudflare]

The temporary provisioning token is read but never copied. The runtime token
must have only Account > Access: Organizations, Identity Providers, and Groups
Edit. Token values are never accepted as command-line arguments.`;
}

function parseArguments(argv) {
  if (argv.includes("--help") || argv.includes("-h")) return { help: true };
  const [command, ...rest] = argv;
  if (command !== "provision") throw new UsageError("The provision command is required");
  const values = {};
  for (let index = 0; index < rest.length; index += 2) {
    const key = rest[index];
    const value = rest[index + 1];
    if (!key?.startsWith("--") || value === undefined || value.startsWith("--")) {
      throw new UsageError(`Expected a value after ${key ?? "the final argument"}`);
    }
    if (Object.hasOwn(values, key)) throw new UsageError(`Duplicate option ${key}`);
    values[key] = value;
  }
  const allowed = new Set([
    "--hostname", "--zone", "--owner-email", "--provision-token-file", "--access-token-file",
    "--account-id", "--zone-id", "--secret-dir",
  ]);
  const unknown = Object.keys(values).find((key) => !allowed.has(key));
  if (unknown) throw new UsageError(`Unknown option ${unknown}`);
  for (const required of ["--hostname", "--zone", "--owner-email", "--provision-token-file", "--access-token-file"]) {
    if (!values[required]) throw new UsageError(`${required} is required`);
  }
  return {
    help: false,
    hostname: values["--hostname"].trim().toLowerCase(),
    zone: values["--zone"].trim().toLowerCase(),
    ownerEmail: values["--owner-email"].trim().toLowerCase(),
    provisionTokenFile: resolve(values["--provision-token-file"]),
    accessTokenFile: resolve(values["--access-token-file"]),
    accountId: values["--account-id"]?.trim() ?? null,
    zoneId: values["--zone-id"]?.trim() ?? null,
    secretDirectory: resolve(values["--secret-dir"] ?? "./secrets/cloudflare"),
  };
}

function validateOptions(options) {
  if (!/^(?=.{1,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(options.hostname)) {
    throw new UsageError("--hostname must be a valid lowercase DNS hostname");
  }
  if (options.hostname !== options.zone && !options.hostname.endsWith(`.${options.zone}`)) {
    throw new UsageError("--hostname must belong to --zone");
  }
  if (!/^[^\s@<>,]+@[^\s@<>,]+$/.test(options.ownerEmail) || options.ownerEmail.length > 254) {
    throw new UsageError("--owner-email must be a valid email address");
  }
  for (const [label, value] of [["--account-id", options.accountId], ["--zone-id", options.zoneId]]) {
    if (value && !/^[a-f0-9]{32}$/i.test(value)) throw new UsageError(`${label} must be a 32-character hexadecimal ID`);
  }
}

function readToken(path, label) {
  let token;
  try {
    token = readFileSync(path, "utf8").trim();
  } catch {
    throw new UsageError(`${label} could not be read`);
  }
  if (Buffer.byteLength(token, "utf8") < 32 || /[\r\n]/.test(token)) {
    throw new UsageError(`${label} does not contain one valid token`);
  }
  return token;
}

function safeErrorMessages(errors) {
  return (Array.isArray(errors) ? errors : []).slice(0, 3).map((error) => {
    const code = error && typeof error === "object" && "code" in error ? String(error.code) : "unknown";
    const message = error && typeof error === "object" && typeof error.message === "string"
      ? error.message.replace(/Bearer\s+\S+/gi, "Bearer [redacted]")
      : "Cloudflare rejected the request";
    return `${code}: ${message}`;
  });
}

function cloudflareClient(token) {
  return async (path, init = {}) => {
    const response = await fetch(`${API_BASE}${path}`, {
      ...init,
      redirect: "error",
      signal: AbortSignal.timeout(20_000),
      headers: {
        accept: "application/json",
        authorization: `Bearer ${token}`,
        ...(init.body ? { "content-type": "application/json" } : {}),
      },
    });
    const text = await response.text();
    let envelope;
    try {
      envelope = JSON.parse(text);
    } catch {
      throw new CloudflareApiError(`Cloudflare returned invalid JSON (HTTP ${response.status})`, response.status);
    }
    if (!response.ok || envelope?.success !== true) {
      const messages = safeErrorMessages(envelope?.errors);
      throw new CloudflareApiError(
        `Cloudflare API request failed (HTTP ${response.status})${messages.length ? `: ${messages.join("; ")}` : ""}`,
        response.status,
        messages,
      );
    }
    return envelope.result;
  };
}

async function findAccount(api, requestedId) {
  if (requestedId) return requestedId;
  const accounts = await api("/accounts?per_page=50");
  if (!Array.isArray(accounts) || accounts.length !== 1 || typeof accounts[0]?.id !== "string") {
    throw new UsageError("More than one Cloudflare account is available; pass --account-id explicitly");
  }
  return accounts[0].id;
}

async function findZone(api, accountId, zoneName, requestedId) {
  if (requestedId) return requestedId;
  const query = new URLSearchParams({ name: zoneName, "account.id": accountId, per_page: "50" });
  const zones = await api(`/zones?${query}`);
  if (!Array.isArray(zones) || zones.length !== 1 || typeof zones[0]?.id !== "string") {
    throw new UsageError(`Could not identify exactly one ${zoneName} zone; pass --zone-id explicitly`);
  }
  return zones[0].id;
}

function exactEmailRule(rule) {
  if (!rule || typeof rule !== "object" || Array.isArray(rule) || Object.keys(rule).length !== 1) return null;
  const email = rule.email;
  if (!email || typeof email !== "object" || Array.isArray(email) || Object.keys(email).length !== 1) return null;
  return typeof email.email === "string" ? email.email.trim().toLowerCase() : null;
}

async function ensureOtp(api, accountId) {
  const providers = await api(`/accounts/${accountId}/access/identity_providers?per_page=100`);
  const existing = Array.isArray(providers)
    ? providers.find((provider) => provider?.type === "onetimepin")
    : null;
  if (existing?.id) return existing;
  return api(`/accounts/${accountId}/access/identity_providers`, {
    method: "POST",
    body: JSON.stringify({ name: "Stuga one-time PIN", type: "onetimepin", config: {} }),
  });
}

async function ensureGroup(provisionApi, accessApi, accountId, groupName, ownerEmail) {
  const groups = await provisionApi(`/accounts/${accountId}/access/groups?per_page=100`);
  const matches = Array.isArray(groups) ? groups.filter((group) => group?.name === groupName) : [];
  if (matches.length > 1) throw new UsageError(`Multiple Access groups are named ${groupName}`);
  let group = matches[0] ?? await provisionApi(`/accounts/${accountId}/access/groups`, {
    method: "POST",
    body: JSON.stringify({ name: groupName, include: [{ email: { email: ownerEmail } }], exclude: [], require: [] }),
  });
  if (!group?.id) throw new CloudflareApiError("Cloudflare did not return an Access group ID", 500);
  group = await accessApi(`/accounts/${accountId}/access/groups/${group.id}`);
  const rules = Array.isArray(group.include) ? group.include : [];
  const currentEmails = rules.map(exactEmailRule);
  if (currentEmails.some((email) => email === null)
    || (group.exclude?.length ?? 0) > 0
    || (group.require?.length ?? 0) > 0) {
    throw new UsageError(`Refusing to overwrite non-Stuga rules in Access group ${groupName}`);
  }
  const emails = [...new Set([...currentEmails, ownerEmail])].sort();
  return accessApi(`/accounts/${accountId}/access/groups/${group.id}`, {
    method: "PUT",
    body: JSON.stringify({
      name: groupName,
      include: emails.map((email) => ({ email: { email } })),
      exclude: [],
      require: [],
    }),
  });
}

function publicDestinations(application) {
  return (Array.isArray(application?.destinations) ? application.destinations : [])
    .filter((destination) => destination?.type === "public" && typeof destination.uri === "string")
    .map((destination) => destination.uri)
    .sort();
}

async function ensureApplication(api, accountId, spec) {
  const query = new URLSearchParams({ domain: spec.domain, exact: "true", per_page: "50" });
  const applications = await api(`/accounts/${accountId}/access/apps?${query}`);
  const matches = Array.isArray(applications)
    ? applications.filter((application) => application?.domain === spec.domain)
    : [];
  if (matches.length > 1) throw new UsageError(`Multiple Access applications protect ${spec.domain}`);
  if (matches.length === 1) {
    const application = matches[0];
    if (application.name !== spec.name || application.type !== "self_hosted") {
      throw new UsageError(`An unmanaged Access application already protects ${spec.domain}`);
    }
    const currentDestinations = publicDestinations(application);
    const desiredDestinations = spec.destinations.map((destination) => destination.uri).sort();
    if (currentDestinations.length > 0 && JSON.stringify(currentDestinations) !== JSON.stringify(desiredDestinations)) {
      throw new UsageError(`The managed Access application ${spec.name} has unexpected destinations`);
    }
    return application;
  }
  return api(`/accounts/${accountId}/access/apps`, {
    method: "POST",
    body: JSON.stringify(spec),
  });
}

function ruleMatches(rule, expected) {
  return JSON.stringify(rule) === JSON.stringify(expected);
}

async function ensureApplicationPolicy(api, accountId, applicationId, spec) {
  const policies = await api(`/accounts/${accountId}/access/apps/${applicationId}/policies?per_page=100`);
  const matches = Array.isArray(policies) ? policies.filter((policy) => policy?.name === spec.name) : [];
  if (matches.length > 1) throw new UsageError(`Multiple Access policies are named ${spec.name}`);
  if (matches.length === 1) {
    const policy = matches[0];
    const includeMatches = Array.isArray(policy.include) && policy.include.length === spec.include.length
      && policy.include.every((rule, index) => ruleMatches(rule, spec.include[index]));
    const requireMatches = Array.isArray(policy.require) && policy.require.length === spec.require.length
      && policy.require.every((rule, index) => ruleMatches(rule, spec.require[index]));
    if (policy.decision !== spec.decision || !includeMatches || !requireMatches || (policy.exclude?.length ?? 0) !== 0) {
      throw new UsageError(`The managed Access policy ${spec.name} has unexpected rules`);
    }
    return policy;
  }
  return api(`/accounts/${accountId}/access/apps/${applicationId}/policies`, {
    method: "POST",
    body: JSON.stringify(spec),
  });
}

async function ensureTunnel(api, accountId, tunnelName, hostname) {
  const query = new URLSearchParams({ name: tunnelName, is_deleted: "false", per_page: "100" });
  const tunnels = await api(`/accounts/${accountId}/cfd_tunnel?${query}`);
  const matches = Array.isArray(tunnels) ? tunnels.filter((tunnel) => tunnel?.name === tunnelName) : [];
  if (matches.length > 1) throw new UsageError(`Multiple active tunnels are named ${tunnelName}`);
  const tunnel = matches[0] ?? await api(`/accounts/${accountId}/cfd_tunnel`, {
    method: "POST",
    body: JSON.stringify({ name: tunnelName, config_src: "cloudflare" }),
  });
  if (!tunnel?.id) throw new CloudflareApiError("Cloudflare did not return a Tunnel ID", 500);
  try {
    const current = await api(`/accounts/${accountId}/cfd_tunnel/${tunnel.id}/configurations`);
    const ingress = current?.config?.ingress;
    if (Array.isArray(ingress) && ingress.some((entry) => entry?.hostname && entry.hostname !== hostname)) {
      throw new UsageError(`Refusing to replace unrelated public hostnames on Tunnel ${tunnelName}`);
    }
  } catch (error) {
    if (!(error instanceof CloudflareApiError) || error.status !== 404) throw error;
  }
  await api(`/accounts/${accountId}/cfd_tunnel/${tunnel.id}/configurations`, {
    method: "PUT",
    body: JSON.stringify({
      config: {
        ingress: [
          { hostname, service: "http://web:8081" },
          { service: "http_status:404" },
        ],
      },
    }),
  });
  return tunnel;
}

async function ensureDns(api, zoneId, hostname, tunnelId) {
  const query = new URLSearchParams({ name: hostname, per_page: "100" });
  const records = await api(`/zones/${zoneId}/dns_records?${query}`);
  const exact = Array.isArray(records) ? records.filter((record) => record?.name === hostname) : [];
  const target = `${tunnelId}.cfargotunnel.com`;
  if (exact.some((record) => record.type !== "CNAME" || String(record.content).toLowerCase() !== target)) {
    throw new UsageError(`A conflicting DNS record already exists for ${hostname}; it was not changed`);
  }
  const existing = exact.find((record) => record.type === "CNAME");
  const body = { type: "CNAME", name: hostname, content: target, proxied: true, ttl: 1, comment: MANAGED_COMMENT };
  if (!existing) return api(`/zones/${zoneId}/dns_records`, { method: "POST", body: JSON.stringify(body) });
  if (existing.proxied !== true || existing.ttl !== 1 || existing.comment !== MANAGED_COMMENT) {
    return api(`/zones/${zoneId}/dns_records/${existing.id}`, { method: "PUT", body: JSON.stringify(body) });
  }
  return existing;
}

function writeProtected(path, value) {
  writeFileSync(path, value, { encoding: "utf8", mode: 0o600 });
  try { chmodSync(path, 0o600); } catch { /* Windows ACLs are handled by the parent directory. */ }
}

function renderRuntimeEnvironment({ accountId, groupId, groupName, operatorEmails, hostname }) {
  return [
    `CLOUDFLARE_ACCESS_ACCOUNT_ID=${accountId}`,
    `CLOUDFLARE_ACCESS_GROUP_ID=${groupId}`,
    `CLOUDFLARE_ACCESS_GROUP_NAME=${JSON.stringify(groupName)}`,
    `CLOUDFLARE_ACCESS_STATIC_EMAILS=${JSON.stringify(operatorEmails.join(","))}`,
    "CLOUDFLARE_ACCESS_API_TOKEN_FILE=/run/secrets/cloudflare/access-group-token",
    `CLOUDFLARE_ACCESS_PUBLIC_ORIGIN=https://${hostname}`,
    "CLOUDFLARE_ACCESS_SYNC_INTERVAL_MS=300000",
    "",
  ].join("\n");
}

async function provision(options) {
  validateOptions(options);
  const provisionToken = readToken(options.provisionTokenFile, "Provisioning token file");
  const accessToken = readToken(options.accessTokenFile, "Runtime Access token file");
  const api = cloudflareClient(provisionToken);
  const accessApi = cloudflareClient(accessToken);
  const accountId = await findAccount(api, options.accountId);
  const zoneId = await findZone(api, accountId, options.zone, options.zoneId);
  const hostname = options.hostname;
  const groupName = `Stuga (${hostname}) members`;
  const applicationName = `Stuga (${hostname})`;
  const handoffName = `Stuga (${hostname}) invitation handoff`;
  const tunnelName = `stuga-${hostname.replace(/[^a-z0-9]+/g, "-")}`;

  console.log("Configuring Cloudflare One-time PIN login and managed member group…");
  const otp = await ensureOtp(accessApi, accountId);
  const group = await ensureGroup(accessApi, accessApi, accountId, groupName, options.ownerEmail);

  console.log("Configuring protected application and invitation handoff…");
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

  console.log("Configuring named Tunnel and proxied DNS record…");
  const tunnel = await ensureTunnel(api, accountId, tunnelName, hostname);
  await ensureDns(api, zoneId, hostname, tunnel.id);
  const tunnelToken = await api(`/accounts/${accountId}/cfd_tunnel/${tunnel.id}/token`);
  if (typeof tunnelToken !== "string" || tunnelToken.length < 32) {
    throw new CloudflareApiError("Cloudflare did not return a valid Tunnel token", 500);
  }

  mkdirSync(options.secretDirectory, { recursive: true, mode: 0o700 });
  writeProtected(resolve(options.secretDirectory, "access-group-token"), `${accessToken}\n`);
  writeProtected(resolve(options.secretDirectory, "tunnel-token"), `${tunnelToken}\n`);
  writeProtected(resolve(options.secretDirectory, "config.env"), renderRuntimeEnvironment({
    accountId,
    groupId: group.id,
    groupName,
    operatorEmails: [options.ownerEmail],
    hostname,
  }));
  writeProtected(resolve(options.secretDirectory, "deployment.json"), `${JSON.stringify({
    version: 1,
    hostname,
    accountId,
    zoneId,
    tunnelId: tunnel.id,
    accessApplicationId: application.id,
    invitationHandoffApplicationId: handoff.id,
    accessGroupId: group.id,
    identityProviderId: otp.id,
  }, null, 2)}\n`);

  console.log(`Cloudflare is configured for https://${hostname}`);
  console.log("Start or update the local stack with: docker compose up -d --build cloudflared");
}

async function main() {
  try {
    const options = parseArguments(process.argv.slice(2));
    if (options.help) {
      console.log(usage());
      return;
    }
    await provision(options);
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unknown provisioning failure";
    console.error(`Cloudflare setup failed: ${message}`);
    if (error instanceof UsageError) console.error(usage());
    process.exitCode = 1;
  }
}

export {
  CloudflareApiError,
  UsageError,
  cloudflareClient,
  parseArguments,
  provision,
  renderRuntimeEnvironment,
  validateOptions,
};

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  await main();
}
