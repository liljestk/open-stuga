import { createHash, randomUUID } from "node:crypto";
import {
  hasLocalHouseAuthority, isAdaptiveReferenceGroups,
  type AdaptiveMonitoringSettings, type AdaptiveSettingsChange, type AdaptiveSettingsMode, type AdaptiveSettingsScope,
} from "@climate-twin/contracts";
import { registerDatabaseMethods, type DatabaseInternals } from "../core.js";
import { ClimateDataValidationError } from "../support/validation-errors.js";
import { approveReferencePlacements } from "../support/adaptive-configuration.js";
import { assertReferenceMembership, normalizeReferenceGroups } from "./adaptive-reference-groups.js";

interface SettingsRevision {
  revision: number;
  mode: AdaptiveSettingsMode;
  baseline_id: string | null;
  baseline_started_at: string | null;
  updated_at: string;
  actor_user_id: string | null;
  change_digest: string | null;
  reference_groups_json: string;
  reference_placement_digests: string | null;
}

interface SettingsWrite {
  houseId: string;
  actorUserId: string;
  change: AdaptiveSettingsChange;
}

function readRevision(database: DatabaseInternals, scope: AdaptiveSettingsScope, revision?: number): SettingsRevision | undefined {
  const filter = revision === undefined ? "" : `AND revision = ?
    AND NOT EXISTS (SELECT 1 FROM adaptive_settings_revisions revoked
      WHERE revoked.house_id = settings.house_id AND revoked.data_mode = settings.data_mode
      AND revoked.revision > settings.revision AND revoked.actor_user_id IS NULL)`;
  return database.db.prepare(`SELECT revision, mode, baseline_id, baseline_started_at,
    updated_at, actor_user_id, change_digest, reference_groups_json, reference_placement_digests
    FROM adaptive_settings_revisions settings
    WHERE house_id = ? AND data_mode = ? ${filter} ORDER BY revision DESC LIMIT 1`)
    .get(scope.houseId, scope.dataMode, ...(revision === undefined ? [] : [revision])) as SettingsRevision | undefined;
}

function toSettings(scope: AdaptiveSettingsScope, row?: SettingsRevision): AdaptiveMonitoringSettings {
  const referenceGroups: unknown = JSON.parse(row?.reference_groups_json ?? "[]");
  if (!isAdaptiveReferenceGroups(referenceGroups)) throw new Error("Stored adaptive reference groups are invalid");
  return {
    ...scope,
    mode: row?.mode ?? "off",
    revision: row?.revision ?? 0,
    baseline: row?.baseline_id && row.baseline_started_at
      ? { id: row.baseline_id, startedAt: row.baseline_started_at }
      : null,
    updatedAt: row?.updated_at ?? null,
    referenceGroups,
  };
}

function assertScope(database: DatabaseInternals, scope: AdaptiveSettingsScope): void {
  const house = database.getHouse(scope.houseId);
  if (!house || !hasLocalHouseAuthority(house)) {
    throw new ClimateDataValidationError(404, "HOUSE_NOT_FOUND", "Active local Home not found");
  }
  const activeMode = database.isRealDataMode() ? "live" : "demo";
  if (activeMode !== scope.dataMode) {
    throw new ClimateDataValidationError(409, "ANALYTICS_DATA_MODE_MISMATCH", `This local database is in ${activeMode} mode`);
  }
}

function actionDigest(change: AdaptiveSettingsChange): string {
  const value = change.action === "set-reference-groups" ? change.referenceGroups
    : change.action === "set-mode" ? change.mode : change.reason;
  return createHash("sha256").update(JSON.stringify([change.action, value])).digest("hex");
}

function nextSettings(current: AdaptiveMonitoringSettings, change: AdaptiveSettingsChange): AdaptiveMonitoringSettings {
  const mode = change.action === "set-mode" ? change.mode : current.mode;
  if (change.action === "reset-baseline" && mode === "off") {
    throw new ClimateDataValidationError(409, "ADAPTIVE_MONITORING_DISABLED", "Enable shadow monitoring before resetting its baseline");
  }
  const referenceGroups = change.action === "set-reference-groups" ? change.referenceGroups : current.referenceGroups;
  const groupsChanged = JSON.stringify(referenceGroups) !== JSON.stringify(current.referenceGroups);
  const updatedAt = new Date().toISOString();
  const baseline = mode === "off" ? null
    : change.action === "reset-baseline" || groupsChanged || !current.baseline
      ? { id: randomUUID(), startedAt: updatedAt }
      : current.baseline;
  return { ...current, mode, revision: change.baseRevision + 1, baseline, updatedAt, referenceGroups };
}

declare module "../core.js" {
  interface DatabaseInternals {
    adaptiveMonitoringSettings(scope: AdaptiveSettingsScope): AdaptiveMonitoringSettings;
    changeAdaptiveMonitoringSettings(input: SettingsWrite): AdaptiveMonitoringSettings;
  }

  interface ClimateDatabaseCore {
    adaptiveMonitoringSettings(scope: AdaptiveSettingsScope): AdaptiveMonitoringSettings;
    changeAdaptiveMonitoringSettings(input: SettingsWrite): AdaptiveMonitoringSettings;
  }
}

registerDatabaseMethods({
  adaptiveMonitoringSettings(scope: AdaptiveSettingsScope): AdaptiveMonitoringSettings {
    return this.transaction(() => {
      assertScope(this, scope);
      return toSettings(scope, readRevision(this, scope));
    });
  },
  changeAdaptiveMonitoringSettings({ houseId, actorUserId, change: request }: SettingsWrite): AdaptiveMonitoringSettings {
    return this.immediateTransaction(() => {
      const change = request.action === "set-reference-groups"
        ? { ...request, referenceGroups: normalizeReferenceGroups(request.referenceGroups) }
        : request;
      const scope = { houseId, dataMode: change.dataMode };
      assertScope(this, scope);
      const previous = readRevision(this, scope);
      const current = toSettings(scope, previous);
      const digest = actionDigest(change);
      const revision = change.baseRevision + 1;
      if (current.revision !== change.baseRevision) {
        const replay = readRevision(this, scope, revision);
        if (replay?.actor_user_id === actorUserId && replay.change_digest === digest) return toSettings(scope, replay);
        throw new ClimateDataValidationError(409, "ADAPTIVE_SETTINGS_CONFLICT", "Adaptive settings changed. Read the latest revision before retrying.");
      }
      if (change.action === "set-reference-groups") assertReferenceMembership(this, houseId, change.referenceGroups);
      const next = nextSettings(current, change);
      const placements = change.action === "set-reference-groups"
        ? approveReferencePlacements(this.db, next.referenceGroups, previous?.reference_placement_digests)
        : previous?.reference_placement_digests ?? null;
      this.db.prepare(`INSERT INTO adaptive_settings_revisions
        (house_id, data_mode, revision, mode, baseline_id, baseline_started_at, updated_at, actor_user_id,
         change_digest, reset_reason, reference_groups_json, reference_placement_digests)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(houseId, change.dataMode, revision, next.mode,
        next.baseline?.id ?? null, next.baseline?.startedAt ?? null, next.updatedAt, actorUserId, digest,
        change.action === "reset-baseline" ? change.reason : null, JSON.stringify(next.referenceGroups), placements);
      return next;
    });
  },
});
