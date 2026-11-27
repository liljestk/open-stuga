import { useEffect, useRef, useState, useSyncExternalStore } from "react";
import { useMutation, useQuery } from "@tanstack/react-query";
import type {
  AdaptiveSettingsChange, AdaptiveSettingsScope, AdaptiveShadowFinding, MeasurementDefinition, Sensor, UnitSystem,
} from "@climate-twin/contracts";
import { adaptiveMonitoringApi } from "../../api/adaptive-monitoring";
import { apiErrorStatus } from "../../api/support/request-error";
import { queryClient } from "../../data/queryClient";
import { useAuthorizationRevision } from "../../data/useAuthorizationRevision";
import { useI18n } from "../../i18n";
import { definitionFor, measurementLabel } from "../../measurements";
import { adaptiveFindingFromLocation, subscribeToAdaptiveFinding, writeAdaptiveFinding } from "./adaptiveLocation";
import { AdaptiveFindingPanel } from "./AdaptiveFindingPanel";
import { AdaptiveLearningSettings } from "./AdaptiveLearningSettings";
import { AdaptiveRequestError, useAdaptiveFormat } from "./adaptivePresentation";
import "./AdaptiveHomePanel.css";

interface Props {
  scope: AdaptiveSettingsScope;
  timeZone: string;
  sensors: readonly Sensor[];
  temperatureSensors: readonly Sensor[];
  definitions: readonly MeasurementDefinition[];
  units: UnitSystem;
}

export function AdaptiveHomePanel(props: Readonly<Props>) {
  const revision = useAuthorizationRevision();
  return <ScopedAdaptiveHome key={JSON.stringify([revision, props.scope.houseId, props.scope.dataMode])} {...props} revision={revision} />;
}

