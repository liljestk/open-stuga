import { createHash, randomUUID } from "node:crypto";
import type { AdaptiveEvidenceEpoch, AdaptiveEvidenceScope, AdaptiveMonitoringSettings } from "@climate-twin/contracts";
import { registerDatabaseMethods, type DatabaseInternals } from "../core.js";
import { adaptiveConfigurationLookup, readReferenceApprovals, referencePlacementDigest } from "../support/adaptive-configuration.js";
import { ClimateDataValidationError } from "../support/validation-errors.js";
import { assertReferenceMembership } from "./adaptive-reference-groups.js";

interface EpochConfiguration {
  propertyId: string;
  baselineId: string;
  configurationDigest: string;
  effectiveAt: string;
}

function generationsFor(database: DatabaseInternals, scope: AdaptiveEvidenceScope, referenceIds: string[]) {
  const generation = adaptiveConfigurationLookup(database.db);
  return [
    generation("home", scope.houseId),
    scope.purpose === "climate" && scope.metric === "temperature" ? generation("weather", scope.houseId) : undefined,
    generation("definition", scope.metric),
    ...[scope.sensorId, ...referenceIds].flatMap((id) => [
      generation("sensor", id), generation("binding", id, scope.metric),
    ]),
  ];
}

function referenceContext(database: DatabaseInternals, scope: AdaptiveEvidenceScope, settings: AdaptiveMonitoringSettings) {
  if (scope.purpose === "climate") return { ids: [], approvedAt: settings.baseline!.startedAt };
  if (scope.metric !== "temperature") return null;
  const group = settings.referenceGroups.find((candidate) => candidate.targetSensorId === scope.sensorId);
  if (!group) return null;
  const stored = database.db.prepare(`SELECT reference_placement_digests AS digests FROM adaptive_settings_revisions
    WHERE house_id = ? AND data_mode = ? AND revision = ?`).get(scope.houseId, scope.dataMode, settings.revision) as
      { digests: string | null } | undefined;
  const approved = readReferenceApprovals(stored?.digests)[scope.sensorId];
  if (approved?.digest !== referencePlacementDigest(database.db, group)) return null;
  try {
    assertReferenceMembership(database, scope.houseId, [group]);
    return { ids: group.referenceSensorIds, approvedAt: approved.approvedAt };
  } catch (error) {
    if (error instanceof ClimateDataValidationError) return null;
    throw error;
  }
}

function effectiveTime(database: DatabaseInternals, boundaries: string[], changes: ReturnType<typeof generationsFor>): string {
  const trackedFrom = database.db.prepare("SELECT value FROM metadata WHERE key = 'adaptive_evidence_observed_from'")
    .get() as { value: string } | undefined;
  if (!trackedFrom) throw new Error("Adaptive configuration tracking is unavailable");
  const boundary = Math.max(Date.parse(trackedFrom.value), ...boundaries.map((time) => Date.parse(time)),
    ...changes.map((change) => change ? Date.parse(change.changed_at) : 0));
  return new Date(boundary).toISOString();
}

function epochConfiguration(database: DatabaseInternals, scope: AdaptiveEvidenceScope): EpochConfiguration | null {
  const { houseId, dataMode } = scope;
  const settings = database.adaptiveMonitoringSettings({ houseId, dataMode });
  const sensor = database.getSensor(scope.sensorId);
  if (!settings.baseline || !sensor?.enabled || sensor.houseId !== houseId
    || !database.getMeasurementDefinition(scope.metric)?.enabled) return null;
  const propertyId = database.getHouse(scope.houseId)?.propertyId;
  const references = referenceContext(database, scope, settings);
  if (!propertyId || !references) return null;
  const changes = generationsFor(database, scope, references.ids);
  const configurationDigest = createHash("sha256").update(JSON.stringify([
    propertyId, references.ids, changes.map((change) => change?.generation ?? 0),
  ])).digest("hex");
  return {
    propertyId, configurationDigest, baselineId: settings.baseline.id,
    effectiveAt: effectiveTime(database, [settings.baseline.startedAt, references.approvedAt], changes),
  };
}

interface EpochRow {
  id: string;
  effective_at: string;
  recorded_at: string;
}

function readEpoch(database: DatabaseInternals, scope: AdaptiveEvidenceScope, configuration: EpochConfiguration): AdaptiveEvidenceEpoch | null {
  const row = database.db.prepare(`SELECT id, effective_at, recorded_at FROM adaptive_evidence_epochs
    WHERE house_id = ? AND data_mode = ? AND sensor_id = ? AND metric = ? AND purpose = ?
      AND baseline_id = ? AND configuration_digest = ?`)
    .get(scope.houseId, scope.dataMode, scope.sensorId, scope.metric, scope.purpose,
      configuration.baselineId, configuration.configurationDigest) as EpochRow | undefined;
  return row ? { ...scope, ...configuration, id: row.id, effectiveAt: row.effective_at, recordedAt: row.recorded_at } : null;
}

declare module "../core.js" {
  interface DatabaseInternals {
    readAdaptiveEvidenceEpoch(scope: AdaptiveEvidenceScope): AdaptiveEvidenceEpoch | null;
    ensureAdaptiveEvidenceEpoch(scope: AdaptiveEvidenceScope): AdaptiveEvidenceEpoch | null;
  }

  interface ClimateDatabaseCore {
    readAdaptiveEvidenceEpoch(scope: AdaptiveEvidenceScope): AdaptiveEvidenceEpoch | null;
    ensureAdaptiveEvidenceEpoch(scope: AdaptiveEvidenceScope): AdaptiveEvidenceEpoch | null;
  }
}

registerDatabaseMethods({
  readAdaptiveEvidenceEpoch(scope: AdaptiveEvidenceScope): AdaptiveEvidenceEpoch | null {
    return this.transaction(() => {
      const configuration = epochConfiguration(this, scope);
      return configuration && readEpoch(this, scope, configuration);
    });
  },
  ensureAdaptiveEvidenceEpoch(scope: AdaptiveEvidenceScope): AdaptiveEvidenceEpoch | null {
    return this.immediateTransaction(() => {
      const configuration = epochConfiguration(this, scope);
      if (!configuration) return null;
      const prior = readEpoch(this, scope, configuration);
      if (prior) return prior;
      const id = randomUUID();
      const recordedAt = new Date().toISOString();
      this.db.prepare(`INSERT INTO adaptive_evidence_epochs
        (id, property_id, house_id, sensor_id, metric, purpose, data_mode, baseline_id,
         configuration_digest, effective_at, recorded_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(id, configuration.propertyId, scope.houseId, scope.sensorId,
        scope.metric, scope.purpose, scope.dataMode, configuration.baselineId, configuration.configurationDigest,
        configuration.effectiveAt, recordedAt);
      return { ...scope, ...configuration, id, recordedAt };
    });
  },
});
