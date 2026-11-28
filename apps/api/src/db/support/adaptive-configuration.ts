import { createHash } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import type { AdaptiveReferenceGroup } from "@climate-twin/contracts";

interface ConfigurationGeneration { generation: number; changed_at: string }
interface ReferenceApproval { digest: string; approvedAt: string }

export function readReferenceApprovals(json: string | null | undefined): Record<string, ReferenceApproval> {
  return JSON.parse(json ?? "{}") as Record<string, ReferenceApproval>;
}

export function approveReferencePlacements(
  database: DatabaseSync,
  groups: AdaptiveReferenceGroup[],
  priorJson: string | null | undefined,
): string {
  const prior = readReferenceApprovals(priorJson);
  const approvedAt = new Date().toISOString();
  return JSON.stringify(Object.fromEntries(groups.map((group) => {
    const digest = referencePlacementDigest(database, group);
    const existing = prior[group.targetSensorId];
    return [group.targetSensorId, existing?.digest === digest ? existing : { digest, approvedAt }];
  })));
}

export function adaptiveConfigurationLookup(database: DatabaseSync) {
  const lookup = database.prepare(`SELECT generation, changed_at FROM adaptive_configuration_generations
    WHERE scope = ? AND entity_id = ? AND metric = ?`);
  return (scope: string, id: string, metric = "") => lookup.get(scope, id, metric) as ConfigurationGeneration | undefined;
}

/** Approval is tied to the participating sensors' placement and temperature source at confirmation. */
export function referencePlacementDigest(database: DatabaseSync, group: AdaptiveReferenceGroup): string {
  const generation = adaptiveConfigurationLookup(database);
  return createHash("sha256").update(JSON.stringify([group.targetSensorId, ...group.referenceSensorIds].map((id) => [
    id, generation("sensor", id)?.generation ?? 0, generation("binding", id, "temperature")?.generation ?? 0,
  ]))).digest("hex");
}
