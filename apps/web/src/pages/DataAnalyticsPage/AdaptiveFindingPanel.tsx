import { useEffect, useRef, useState } from "react";
import { useMutation, useQuery } from "@tanstack/react-query";
import {
  ADAPTIVE_REVIEW_DISPOSITIONS, ADAPTIVE_REVIEW_NOTE_LIMIT, isOneOf,
  type AdaptiveFindingDetail, type AdaptiveFindingReviewWrite, type AdaptiveReviewDisposition, type AdaptiveSettingsScope,
  type AdaptiveShadowFinding, type MeasurementDefinition, type UnitSystem,
} from "@climate-twin/contracts";
import { adaptiveMonitoringApi } from "../../api/adaptive-monitoring";
import { apiErrorStatus } from "../../api/support/request-error";
import { createClientUuid } from "../../clientUuid";
import { queryClient } from "../../data/queryClient";
import { useI18n } from "../../i18n";
import { definitionFor, formatMeasurement, formatMeasurementDelta } from "../../measurements";
import { AdaptiveRequestError, useAdaptiveFormat } from "./adaptivePresentation";

interface Props {
  scope: AdaptiveSettingsScope;
  revision: number;
  findingId: string;
  findingTitle: (finding: AdaptiveShadowFinding) => string;
  timeZone: string;
  sensorName: (id: string) => string;
  definitions: readonly MeasurementDefinition[];
  units: UnitSystem;
}

export function AdaptiveFindingPanel(props: Readonly<Props>) {
  const { t } = useI18n();
  const { scope, findingId, revision } = props;
  const key = ["adaptive-finding", revision, scope.houseId, scope.dataMode, findingId];
  const detail = useQuery({
    queryKey: key, retry: false, queryFn: ({ signal }) => adaptiveMonitoringApi.finding(scope, findingId, { signal }),
  }, queryClient);
  if (detail.isPending) return <p role="status">{t("common.loading")}</p>;
  if (detail.isError) return <AdaptiveRequestError error={detail.error} onRetry={() => void detail.refetch()} />;
  return <>
    <h3>{props.findingTitle(detail.data.finding)}</h3>
    {!detail.data.finding.epochCurrent && <p>{t("adaptive.previousBaseline")}</p>}
    <AdaptiveReviewForm detail={detail.data} timeZone={props.timeZone}
      onSave={async (input) => {
        const review = await adaptiveMonitoringApi.review(scope, findingId, input);
        await queryClient.cancelQueries({ queryKey: key, exact: true });
        queryClient.setQueryData<AdaptiveFindingDetail>(key, (current) => current && { ...current, latestReview: review });
      }}
      onRefresh={() => void detail.refetch()} />
    <AdaptiveFindingEvidence key={detail.data.finding.revision} {...props} detail={detail.data} />
  </>;
}

