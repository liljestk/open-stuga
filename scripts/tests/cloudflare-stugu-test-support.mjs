// An in-memory stand-in for the Cloudflare API endpoints the provisioner calls.
// It records every request so tests can assert exactly which writes happened.

export const ACCOUNT_ID = "0123456789abcdef0123456789abcdef";
export const ZONE_ID = "fedcba9876543210fedcba9876543210";

function envelope(result, status = 200) {
  return new Response(JSON.stringify({ success: status < 400, errors: status < 400 ? [] : [{ code: 1003, message: "Not found" }], result }), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function byId(collection, id) {
  const found = collection.find((item) => item.id === id);
  return found ? envelope(found) : envelope(null, 404);
}

export function fakeCloudflare(initial = {}) {
  const state = {
    identityProviders: initial.identityProviders ?? [],
    groups: initial.groups ?? [],
    applications: initial.applications ?? [],
    policies: initial.policies ?? {},
    tunnels: initial.tunnels ?? [],
    tunnelConfigurations: initial.tunnelConfigurations ?? {},
    dnsRecords: initial.dnsRecords ?? [],
  };
  const requests = [];
  let sequence = 0;
  const created = (prefix, body) => ({ ...body, id: `${prefix}-created-${++sequence}` });
  const accounts = `/accounts/${ACCOUNT_ID}`;
  const routes = [
    ["GET", `${accounts}/access/identity_providers`, () => envelope(state.identityProviders)],
    ["POST", `${accounts}/access/identity_providers`, (body) => {
      const provider = created("idp", body);
      state.identityProviders.push(provider);
      return envelope(provider);
    }],
    ["GET", `${accounts}/access/groups`, () => envelope(state.groups)],
    ["POST", `${accounts}/access/groups`, (body) => {
      const group = created("group", body);
      state.groups.push(group);
      return envelope(group);
    }],
    ["GET", /^\/accounts\/\w+\/access\/groups\/([^/]+)$/u, (_body, [id]) => byId(state.groups, id)],
    ["PUT", /^\/accounts\/\w+\/access\/groups\/([^/]+)$/u, (body, [id]) => {
      const group = state.groups.find((item) => item.id === id);
      Object.assign(group, body);
      return envelope(group);
    }],
    ["GET", `${accounts}/access/apps`, (_body, _match, query) => envelope(
      state.applications.filter((application) => application.domain === query.get("domain")),
    )],
    ["POST", `${accounts}/access/apps`, (body) => {
      const application = created("app", body);
      state.applications.push(application);
      return envelope(application);
    }],
    ["GET", /^\/accounts\/\w+\/access\/apps\/([^/]+)\/policies$/u, (_body, [id]) => envelope(state.policies[id] ?? [])],
    ["POST", /^\/accounts\/\w+\/access\/apps\/([^/]+)\/policies$/u, (body, [id]) => {
      const policy = created("policy", body);
      state.policies[id] = [...(state.policies[id] ?? []), policy];
      return envelope(policy);
    }],
    ["GET", `${accounts}/cfd_tunnel`, (_body, _match, query) => envelope(
      state.tunnels.filter((tunnel) => tunnel.name === query.get("name") && !tunnel.deleted_at),
    )],
    ["POST", `${accounts}/cfd_tunnel`, (body) => {
      const tunnel = created("tunnel", body);
      state.tunnels.push(tunnel);
      return envelope(tunnel);
    }],
    ["GET", /^\/accounts\/\w+\/cfd_tunnel\/([^/]+)$/u, (_body, [id]) => byId(state.tunnels, id)],
    ["GET", /^\/accounts\/\w+\/cfd_tunnel\/([^/]+)\/configurations$/u, (_body, [id]) => (
      state.tunnelConfigurations[id] ? envelope(state.tunnelConfigurations[id]) : envelope(null, 404)
    )],
    ["PUT", /^\/accounts\/\w+\/cfd_tunnel\/([^/]+)\/configurations$/u, (body, [id]) => {
      state.tunnelConfigurations[id] = body;
      return envelope(body);
    }],
    ["GET", /^\/accounts\/\w+\/cfd_tunnel\/([^/]+)\/token$/u, (_body, [id]) => envelope(`connector-token-for-${id}-padded-past-thirty-two-bytes`)],
    ["GET", `/zones/${ZONE_ID}/dns_records`, (_body, _match, query) => envelope(
      state.dnsRecords.filter((record) => record.name === query.get("name")),
    )],
    ["POST", `/zones/${ZONE_ID}/dns_records`, (body) => {
      const record = created("dns", body);
      state.dnsRecords.push(record);
      return envelope(record);
    }],
    ["PUT", /^\/zones\/\w+\/dns_records\/([^/]+)$/u, (body, [id]) => {
      const record = state.dnsRecords.find((item) => item.id === id);
      Object.assign(record, body);
      return envelope(record);
    }],
  ];

  const fetcher = async (url, init = {}) => {
    const { pathname, searchParams } = new URL(url);
    const path = pathname.replace(/^\/client\/v4/u, "");
    const method = init.method ?? "GET";
    const body = init.body ? JSON.parse(init.body) : undefined;
    requests.push({ method, path, body });
    for (const [routeMethod, pattern, handler] of routes) {
      if (routeMethod !== method) continue;
      const match = typeof pattern === "string" ? (pattern === path ? [] : null) : pattern.exec(path)?.slice(1);
      if (match) return handler(body, match, searchParams);
    }
    throw new Error(`Unexpected Cloudflare request ${method} ${path}`);
  };

  return {
    fetcher,
    state,
    requests,
    writes: () => requests.filter((request) => request.method !== "GET"),
  };
}

/** The resources a coordinator provisioned before the Stuga → Stugu rebrand. */
export function preRebrandCoordinator(hostname, ownerEmail) {
  const tunnelId = "8a1f0c2e-5b4d-4c6a-9e7f-0123456789ab";
  return {
    deployment: {
      version: 2,
      mode: "stugby-coordinator",
      hostname,
      accountId: ACCOUNT_ID,
      zoneId: ZONE_ID,
      tunnelId,
      accessApplicationId: "app-human",
      invitationHandoffApplicationId: "app-handoff",
      stugbyProtocolApplicationId: "app-protocol",
      accessGroupId: "group-members",
      identityProviderId: "idp-otp",
      oauthClientId: "legacy-oauth-client",
      oauthRedirectUri: "http://127.0.0.1:8080/api/v1/cloudflare/setup/oauth/callback",
    },
    cloudflare: {
      identityProviders: [{ id: "idp-otp", name: "Stuga one-time PIN", type: "onetimepin" }],
      groups: [{
        id: "group-members",
        name: `Stuga (${hostname}) members`,
        include: [{ email: { email: ownerEmail } }, { email: { email: "family@example.test" } }],
        exclude: [],
        require: [],
      }],
      applications: [
        {
          id: "app-human",
          name: `Stuga (${hostname})`,
          type: "self_hosted",
          domain: hostname,
          destinations: [{ type: "public", uri: hostname }],
        },
        {
          id: "app-handoff",
          name: `Stuga (${hostname}) invitation handoff`,
          type: "self_hosted",
          domain: `${hostname}/invite-bootstrap`,
          destinations: [
            { type: "public", uri: `${hostname}/invite-bootstrap` },
            { type: "public", uri: `${hostname}/invite-bootstrap.js` },
          ],
        },
        {
          id: "app-protocol",
          name: `Stuga (${hostname}) Stugby protocol`,
          type: "self_hosted",
          domain: `${hostname}/api/v1/stugby-protocol/*`,
          destinations: [{ type: "public", uri: `${hostname}/api/v1/stugby-protocol/*` }],
        },
      ],
      policies: {
        "app-human": [{
          id: "policy-human",
          name: `Stuga (${hostname}) allow managed members`,
          decision: "allow",
          precedence: 1,
          include: [{ group: { id: "group-members" } }],
          exclude: [],
          require: [{ login_method: { id: "idp-otp" } }],
          session_duration: "24h",
        }],
        "app-handoff": [{
          id: "policy-handoff",
          name: `Stuga (${hostname}) invitation handoff public static files`,
          decision: "bypass",
          precedence: 1,
          include: [{ everyone: {} }],
          exclude: [],
          require: [],
        }],
        "app-protocol": [{
          id: "policy-protocol",
          name: `Stuga (${hostname}) signed Stugby nodes`,
          decision: "bypass",
          precedence: 1,
          include: [{ everyone: {} }],
          exclude: [],
          require: [],
        }],
      },
      tunnels: [{ id: tunnelId, name: `stuga-${hostname.replace(/[^a-z0-9]+/gu, "-")}` }],
      tunnelConfigurations: {
        [tunnelId]: {
          config: {
            ingress: [{ hostname, service: "http://web:8081" }, { service: "http_status:404" }],
          },
        },
      },
      dnsRecords: [{
        id: "dns-legacy",
        type: "CNAME",
        name: hostname,
        content: `${tunnelId}.cfargotunnel.com`,
        proxied: true,
        ttl: 1,
        comment: "Managed by Stuga cloudflare-stuga.mjs",
      }],
    },
  };
}
