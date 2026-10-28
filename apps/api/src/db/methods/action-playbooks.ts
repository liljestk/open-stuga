import { validateActionPlaybook } from "../action-playbook-validation.js";
import { randomUUID } from "node:crypto";
import type { ActionPlaybook, ActionPlaybookInput, ActionRun, ActionRunStartInput, MeasurementSample } from "@climate-twin/contracts";
import { ActionPlaybookRow, ActionRunRow } from "../support/row-types.js";
import { ClimateDataValidationError } from "../support/validation-errors.js";
import { actionPlaybookFromRow } from "../support/row-mappers.js";
import { actionRunFromRow } from "../support/row-mappers.js";
import { registerDatabaseMethods } from "../core.js";

declare module "../core.js" {
  interface DatabaseInternals {
    listActionPlaybooks(metric?: string, enabledOnly?: boolean): ActionPlaybook[];
    getActionPlaybook(id: string): ActionPlaybook | null;
    saveActionPlaybook(input: ActionPlaybookInput): ActionPlaybook;
    updateActionPlaybook(id: string, patch: Partial<ActionPlaybookInput>): ActionPlaybook | null;
    listActionRuns(options?: {
            houseId?: string;
            sensorId?: string;
            alertEventId?: string;
            activeOnly?: boolean;
            limit?: number;
        }): ActionRun[];
    getActionRun(id: string): ActionRun | null;
    startActionRun(input: ActionRunStartInput, now?: Date): ActionRun;
    completeActionRun(id: string, now?: Date): ActionRun | null;
    cancelActionRun(id: string, note?: string | null, now?: Date): ActionRun | null;
    verifyActionRun(id: string, samples: MeasurementSample[], now?: Date): ActionRun | null;
    verifyDueActionRuns(now?: Date): ActionRun[];
  }

  interface ClimateDatabaseCore {
    listActionPlaybooks(metric?: string, enabledOnly?: boolean): ActionPlaybook[];
    getActionPlaybook(id: string): ActionPlaybook | null;
    saveActionPlaybook(input: ActionPlaybookInput): ActionPlaybook;
    updateActionPlaybook(id: string, patch: Partial<ActionPlaybookInput>): ActionPlaybook | null;
    listActionRuns(options?: {
            houseId?: string;
            sensorId?: string;
            alertEventId?: string;
            activeOnly?: boolean;
            limit?: number;
        }): ActionRun[];
    getActionRun(id: string): ActionRun | null;
    startActionRun(input: ActionRunStartInput, now?: Date): ActionRun;
    completeActionRun(id: string, now?: Date): ActionRun | null;
    cancelActionRun(id: string, note?: string | null, now?: Date): ActionRun | null;
    verifyActionRun(id: string, samples: MeasurementSample[], now?: Date): ActionRun | null;
    verifyDueActionRuns(now?: Date): ActionRun[];
  }
}

