import { SYSTEM_VERSION } from "@climate-twin/contracts";

export const API_RUNTIME_VERSION_HEADER = "x-stugu-system-version";

export class ApiVersionMismatchError extends Error {
  readonly code = "API_RUNTIME_VERSION_MISMATCH";
  readonly expectedVersion = SYSTEM_VERSION;

  constructor(readonly actualVersion: string | null) {
    super(actualVersion
      ? `Stugu web ${SYSTEM_VERSION} cannot use API ${actualVersion}. Both must run the same version.`
      : `Stugu web ${SYSTEM_VERSION} cannot verify the API version. The API may need to be restarted.`);
    this.name = "ApiVersionMismatchError";
  }
}

type ApiVersionMismatchListener = (error: ApiVersionMismatchError) => void;

const mismatchListeners = new Set<ApiVersionMismatchListener>();

export function subscribeToApiVersionMismatch(listener: ApiVersionMismatchListener): () => void {
  mismatchListeners.add(listener);
  return () => mismatchListeners.delete(listener);
}

export function assertApiRuntimeVersion(actualVersion: string | null, required = false): void {
  const normalizedVersion = actualVersion?.trim().slice(0, 50) || null;
  if (normalizedVersion === SYSTEM_VERSION || (!required && normalizedVersion === null)) return;
  const error = new ApiVersionMismatchError(normalizedVersion);
  for (const listener of mismatchListeners) listener(error);
  throw error;
}
