import type { SystemUpdateHostProjection, SystemUpdateStatus } from "@climate-twin/contracts";

type ApplicationFields = Omit<SystemUpdateStatus, "schema" | "revision" | "application" | "host" | "workflow">;

/** The host projection the API reports where the platform manages host updates itself. */
export const externallyManagedHost: SystemUpdateHostProjection = {
  supported: false,
  phase: "idle",
  reason: "platform-managed-externally",
  detail: null,
  currentVersion: null,
  currentGeneration: null,
  activeSlot: null,
  updateAvailable: false,
  targetVersion: null,
  targetGeneration: null,
  targetDigest: null,
  updatedAt: null,
  readyToRestart: null,
};

/** A full v2 status for these application fields, with no host update and no workflow. */
export function systemUpdateStatus(fields: ApplicationFields): SystemUpdateStatus {
  return {
    ...fields,
    schema: "stugu-system-updates/v2",
    revision: 1,
    application: {
      currentVersion: fields.currentVersion,
      latestVersion: fields.latestVersion,
      updateAvailable: fields.updateAvailable,
      capability: fields.capability,
      operation: fields.operation,
    },
    host: externallyManagedHost,
    workflow: null,
  };
}
