import { Check, ChevronDown, Eye, LoaderCircle } from "lucide-react";
import { useEffect, useId, useState, type FormEvent } from "react";
import type {
  House,
  ManualObservation,
  ManualObservationInput,
  ManualObservationPatch,
  ObservationConfidence,
  ObservationSource,
  ObservationTimePrecision,
} from "@climate-twin/contracts";
import { useI18n, type TranslationKey } from "../i18n";
import { localObservationDate, localObservationDateTime, observationTimeFields } from "../observationTime";
import { ApiRequestError } from "../api";

const kinds: ManualObservation["kind"][] = ["note", "leak", "condensation", "mould", "ventilation", "maintenance"];
const precisions: ObservationTimePrecision[] = ["exact", "approximate", "date-only", "date-range", "unknown"];
const sources: ObservationSource[] = ["owner", "caretaker", "contractor", "sensor", "imported-document", "automated-analysis", "unknown"];
const confidences: ObservationConfidence[] = ["confirmed", "probable", "uncertain", "awaiting-inspection"];

interface ObservationComposerProps {
  house: House;
  floorId: string;
  observation?: ManualObservation;
  compact?: boolean;
  collapsible?: boolean;
  onCreate?: (input: ManualObservationInput) => Promise<ManualObservation>;
  onUpdate?: (id: string, patch: ManualObservationPatch) => Promise<ManualObservation>;
  onReload?: (id: string) => Promise<ManualObservation>;
  onSaved?: (observation: ManualObservation) => void;
  onCancel?: () => void;
  onViewActivity?: () => void;
}

function initialLocalDateTime(observation: ManualObservation | undefined, house: House): string {
  if (observation?.occurredAt && (observation.timePrecision === undefined || observation.timePrecision === "exact" || observation.timePrecision === "approximate")) {
    const parsed = new Date(observation.occurredAt);
    if (Number.isFinite(parsed.getTime())) return localObservationDateTime(parsed, house.timezone);
  }
  return localObservationDateTime(new Date(), house.timezone);
}

