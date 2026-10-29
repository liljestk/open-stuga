import { chmodSync, existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";

import { parse as parsePath, resolve } from "node:path";

import { pathToFileURL } from "node:url";

import { CloudflareApiError, MANAGED_COMMENT, UsageError } from "./configuration-client.mjs";

export async function ensureTunnel(api, accountId, tunnelName, hostname) {
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

export async function ensureDns(api, zoneId, hostname, tunnelId) {
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

export function writeProtected(path, value) {
  writeFileSync(path, value, { encoding: "utf8", mode: 0o600 });
  try { chmodSync(path, 0o600); } catch { /* Windows ACLs are handled by the parent directory. */ }
}

export function renderRuntimeEnvironment({ accountId, groupId, groupName, operatorEmails, hostname, coordinator = false }) {
  const lines = [
    `CLOUDFLARE_ACCESS_ACCOUNT_ID=${accountId}`,
    `CLOUDFLARE_ACCESS_GROUP_ID=${groupId}`,
    `CLOUDFLARE_ACCESS_GROUP_NAME=${JSON.stringify(groupName)}`,
    `CLOUDFLARE_ACCESS_STATIC_EMAILS=${JSON.stringify(operatorEmails.join(","))}`,
    "CLOUDFLARE_ACCESS_API_TOKEN_FILE=/run/secrets/cloudflare/access-group-token",
    `CLOUDFLARE_ACCESS_PUBLIC_ORIGIN=https://${hostname}`,
    "CLOUDFLARE_ACCESS_SYNC_INTERVAL_MS=300000",
  ];
  if (coordinator) lines.push(`STUGBY_PUBLIC_ORIGIN=https://${hostname}`);
  return [...lines, ""].join("\n");
}

export function stugubyProtocolApplicationSpec(hostname) {
  const domain = `${hostname}/api/v1/stugby-protocol/*`;
  return {
    name: `Stugu (${hostname}) Stuguby protocol`,
    type: "self_hosted",
    domain,
    destinations: [{ type: "public", uri: domain }],
    app_launcher_visible: false,
  };
}

export function stugubyProtocolPolicySpec(hostname) {
  return {
    name: `Stugu (${hostname}) signed Stuguby nodes`,
    decision: "bypass",
    precedence: 1,
    include: [{ everyone: {} }],
    exclude: [],
    require: [],
  };
}

/**
 * The machine paths an assistant connection (Claude, ChatGPT) calls from its own
 * servers: OAuth discovery, registration, token exchange and revocation, and the
 * MCP endpoint itself. Each authenticates the client in Stugu; the consent page
 * and every other path stay behind the human Access application.
 */
export function assistantConnectorApplicationSpec(hostname) {
  const destinations = [
    `${hostname}/api/v1/mcp`,
    `${hostname}/api/v1/oauth/*`,
    `${hostname}/.well-known/oauth-authorization-server`,
    `${hostname}/.well-known/oauth-protected-resource/api/v1/mcp`,
  ];
  return {
    name: `Stugu (${hostname}) assistant connector`,
    type: "self_hosted",
    domain: destinations[0],
    destinations: destinations.map((uri) => ({ type: "public", uri })),
    app_launcher_visible: false,
  };
}

export function assistantConnectorPolicySpec(hostname) {
  return {
    name: `Stugu (${hostname}) OAuth-authenticated assistants`,
    decision: "bypass",
    precedence: 1,
    include: [{ everyone: {} }],
    exclude: [],
    require: [],
  };
}

export function readExistingDeployment(deploymentPath, options) {
  if (!existsSync(deploymentPath)) return null;
  let previous;
  try { previous = JSON.parse(readFileSync(deploymentPath, "utf8")); } catch {
    throw new UsageError(`Refusing to overwrite invalid deployment metadata at ${deploymentPath}`);
  }
  const mode = previous?.mode === "stugby-coordinator"
    ? "stuguby-coordinator"
    : previous?.mode;
  const validVersion = previous?.version === 1 || previous?.version === 2;
  const validMode = previous?.version === 1
    ? mode === undefined
    : ["remote-ui", "stuguby-coordinator"].includes(mode);
  const hostname = typeof previous?.hostname === "string" ? previous.hostname.trim().toLowerCase() : "";
  if (!validVersion || !validMode || !hostname) {
    throw new UsageError(`Refusing to overwrite unsupported deployment metadata at ${deploymentPath}`);
  }
  if (hostname !== options.hostname) {
    throw new UsageError(`The existing deployment in ${deploymentPath} belongs to ${hostname}, not ${options.hostname}`);
  }
  if (options.command === "provision" && mode === "stuguby-coordinator") {
    throw new UsageError(
      "Refusing to downgrade a Stuguby coordinator with provision; rerun provision-coordinator or stop cloudflared",
    );
  }
  return { ...previous, mode };
}