function AdaptiveFindingEvidence({ detail, scope, revision, findingId, definitions, units, timeZone, sensorName }: Readonly<Props & {
  detail: AdaptiveFindingDetail;
}>) {
  const { t } = useI18n();
  const { date, number, percent } = useAdaptiveFormat(timeZone);
  const [evidenceCursor, setEvidenceCursor] = useState<string>();
  const [revisionCursor, setRevisionCursor] = useState<number>();
  const page = useQuery({
    queryKey: ["adaptive-finding-page", revision, scope.houseId, scope.dataMode, findingId, detail.finding.revision, evidenceCursor, revisionCursor],
    enabled: Boolean(evidenceCursor || revisionCursor), retry: false,
    queryFn: ({ signal }) => adaptiveMonitoringApi.finding(scope, findingId, {
      signal, ...(evidenceCursor ? { beforeEvidenceAt: evidenceCursor } : {}), ...(revisionCursor ? { beforeRevision: revisionCursor } : {}),
    }),
  }, queryClient);
  const evidence = evidenceCursor ? page.data?.evidence : detail.evidence;
  const revisions = revisionCursor ? page.data?.revisions : detail.revisions;
  const definition = definitionFor(definitions, detail.finding.metric);
  const format = detail.evidence.quantity === "temperature-offset" ? formatMeasurementDelta : formatMeasurement;
  const value = (reading: number | null) => reading === null ? t("adaptive.missing") : format(reading, definition, units);
  return <>
    <details className="adaptive-section" open>
      <summary>{t("adaptive.evidence")}</summary>
      {detail.evidence.quantity === "temperature-offset" && <p>{t("adaptive.offset")}</p>}
      {detail.evidence.referenceSensorIds.length > 0 && <p>{t("adaptive.references", { sensors: detail.evidence.referenceSensorIds.map(sensorName).join(", ") })}</p>}
      {evidence?.items.length === 0 && <p>{t("adaptive.noEvidence")}</p>}
      <ul className="adaptive-items">
        {evidence?.items.map((hour) => <li key={hour.hour}>
          <strong>{date(hour.hour)}</strong>
          <dl className="adaptive-values">
            <div><dt>{t("adaptive.observed")}</dt><dd>{value(hour.observed)}</dd></div>
            <div><dt>{t("adaptive.expected")}</dt><dd>{value(hour.expected)}</dd></div>
            <div><dt>{t("adaptive.range")}</dt><dd>{hour.range ? `${value(hour.range.lower)} – ${value(hour.range.upper)}` : t("adaptive.missing")}</dd></div>
            <div><dt>{t("adaptive.coverageLabel")}</dt><dd>{hour.coverage === null ? t("adaptive.missing") : percent(hour.coverage)}</dd></div>
          </dl>
          <details>
            <summary>{t("adaptive.evidenceDetails")}</summary>
            <p>{t("adaptive.recorded", { date: date(hour.recordedAt) })}</p>
            <p>{t("adaptive.available", { date: hour.availableAt ? date(hour.availableAt) : t("adaptive.missing") })}</p>
            <p>{t("adaptive.evidenceReason", { reason: hour.reason })}</p>
            {hour.contextGuard && <p>{t(`adaptive.guard.${hour.contextGuard.reason}`, { date: date(hour.contextGuard.until) })}</p>}
            {hour.model && <p>{t("adaptive.model", { version: hour.model.version, date: date(hour.model.evaluatedThrough) })}</p>}
          </details>
        </li>)}
      </ul>
      <div className="adaptive-actions">
        {evidenceCursor && <button type="button" className="secondary-button" onClick={() => setEvidenceCursor(undefined)}>{t("adaptive.latestEvidence")}</button>}
        {evidence?.nextBefore && <button type="button" className="secondary-button"
          onClick={() => setEvidenceCursor(evidence.nextBefore ?? undefined)}>{t("adaptive.olderEvidence")}</button>}
      </div>
    </details>
    <details className="adaptive-section" open={revisionCursor ? true : undefined}>
      <summary>{t("adaptive.history")}</summary>
      <ul className="adaptive-items">
        {revisions?.items.map((item) => <li key={item.revision}>{t("adaptive.revision", {
          number: number(item.revision), state: t(`adaptive.finding.${item.state}`), date: date(item.recordedAt),
        })}</li>)}
      </ul>
      <div className="adaptive-actions">
        {revisionCursor && <button type="button" className="secondary-button" onClick={() => setRevisionCursor(undefined)}>{t("adaptive.latestRevisions")}</button>}
        {revisions?.nextBeforeRevision && <button type="button" className="secondary-button"
          onClick={() => setRevisionCursor(revisions.nextBeforeRevision ?? undefined)}>{t("adaptive.olderRevisions")}</button>}
      </div>
    </details>
    {(evidenceCursor || revisionCursor) && page.isPending && <p role="status">{t("common.loading")}</p>}
    {page.isError && <AdaptiveRequestError error={page.error} onRetry={() => void page.refetch()} />}
  </>;
}