registerDatabaseMethods({
  listActionPlaybooks(metric?: string, enabledOnly = false): ActionPlaybook[] {
      const clauses: string[] = [];
      const parameters: string[] = [];
      if (metric) { clauses.push("metric = ?"); parameters.push(metric); }
      if (enabledOnly) clauses.push("enabled = 1");
      const where = clauses.length ? `WHERE ${clauses.join(" AND ")}` : "";
      return (this.db.prepare(`SELECT * FROM action_playbooks ${where} ORDER BY built_in DESC, name`)
        .all(...parameters) as unknown as ActionPlaybookRow[]).map(actionPlaybookFromRow);
    },
  getActionPlaybook(id: string): ActionPlaybook | null {
      const row = this.db.prepare("SELECT * FROM action_playbooks WHERE id = ?").get(id) as unknown as ActionPlaybookRow | undefined;
      return row ? actionPlaybookFromRow(row) : null;
    },
  saveActionPlaybook(input: ActionPlaybookInput): ActionPlaybook {
      validateActionPlaybook(input);
      if (!this.getMeasurementDefinition(input.metric)) {
        throw new ClimateDataValidationError(404, "UNKNOWN_METRIC", `Unknown measurement metric: ${input.metric}`);
      }
      const now = new Date().toISOString();
      const id = input.id ?? randomUUID();
      const instructions = [...new Set(input.instructions.map((item) => item.trim()).filter(Boolean))];
      if (!input.name.trim() || !input.description.trim() || instructions.length === 0 || instructions.length > 20) {
        throw new ClimateDataValidationError(400, "INVALID_PLAYBOOK", "A playbook requires a name, description, and 1–20 instructions");
      }
      this.db.prepare(`INSERT INTO action_playbooks(
        id, name, description, instructions_json, metric, goal, minimum_improvement, target_value,
        wait_seconds, verification_window_seconds, enabled, built_in, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?, ?)`)
        .run(id, input.name.trim(), input.description.trim(), JSON.stringify(instructions), input.metric, input.goal,
          input.minimumImprovement, input.targetValue, input.waitSeconds, input.verificationWindowSeconds,
          input.enabled === false ? 0 : 1, now, now);
      return this.getActionPlaybook(id)!;
    },
  updateActionPlaybook(id: string, patch: Partial<ActionPlaybookInput>): ActionPlaybook | null {
      const current = this.getActionPlaybook(id);
      if (!current) return null;
      const next: ActionPlaybookInput = {
        name: patch.name ?? current.name,
        description: patch.description ?? current.description,
        instructions: patch.instructions ?? current.instructions,
        metric: patch.metric ?? current.metric,
        goal: patch.goal ?? current.goal,
        minimumImprovement: patch.minimumImprovement ?? current.minimumImprovement,
        targetValue: patch.targetValue === undefined ? current.targetValue : patch.targetValue,
        waitSeconds: patch.waitSeconds ?? current.waitSeconds,
        verificationWindowSeconds: patch.verificationWindowSeconds ?? current.verificationWindowSeconds,
        enabled: patch.enabled ?? current.enabled,
      };
      validateActionPlaybook(next);
      if (!this.getMeasurementDefinition(next.metric)) {
        throw new ClimateDataValidationError(404, "UNKNOWN_METRIC", `Unknown measurement metric: ${next.metric}`);
      }
      const instructions = [...new Set(next.instructions.map((item) => item.trim()).filter(Boolean))];
      if (!next.name.trim() || !next.description.trim() || instructions.length === 0 || instructions.length > 20) {
        throw new ClimateDataValidationError(400, "INVALID_PLAYBOOK", "A playbook requires a name, description, and 1–20 instructions");
      }
      this.db.prepare(`UPDATE action_playbooks SET name = ?, description = ?, instructions_json = ?, metric = ?,
        goal = ?, minimum_improvement = ?, target_value = ?, wait_seconds = ?, verification_window_seconds = ?,
        enabled = ?, updated_at = ? WHERE id = ?`)
        .run(next.name.trim(), next.description.trim(), JSON.stringify(instructions), next.metric, next.goal,
          next.minimumImprovement, next.targetValue, next.waitSeconds, next.verificationWindowSeconds,
          next.enabled === false ? 0 : 1, new Date().toISOString(), id);
      return this.getActionPlaybook(id);
    },
  listActionRuns(options: {
      houseId?: string;
      sensorId?: string;
      alertEventId?: string;
      activeOnly?: boolean;
      limit?: number;
    } = {}): ActionRun[] {
      const clauses: string[] = [];
      const parameters: Array<string | number> = [];
      if (options.houseId) {
        clauses.push("sensor.house_id = ?");
        parameters.push(options.houseId);
      }
      if (options.sensorId) { clauses.push("run.sensor_id = ?"); parameters.push(options.sensorId); }
      if (options.alertEventId) { clauses.push("run.alert_event_id = ?"); parameters.push(options.alertEventId); }
      if (options.activeOnly) clauses.push("run.status IN ('active', 'waiting')");
      const where = ["house.deleted_at IS NULL", ...clauses].join(" AND ");
      const requestedLimit = options.limit ?? 500;
      const limit = Number.isFinite(requestedLimit)
        ? Math.min(500, Math.max(1, Math.trunc(requestedLimit)))
        : 500;
      return (this.db.prepare(`SELECT run.* FROM action_runs AS run
        JOIN sensors AS sensor ON sensor.id = run.sensor_id
        JOIN houses AS house ON house.id = sensor.house_id
        WHERE ${where} ORDER BY run.updated_at DESC, run.id DESC LIMIT ?`)
        .all(...parameters, limit) as unknown as ActionRunRow[]).map(actionRunFromRow);
    },
  getActionRun(id: string): ActionRun | null {
      const row = this.db.prepare(`SELECT run.* FROM action_runs AS run
        JOIN sensors AS sensor ON sensor.id = run.sensor_id
        JOIN houses AS house ON house.id = sensor.house_id
        WHERE run.id = ? AND house.deleted_at IS NULL`).get(id) as unknown as ActionRunRow | undefined;
      return row ? actionRunFromRow(row) : null;
    },
  startActionRun(input: ActionRunStartInput, now = new Date()): ActionRun {
      const playbook = this.getActionPlaybook(input.playbookId);
      if (!playbook || !playbook.enabled) throw new ClimateDataValidationError(404, "PLAYBOOK_NOT_FOUND", "Action playbook not found");
      const sensor = this.getSensor(input.sensorId);
      if (!sensor || !sensor.enabled) throw new ClimateDataValidationError(404, "SENSOR_NOT_FOUND", "Sensor not found or disabled");
      const baseline = this.getLatestMeasurementSample(sensor.id, playbook.metric);
      if (!baseline || baseline.quality === "stale") {
        throw new ClimateDataValidationError(409, "BASELINE_UNAVAILABLE", "A fresh baseline sample is required before starting this action");
      }
      if (input.alertEventId) {
        const event = this.getAlertEvent(input.alertEventId);
        if (!event || event.sensorId !== sensor.id || event.metric !== playbook.metric) {
          throw new ClimateDataValidationError(409, "ALERT_MISMATCH", "The alert does not match the selected sensor and playbook metric");
        }
      }
      if (input.maintenanceTaskId) {
        const task = this.getMaintenanceTask(input.maintenanceTaskId);
        if (!task) {
          throw new ClimateDataValidationError(404, "MAINTENANCE_TASK_NOT_FOUND", "Maintenance task not found");
        }
        const house = this.getHouse(sensor.houseId);
        if (!house || task.propertyId !== house.propertyId || (task.houseId !== null && task.houseId !== house.id)) {
          throw new ClimateDataValidationError(
            409,
            "MAINTENANCE_TASK_SCOPE_MISMATCH",
            "Maintenance task does not belong to the selected sensor's Home or property",
          );
        }
      }
      const duplicate = this.db.prepare(`SELECT 1 FROM action_runs
        WHERE playbook_id = ? AND sensor_id = ? AND status IN ('active', 'waiting') LIMIT 1`)
        .get(playbook.id, sensor.id);
      if (duplicate) throw new ClimateDataValidationError(409, "ACTION_ALREADY_ACTIVE", "This action is already active for the sensor");
      const timestamp = now.toISOString();
      const id = randomUUID();
      this.db.prepare(`INSERT INTO action_runs(
        id, playbook_id, alert_event_id, maintenance_task_id, sensor_id, metric, status, started_at,
        action_completed_at, verify_after, verification_deadline, baseline_value, baseline_timestamp,
        result_value, result_timestamp, improvement, sample_count, operator_note, verification_note,
        created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, 'active', ?, NULL, NULL, NULL, ?, ?, NULL, NULL, NULL, 0, ?, NULL, ?, ?)`)
        .run(id, playbook.id, input.alertEventId ?? null, input.maintenanceTaskId ?? null, sensor.id, playbook.metric,
          timestamp, baseline.value, baseline.timestamp, input.operatorNote?.trim() || null, timestamp, timestamp);
      return this.getActionRun(id)!;
    },
  completeActionRun(id: string, now = new Date()): ActionRun | null {
      const run = this.getActionRun(id);
      if (!run) return null;
      if (run.status !== "active") {
        throw new ClimateDataValidationError(409, "INVALID_ACTION_STATE", "Only an active action can be marked complete");
      }
      const playbook = this.getActionPlaybook(run.playbookId)!;
      const verifyAfter = new Date(now.getTime() + playbook.waitSeconds * 1_000);
      const deadline = new Date(verifyAfter.getTime() + playbook.verificationWindowSeconds * 1_000);
      this.db.prepare(`UPDATE action_runs SET status = 'waiting', action_completed_at = ?, verify_after = ?,
        verification_deadline = ?, updated_at = ? WHERE id = ? AND status = 'active'`)
        .run(now.toISOString(), verifyAfter.toISOString(), deadline.toISOString(), now.toISOString(), id);
      return this.getActionRun(id);
    },
  cancelActionRun(id: string, note: string | null = null, now = new Date()): ActionRun | null {
      const run = this.getActionRun(id);
      if (!run) return null;
      if (!['active', 'waiting'].includes(run.status)) return run;
      this.db.prepare(`UPDATE action_runs SET status = 'cancelled', verification_note = ?, updated_at = ? WHERE id = ?`)
        .run(note?.trim() || "Cancelled by operator", now.toISOString(), id);
      return this.getActionRun(id);
    },
  verifyActionRun(id: string, candidateSamples: MeasurementSample[], now = new Date()): ActionRun | null {
      const run = this.getActionRun(id);
      if (!run || run.status !== "waiting" || !run.verifyAfter || !run.verificationDeadline
        || Date.parse(run.verifyAfter) > now.getTime()) return run;
      const playbook = this.getActionPlaybook(run.playbookId);
      if (!playbook) return run;
      const windowEnd = new Date(Math.min(now.getTime(), Date.parse(run.verificationDeadline))).toISOString();
      const evidenceFrom = new Date(Math.max(Date.parse(run.verifyAfter), Date.parse(run.baselineTimestamp) + 1)).toISOString();
      const samples = candidateSamples
        .filter((sample) => sample.sensorId === run.sensorId && sample.metric === run.metric
          && sample.timestamp >= evidenceFrom && sample.timestamp <= windowEnd && sample.quality !== "stale")
        .sort((left, right) => left.timestamp.localeCompare(right.timestamp));
      const latest = samples.at(-1) ?? null;
      let improvement: number | null = null;
      let succeeded = false;
      if (latest) {
        improvement = playbook.goal === "decrease" || playbook.goal === "below"
          ? run.baselineValue - latest.value
          : latest.value - run.baselineValue;
        succeeded = playbook.goal === "decrease"
          ? improvement >= playbook.minimumImprovement
          : playbook.goal === "increase"
            ? improvement >= playbook.minimumImprovement
            : playbook.goal === "below"
              ? latest.value <= (playbook.targetValue ?? -Infinity)
              : latest.value >= (playbook.targetValue ?? Infinity);
      }
      const expired = now.getTime() >= Date.parse(run.verificationDeadline);
      const status = succeeded ? "verified" : expired ? "not-improved" : "waiting";
      const note = succeeded
        ? "The measured result met the playbook verification goal."
        : expired
          ? latest ? "The verification window ended without meeting the goal." : "No fresh verification samples arrived before the deadline."
          : null;
      this.db.prepare(`UPDATE action_runs SET status = ?, result_value = ?, result_timestamp = ?, improvement = ?,
        sample_count = ?, verification_note = ?, updated_at = ? WHERE id = ? AND status = 'waiting'`)
        .run(status, latest?.value ?? null, latest?.timestamp ?? null, improvement, samples.length, note,
          now.toISOString(), run.id);
      return this.getActionRun(run.id);
    },
  verifyDueActionRuns(now = new Date()): ActionRun[] {
      const due = (this.db.prepare(`SELECT run.* FROM action_runs AS run
        JOIN sensors AS sensor ON sensor.id = run.sensor_id
        JOIN houses AS house ON house.id = sensor.house_id
        WHERE run.status = 'waiting' AND run.verify_after <= ? AND house.deleted_at IS NULL
        ORDER BY run.verify_after LIMIT 200`)
        .all(now.toISOString()) as unknown as ActionRunRow[]).map(actionRunFromRow);
      const changed: ActionRun[] = [];
      for (const run of due) {
        if (!run.verifyAfter || !run.verificationDeadline) continue;
        const windowEnd = new Date(Math.min(now.getTime(), Date.parse(run.verificationDeadline))).toISOString();
        const evidenceFrom = new Date(Math.max(Date.parse(run.verifyAfter), Date.parse(run.baselineTimestamp) + 1)).toISOString();
        const samples = this.measurementHistory(run.sensorId, run.metric, evidenceFrom, windowEnd, 10_000)
          .filter((sample) => sample.quality !== "stale");
        const updated = this.verifyActionRun(run.id, samples, now);
        if (!updated) continue;
        if (updated.status !== run.status || updated.sampleCount !== run.sampleCount || updated.resultValue !== run.resultValue) changed.push(updated);
      }
      return changed;
    },
});
