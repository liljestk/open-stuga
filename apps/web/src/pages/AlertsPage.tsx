import { useEffect, useState, type FormEvent } from "react";
import { AlertCircle, Bell, BellRing, Check, ChevronDown, Clock3, HelpCircle, LoaderCircle, MessageCircle, Plus, ShieldCheck } from "lucide-react";
import type { AlertDeliveryPolicy, AlertEvent, AlertOperator, AlertRule, AlertRulePatch, AlertSeverity, IntegrationStatus, MeasurementDefinition, Metric, Sensor, UnitSystem } from "@climate-twin/contracts";
import { type ClimateState } from "../domain";
import { useI18n } from "../i18n";
import { defaultAlertThreshold, definitionFor, displayUnit, enabledDefinitions, formatMeasurement, fromDisplayValue, measurementLabel, toDisplayValue } from "../measurements";
import { formatInTimeZone } from "../dateTime";
import { deriveHouseMonitoring, type HouseMonitoringBlocker } from "../houseMonitoring";
import { integrationForHouse } from "../integrationScope";
import { useNow } from "../useNow";
import { alertGroupKey } from "../alertGrouping";
import { TelegramSetupPanel } from "./TelegramSetupPanel";
import { ActionPlaybookLauncher, AlertOrchestrationPanel } from "./AlertOrchestrationPanel";

export { countActionableAlertGroups } from "../alertGrouping";

interface AlertsPageProps {
  state: ClimateState;
  units: UnitSystem;
  onCreateRule: (rule: Omit<AlertRule, "id">) => Promise<void>;
  onUpdateRule: (id: string, patch: AlertRulePatch) => Promise<AlertRule>;
  onAcknowledge: (id: string) => Promise<void>;
  onInspectAlert?: (alert: AlertEvent) => void;
  onIntegrationChange?: (integration: IntegrationStatus) => void;
  readOnly?: boolean;
}

