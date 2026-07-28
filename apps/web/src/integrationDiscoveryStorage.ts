const integrationDiscoveryStorageKey = (houseId: string) => `stugu.integration-discovery.${houseId}`;

export function rememberedIntegrationDiscovery(houseId: string): string | null {
  if (typeof window === "undefined") return null;
  try {
    const id = window.localStorage.getItem(integrationDiscoveryStorageKey(houseId));
    return id && id.length <= 200 ? id : null;
  } catch {
    return null;
  }
}

export function rememberIntegrationDiscovery(houseId: string, jobId: string): void {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(integrationDiscoveryStorageKey(houseId), jobId);
  } catch {
    // Discovery still completes server-side when browser storage is unavailable.
  }
}

export function forgetIntegrationDiscovery(houseId: string, jobId?: string): void {
  if (typeof window === "undefined") return;
  try {
    const key = integrationDiscoveryStorageKey(houseId);
    if (!jobId || window.localStorage.getItem(key) === jobId) window.localStorage.removeItem(key);
  } catch {
    // Nothing sensitive or authoritative is stored here.
  }
}
