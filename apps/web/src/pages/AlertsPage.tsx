import { useEffect, useState, type FormEvent } from "react";
import { AlertCircle, Bell, BellRing, Check, Clock3, LoaderCircle, Plus, ShieldCheck } from "lucide-react";
import type { AlertOperator, AlertRule, AlertSeverity, MeasurementDefinition, Metric, Sensor, UnitSystem } from "@climate-twin/contracts";
import { type ClimateState } from "../domain";
import { useI18n } from "../i18n";
import { defaultAlertThreshold, definitionFor, displayUnit, enabledDefinitions, formatMeasurement, fromDisplayValue, measurementLabel, toDisplayValue } from "../measurements";
import { formatInTimeZone } from "../dateTime";

interface AlertsPageProps {
  state: ClimateState;
  units: UnitSystem;
  onCreateRule: (rule: Omit<AlertRule, "id">) => Promise<void>;
  onAcknowledge: (id: string) => Promise<void>;
}

export function AlertsPage({ state, units, onCreateRule, onAcknowledge }: AlertsPageProps) {
  const { locale, t } = useI18n();
  const [showForm, setShowForm] = useState(false);
  const [name, setName] = useState("");
  const [sensorId, setSensorId] = useState("");
  const [metric, setMetric] = useState<Metric>("humidity");
  const [operator, setOperator] = useState<AlertOperator>("gte");
  const [threshold, setThreshold] = useState(65);
  const [duration, setDuration] = useState(15);
  const [severity, setSeverity] = useState<AlertSeverity>("warning");
  const [webhook, setWebhook] = useState(true);
  const [submitting, setSubmitting] = useState(false);
  const [submitError, setSubmitError] = useState<string | null>(null);
  const openAlerts = state.alerts.filter((alert) => !alert.resolvedAt);
  const definitions = enabledDefinitions(state.measurementDefinitions);
  const definition = definitionFor(definitions, metric);
  useEffect(() => {
    if (definitions.length && !definitions.some((item) => item.id === metric)) {
      const next = definitions[0]!;
      setMetric(next.id);
      setThreshold(defaultAlertThreshold(next));
    }
  }, [definitions, metric]);

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (submitting) return;
    setSubmitting(true);
    setSubmitError(null);
    try {
      await onCreateRule({ name, sensorId: sensorId || null, metric, operator, threshold, durationSeconds: duration * 60, severity, enabled: true, webhookEnabled: webhook });
      setName("");
      setShowForm(false);
    } catch (error) {
      setSubmitError(error instanceof Error && error.message.trim() ? error.message : t("alerts.createFailed"));
    } finally {
      setSubmitting(false);
    }
  };
  const sensorLabel = (sensor: Sensor | undefined) => {
    if (!sensor) return t("alerts.allSensors");
    const houseName = state.houses.find((house) => house.id === sensor.houseId)?.name;
    return houseName ? `${houseName} · ${sensor.name}` : sensor.name;
  };

  return (
    <>
      <header className="page-heading">
        <div><span className="eyebrow"><BellRing size={14} aria-hidden="true" />{t("alerts.open")}</span><h1>{t("alerts.title")}</h1><p>{t("alerts.description")}</p></div>
        <button type="button" className="primary-button" onClick={() => setShowForm((value) => !value)} aria-expanded={showForm}><Plus size={16} aria-hidden="true" />{t("alerts.newRule")}</button>
      </header>
      <div className="alert-stats">
        <div><span className="summary-icon alert"><AlertCircle size={18} aria-hidden="true" /></span><span><small>{t("alerts.open")}</small><strong>{openAlerts.filter((item) => !item.acknowledgedAt).length}</strong></span></div>
        <div><span className="summary-icon flow"><ShieldCheck size={18} aria-hidden="true" /></span><span><small>{t("alerts.rules")}</small><strong>{state.alertRules.filter((item) => item.enabled).length}</strong></span></div>
      </div>

      {showForm && (
        <section className="panel rule-builder" aria-labelledby="new-rule-heading">
          <div className="panel-header"><div><span className="eyebrow">{t("alerts.rules")}</span><h2 id="new-rule-heading">{t("alerts.newRule")}</h2></div></div>
          <form onSubmit={submit}>
            <label className="field field-wide"><span>{t("alerts.ruleName")}</span><input required value={name} onChange={(event) => setName(event.target.value)} placeholder={t("alerts.ruleNamePlaceholder")} /></label>
            <div className="form-grid">
              <label className="field"><span>{t("alerts.appliesTo")}</span><select value={sensorId} onChange={(event) => setSensorId(event.target.value)}><option value="">{t("alerts.allSensors")}</option>{state.sensors.filter((sensor) => sensor.enabled).map((sensor) => <option key={sensor.id} value={sensor.id}>{sensorLabel(sensor)}</option>)}</select></label>
              <label className="field"><span>{t("common.metric")}</span><select value={metric} onChange={(event) => { const next = event.target.value; const nextDefinition = definitionFor(definitions, next); setMetric(next); setThreshold(defaultAlertThreshold(nextDefinition)); }}>{definitions.map((item) => <option key={item.id} value={item.id}>{measurementLabel(item, locale)} · {displayUnit(item, units)}</option>)}</select></label>
              <label className="field"><span>{t("alerts.condition")}</span><select value={operator} onChange={(event) => setOperator(event.target.value as AlertOperator)}><option value="gt">{t("alerts.above")}</option><option value="gte">{t("alerts.atOrAbove")}</option><option value="lt">{t("alerts.below")}</option><option value="lte">{t("alerts.atOrBelow")}</option></select></label>
              <label className="field"><span>{t("alerts.threshold")}</span><div className="input-suffix"><input type="number" min={definition.validMin == null ? undefined : toDisplayValue(definition.validMin, definition, units)} max={definition.validMax == null ? undefined : toDisplayValue(definition.validMax, definition, units)} step={10 ** -definition.precision} value={Number(toDisplayValue(threshold, definition, units).toFixed(definition.precision))} onChange={(event) => setThreshold(fromDisplayValue(Number(event.target.value), definition, units))} /><span>{displayUnit(definition, units)}</span></div></label>
              <label className="field"><span>{t("alerts.duration")}</span><div className="input-suffix"><input type="number" min="1" value={duration} onChange={(event) => setDuration(Number(event.target.value))} /><span>{t("common.minutes")}</span></div></label>
              <label className="field"><span>{t("alerts.severity")}</span><select value={severity} onChange={(event) => setSeverity(event.target.value as AlertSeverity)}><option value="info">{t("alerts.info")}</option><option value="warning">{t("alerts.warning")}</option><option value="critical">{t("alerts.critical")}</option></select></label>
            </div>
            <label className="check-field"><input type="checkbox" checked={webhook} onChange={(event) => setWebhook(event.target.checked)} /><span><Bell size={16} aria-hidden="true" />{t("alerts.webhook")}</span></label>
            {submitError && <p className="error-message" role="alert">{submitError}</p>}
            <div className="form-actions"><button type="button" className="secondary-button" disabled={submitting} onClick={() => setShowForm(false)}>{t("common.cancel")}</button><button type="submit" className="primary-button" disabled={submitting}>{submitting ? t("common.saving") : <><Plus size={15} aria-hidden="true" />{t("alerts.create")}</>}</button></div>
          </form>
        </section>
      )}

      <div className="alerts-layout">
        <section className="panel" aria-labelledby="open-alerts-heading">
          <div className="panel-header"><div><span className="eyebrow">{openAlerts.length}</span><h2 id="open-alerts-heading">{t("alerts.open")}</h2></div></div>
          {openAlerts.length === 0 ? <div className="empty-state success"><ShieldCheck size={34} aria-hidden="true" /><span>{t("alerts.none")}</span></div> : <div className="event-list">{openAlerts.map((alert) => { const sensor = state.sensors.find((candidate) => candidate.id === alert.sensorId); const sensorHouse = state.houses.find((candidate) => candidate.id === sensor?.houseId); return <AlertRow key={alert.id} alert={alert} sensor={sensor} houseName={sensorHouse?.name} timeZone={sensorHouse?.timezone} definitions={definitions} units={units} locale={locale} onAcknowledge={onAcknowledge} />; })}</div>}
        </section>
        <section className="panel" aria-labelledby="rules-heading">
          <div className="panel-header"><div><span className="eyebrow">{state.alertRules.length}</span><h2 id="rules-heading">{t("alerts.rules")}</h2></div></div>
          {state.alertRules.length === 0 ? <div className="empty-state">{t("alerts.noRules")}</div> : <div className="rule-list">{state.alertRules.map((rule) => {
            const ruleDefinition = definitionFor(definitions, rule.metric);
            return <div key={rule.id} className="rule-row"><span className={`severity-mark ${rule.severity}`} aria-hidden="true" /><div><strong>{rule.name}</strong><small>{rule.sensorId ? sensorLabel(state.sensors.find((sensor) => sensor.id === rule.sensorId)) : t("alerts.allSensors")} · {measurementLabel(ruleDefinition, locale)} · {t("alerts.severity")}: {t(`alerts.${rule.severity}`)}</small></div><span className="rule-condition">{operatorSymbol(rule.operator)} {formatMeasurement(rule.threshold, ruleDefinition, units)} · {rule.durationSeconds / 60} {t("common.minutes")}</span><span className={rule.enabled ? "status-badge positive" : "status-badge"}>{rule.enabled ? t("common.on") : t("common.off")}</span></div>;
          })}</div>}
        </section>
      </div>
    </>
  );
}