function AdaptiveReviewForm({ detail, timeZone, onSave, onRefresh }: Readonly<{
  detail: AdaptiveFindingDetail;
  timeZone: string;
  onSave: (input: AdaptiveFindingReviewWrite) => Promise<void>;
  onRefresh: () => void;
}>) {
  const { t } = useI18n();
  const { date } = useAdaptiveFormat(timeZone);
  const [editing, setEditing] = useState(false);
  const [disposition, setDisposition] = useState<AdaptiveReviewDisposition | "">("");
  const [note, setNote] = useState("");
  const [reportedRecovery, setReportedRecovery] = useState(false);
  const [baseRevision, setBaseRevision] = useState(detail.finding.revision);
  const [saved, setSaved] = useState(false);
  const [refreshRequired, setRefreshRequired] = useState(false);
  const action = useRef<HTMLButtonElement>(null);
  const field = useRef<HTMLSelectElement>(null);
  const attempt = useRef({ body: "", key: "" });
  const mutation = useMutation({ mutationFn: onSave }, queryClient);
  const latest = detail.latestReview;
  useEffect(() => {
    if (editing) field.current?.focus();
  }, [editing]);
  function openEditor() {
    mutation.reset();
    setSaved(false);
    setRefreshRequired(false);
    setBaseRevision(detail.finding.revision);
    setDisposition(latest?.disposition ?? "");
    setNote(latest?.note ?? "");
    setReportedRecovery(latest?.reportedRecovery ?? false);
    setEditing(true);
  }
  function closeEditor() {
    setEditing(false);
    action.current?.focus();
  }
  function save() {
    if (!disposition || mutation.isPending || refreshRequired) return;
    const payload = { baseRevision, disposition, ...(note.trim() ? { note: note.trim() } : {}), reportedRecovery };
    const body = JSON.stringify(payload);
    if (attempt.current.body !== body) attempt.current = { body, key: createClientUuid() };
    mutation.mutate({ ...payload, idempotencyKey: attempt.current.key }, {
      onSuccess: () => {
        attempt.current = { body: "", key: "" };
        setSaved(true);
        closeEditor();
      },
      onError: (error) => { if (apiErrorStatus(error) === 409) setRefreshRequired(true); },
    });
  }
  return <section className="adaptive-section">
    <h4>{t("adaptive.review")}</h4>
    {latest && <div>
      <p>{t("adaptive.reviewRecorded", { disposition: t(`adaptive.disposition.${latest.disposition}`), date: date(latest.recordedAt) })}</p>
      {latest.note && <p className="adaptive-note">{latest.note}</p>}
      {latest.reportedRecovery && <p>{t("adaptive.reportedRecovery")}</p>}
    </div>}
    <button ref={action} type="button" className="secondary-button" aria-expanded={editing}
      onClick={editing ? closeEditor : openEditor}>{t(latest ? "adaptive.reviseReview" : "adaptive.addReview")}</button>
    {saved && <p role="status">{t("common.saved")}</p>}
    {editing && <form className="adaptive-form" onSubmit={(event) => { event.preventDefault(); save(); }}>
      <label>{t("adaptive.disposition")}
        <select ref={field} required
          value={disposition} onChange={(event) => setDisposition(isOneOf(event.target.value, ADAPTIVE_REVIEW_DISPOSITIONS) ? event.target.value : "")}>
          <option value="">{t("adaptive.chooseDisposition")}</option>
          {ADAPTIVE_REVIEW_DISPOSITIONS.map((option) => <option key={option} value={option}>{t(`adaptive.disposition.${option}`)}</option>)}
        </select>
      </label>
      <label>{t("adaptive.note")}<textarea maxLength={ADAPTIVE_REVIEW_NOTE_LIMIT} value={note} onChange={(event) => setNote(event.target.value)} /></label>
      <label className="adaptive-checkbox"><input type="checkbox" checked={reportedRecovery}
        onChange={(event) => setReportedRecovery(event.target.checked)} />{t("adaptive.reportedRecovery")}</label>
      <div className="adaptive-actions">
        <button type="submit" className="primary-button" disabled={mutation.isPending || refreshRequired}>{t("common.save")}</button>
        <button type="button" className="secondary-button" disabled={mutation.isPending} onClick={closeEditor}>{t("common.cancel")}</button>
      </div>
      {mutation.isError && <AdaptiveRequestError error={mutation.error} onRetry={() => {
        if (!refreshRequired) { save(); return; }
        onRefresh();
        closeEditor();
      }} />}
    </form>}
  </section>;
}
