import type { MeasurementForecastEvaluation, Sensor } from "@climate-twin/contracts";
import { useI18n } from "../i18n";

/**
 * Says why a sensor's forecast is missing, or how much better than "no change"
 * a shown one was in its own backtest.
 */
export function ForecastNotes({
  evaluations,
  sensors,
}: Readonly<{ evaluations: Record<string, MeasurementForecastEvaluation>; sensors: readonly Sensor[] }>) {
  const { locale, t } = useI18n();
  const percent = new Intl.NumberFormat(locale, { style: "percent", maximumFractionDigits: 0 });
  const notes = sensors.flatMap((sensor) => {
    const evaluation = evaluations[sensor.id];
    if (!evaluation) return [];
    if (evaluation.status === "ready" && evaluation.skill6h !== null) {
      return [{
        id: sensor.id,
        text: t("forecast.note.ready", {
          sensor: sensor.name,
          skill: percent.format(evaluation.skill6h),
          coverage: evaluation.coverage90 === null ? t("forecast.note.coverageUnknown") : percent.format(evaluation.coverage90),
        }),
      }];
    }
    return [{
      id: sensor.id,
      text: t(evaluation.status === "no-skill" ? "forecast.note.noSkill" : "forecast.note.insufficient", { sensor: sensor.name }),
    }];
  });
  if (!notes.length) return null;
  return <ul className="analytics-forecast-notes" aria-label={t("forecast.note.label")}>
    {notes.map((note) => <li key={note.id}>{note.text}</li>)}
  </ul>;
}