export function ObservationComposer({ house, floorId, observation, compact = false, collapsible = false, onCreate, onUpdate, onReload, onSaved, onCancel, onViewActivity }: Readonly<ObservationComposerProps>) {
  const { t } = useI18n();
  const id = useId();
  const editing = Boolean(observation);
  const [kind, setKind] = useState<ManualObservation["kind"]>(observation?.kind ?? "note");
  const [severity, setSeverity] = useState<ManualObservation["severity"]>(observation?.severity ?? "info");
  const [note, setNote] = useState(observation?.note ?? "");
  const [selectedFloorId, setSelectedFloorId] = useState(observation?.floorId ?? floorId);
  const [precision, setPrecision] = useState<ObservationTimePrecision>(observation?.timePrecision ?? "exact");
  const [dateTime, setDateTime] = useState(() => initialLocalDateTime(observation, house));
  const [date, setDate] = useState(observation?.timePrecision === "date-only" ? observation.occurredAt : localObservationDate(new Date(), house.timezone));
  const [validFrom, setValidFrom] = useState(observation?.validFrom ?? localObservationDate(new Date(), house.timezone));
  const [validTo, setValidTo] = useState(observation?.validTo ?? localObservationDate(new Date(), house.timezone));
  const [source, setSource] = useState<ObservationSource>(observation?.source ?? "unknown");
  const [sourceDetail, setSourceDetail] = useState(observation?.sourceDetail ?? "");
  const [confidence, setConfidence] = useState<ObservationConfidence>(observation?.confidence ?? "uncertain");
  const [pending, setPending] = useState(false);
  const [feedback, setFeedback] = useState<"saved" | "error" | "conflict" | "reload-error" | "invalid-time" | null>(null);
  const [disclosureOpen, setDisclosureOpen] = useState(false);

  useEffect(() => {
    setKind(observation?.kind ?? "note");
    setSeverity(observation?.severity ?? "info");
    setNote(observation?.note ?? "");
    setSelectedFloorId(observation?.floorId ?? floorId);
    setPrecision(observation?.timePrecision ?? "exact");
    setDateTime(initialLocalDateTime(observation, house));
    setDate(observation?.timePrecision === "date-only" ? observation.occurredAt : localObservationDate(new Date(), house.timezone));
    setValidFrom(observation?.validFrom ?? localObservationDate(new Date(), house.timezone));
    setValidTo(observation?.validTo ?? localObservationDate(new Date(), house.timezone));
    setSource(observation?.source ?? "unknown");
    setSourceDetail(observation?.sourceDetail ?? "");
    setConfidence(observation?.confidence ?? "uncertain");
    setFeedback(null);
  }, [floorId, house.id, house.timezone, observation?.id, observation?.revision]);

  const submit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const trimmedNote = note.trim();
    if (!trimmedNote || pending) return;
    const time = observationTimeFields(precision, dateTime, date, validFrom, validTo, house.timezone);
    if (!time) {
      setFeedback("invalid-time");
      return;
    }
    setPending(true);
    setFeedback(null);
    try {
      let saved: ManualObservation;
      if (observation && onUpdate) {
        saved = await onUpdate(observation.id, {
          baseRevision: observation.revision ?? 1,
          floorId: selectedFloorId,
          kind,
          severity,
          note: trimmedNote,
          ...time,
          source,
          sourceDetail: sourceDetail.trim() || null,
          confidence,
        });
      } else if (onCreate) {
        saved = await onCreate({
          houseId: house.id,
          floorId: selectedFloorId,
          sensorId: null,
          kind,
          severity,
          note: trimmedNote,
          x: null,
          y: null,
          source,
          sourceDetail: sourceDetail.trim() || null,
          confidence,
          ...time,
        });
        setNote("");
        setKind("note");
        setSeverity("info");
        const now = new Date();
        setDateTime(localObservationDateTime(now, house.timezone));
        setDate(localObservationDate(now, house.timezone));
      } else {
        return;
      }
      setFeedback("saved");
      onSaved?.(saved);
    } catch (error) {
      setFeedback(error instanceof ApiRequestError && error.status === 409 ? "conflict" : "error");
    } finally {
      setPending(false);
    }
  };

  const reload = async () => {
    if (!observation || !onReload || pending) return;
    setPending(true);
    try {
      await onReload(observation.id);
      setFeedback(null);
    } catch {
      setFeedback("reload-error");
    } finally {
      setPending(false);
    }
  };

  const form = <form onSubmit={(event) => void submit(event)} noValidate>
        <label className="field observation-note-field"><span>{t("observations.quickNote")}</span><textarea autoFocus={editing} required rows={compact ? 2 : 3} value={note} disabled={pending} onChange={(event) => { setNote(event.target.value); setFeedback(null); }} placeholder={t("observations.notePlaceholder")} /></label>
        <div className="observation-quick-fields">
          <label className="field"><span>{t("observations.quickKind")}</span><select value={kind} disabled={pending} onChange={(event) => setKind(event.target.value as ManualObservation["kind"])}>{kinds.map((item) => <option key={item} value={item}>{t(`observations.${item === "note" ? "noteKind" : item}` as TranslationKey)}</option>)}</select></label>
          <label className="field"><span>{t("observations.quickFloor")}</span><select value={selectedFloorId} disabled={pending} onChange={(event) => setSelectedFloorId(event.target.value)}>{house.floors.map((item) => <option key={item.id} value={item.id}>{item.name}</option>)}</select></label>
        </div>
        <details className="observation-more-details" open={editing || undefined}>
          <summary><span>{t("observations.moreDetails")}</span><ChevronDown size={15} aria-hidden="true" /></summary>
          <div className="observation-more-grid">
            <label className="field"><span>{t("observations.quickSeverity")}</span><select value={severity} disabled={pending} onChange={(event) => setSeverity(event.target.value as ManualObservation["severity"])}><option value="info">{t("alerts.info")}</option><option value="warning">{t("alerts.warning")}</option><option value="critical">{t("alerts.critical")}</option></select></label>
            <label className="field"><span>{t("observations.quickTimePrecision")}</span><select value={precision} disabled={pending} onChange={(event) => { setPrecision(event.target.value as ObservationTimePrecision); setFeedback(null); }}>{precisions.map((item) => <option key={item} value={item}>{t(`observations.precision.${item}` as TranslationKey)}</option>)}</select></label>
            {(precision === "exact" || precision === "approximate") && <label className="field observation-wide-field"><span>{t("observations.quickObservedAt")}</span><input type="datetime-local" required value={dateTime} disabled={pending} onChange={(event) => setDateTime(event.target.value)} /><small>{t("observations.localTimeHelp")}</small></label>}
            {precision === "date-only" && <label className="field observation-wide-field"><span>{t("observations.quickObservedDate")}</span><input type="date" required value={date} disabled={pending} onChange={(event) => setDate(event.target.value)} /></label>}
            {precision === "date-range" && <><label className="field"><span>{t("observations.quickValidFrom")}</span><input type="date" required max={validTo} value={validFrom} disabled={pending} onChange={(event) => setValidFrom(event.target.value)} /></label><label className="field"><span>{t("observations.quickValidTo")}</span><input type="date" required min={validFrom} value={validTo} disabled={pending} onChange={(event) => setValidTo(event.target.value)} /></label></>}
            {precision === "unknown" && <p className="field-help observation-wide-field">{t("observations.unknownTimeHelp")}</p>}
            <label className="field"><span>{t("observations.quickSource")}</span><select value={source} disabled={pending} onChange={(event) => setSource(event.target.value as ObservationSource)}>{sources.map((item) => <option key={item} value={item}>{t(`observations.source.${item}` as TranslationKey)}</option>)}</select></label>
            <label className="field"><span>{t("observations.quickConfidence")}</span><select value={confidence} disabled={pending} onChange={(event) => setConfidence(event.target.value as ObservationConfidence)}>{confidences.map((item) => <option key={item} value={item}>{t(`observations.confidence.${item}` as TranslationKey)}</option>)}</select></label>
            <label className="field observation-wide-field"><span>{t("observations.quickSourceDetail")}</span><input value={sourceDetail} disabled={pending} onChange={(event) => setSourceDetail(event.target.value)} placeholder={t("observations.sourceDetailPlaceholder")} /></label>
          </div>
        </details>
        <div className="observation-composer-actions">
          {onCancel && <button type="button" className="secondary-button" disabled={pending} onClick={onCancel}>{t("common.cancel")}</button>}
          <button type="submit" className="primary-button" disabled={pending || !note.trim()}>{pending ? <LoaderCircle className="spin" size={15} aria-hidden="true" /> : <Check size={15} aria-hidden="true" />}{t(pending ? "observations.saving" : editing ? "activity.saveObservation" : "observations.quickSave")}</button>
        </div>
        {feedback === "invalid-time" && <p className="inline-error" role="alert">{t("observations.invalidTime")}</p>}
        {feedback === "error" && <p className="inline-error" role="alert">{t(editing ? "activity.editObservationFailed" : "observations.saveFailed")}</p>}
        {(feedback === "conflict" || feedback === "reload-error") && <div className="maintenance-conflict"><p className="inline-error" role="alert">{t(feedback === "conflict" ? "observations.conflict" : "observations.reloadFailed")}</p>{observation && onReload && <button type="button" className="text-button" disabled={pending} onClick={() => void reload()}>{t(pending ? "observations.reloading" : "observations.reload")}</button>}</div>}
        {feedback === "saved" && <div className="observation-composer-success" role="status" aria-live="polite"><span><Check size={15} aria-hidden="true" />{t(editing ? "activity.observationUpdated" : "observations.logged")}</span>{onViewActivity && !editing && <button type="button" className="text-button" onClick={onViewActivity}>{t("activity.viewAll")}</button>}</div>}
      </form>;

  if (collapsible && !editing) {
    return <details className={`panel observation-composer ${compact ? "compact" : ""} collapsible creating`} open={disclosureOpen}>
      <summary className="observation-composer-summary" onClick={(event) => { event.preventDefault(); setDisclosureOpen((value) => !value); }}>
        <span className="observation-composer-icon" aria-hidden="true"><Eye size={18} /></span>
        <span className="observation-composer-summary-copy"><span className="eyebrow">{t("observations.quickEyebrow")}</span><strong>{t("observations.add")}</strong><small>{t("observations.quickDescription")}</small></span>
        <ChevronDown className="disclosure-chevron" size={18} aria-hidden="true" />
      </summary>
      {disclosureOpen && <div className="observation-composer-content">{form}</div>}
    </details>;
  }

  return (
    <section className={`panel observation-composer ${compact ? "compact" : ""} ${editing ? "editing" : "creating"}`} aria-labelledby={`${id}-title`}>
      <div className="observation-composer-heading">
        <span className="observation-composer-icon" aria-hidden="true"><Eye size={18} /></span>
        <div><span className="eyebrow">{t(editing ? "activity.editObservationEyebrow" : "observations.quickEyebrow")}</span><h2 id={`${id}-title`}>{t(editing ? "activity.editObservation" : "observations.quickTitle")}</h2><p>{t(editing ? "activity.editObservationDescription" : "observations.quickDescription")}</p></div>
      </div>
      {form}
    </section>
  );
}
