import { useCallback, useEffect, useMemo, useState } from "react";
import { Archive, CheckCircle2, Database, Download, RefreshCw, ShieldAlert, Stethoscope, TriangleAlert } from "lucide-react";
import type { BackupOperationStatus, DataExportPreview, DataExportPrivacyLevel, House, Sensor, SetupDoctorReport } from "@climate-twin/contracts";
import { api } from "../api";
import { useI18n } from "../i18n";
import "./SetupOperationsPanel.css";

type LoadState<T> = { value: T | null; loading: boolean; error: string | null };
type Feedback = { kind: "success" | "error"; text: string };

const initial = <T,>(): LoadState<T> => ({ value: null, loading: true, error: null });

export function SystemOperationsPanel() {
  const { locale, t } = useI18n();
  const [doctor, setDoctor] = useState<LoadState<SetupDoctorReport>>(initial);
  const [backup, setBackup] = useState<LoadState<BackupOperationStatus>>(initial);
  const [privacy, setPrivacy] = useState<DataExportPrivacyLevel>("operations");
  const [telemetry, setTelemetry] = useState(false);
  const [preview, setPreview] = useState<LoadState<DataExportPreview>>(initial);
  const [requestingBackup, setRequestingBackup] = useState(false);

  const refresh = useCallback(() => {
    setDoctor((current) => ({ ...current, loading: true, error: null }));
    setBackup((current) => ({ ...current, loading: true, error: null }));
    void api.setupDoctor().then((value) => setDoctor({ value, loading: false, error: null }))
      .catch((error: unknown) => setDoctor({ value: null, loading: false, error: message(error, t("setup.operations.operationFailed")) }));
    void api.backupStatus().then((value) => setBackup({ value, loading: false, error: null }))
      .catch((error: unknown) => setBackup({ value: null, loading: false, error: message(error, t("setup.operations.operationFailed")) }));
  }, [t]);

  useEffect(refresh, [refresh]);
  useEffect(() => {
    let active = true;
    setPreview((current) => ({ ...current, loading: true, error: null }));
    void api.dataExportPreview(privacy, telemetry).then((value) => {
      if (active) setPreview({ value, loading: false, error: null });
    }).catch((error: unknown) => {
      if (active) setPreview({ value: null, loading: false, error: message(error, t("setup.operations.operationFailed")) });
    });
    return () => { active = false; };
  }, [privacy, t, telemetry]);

  const requestBackup = async () => {
    setRequestingBackup(true);
    try {
      const value = await api.requestBackup();
      setBackup({ value, loading: false, error: null });
    } catch (error) {
      setBackup({ value: backup.value, loading: false, error: message(error, t("setup.operations.operationFailed")) });
    } finally {
      setRequestingBackup(false);
    }
  };

  return <div className="setup-operations-grid">
    <section className="panel setup-doctor-panel" aria-labelledby="setup-doctor-heading">
      <div className="panel-header">
        <div><span className="eyebrow"><Stethoscope size={14} aria-hidden="true" /> {t("setup.operations.doctorEyebrow")}</span><h2 id="setup-doctor-heading">{t("setup.operations.doctorTitle")}</h2></div>
        <button type="button" className="secondary-button" onClick={refresh} disabled={doctor.loading}><RefreshCw size={15} className={doctor.loading ? "spin" : ""} aria-hidden="true" /> {t("setup.operations.recheck")}</button>
      </div>
      {doctor.error && <p className="error-message" role="alert">{doctor.error}</p>}
      {doctor.value && <>
        <p className={`setup-doctor-summary ${doctor.value.overall}`}>
          <DoctorIcon status={doctor.value.overall} />
          <strong>{doctor.value.overall === "ready" ? t("setup.operations.ready") : doctor.value.overall === "blocked" ? t("setup.operations.blocked") : t("setup.operations.attention")}</strong>
          <span>{t("setup.operations.checksClear", { clear: doctor.value.checks.filter((check) => check.status === "pass" || check.status === "not-applicable").length, total: doctor.value.checks.length })}</span>
        </p>
        <ul className="setup-doctor-list">{doctor.value.checks.map((check) => <li key={check.id} className={check.status}><DoctorIcon status={check.status} /><span><strong>{check.title}</strong><small>{check.detail}</small>{check.action && <em>{check.action}</em>}</span></li>)}</ul>
      </>}
    </section>

    <section className="panel data-operations-panel" aria-labelledby="data-operations-heading">
      <div className="panel-header"><div><span className="eyebrow"><Database size={14} aria-hidden="true" /> {t("setup.operations.dataEyebrow")}</span><h2 id="data-operations-heading">{t("setup.operations.dataTitle")}</h2></div></div>
      <div className="data-operation-controls">
        <label className="field"><span>{t("setup.operations.privacyScope")}</span><select value={privacy} onChange={(event) => setPrivacy(event.target.value as DataExportPrivacyLevel)}><option value="structure">{t("setup.operations.privacyStructure")}</option><option value="operations">{t("setup.operations.privacyOperations")}</option><option value="full">{t("setup.operations.privacyFull")}</option></select></label>
        <label className="check-field"><input type="checkbox" checked={telemetry} onChange={(event) => setTelemetry(event.target.checked)} /><span>{t("setup.operations.includeTelemetry")}</span></label>
      </div>
      {preview.error && <p className="error-message" role="alert">{preview.error}</p>}
      {preview.value && <div className="export-preview">
        <strong>{t("setup.operations.telemetryRows", { count: new Intl.NumberFormat(locale).format(preview.value.estimatedTelemetryRows) })}</strong>
        <span>{t("setup.operations.controlRecords", { count: new Intl.NumberFormat(locale).format(Object.values(preview.value.counts).reduce((total, count) => total + count, 0)) })}</span>
        {preview.value.sensitiveCategories.length > 0 && <small>{t("setup.operations.sensitiveCategories", { categories: preview.value.sensitiveCategories.join(", ") })}</small>}
      </div>}
      <a className="primary-button" href={api.dataExportUrl(privacy, telemetry)} download><Download size={15} aria-hidden="true" /> {t("setup.operations.downloadExport")}</a>
      <hr />
      {backup.error && <p className="error-message" role="alert">{backup.error}</p>}
      {backup.value && <dl className="backup-status">
        <div><dt>{t("setup.operations.scheduler")}</dt><dd>{backup.value.schedulerHealthy ? t("setup.operations.healthy") : t("setup.operations.notReporting")}</dd></div>
        <div><dt>{t("setup.operations.latestBackup")}</dt><dd>{formatDate(backup.value.latestVerifiedBackupAt, locale, t("setup.operations.never"))}</dd></div>
        <div><dt>{t("setup.operations.latestRestore")}</dt><dd>{formatDate(backup.value.latestRestoreDrillAt, locale, t("setup.operations.never"))}</dd></div>
        <div><dt>{t("setup.operations.currentState")}</dt><dd>{backupState(backup.value.state, t)}</dd></div>
      </dl>}
      <button type="button" className="secondary-button" disabled={requestingBackup || backup.value?.state === "running" || backup.value?.state === "requested"} onClick={() => void requestBackup()}><Archive size={15} aria-hidden="true" />{requestingBackup ? t("setup.operations.requestingBackup") : t("setup.operations.runBackup")}</button>
    </section>

  </div>;
}

