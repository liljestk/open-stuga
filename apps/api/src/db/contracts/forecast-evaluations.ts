import type { MeasurementForecastEvaluation } from "@climate-twin/contracts";
import "../core.js";

declare module "../core.js" {
  interface DatabaseInternals {
    /** Keeps one evaluation per sensor, metric and UTC day; later ones that day replace it. */
    saveForecastEvaluation(evaluation: MeasurementForecastEvaluation): void;
    latestForecastEvaluation(sensorId: string, metric: string): MeasurementForecastEvaluation | null;
    /** Daily evaluations since a UTC date (YYYY-MM-DD), oldest first. */
    listForecastEvaluations(since: string, sensorId?: string): MeasurementForecastEvaluation[];
  }

  interface ClimateDatabaseCore {
    saveForecastEvaluation(evaluation: MeasurementForecastEvaluation): void;
    latestForecastEvaluation(sensorId: string, metric: string): MeasurementForecastEvaluation | null;
    listForecastEvaluations(since: string, sensorId?: string): MeasurementForecastEvaluation[];
  }
}