function ScopedAdaptiveHome({ scope, sensors, temperatureSensors, definitions, timeZone, units, revision }: Readonly<Props & { revision: number }>) {
  const { t, locale } = useI18n();
  const { date, number, percent } = useAdaptiveFormat(timeZone);
  const selected = useSyncExternalStore(subscribeToAdaptiveFinding, () => adaptiveFindingFromLocation(scope));
  const [findingCursors, setFindingCursors] = useState<string[]>([]);
  const [streamCursors, setStreamCursors] = useState<string[]>([]);
  const [streamsOpen, setStreamsOpen] = useState(false);
  const listHeading = useRef<HTMLHeadingElement>(null);
  const back = useRef<HTMLButtonElement>(null);
  const previousSelection = useRef(selected);
  const selectedButton = useRef<HTMLButtonElement | null>(null);
  const snapshotKey = ["adaptive-home", revision, scope.houseId, scope.dataMode];
  const findingCursor = findingCursors.at(-1);
  const streamCursor = streamCursors.at(-1);
  const query = useQuery({
    queryKey: [...snapshotKey, findingCursor, streamCursor], retry: false,
    queryFn: ({ signal }) => adaptiveMonitoringApi.snapshot(scope, {
      signal, ...(findingCursor ? { findingCursor } : {}), ...(streamCursor ? { streamCursor } : {}),
    }),
  }, queryClient);
  function refresh() {
    setFindingCursors([]);
    setStreamCursors([]);
    void queryClient.invalidateQueries({ queryKey: snapshotKey });
  }
  const change = useMutation({
    mutationFn: (input: AdaptiveSettingsChange) => adaptiveMonitoringApi.changeSettings(scope.houseId, input),
    onSuccess: refresh,
  }, queryClient);
  useEffect(() => {
    if (selected === previousSelection.current) return;
    previousSelection.current = selected;
    if (selected) back.current?.focus();
    else if (selectedButton.current?.isConnected) selectedButton.current.focus();
    else listHeading.current?.focus();
  }, [selected]);
  const sensorName = (id: string) => sensors.find((sensor) => sensor.id === id)?.name ?? id;
  const metricName = (id: string) => measurementLabel(definitionFor(definitions, id), locale);
  const findingTitle = (finding: AdaptiveShadowFinding) => t(`adaptive.direction.${finding.direction}`, {
    sensor: sensorName(finding.sensorId), metric: metricName(finding.metric),
  });
  const snapshot = query.data;
  const blocked = [401, 403, 404].includes(apiErrorStatus(query.error) ?? 0);
  return <div className="analytics-primary-tool-content adaptive-home">
    {query.isPending && <p role="status">{t("common.loading")}</p>}
    {query.isError && <AdaptiveRequestError error={query.error} onRetry={refresh} />}
    {snapshot && !blocked && <>
      <div className="adaptive-heading">
        <div>
          <h3>{t(`adaptive.status.${snapshot.state}`)}</h3>
          <p>{t("adaptive.readiness", { ready: number(snapshot.counts.ready), total: number(snapshot.counts.total) })}</p>
          {snapshot.evaluatedThrough && <p>{t("adaptive.evaluatedThrough", { date: date(snapshot.evaluatedThrough) })}</p>}
          {snapshot.completeness !== "complete" && <p>{t(`adaptive.completeness.${snapshot.completeness}`)}</p>}
        </div>
        <button type="button" className="secondary-button" onClick={refresh} disabled={query.isFetching}>{t("adaptive.refresh")}</button>
      </div>
      <AdaptiveLearningSettings settings={snapshot.settings} sensors={temperatureSensors} timeZone={timeZone}
        sensorName={sensorName} pending={change.isPending} stale={query.isFetching || apiErrorStatus(change.error) === 409}
        onChange={change.mutate} />
      {change.isError && <AdaptiveRequestError error={change.error} onRetry={() => { change.reset(); refresh(); }} />}
      {change.isSuccess && <p role="status">{t("common.saved")}</p>}
      <details className="adaptive-section" open={streamsOpen} onToggle={(event) => setStreamsOpen(event.currentTarget.open)}>
        <summary>{t("adaptive.streams")}</summary>
        {snapshot.streams.items.length === 0 && <p>{t("adaptive.noStreams")}</p>}
        <ul className="adaptive-items">
          {snapshot.streams.items.map((stream) => <li key={JSON.stringify([stream.sensorId, stream.metric, stream.purpose])}>
            <strong>{sensorName(stream.sensorId)} · {metricName(stream.metric)} · {t(`adaptive.kind.${stream.purpose}`)}</strong>
            <p>{t(`adaptive.status.${stream.state}`)} · {t(`adaptive.reason.${stream.reason}`)}</p>
            {stream.coverage !== null && <p>{t("adaptive.coverage", { percent: percent(stream.coverage) })}</p>}
          </li>)}
        </ul>
        <PageButtons previous={streamCursors.length > 0} next={snapshot.streams.nextCursor}
          onPrevious={() => setStreamCursors(streamCursors.slice(0, -1))} onNext={(cursor) => setStreamCursors([...streamCursors, cursor])} />
      </details>
      <section className="adaptive-section" hidden={selected !== null}>
        <h3 tabIndex={-1} ref={listHeading}>{t("adaptive.findings")}</h3>
        {snapshot.findings.items.length === 0 && <p>{t("adaptive.noFindings")}</p>}
        <ul className="adaptive-items">
          {snapshot.findings.items.map((finding) => <li key={finding.id}>
            <strong>{findingTitle(finding)}</strong>
            <p>{t(`adaptive.finding.${finding.state}`)} · {date(finding.evidenceAt)}</p>
            <button type="button" className="secondary-button" aria-expanded={selected === finding.id}
              onClick={(event) => { selectedButton.current = event.currentTarget; writeAdaptiveFinding(scope, finding.id); }}>{t("adaptive.reviewChange")}</button>
          </li>)}
        </ul>
        <PageButtons previous={findingCursors.length > 0} next={snapshot.findings.nextCursor}
          onPrevious={() => setFindingCursors(findingCursors.slice(0, -1))} onNext={(cursor) => setFindingCursors([...findingCursors, cursor])} />
      </section>
    </>}
    {selected && !blocked && <section className="adaptive-section" aria-label={t("adaptive.reviewChange")}>
      <button ref={back} type="button" className="secondary-button" onClick={() => writeAdaptiveFinding(scope, null)}>{t("adaptive.backToFindings")}</button>
      <AdaptiveFindingPanel key={selected} scope={scope} revision={revision} findingId={selected}
        findingTitle={findingTitle} timeZone={timeZone} sensorName={sensorName} definitions={definitions} units={units} />
    </section>}
  </div>;
}

function PageButtons({ previous, next, onPrevious, onNext }: Readonly<{
  previous: boolean; next: string | null; onPrevious: () => void; onNext: (cursor: string) => void;
}>) {
  const { t } = useI18n();
  return (previous || next) && <div className="adaptive-actions">
    {previous && <button type="button" className="secondary-button" onClick={onPrevious}>{t("adaptive.previousPage")}</button>}
    {next && <button type="button" className="secondary-button" onClick={() => onNext(next)}>{t("adaptive.nextPage")}</button>}
  </div>;
}