export function SetupOperationsPanel({ house }: Readonly<{ house: House }>) {
  return <div className="setup-operations-grid"><BulkMappingAssistant house={house} /></div>;
}

function BulkMappingAssistant({ house }: Readonly<{ house: House }>) {
  const { t } = useI18n();
  const [sensors, setSensors] = useState<Sensor[]>([]);
  const [drafts, setDrafts] = useState<Record<string, Record<string, string>>>({});
  const [feedback, setFeedback] = useState<Feedback | null>(null);
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    let active = true;
    setFeedback(null);
    void api.sensors(house.id).then((items) => {
      if (!active) return;
      setSensors(items);
      setDrafts(Object.fromEntries(items.map((sensor) => [sensor.id, {
        temperature: sensor.measurementEntityIds?.temperature ?? sensor.temperatureEntityId ?? "",
        humidity: sensor.measurementEntityIds?.humidity ?? sensor.humidityEntityId ?? "",
        battery: sensor.measurementEntityIds?.battery ?? sensor.batteryEntityId ?? "",
        power: sensor.measurementEntityIds?.power ?? "",
        energy: sensor.measurementEntityIds?.energy ?? "",
      }])));
    }).catch((error: unknown) => {
      if (active) setFeedback({ kind: "error", text: message(error, t("setup.operations.operationFailed")) });
    });
    return () => { active = false; };
  }, [house.id, t]);
  const metrics = useMemo(() => [
    { id: "temperature", label: t("common.temperature") },
    { id: "humidity", label: t("common.humidity") },
    { id: "battery", label: t("setup.operations.metricBattery") },
    { id: "power", label: t("setup.operations.metricPower") },
    { id: "energy", label: t("setup.operations.metricEnergy") },
  ] as const, [t]);
  const save = async () => {
    setBusy(true);
    setFeedback(null);
    try {
      const mappings = sensors.map((sensor) => ({ sensorId: sensor.id, measurementEntityIds: Object.fromEntries(Object.entries(drafts[sensor.id] ?? {}).filter(([, value]) => value.trim()).map(([metric, value]) => [metric, value.trim()])) }));
      const result = await api.bulkSensorMappings(house.id, mappings);
      setSensors(result.sensors);
      setFeedback({ kind: "success", text: t("setup.operations.savedMappings", { count: result.sensors.length }) });
    } catch (error) {
      setFeedback({ kind: "error", text: message(error, t("setup.operations.operationFailed")) });
    } finally {
      setBusy(false);
    }
  };
  return <section className="panel bulk-mapping-panel" aria-labelledby="bulk-mapping-heading">
    <div className="panel-header"><div><span className="eyebrow">{t("setup.operations.sharedSources")}</span><h2 id="bulk-mapping-heading">{t("setup.operations.bulkTitle", { house: house.name })}</h2></div></div>
    <p>{t("setup.operations.bulkDescription")}</p>
    {sensors.length ? <div className="bulk-mapping-scroll" tabIndex={0}><table><thead><tr><th>{t("setup.operations.sensorColumn")}</th>{metrics.map((metric) => <th key={metric.id}>{metric.label}</th>)}</tr></thead><tbody>{sensors.map((sensor) => <tr key={sensor.id}><th>{sensor.name}<small>{sensor.room}</small></th>{metrics.map((metric) => <td key={metric.id}><input aria-label={t("setup.operations.entityLabel", { sensor: sensor.name, metric: metric.label })} value={drafts[sensor.id]?.[metric.id] ?? ""} placeholder={`sensor.${metric.id}`} onChange={(event) => setDrafts((current) => ({ ...current, [sensor.id]: { ...current[sensor.id], [metric.id]: event.target.value } }))} /></td>)}</tr>)}</tbody></table></div> : <p>{t("setup.operations.noSensors")}</p>}
    {feedback && <p role={feedback.kind === "success" ? "status" : "alert"}>{feedback.text}</p>}
    <button type="button" className="primary-button" disabled={busy || !sensors.length} onClick={() => void save()}>{busy ? t("common.saving") : t("setup.operations.validateSave")}</button>
  </section>;
}

function DoctorIcon({ status }: Readonly<{ status: SetupDoctorReport["overall"] | SetupDoctorReport["checks"][number]["status"] }>) {
  if (status === "ready" || status === "pass" || status === "not-applicable") return <CheckCircle2 size={18} aria-hidden="true" />;
  if (status === "blocked" || status === "fail") return <ShieldAlert size={18} aria-hidden="true" />;
  return <TriangleAlert size={18} aria-hidden="true" />;
}

function backupState(state: BackupOperationStatus["state"], t: ReturnType<typeof useI18n>["t"]): string {
  if (state === "idle") return t("setup.operations.backupIdle");
  if (state === "requested") return t("setup.operations.backupRequested");
  if (state === "running") return t("setup.operations.backupRunning");
  if (state === "complete") return t("setup.operations.backupComplete");
  return t("setup.operations.backupFailed");
}

function formatDate(value: string | null, locale: string, never: string): string {
  return value ? new Intl.DateTimeFormat(locale, { dateStyle: "medium", timeStyle: "short" }).format(new Date(value)) : never;
}

function message(error: unknown, fallback: string): string {
  return error instanceof Error && error.message.trim() ? error.message : fallback;
}
