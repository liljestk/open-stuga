import { UsageError } from "./configuration-client.mjs";

/**
 * Comment the provisioner wrote on DNS records before the Stuga → Stugu rebrand
 * (0.14.0). A record carrying it is already managed and is not rewritten.
 */
export const LEGACY_MANAGED_COMMENT = "Managed by Stuga cloudflare-stuga.mjs";

/**
 * The name the provisioner gave a resource before the rebrand: `Stuga (<host>)…`
 * Access applications, policies and groups, `stuga-<host>` tunnels, and
 * "Stugby" for the Stuguby protocol application and policy.
 */
export function legacyResourceName(name) {
  return name
    .replace(/^Stugu /u, "Stuga ")
    .replace(/^stugu-/u, "stuga-")
    .replaceAll("Stuguby", "Stugby");
}

/** Every name under which an earlier provisioning run may have created `name`. */
export function managedNames(name) {
  return [...new Set([name, legacyResourceName(name)])];
}

function recordedId(value) {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

/**
 * Resource IDs an earlier run recorded in deployment.json. Deployments written
 * before the rebrand record the protocol application as `stugbyProtocolApplicationId`.
 */
export function recordedResourceIds(previous) {
  return {
    accessGroupId: recordedId(previous?.accessGroupId),
    accessApplicationId: recordedId(previous?.accessApplicationId),
    invitationHandoffApplicationId: recordedId(previous?.invitationHandoffApplicationId),
    stugubyProtocolApplicationId: recordedId(
      previous?.stugubyProtocolApplicationId ?? previous?.stugbyProtocolApplicationId,
    ),
    assistantConnectorApplicationId: recordedId(previous?.assistantConnectorApplicationId),
    tunnelId: recordedId(previous?.tunnelId),
  };
}

/**
 * Finds the resource an earlier run created: the recorded ID first, then the
 * current name, then the pre-rebrand name. Two resources with one name are
 * ambiguous and refused.
 */
export function pickManaged(resources, { name, recordedId: id, label }) {
  const candidates = Array.isArray(resources) ? resources : [];
  const recorded = id ? candidates.find((resource) => resource?.id === id) : undefined;
  if (recorded) return recorded;
  for (const candidate of managedNames(name)) {
    const matches = candidates.filter((resource) => resource?.name === candidate);
    if (matches.length > 1) throw new UsageError(`Multiple ${label} are named ${candidate}`);
    if (matches.length === 1) return matches[0];
  }
  return null;
}