function AlertRow({ alert, sensor, houseName, timeZone, definitions, units, locale, onAcknowledge }: { alert: ClimateState["alerts"][number]; sensor: Sensor | undefined; houseName: string | undefined; timeZone: string | undefined; definitions: MeasurementDefinition[]; units: UnitSystem; locale: string; onAcknowledge: (id: string) => Promise<void> }) {
  const { t } = useI18n();
  const [acknowledging, setAcknowledging] = useState(false);
  const [acknowledgeError, setAcknowledgeError] = useState(false);
  const definition = definitionFor(definitions, alert.metric);
  const acknowledge = async () => {
    if (acknowledging) return;
    setAcknowledging(true);
    setAcknowledgeError(false);
    try {
      await onAcknowledge(alert.id);
    } catch {
      setAcknowledgeError(true);
    } finally {
      setAcknowledging(false);
    }
  };
  return (
    <article className={`event-row ${alert.severity}`}>
      <span className="event-icon" aria-hidden="true"><AlertCircle size={19} /></span>
      <div className="event-main"><div><strong>{houseName ? `${houseName} · ${sensor?.name ?? alert.sensorId}` : sensor?.name ?? alert.sensorId}</strong><span className={`status-badge ${alert.severity}`}>{t(`alerts.${alert.severity}`)}</span></div><p>{measurementLabel(definition, locale)}: {t("alerts.valueExceeded", { value: formatMeasurement(alert.value, definition, units), threshold: formatMeasurement(alert.threshold, definition, units) })}</p><small><Clock3 size={13} aria-hidden="true" />{t("alerts.since", { time: formatInTimeZone(alert.startedAt, locale, timeZone, { dateStyle: "medium", timeStyle: "short" }) })}</small></div>
      {alert.acknowledgedAt ? <span className="acknowledged"><Check size={15} aria-hidden="true" />{t("alerts.acknowledged")}</span> : <button type="button" className="secondary-button" disabled={acknowledging} onClick={() => void acknowledge()}>{acknowledging ? <LoaderCircle className="spin" size={15} aria-hidden="true" /> : null}{t("alerts.acknowledge")}</button>}
      {acknowledgeError && <p className="event-action-error" role="alert">{t("alerts.acknowledgeFailed")}</p>}
    </article>
  );
}

function operatorSymbol(operator: AlertOperator) {
  return ({ gt: ">", gte: "≥", lt: "<", lte: "≤" } as const)[operator];
}
