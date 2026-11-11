import { useRef, useState } from "react";
import { ADAPTIVE_REVIEW_DISPOSITIONS, type AdaptiveDisposition, type AdaptiveFinding, type AdaptiveReviewInput, type DataMode, type House, type MeasurementDefinition, type UnitSystem } from "@climate-twin/contracts";
import { useI18n } from "../i18n";
import { formatMeasurement, measurementLabel } from "../measurements";
import { formatInTimeZone } from "../dateTime";

export function AdaptiveFindingReview(props: Readonly<{
  finding: AdaptiveFinding; house: House; definition: MeasurementDefinition | undefined; units: UnitSystem;
  dataMode: DataMode; readOnly: boolean; busy: boolean; open: boolean; onOpen(open: boolean): void;
  onReview(body: AdaptiveReviewInput): Promise<unknown>;
}>) {
  const { t, locale } = useI18n();
  const f = props.finding;
  const [disposition, setDisposition] = useState<AdaptiveDisposition>(f.review?.disposition ?? "uncertain");
  const [note, setNote] = useState(f.review?.note ?? "");
  const [saved, setSaved] = useState(false);
  const retry = useRef<{ payload: string; key: string } | null>(null);
  const value = (n: number) => props.definition ? formatMeasurement(n, props.definition, props.units) : `${n.toFixed(1)} ${f.unit}`;
  const submit = async () => {
    const payload = JSON.stringify([f.revision, disposition, note]);
    if (retry.current?.payload !== payload) retry.current = { payload, key: crypto.randomUUID() };
    await props.onReview({ dataMode: props.dataMode, baseRevision: f.revision, disposition, note, idempotencyKey: retry.current.key });
    retry.current = null; setSaved(true);
  };
  return <details className="adaptive-finding" open={props.open} onToggle={e => {
    if (e.currentTarget.open !== props.open) props.onOpen(e.currentTarget.open);
  }}>
    <summary>
      <span><strong>{t(f.kind === "sensor-comparison" ? "adaptive.sensorChange" : "adaptive.climateChange", { room: f.room || f.sensorName })}</strong>
        <small>{props.definition ? measurementLabel(props.definition, locale) : f.metric} · {value(f.observed)}</small>
        <small>{t(`adaptive.finding.${f.state}`)}</small></span>
      <span>{t("adaptive.review")}</span>
    </summary>
    <div className="adaptive-finding-body">
      <p>{t(f.kind === "sensor-comparison" ? "adaptive.sensorExplanation" : "adaptive.climateExplanation")}</p>
      <dl className="adaptive-evidence">
        <div><dt>{t("adaptive.observed")}</dt><dd>{value(f.observed)}</dd></div>
        <div><dt>{t("adaptive.expected")}</dt><dd>{value(f.expected)}</dd></div>
        <div><dt>{t("adaptive.range")}</dt><dd>{t("adaptive.rangeValues", { low: value(f.low), high: value(f.high) })}</dd></div>
        <div><dt>{t("adaptive.coverage")}</dt><dd>{Math.round(f.coverage * 100)}%</dd></div>
      </dl>
      <p>{t("adaptive.evidenceAt", { time: formatInTimeZone(f.lastEvidenceAt, locale, props.house.timezone, { dateStyle: "medium", timeStyle: "short" }) })}</p>
      {f.freshness === "stale" && <p role="status">{t("adaptive.staleEvidence")}</p>}
      <p>{t("adaptive.checkAction")}</p>
      <details><summary>{t("adaptive.why")}</summary>
        <p>{t("adaptive.contextLimits")}</p>
        <p>{t("adaptive.model", { version: f.modelId.slice(0, 12) })}</p>
        <p>{t("adaptive.sources", { sensors: f.sourceIds.join(", ") })}</p>
      </details>
      {!props.readOnly && <form onSubmit={e => { e.preventDefault(); setSaved(false); void submit().catch(() => undefined); }}>
        <label className="field"><span>{t("adaptive.disposition")}</span>
          <select value={disposition} onChange={e => {
            const next = ADAPTIVE_REVIEW_DISPOSITIONS.find(d => d === e.target.value);
            if (next) setDisposition(next);
          }}>{ADAPTIVE_REVIEW_DISPOSITIONS.map(d => <option key={d} value={d}>{t(`adaptive.disposition.${d}`)}</option>)}</select>
        </label>
        <label className="field"><span>{t("adaptive.note")}</span><textarea maxLength={2000} value={note} onChange={e => setNote(e.target.value)} /></label>
        <button type="submit" className="secondary-button" disabled={props.busy}>{t(props.busy ? "adaptive.saving" : "adaptive.saveReview")}</button>
        {saved && <p role="status">{t("adaptive.reviewSaved")}</p>}
      </form>}
    </div>
  </details>;
}
