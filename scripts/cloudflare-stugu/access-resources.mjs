import { CloudflareApiError, UsageError } from "./configuration-client.mjs";

import { managedNames, pickManaged } from "./managed-names.mjs";

// Each Access resource has an inspect step, which only reads and refuses
// anything Stugu does not own, and an ensure step, which writes. Provisioning
// inspects every resource before it ensures any, so a refusal changes nothing.

export function exactEmailRule(rule) {
  if (!rule || typeof rule !== "object" || Array.isArray(rule) || Object.keys(rule).length !== 1) return null;
  const email = rule.email;
  if (!email || typeof email !== "object" || Array.isArray(email) || Object.keys(email).length !== 1) return null;
  return typeof email.email === "string" ? email.email.trim().toLowerCase() : null;
}

export async function findIdentityProvider(api, accountId) {
  const providers = await api(`/accounts/${accountId}/access/identity_providers?per_page=100`);
  const existing = Array.isArray(providers)
    ? providers.find((provider) => provider?.type === "onetimepin")
    : null;
  return existing?.id ? existing : null;
}

export async function ensureIdentityProvider(api, accountId, existing) {
  if (existing) return existing;
  const created = await api(`/accounts/${accountId}/access/identity_providers`, {
    method: "POST",
    body: JSON.stringify({ name: "Stugu one-time PIN", type: "onetimepin", config: {} }),
  });
  if (!created?.id) throw new CloudflareApiError("Cloudflare did not return an identity provider ID", 500);
  return created;
}

export async function inspectGroup(api, accountId, { name, recordedId }) {
  const groups = await api(`/accounts/${accountId}/access/groups?per_page=100`);
  const found = pickManaged(groups, { name, recordedId, label: "Access groups" });
  if (!found?.id) return null;
  const group = await api(`/accounts/${accountId}/access/groups/${found.id}`);
  const emails = (Array.isArray(group?.include) ? group.include : []).map(exactEmailRule);
  if (emails.some((email) => email === null)
    || (group?.exclude?.length ?? 0) > 0
    || (group?.require?.length ?? 0) > 0) {
    throw new UsageError(`Refusing to overwrite non-Stugu rules in Access group ${found.name}`);
  }
  return { id: found.id, name: typeof group.name === "string" ? group.name : found.name, emails };
}

/**
 * Creates the member group, or adds the owner to the existing one. An existing
 * group keeps its name, because the API's group synchronization checks it.
 */
export async function ensureGroup(api, accountId, existing, { name, ownerEmail }) {
  if (!existing) {
    const created = await api(`/accounts/${accountId}/access/groups`, {
      method: "POST",
      body: JSON.stringify({ name, include: [{ email: { email: ownerEmail } }], exclude: [], require: [] }),
    });
    if (!created?.id) throw new CloudflareApiError("Cloudflare did not return an Access group ID", 500);
    return { id: created.id, name, emails: [ownerEmail] };
  }
  if (existing.emails.includes(ownerEmail)) return existing;
  const emails = [...new Set([...existing.emails, ownerEmail])].sort();
  await api(`/accounts/${accountId}/access/groups/${existing.id}`, {
    method: "PUT",
    body: JSON.stringify({
      name: existing.name,
      include: emails.map((email) => ({ email: { email } })),
      exclude: [],
      require: [],
    }),
  });
  return { ...existing, emails };
}

export function publicDestinations(application) {
  return (Array.isArray(application?.destinations) ? application.destinations : [])
    .filter((destination) => destination?.type === "public" && typeof destination.uri === "string")
    .map((destination) => destination.uri)
    .sort();
}

/**
 * The application that protects `spec.domain`, if any. It must be the one an
 * earlier run created: the ID recorded in deployment.json, or the current or
 * pre-rebrand name.
 */
