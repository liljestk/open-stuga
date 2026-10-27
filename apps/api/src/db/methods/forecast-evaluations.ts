import type { MeasurementForecastEvaluation } from "@climate-twin/contracts";
import { registerDatabaseMethods } from "../core.js";

/** A year of daily evaluations is enough evidence for long-run skill. */
const RETENTION_DAYS = 400;

interface EvaluationRow {
  evaluation_json: string;
}

registerDatabaseMethods({
  saveForecastEvaluation(evaluation: MeasurementForecastEvaluation): void {
    const evaluatedOn = evaluation.computedAt.slice(0, 10);
    this.db.prepare(`INSERT INTO forecast_evaluations (sensor_id, metric, evaluated_on, algorithm_version, model, status,
        skill_6h, skill_24h, coverage_90, computed_at, evaluation_json)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(sensor_id, metric, evaluated_on) DO UPDATE SET algorithm_version = excluded.algorithm_version,
        model = excluded.model, status = excluded.status, skill_6h = excluded.skill_6h, skill_24h = excluded.skill_24h,
        coverage_90 = excluded.coverage_90, computed_at = excluded.computed_at, evaluation_json = excluded.evaluation_json`)
      .run(evaluation.sensorId, evaluation.metric, evaluatedOn, evaluation.algorithmVersion, evaluation.model,
        evaluation.status, evaluation.skill6h, evaluation.skill24h, evaluation.coverage90, evaluation.computedAt,
        JSON.stringify(evaluation));
    const cutoff = new Date(Date.parse(evaluation.computedAt) - RETENTION_DAYS * 86_400_000).toISOString().slice(0, 10);
    this.db.prepare("DELETE FROM forecast_evaluations WHERE evaluated_on < ?").run(cutoff);
  },

  latestForecastEvaluation(sensorId: string, metric: string): MeasurementForecastEvaluation | null {
    const row = this.db.prepare(`SELECT evaluation_json FROM forecast_evaluations
      WHERE sensor_id = ? AND metric = ? ORDER BY evaluated_on DESC LIMIT 1`)
      .get(sensorId, metric) as unknown as EvaluationRow | undefined;
    return row ? JSON.parse(row.evaluation_json) as MeasurementForecastEvaluation : null;
  },

  listForecastEvaluations(since: string, sensorId?: string): MeasurementForecastEvaluation[] {
    const rows = (sensorId
      ? this.db.prepare(`SELECT evaluation_json FROM forecast_evaluations
          WHERE evaluated_on >= ? AND sensor_id = ? ORDER BY evaluated_on, sensor_id, metric`).all(since, sensorId)
      : this.db.prepare(`SELECT evaluation_json FROM forecast_evaluations
          WHERE evaluated_on >= ? ORDER BY evaluated_on, sensor_id, metric`).all(since)) as unknown as EvaluationRow[];
    return rows.map((row) => JSON.parse(row.evaluation_json) as MeasurementForecastEvaluation);
  },
});
