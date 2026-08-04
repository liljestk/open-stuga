import type { AppSession } from "@climate-twin/contracts";

export const accountStorageNamespace = "stugu.account.v1.";

export const accountStorageKeyFamilies = [
  { key: "climate-twin-locale", kind: "exact", legacy: "migrate" },
  { key: "climate-twin-units", kind: "exact", legacy: "migrate" },
  { key: "climate-twin-navigation", kind: "exact", legacy: "migrate" },
  { key: "climate-twin-map-information", kind: "exact", legacy: "migrate" },
  { key: "climate-twin-outdoor-panel", kind: "exact", legacy: "migrate" },
  { key: "stugu-spatial-layer-panel", kind: "exact", legacy: "migrate" },
  { key: "stugu-experimental-home-visualizations", kind: "exact", legacy: "migrate" },
  { key: "stugu-outdoor-influence-metric", kind: "exact", legacy: "migrate" },
  { key: "stugu-home-map-energy-devices-visible", kind: "exact", legacy: "migrate" },
  { key: "stugu-home-map-connected-devices-visible", kind: "exact", legacy: "migrate" },
  { key: "stugu-home-map-climate-sensors-visible", kind: "exact", legacy: "migrate" },
  { key: "stugu-home-map-opening-state-labels-visible", kind: "exact", legacy: "migrate" },
  { key: "stugu-home-map-animations-enabled", kind: "exact", legacy: "migrate" },
  { key: "stugu-home-map-outdoor-extras-visible", kind: "exact", legacy: "migrate" },
  { key: "stugu-mobile-overview", kind: "exact", legacy: "discard" },
  { key: "stugu-dismissed-tp-link-device-notices", kind: "exact", legacy: "discard" },
  { key: "stugu-dismissed-integration-discovery-notices", kind: "exact", legacy: "discard" },
  { key: "stugu.integration-discovery.", kind: "prefix", legacy: "discard" },
  { key: "stugu-home-pulse-hidden:v1:", kind: "prefix", legacy: "discard" },
] as const satisfies ReadonlyArray<{
  key: string;
  kind: "exact" | "prefix";
  legacy: "migrate" | "discard";
}>;

let activeAccountPrefix: string | null = null;
const scopeListeners = new Set<() => void>();

function storage(): Storage | null {
  try {
    return globalThis.localStorage ?? null;
  } catch {
    return null;
  }
}

function accountHash(value: string): string {
  let first = 0x811c9dc5;
  let second = 0x9e3779b9;
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    first = Math.imul(first ^ code, 0x01000193);
    second = Math.imul(second ^ code, 0x85ebca6b);
  }
  return `${(first >>> 0).toString(36)}${(second >>> 0).toString(36)}`;
}

function accountPrefix(session: AppSession): string {
  const principal = [
    session.tenant.id,
    session.principal.type.trim().toLowerCase(),
    session.principal.email?.trim().toLowerCase() ?? "",
  ].join("\u001f");
  return `${accountStorageNamespace}${accountHash(principal)}.`;
}

function matchingKeys(store: Storage, predicate: (key: string) => boolean): string[] {
  const keys: string[] = [];
  for (let index = 0; index < store.length; index += 1) {
    const key = store.key(index);
    if (key && predicate(key)) keys.push(key);
  }
  return keys;
}

function clearLegacySensitiveState(store: Storage): void {
  for (const family of accountStorageKeyFamilies) {
    if (family.legacy !== "discard") continue;
    if (family.kind === "exact") store.removeItem(family.key);
    else for (const key of matchingKeys(store, (candidate) => candidate.startsWith(family.key))) store.removeItem(key);
  }
}

function migrateLegacyPreferences(store: Storage, prefix: string): void {
  for (const family of accountStorageKeyFamilies) {
    if (family.kind !== "exact" || family.legacy !== "migrate") continue;
    const legacyValue = store.getItem(family.key);
    if (legacyValue === null) continue;
    const scopedKey = `${prefix}${family.key}`;
    if (store.getItem(scopedKey) === null) store.setItem(scopedKey, legacyValue);
    if (store.getItem(scopedKey) !== null) store.removeItem(family.key);
  }
}

function notifyScopeChange(): void {
  for (const listener of scopeListeners) listener();
}

/** Selects the authenticated account namespace before workspace data is read. */
export function activateAccountStorage(session: AppSession): void {
  if (!session.authenticated || session.setupRequired) {
    deactivateAccountStorage({ purge: true });
    return;
  }
  const nextPrefix = accountPrefix(session);
  const store = storage();
  if (store) {
    try {
      migrateLegacyPreferences(store, nextPrefix);
      // Dismissed, hidden, and in-flight job state cannot safely be attributed
      // to the first account after this migration, so fail closed and discard it.
      clearLegacySensitiveState(store);
    } catch {
      // Persistent storage is optional; the in-memory namespace still prevents
      // an authenticated account from reading an unscoped legacy value.
    }
  }
  activeAccountPrefix = nextPrefix;
  notifyScopeChange();
}

/** Clears the active account's browser state during logout/session expiry. */
export function deactivateAccountStorage({ purge = false }: { purge?: boolean } = {}): void {
  const prefix = activeAccountPrefix;
  const store = storage();
  if (store && purge) {
    try {
      if (prefix) {
        for (const key of matchingKeys(store, (candidate) => candidate.startsWith(prefix))) store.removeItem(key);
      }
      clearLegacySensitiveState(store);
    } catch {
      // Logout must continue even when browser storage is unavailable.
    }
  }
  activeAccountPrefix = null;
  notifyScopeChange();
}

export function subscribeToAccountStorageScope(listener: () => void): () => void {
  scopeListeners.add(listener);
  return () => scopeListeners.delete(listener);
}

export function readLocalStorage(key: string): string | null {
  try {
    return storage()?.getItem(activeAccountPrefix ? `${activeAccountPrefix}${key}` : key) ?? null;
  } catch {
    return null;
  }
}

export function writeLocalStorage(key: string, value: string): boolean {
  try {
    const store = storage();
    if (!store) return false;
    store.setItem(activeAccountPrefix ? `${activeAccountPrefix}${key}` : key, value);
    return true;
  } catch {
    return false;
  }
}

export function removeLocalStorage(key: string): boolean {
  try {
    const store = storage();
    if (!store) return false;
    store.removeItem(activeAccountPrefix ? `${activeAccountPrefix}${key}` : key);
    return true;
  } catch {
    return false;
  }
}

export function accountScopedStorageKeyForTest(session: AppSession, key: string): string {
  return `${accountPrefix(session)}${key}`;
}