export function AlertsPage({ state, units, onCreateRule, onUpdateRule, onAcknowledge, onInspectAlert, onIntegrationChange, readOnly = false }: AlertsPageProps) {
  const { locale, t } = useI18n();
  const now = useNow();
  const [showForm, setShowForm] = useState(false);
  const [name, setName] = useState("");
  const [sensorId, setSensorId] = useState("");
  const [metric, setMetric] = useState<Metric>("humidity");
  const [operator, setOperator] = useState<AlertOperator>("gte");
  const [threshold, setThreshold] = useState(65);
  const [duration, setDuration] = useState(15);
  const [severity, setSeverity] = useState<AlertSeverity>("warning");
  const [webhook, setWebhook] = useState(true);
  const [telegramEnabled, setTelegramEnabled] = useState(false);
  const [deliveryPolicy, setDeliveryPolicy] = useState<AlertDeliveryPolicy>(() => defaultDeliveryPolicy());
  const [submitting, setSubmitting] = useState(false);
  const [submitError, setSubmitError] = useState<string | null>(null);
  const [telegramSetupOpen, setTelegramSetupOpen] = useState(false);
  const openAlerts = state.alerts.filter((alert) => !alert.resolvedAt).sort(compareAlertPriority);
  const actionableGroups = groupAlerts(openAlerts.filter((alert) => !alert.acknowledgedAt), state.alertRules);
  const acknowledgedGroups = groupAlerts(openAlerts.filter((alert) => alert.acknowledgedAt), state.alertRules);
  const definitions = enabledDefinitions(state.measurementDefinitions);
  const definition = definitionFor(definitions, metric);
  const telegramReady = Boolean(state.integration.telegram?.available && state.integration.telegram.configured && state.integration.telegram.connected);
  const inventoryUnavailable = readOnly && state.houses.length === 0;
  const coverageExceptions = state.houses.flatMap((house) => {
    const result = deriveHouseMonitoring({
      house,
      sensors: state.sensors,
      latestMeasurements: state.latestMeasurements,
      measurementHistory: state.measurementHistory,
      alerts: state.alerts,
      alertRules: state.alertRules,
      integration: integrationForHouse(state.integration, house.id, Boolean(house.location)),
      referenceTime: now,
    });
    const blocker = result.blockers.find((item) => ["no-sensors", "missing-data", "stale-data", "source-disconnected", "estimated-data", "aging-data"].includes(item.kind));
    return blocker ? [{ house, blocker }] : [];
  });
  useEffect(() => {
    if (definitions.length && !definitions.some((item) => item.id === metric)) {
      const next = definitions[0]!;
      setMetric(next.id);
      setThreshold(defaultAlertThreshold(next));
    }
  }, [definitions, metric]);
  useEffect(() => {
    if (readOnly) setShowForm(false);
  }, [readOnly]);

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (readOnly || submitting) return;
    setSubmitting(true);
    setSubmitError(null);
    try {
      await onCreateRule({ name, sensorId: sensorId || null, metric, operator, threshold, durationSeconds: duration * 60, severity, enabled: true, webhookEnabled: webhook, telegramEnabled, deliveryPolicy });
      setName("");
      setTelegramEnabled(false);
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
  const openTelegramSetup = () => setTelegramSetupOpen(true);

  return (
    <>
      <header className="page-heading">
        <div><span className="eyebrow"><BellRing size={14} aria-hidden="true" />{t("alerts.open")}</span><h1>{t("alerts.title")}</h1><p>{t("alerts.description")}</p></div>
      </header>
      <section className="panel alerts-open-panel" aria-labelledby="open-alerts-heading">
        <div className="panel-header alerts-open-heading"><div><span className="eyebrow">{t("alerts.open")}</span><h2 id="open-alerts-heading">{t("alerts.needsAttention")}</h2></div><span className="alerts-open-count" aria-label={`${actionableGroups.length} ${t("alerts.open")}`}>{actionableGroups.length}</span></div>
        {actionableGroups.length === 0 ? inventoryUnavailable
          ? <div className="empty-state"><HelpCircle size={34} aria-hidden="true" /><strong>{t("properties.noAccessTitle")}</strong><span>{t("properties.noAccessBody")}</span></div>
          : <div className="empty-state success"><ShieldCheck size={34} aria-hidden="true" /><strong>{t("alerts.noThresholdAlerts")}</strong><span>{t(acknowledgedGroups.length ? "alerts.noneActionable" : coverageExceptions.length ? "alerts.noThresholdAlertsUnknown" : "alerts.noThresholdAlertsConfirmed")}</span></div>
          : <div className="event-list">{actionableGroups.map((group) => { const sensor = state.sensors.find((candidate) => candidate.id === group.primary.sensorId); const sensorHouse = state.houses.find((candidate) => candidate.id === sensor?.houseId); return <AlertRow key={group.key} alerts={group.alerts} rule={group.rule} sensor={sensor} houseName={sensorHouse?.name} timeZone={sensorHouse?.timezone} definitions={definitions} units={units} locale={locale} onAcknowledge={readOnly ? undefined : onAcknowledge} onInspect={onInspectAlert} />; })}</div>}
        {acknowledgedGroups.length > 0 && <details className="acknowledged-alerts">
          <summary><span><Check size={15} aria-hidden="true" />{t("alerts.acknowledgedOpen")}</span><small>{t("alerts.acknowledgedCount", { count: acknowledgedGroups.length })}</small><ChevronDown size={16} aria-hidden="true" /></summary>
          <div className="event-list">{acknowledgedGroups.map((group) => { const sensor = state.sensors.find((candidate) => candidate.id === group.primary.sensorId); const sensorHouse = state.houses.find((candidate) => candidate.id === sensor?.houseId); return <AlertRow key={`acknowledged:${group.key}`} alerts={group.alerts} rule={group.rule} sensor={sensor} houseName={sensorHouse?.name} timeZone={sensorHouse?.timezone} definitions={definitions} units={units} locale={locale} onAcknowledge={readOnly ? undefined : onAcknowledge} onInspect={onInspectAlert} />; })}</div>
        </details>}
      </section>

      {!inventoryUnavailable && (coverageExceptions.length ? <section className="alerts-monitoring-summary unknown" aria-labelledby="alerts-monitoring-heading">
        <span aria-hidden="true"><HelpCircle size={19} /></span>
        <div><h2 id="alerts-monitoring-heading">{t("alerts.monitoringUnknown")}</h2><ul>{coverageExceptions.map(({ house, blocker }) => <li key={house.id}><b>{house.name}</b><span>{coverageBlockerText(blocker, t)}</span></li>)}</ul></div>
      </section> : <details className="alerts-monitoring-summary confirmed">
        <summary><ShieldCheck size={19} aria-hidden="true" /><strong>{t("alerts.monitoringConfirmed")}</strong><ChevronDown size={16} aria-hidden="true" /></summary>
        <p>{t("alerts.monitoringConfirmedBody")}</p>
      </details>)}

      {!readOnly && onIntegrationChange && <section className="alerts-delivery-settings" aria-labelledby="alerts-delivery-settings-title">
        <header className="alerts-delivery-settings-heading">
          <div><span className="eyebrow"><MessageCircle size={14} aria-hidden="true" />{t("alerts.deliverySettingsEyebrow")}</span><h2 id="alerts-delivery-settings-title">{t("alerts.deliverySettingsTitle")}</h2><p>{t("alerts.deliverySettingsDescription")}</p></div>
        </header>
        <TelegramSetupPanel
          integration={state.integration}
          onIntegrationChange={onIntegrationChange}
          open={telegramSetupOpen}
          onOpenChange={setTelegramSetupOpen}
          titleId="alerts-telegram-setup-title"
        />
      </section>}

      {!readOnly && <AlertOrchestrationPanel />}

      {!readOnly && <details className="panel alerts-rule-admin" aria-labelledby="rules-heading">
        <summary><span><strong id="rules-heading">{t("alerts.rules")}</strong><small>{state.alertRules.filter((item) => item.enabled).length} {t("common.on")}</small></span><ChevronDown size={16} aria-hidden="true" /></summary>
        <div>
          <button type="button" className="secondary-button" onClick={() => setShowForm((value) => !value)} aria-expanded={showForm} aria-controls="new-rule-builder"><Plus size={16} aria-hidden="true" />{t("alerts.newRule")}</button>
          {showForm && <section id="new-rule-builder" className="rule-builder" aria-labelledby="new-rule-heading">
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
              <fieldset className="alert-delivery-options">
                <legend>{t("alerts.delivery")}</legend>
                <label className="check-field"><input type="checkbox" checked={webhook} onChange={(event) => setWebhook(event.target.checked)} /><span><Bell size={16} aria-hidden="true" />{t("alerts.webhook")}</span></label>
                <label className="check-field"><input type="checkbox" checked={telegramEnabled} disabled={!telegramReady} onChange={(event) => setTelegramEnabled(event.target.checked)} /><span><MessageCircle size={16} aria-hidden="true" />{t("alerts.telegram")}</span></label>
                <div className={`alert-delivery-help ${telegramReady ? "ready" : ""}`}>
                  <span>{t(telegramReady ? "alerts.telegramReady" : "alerts.telegramUnavailable")}</span>
                  {!telegramReady && onIntegrationChange && <button type="button" className="text-button" onClick={openTelegramSetup}>{t("alerts.setupTelegram")}</button>}
                </div>
              </fieldset>
              <DeliveryPolicyEditor value={deliveryPolicy} onChange={setDeliveryPolicy} />
              {submitError && <p className="error-message" role="alert">{submitError}</p>}
              <div className="form-actions"><button type="button" className="secondary-button" disabled={submitting} onClick={() => setShowForm(false)}>{t("common.cancel")}</button><button type="submit" className="primary-button" disabled={submitting}>{submitting ? t("common.saving") : <><Plus size={15} aria-hidden="true" />{t("alerts.create")}</>}</button></div>
            </form>
          </section>}
          {state.alertRules.length === 0 ? <div className="empty-state">{t("alerts.noRules")}</div> : <div className="rule-list">{state.alertRules.map((rule) => {
            const ruleDefinition = definitionFor(definitions, rule.metric);
            return <div key={rule.id} className="rule-row"><span className={`severity-mark ${rule.severity}`} aria-hidden="true" /><div className="rule-details"><strong>{rule.name}</strong><small>{rule.sensorId ? sensorLabel(state.sensors.find((sensor) => sensor.id === rule.sensorId)) : t("alerts.allSensors")} · {measurementLabel(ruleDefinition, locale)} · {t("alerts.severity")}: {t(`alerts.${rule.severity}`)}</small><RuleDelivery rule={rule} telegramReady={telegramReady} onUpdateRule={onUpdateRule} onOpenTelegramSetup={onIntegrationChange ? openTelegramSetup : undefined} /></div><span className="rule-condition">{operatorSymbol(rule.operator)} {formatMeasurement(rule.threshold, ruleDefinition, units)} · {rule.durationSeconds / 60} {t("common.minutes")}</span><span className={rule.enabled ? "status-badge positive" : "status-badge"}>{rule.enabled ? t("common.on") : t("common.off")}</span></div>;
          })}</div>}
        </div>
      </details>}
    </>
  );
}

function RuleDelivery({ rule, telegramReady, onUpdateRule, onOpenTelegramSetup }: { rule: AlertRule; telegramReady: boolean; onUpdateRule: (id: string, patch: AlertRulePatch) => Promise<AlertRule>; onOpenTelegramSetup: (() => void) | undefined }) {
  const { t } = useI18n();
  const [pending, setPending] = useState(false);
  const [failed, setFailed] = useState(false);
  const toggleTelegram = async () => {
    if (pending || (!telegramReady && !rule.telegramEnabled)) return;
    setPending(true);
    setFailed(false);
    try {
      await onUpdateRule(rule.id, { telegramEnabled: !Boolean(rule.telegramEnabled) });
    } catch {
      setFailed(true);
    } finally {
      setPending(false);
    }
  };
  return (
    <div className="rule-delivery" aria-label={t("alerts.delivery")}>
      {rule.webhookEnabled && <span className="channel-chip"><Bell size={13} aria-hidden="true" />{t("alerts.webhookChannel")}</span>}
      <button type="button" className={`channel-chip channel-toggle ${rule.telegramEnabled ? "active" : ""}`} aria-pressed={Boolean(rule.telegramEnabled)} disabled={pending || (!telegramReady && !rule.telegramEnabled)} onClick={() => void toggleTelegram()}>
        {pending ? <LoaderCircle className="spin" size={13} aria-hidden="true" /> : <MessageCircle size={13} aria-hidden="true" />}{t("alerts.telegramChannel")}
      </button>
      {!telegramReady && !rule.telegramEnabled && onOpenTelegramSetup && <button type="button" className="text-button channel-setup" onClick={onOpenTelegramSetup}>{t("alerts.setup")}</button>}
      {failed && <span className="rule-delivery-error" role="alert">{t("alerts.deliveryUpdateFailed")}</span>}
      <SavedDeliveryPolicyEditor rule={rule} onUpdateRule={onUpdateRule} />
    </div>
  );
}

function defaultDeliveryPolicy(): AlertDeliveryPolicy {
  return {
    timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC",
    activeDays: [1, 2, 3, 4, 5, 6, 7],
    activeFrom: null,
    activeUntil: null,
    quietHoursFrom: "22:00",
    quietHoursUntil: "07:00",
    quietHoursMode: "defer",
    criticalBypassQuietHours: true,
    escalationAfterSeconds: 30 * 60,
    reminderIntervalSeconds: 2 * 60 * 60,
    maxAttempts: 8,
  };
}

function SavedDeliveryPolicyEditor({ rule, onUpdateRule }: Readonly<{ rule: AlertRule; onUpdateRule: (id: string, patch: AlertRulePatch) => Promise<AlertRule> }>) {
  const { t } = useI18n();
  const [draft, setDraft] = useState(rule.deliveryPolicy ?? defaultDeliveryPolicy());
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(false);
  useEffect(() => setDraft(rule.deliveryPolicy ?? defaultDeliveryPolicy()), [rule.deliveryPolicy]);
  const save = async () => {
    setBusy(true); setError(false);
    try { await onUpdateRule(rule.id, { deliveryPolicy: draft }); }
    catch { setError(true); }
    finally { setBusy(false); }
  };
  return <details className="rule-policy-editor"><summary>{t("alerts.policy.schedule")}</summary><DeliveryPolicyEditor value={draft} compact onChange={setDraft} /><button type="button" className="secondary-button" disabled={busy} onClick={() => void save()}>{busy ? t("common.saving") : t("alerts.policy.save")}</button>{error && <span role="alert">{t("alerts.policy.updateFailed")}</span>}</details>;
}

function DeliveryPolicyEditor({ value, onChange, compact = false }: Readonly<{ value: AlertDeliveryPolicy; onChange: (value: AlertDeliveryPolicy) => void; compact?: boolean }>) {
  const { t } = useI18n();
  const minutes = (seconds: number | null) => seconds === null ? "" : String(seconds / 60);
  const optionalSeconds = (raw: string) => raw.trim() === "" ? null : Math.max(60, Math.round(Number(raw) * 60));
  return <fieldset className={`delivery-policy-editor ${compact ? "compact" : ""}`}>
    <legend>{compact ? t("alerts.policy.deliverySchedule") : t("alerts.policy.legend")}</legend>
    <div className="form-grid">
      <label className="field"><span>{t("alerts.policy.timezone")}</span><input value={value.timeZone} onChange={(event) => onChange({ ...value, timeZone: event.target.value })} /></label>
      <label className="field"><span>{t("alerts.policy.quietFrom")}</span><input type="time" value={value.quietHoursFrom ?? ""} onChange={(event) => onChange({ ...value, quietHoursFrom: event.target.value || null })} /></label>
      <label className="field"><span>{t("alerts.policy.quietUntil")}</span><input type="time" value={value.quietHoursUntil ?? ""} onChange={(event) => onChange({ ...value, quietHoursUntil: event.target.value || null })} /></label>
      <label className="field"><span>{t("alerts.policy.duringQuiet")}</span><select value={value.quietHoursMode} onChange={(event) => onChange({ ...value, quietHoursMode: event.target.value as AlertDeliveryPolicy["quietHoursMode"] })}><option value="defer">{t("alerts.policy.defer")}</option><option value="silent">{t("alerts.policy.silent")}</option></select></label>
      <label className="field"><span>{t("alerts.policy.escalateAfter")}</span><input type="number" min="1" value={minutes(value.escalationAfterSeconds)} onChange={(event) => onChange({ ...value, escalationAfterSeconds: optionalSeconds(event.target.value) })} /></label>
      <label className="field"><span>{t("alerts.policy.repeatEvery")}</span><input type="number" min="1" value={minutes(value.reminderIntervalSeconds)} onChange={(event) => onChange({ ...value, reminderIntervalSeconds: optionalSeconds(event.target.value) })} /></label>
      <label className="field"><span>{t("alerts.policy.deliveryAttempts")}</span><input type="number" min="1" max="50" value={value.maxAttempts} onChange={(event) => onChange({ ...value, maxAttempts: Math.max(1, Math.min(50, Number(event.target.value))) })} /></label>
    </div>
    <label className="check-field"><input type="checkbox" checked={value.criticalBypassQuietHours} onChange={(event) => onChange({ ...value, criticalBypassQuietHours: event.target.checked })} /><span>{t("alerts.policy.criticalBypass")}</span></label>
  </fieldset>;
}

function coverageBlockerText(blocker: HouseMonitoringBlocker, t: ReturnType<typeof useI18n>["t"]): string {
  if (blocker.kind === "no-sensors") return t("alerts.coverage.noSensors");
  if (blocker.kind === "missing-data") return t("alerts.coverage.missing", { count: blocker.count });
  if (blocker.kind === "stale-data") return t("alerts.coverage.stale", { count: blocker.count });
  if (blocker.kind === "source-disconnected") return t("alerts.coverage.sourceDisconnected", { count: blocker.count });
  if (blocker.kind === "estimated-data") return t("alerts.coverage.estimated", { count: blocker.count });
  return t("alerts.coverage.aging", { count: blocker.count });
}

function AlertRow({ alerts, rule, sensor, houseName, timeZone, definitions, units, locale, onAcknowledge, onInspect }: { alerts: AlertEvent[]; rule: AlertRule | undefined; sensor: Sensor | undefined; houseName: string | undefined; timeZone: string | undefined; definitions: MeasurementDefinition[]; units: UnitSystem; locale: string; onAcknowledge: ((id: string) => Promise<void>) | undefined; onInspect: ((alert: AlertEvent) => void) | undefined }) {
  const { t } = useI18n();
  const alert = alerts[0]!;
  const [acknowledging, setAcknowledging] = useState(false);
  const [acknowledgeError, setAcknowledgeError] = useState(false);
  const definition = definitionFor(definitions, alert.metric);
  const acknowledge = async () => {
    if (acknowledging || !onAcknowledge) return;
    setAcknowledging(true);
    setAcknowledgeError(false);
    try {
      await Promise.all(alerts.map((item) => onAcknowledge(item.id)));
    } catch {
      setAcknowledgeError(true);
    } finally {
      setAcknowledging(false);
    }
  };
  return (
    <article className={`event-row ${alert.severity}`}>
      <span className="event-icon" aria-hidden="true"><AlertCircle size={19} /></span>
      <div className="event-main"><div><strong>{houseName ? `${houseName} · ${sensor?.name ?? alert.sensorId}` : sensor?.name ?? alert.sensorId}</strong><span className={`status-badge ${alert.severity}`}>{t(`alerts.${alert.severity}`)}</span></div><p>{measurementLabel(definition, locale)}: {t(rule?.operator === "lt" || rule?.operator === "lte" ? "alerts.valueBelow" : "alerts.valueAbove", { value: formatMeasurement(alert.value, definition, units), threshold: formatMeasurement(alert.threshold, definition, units) })}</p><p className="event-recommendation">{t(alert.metric === "temperature" || alert.metric === "humidity" || alert.metric === "co2" ? `alerts.action.${alert.metric}` : "alerts.action.generic")}</p><small><Clock3 size={13} aria-hidden="true" />{t("alerts.since", { time: formatInTimeZone(alert.startedAt, locale, timeZone, { dateStyle: "medium", timeStyle: "short" }) })}</small></div>
      <div className="event-actions">
        {onInspect && <button type="button" className="primary-button" onClick={() => onInspect(alert)}>{t("alerts.inspect")}</button>}
        {onAcknowledge && <ActionPlaybookLauncher alert={alert} />}
        {alert.acknowledgedAt ? <span className="acknowledged"><Check size={15} aria-hidden="true" />{t("alerts.acknowledged")}</span> : onAcknowledge ? <button type="button" className="secondary-button" disabled={acknowledging} onClick={() => void acknowledge()}>{acknowledging ? <LoaderCircle className="spin" size={15} aria-hidden="true" /> : null}{t("alerts.acknowledge")}</button> : null}
      </div>
      {alerts.length > 1 && <small className="related-alert-count">{t("alerts.relatedCount", { count: alerts.length })}</small>}
      <details className="alert-explanation">
        <summary>{t("alerts.explain")}<ChevronDown size={15} aria-hidden="true" /></summary>
        <div><p>{t(alert.severity === "critical" ? "alerts.whyCritical" : alert.severity === "warning" ? "alerts.whyWarning" : "alerts.whyInfo")}</p></div>
      </details>
      {acknowledgeError && <p className="event-action-error" role="alert">{t("alerts.acknowledgeFailed")}</p>}
    </article>
  );
}

interface AlertGroup {
  key: string;
  primary: AlertEvent;
  alerts: AlertEvent[];
  rule: AlertRule | undefined;
}

function compareAlertPriority(left: AlertEvent, right: AlertEvent): number {
  const severity = { critical: 3, warning: 2, info: 1 } as const;
  return severity[right.severity] - severity[left.severity]
    || Date.parse(right.startedAt) - Date.parse(left.startedAt)
    || left.id.localeCompare(right.id);
}

function groupAlerts(alerts: AlertEvent[], rules: AlertRule[]): AlertGroup[] {
  const rulesById = new Map(rules.map((rule) => [rule.id, rule]));
  const grouped = new Map<string, AlertEvent[]>();
  for (const alert of alerts) {
    const key = alertGroupKey(alert, rulesById);
    const bucket = grouped.get(key);
    if (bucket) bucket.push(alert);
    else grouped.set(key, [alert]);
  }
  return [...grouped.entries()]
    .map(([key, items]) => {
      const sorted = items.sort(compareAlertPriority);
      const primary = sorted[0]!;
      return { key, primary, alerts: sorted, rule: rulesById.get(primary.ruleId) };
    })
    .sort((left, right) => compareAlertPriority(left.primary, right.primary));
}

function operatorSymbol(operator: AlertOperator) {
  return ({ gt: ">", gte: "≥", lt: "<", lte: "≤" } as const)[operator];
}
