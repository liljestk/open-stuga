import { createHash, randomUUID } from "node:crypto";
import {
  hasLocalHouseAuthority,
  type AdaptiveMonitoringSettings, type AdaptiveSettingsChange, type AdaptiveSettingsMode, type AdaptiveSettingsScope,
} from "@climate-twin/contracts";
import { registerDatabaseMethods, type DatabaseInternals } from "../core.js";
import { ClimateDataValidationError } from "../support/validation-errors.js";

interface SettingsRevision {
  revision: number;
  mode: AdaptiveSettingsMode;
  baseline_id: string | null;
  baseline_started_at: string | null;
  updated_at: string;
  actor_user_id: string | null;
  change_digest: string | null;
}

interface SettingsWrite {
  houseId: string;
  actorUserId: string;
  change: AdaptiveSettingsChange;
}

function readRevision(database: DatabaseInternals, scope: AdaptiveSettingsScope, revision?: number): SettingsRevision | undefined {
  const filter = revision === undefined ? "" : "AND revision = ?";
  return database.db.prepare(`SELECT revision, mode, baseline_id, baseline_started_at,
    updated_at, actor_user_id, change_digest FROM adaptive_settings_revisions
    WHERE house_id = ? AND data_mode = ? ${filter} ORDER BY revision DESC LIMIT 1`)
    .get(scope.houseId, scope.dataMode, ...(revision === undefined ? [] : [revision])) as SettingsRevision | undefined;
}

function toSettings(scope: AdaptiveSettingsScope, row?: SettingsRevision): AdaptiveMonitoringSettings {
  return {
    ...scope,
    mode: row?.mode ?? "off",
    revision: row?.revision ?? 0,
    baseline: row?.baseline_id && row.baseline_started_at
      ? { id: row.baseline_id, startedAt: row.baseline_started_at }
      : null,
    updatedAt: row?.updated_at ?? null,
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
  const value = change.action === "set-mode" ? change.mode : change.reason;
  return createHash("sha256").update(JSON.stringify([change.action, value])).digest("hex");
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
  changeAdaptiveMonitoringSettings({ houseId, actorUserId, change }: SettingsWrite): AdaptiveMonitoringSettings {
    return this.immediateTransaction(() => {
      const scope = { houseId, dataMode: change.dataMode };
      assertScope(this, scope);
      const current = toSettings(scope, readRevision(this, scope));
      const digest = actionDigest(change);
      const revision = change.baseRevision + 1;
      if (current.revision !== change.baseRevision) {
        const replay = readRevision(this, scope, revision);
        if (replay?.actor_user_id === actorUserId && replay.change_digest === digest) return toSettings(scope, replay);
        throw new ClimateDataValidationError(409, "ADAPTIVE_SETTINGS_CONFLICT", "Adaptive settings changed. Read the latest revision before retrying.");
      }
      const mode = change.action === "set-mode" ? change.mode : current.mode;
      if (change.action === "reset-baseline" && mode === "off") {
        throw new ClimateDataValidationError(409, "ADAPTIVE_MONITORING_DISABLED", "Enable shadow monitoring before resetting its baseline");
      }
      const updatedAt = new Date().toISOString();
      const baseline = mode === "off" ? null
        : change.action === "reset-baseline" || !current.baseline
          ? { id: randomUUID(), startedAt: updatedAt }
          : current.baseline;
      this.db.prepare(`INSERT INTO adaptive_settings_revisions
        (house_id, data_mode, revision, mode, baseline_id, baseline_started_at, updated_at, actor_user_id, change_digest, reset_reason)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(houseId, change.dataMode, revision, mode,
        baseline?.id ?? null, baseline?.startedAt ?? null, updatedAt, actorUserId, digest,
        change.action === "reset-baseline" ? change.reason : null);
      return { ...scope, mode, revision, baseline, updatedAt };
    });
  },
});