export async function inspectApplication(api, accountId, spec, recordedId) {
  const query = new URLSearchParams({ domain: spec.domain, exact: "true", per_page: "50" });
  const applications = await api(`/accounts/${accountId}/access/apps?${query}`);
  const matches = Array.isArray(applications)
    ? applications.filter((application) => application?.domain === spec.domain)
    : [];
  if (matches.length > 1) throw new UsageError(`Multiple Access applications protect ${spec.domain}`);
  const [application] = matches;
  if (!application) return null;
  const managed = (Boolean(recordedId) && application.id === recordedId)
    || managedNames(spec.name).includes(application.name);
  if (!managed || application.type !== "self_hosted") {
    throw new UsageError(`An unmanaged Access application already protects ${spec.domain}`);
  }
  const currentDestinations = publicDestinations(application);
  const desiredDestinations = spec.destinations.map((destination) => destination.uri).sort();
  if (currentDestinations.length > 0 && JSON.stringify(currentDestinations) !== JSON.stringify(desiredDestinations)) {
    throw new UsageError(`The managed Access application ${application.name} has unexpected destinations`);
  }
  return application;
}

export async function ensureApplication(api, accountId, existing, spec) {
  if (existing) return existing;
  const created = await api(`/accounts/${accountId}/access/apps`, {
    method: "POST",
    body: JSON.stringify(spec),
  });
  if (!created?.id) throw new CloudflareApiError("Cloudflare did not return an Access application ID", 500);
  return created;
}

export function ruleMatches(rule, expected) {
  return JSON.stringify(rule) === JSON.stringify(expected);
}

function rulesMatch(actual, expected) {
  return Array.isArray(actual) && actual.length === expected.length
    && actual.every((rule, index) => ruleMatches(rule, expected[index]));
}

function policyMatches(policy, spec) {
  return policy.decision === spec.decision
    && policy.precedence === spec.precedence
    && rulesMatch(policy.include, spec.include)
    && rulesMatch(policy.require, spec.require)
    && (policy.exclude?.length ?? 0) === 0
    && (spec.session_duration === undefined || policy.session_duration === spec.session_duration);
}

export async function inspectApplicationPolicy(api, accountId, applicationId, spec) {
  const policies = await api(`/accounts/${accountId}/access/apps/${applicationId}/policies?per_page=100`);
  const list = Array.isArray(policies) ? policies : [];
  const names = managedNames(spec.name);
  if (list.some((policy) => !names.includes(policy?.name))) {
    throw new UsageError(`Refusing to coexist with unmanaged Access policies on application ${applicationId}`);
  }
  if (list.length > 1) throw new UsageError(`Multiple Access policies are named ${spec.name} on application ${applicationId}`);
  const [policy] = list;
  if (!policy) return null;
  if (!policyMatches(policy, spec)) {
    throw new UsageError(`The managed Access policy ${policy.name} has unexpected rules`);
  }
  return policy;
}

export async function ensureApplicationPolicy(api, accountId, applicationId, existing, spec) {
  if (existing) return existing;
  return api(`/accounts/${accountId}/access/apps/${applicationId}/policies`, {
    method: "POST",
    body: JSON.stringify(spec),
  });
}

export function humanApplicationSpec(hostname, identityProviderId) {
  return {
    name: `Stugu (${hostname})`,
    type: "self_hosted",
    domain: hostname,
    destinations: [{ type: "public", uri: hostname }],
    session_duration: "24h",
    allowed_idps: [identityProviderId],
    auto_redirect_to_identity: true,
    allow_authenticate_via_warp: false,
    app_launcher_visible: true,
  };
}

export function humanPolicySpec(hostname, { groupId, identityProviderId }) {
  return {
    name: `Stugu (${hostname}) allow managed members`,
    decision: "allow",
    precedence: 1,
    include: [{ group: { id: groupId } }],
    exclude: [],
    require: [{ login_method: { id: identityProviderId } }],
    session_duration: "24h",
  };
}

export function invitationHandoffApplicationSpec(hostname) {
  return {
    name: `Stugu (${hostname}) invitation handoff`,
    type: "self_hosted",
    domain: `${hostname}/invite-bootstrap`,
    destinations: [
      { type: "public", uri: `${hostname}/invite-bootstrap` },
      { type: "public", uri: `${hostname}/invite-bootstrap.js` },
    ],
    app_launcher_visible: false,
  };
}

export function invitationHandoffPolicySpec(hostname) {
  return {
    name: `Stugu (${hostname}) invitation handoff public static files`,
    decision: "bypass",
    precedence: 1,
    include: [{ everyone: {} }],
    exclude: [],
    require: [],
  };
}
