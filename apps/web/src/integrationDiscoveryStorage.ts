import { readLocalStorage, removeLocalStorage, writeLocalStorage } from "./browserStorage";

const integrationDiscoveryStorageKey = (houseId: string) => `stugu.integration-discovery.${houseId}`;

export function rememberedIntegrationDiscovery(houseId: string): string | null {
  const id = readLocalStorage(integrationDiscoveryStorageKey(houseId));
  return id && id.length <= 200 ? id : null;
}

export function rememberIntegrationDiscovery(houseId: string, jobId: string): void {
  writeLocalStorage(integrationDiscoveryStorageKey(houseId), jobId);
}

export function forgetIntegrationDiscovery(houseId: string, jobId?: string): void {
  const key = integrationDiscoveryStorageKey(houseId);
  if (!jobId || readLocalStorage(key) === jobId) removeLocalStorage(key);
}
