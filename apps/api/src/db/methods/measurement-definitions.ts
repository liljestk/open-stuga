import type { MeasurementDefinition } from "@climate-twin/contracts";
import { MeasurementDefinitionRow } from "../support/row-types.js";
import { ClimateDataValidationError } from "../support/validation-errors.js";
import { measurementDefinitionFromRow } from "../support/row-mappers.js";
import { registerDatabaseMethods } from "../core.js";

declare module "../core.js" {
  interface DatabaseInternals {
    listMeasurementDefinitions(includeDisabled?: boolean): MeasurementDefinition[];
    getMeasurementDefinition(id: string): MeasurementDefinition | null;
    createMeasurementDefinition(definition: MeasurementDefinition): MeasurementDefinition;
    updateMeasurementDefinition(id: string, patch: Partial<Omit<MeasurementDefinition, "id" | "builtin">>): MeasurementDefinition | null;
    disableMeasurementDefinition(id: string): MeasurementDefinition | null;
  }

  interface ClimateDatabaseCore {
    listMeasurementDefinitions(includeDisabled?: boolean): MeasurementDefinition[];
    getMeasurementDefinition(id: string): MeasurementDefinition | null;
    createMeasurementDefinition(definition: MeasurementDefinition): MeasurementDefinition;
    updateMeasurementDefinition(id: string, patch: Partial<Omit<MeasurementDefinition, "id" | "builtin">>): MeasurementDefinition | null;
    disableMeasurementDefinition(id: string): MeasurementDefinition | null;
  }
}

registerDatabaseMethods({
  listMeasurementDefinitions(includeDisabled = true): MeasurementDefinition[] {
      const rows = (includeDisabled
        ? this.db.prepare("SELECT * FROM measurement_definitions ORDER BY builtin DESC, id").all()
        : this.db.prepare("SELECT * FROM measurement_definitions WHERE enabled = 1 ORDER BY builtin DESC, id").all()) as unknown as MeasurementDefinitionRow[];
      return rows.map(measurementDefinitionFromRow);
    },
  getMeasurementDefinition(id: string): MeasurementDefinition | null {
      const row = this.db.prepare("SELECT * FROM measurement_definitions WHERE id = ?").get(id) as unknown as MeasurementDefinitionRow | undefined;
      return row ? measurementDefinitionFromRow(row) : null;
    },
  createMeasurementDefinition(definition: MeasurementDefinition): MeasurementDefinition {
      this.db.prepare(`INSERT INTO measurement_definitions
        (id, labels_json, unit, dimension, allowed_units_json, kind, default_aggregation,
         generic_history_enabled, generic_stats_enabled, precision, valid_min, valid_max, display_min, display_max,
         interpolation_delta, color_scale, builtin, enabled, spatial_interpolation, forecast_supported)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
        .run(definition.id, JSON.stringify(definition.labels), definition.unit, definition.dimension ?? "finite_scalar",
          JSON.stringify(definition.allowedUnits ?? [definition.unit]), definition.kind ?? "gauge", definition.defaultAggregation ?? "mean",
          definition.genericHistoryEnabled === false ? 0 : 1, definition.genericStatsEnabled === false ? 0 : 1, definition.precision,
          definition.validMin, definition.validMax, definition.displayMin, definition.displayMax,
          definition.interpolationDelta, definition.colorScale, definition.builtin ? 1 : 0, definition.enabled ? 1 : 0,
          definition.spatialInterpolation ? 1 : 0, definition.forecastSupported ? 1 : 0);
      return this.getMeasurementDefinition(definition.id)!;
    },
  updateMeasurementDefinition(id: string, patch: Partial<Omit<MeasurementDefinition, "id" | "builtin">>): MeasurementDefinition | null {
      const current = this.getMeasurementDefinition(id);
      if (!current) return null;
      const next: MeasurementDefinition = { ...current, ...patch, id, builtin: current.builtin };
      if (next.unit !== current.unit) {
        const usage = this.db.prepare(`SELECT 1 FROM (
          SELECT metric FROM measurement_samples WHERE metric = ?
          UNION ALL SELECT metric FROM sensor_measurement_bindings WHERE metric = ?
          UNION ALL SELECT metric FROM alert_rules WHERE metric = ?
        ) LIMIT 1`).get(id, id, id);
        if (usage) {
          throw new ClimateDataValidationError(
            409,
            "UNIT_IMMUTABLE",
            "Canonical unit cannot change after samples, sensor bindings, or alert rules reference the metric",
          );
        }
      }
      this.db.prepare(`UPDATE measurement_definitions SET labels_json = ?, unit = ?, dimension = ?, allowed_units_json = ?,
        kind = ?, default_aggregation = ?, generic_history_enabled = ?, generic_stats_enabled = ?, precision = ?,
        valid_min = ?, valid_max = ?, display_min = ?, display_max = ?, interpolation_delta = ?, color_scale = ?, enabled = ?,
        spatial_interpolation = ?, forecast_supported = ? WHERE id = ?`)
        .run(JSON.stringify(next.labels), next.unit, next.dimension ?? "finite_scalar", JSON.stringify(next.allowedUnits ?? [next.unit]),
          next.kind ?? "gauge", next.defaultAggregation ?? "mean", next.genericHistoryEnabled === false ? 0 : 1,
          next.genericStatsEnabled === false ? 0 : 1, next.precision, next.validMin, next.validMax, next.displayMin,
          next.displayMax, next.interpolationDelta, next.colorScale, next.enabled ? 1 : 0,
          next.spatialInterpolation ? 1 : 0, next.forecastSupported ? 1 : 0, id);
      if (next.enabled && !current.enabled) this.rearmEligibleNotSupportedTapoGaps(null, id);
      return next;
    },
  disableMeasurementDefinition(id: string): MeasurementDefinition | null {
      const current = this.getMeasurementDefinition(id);
      if (!current) return null;
      this.db.prepare("UPDATE measurement_definitions SET enabled = 0 WHERE id = ?").run(id);
      return { ...current, enabled: false };
    },
});
