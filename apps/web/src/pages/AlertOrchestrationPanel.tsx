import { useCallback, useEffect, useState } from "react";
import { CheckCircle2, ChevronDown, CirclePlay, Clock3, LoaderCircle, RefreshCw, RotateCcw, Send, ShieldAlert } from "lucide-react";
import type { ActionPlaybook, ActionRun, AlertEvent, NotificationDeliveryStatus } from "@climate-twin/contracts";
import { api } from "../api";
import { useI18n } from "../i18n";
import "./AlertOrchestrationPanel.css";

export function AlertOrchestrationPanel() {
  const { locale, t } = useI18n();
  const [deliveries, setDeliveries] = useState<NotificationDeliveryStatus[]>([]);
  const [runs, setRuns] = useState<ActionRun[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [retrying, setRetrying] = useState<string | null>(null);
  const load = useCallback(() => {
    setLoading(true);
    setError(null);
    void Promise.all([api.notificationDeliveries({ limit: 100 }), api.actionRuns({ limit: 100 })])
      .then(([nextDeliveries, nextRuns]) => {
        setDeliveries(nextDeliveries);
        setRuns(nextRuns);
      })
      .catch((reason: unknown) => setError(message(reason, t("alerts.orchestration.operationFailed"))))
      .finally(() => setLoading(false));
  }, [t]);
  useEffect(load, [load]);

  const retry = async (delivery: NotificationDeliveryStatus) => {
    setRetrying(delivery.id);
    try {
      const next = await api.retryNotificationDelivery(delivery.id);
      setDeliveries((current) => current.map((candidate) => candidate.id === next.id ? next : candidate));
    } catch (reason) {
      setError(message(reason, t("alerts.orchestration.operationFailed")));
    } finally {
      setRetrying(null);
    }
  };

  const failed = deliveries.filter((delivery) => delivery.deadLetteredAt || delivery.abandonedAt);
  const deliveredCount = deliveries.filter((delivery) => delivery.deliveredAt).length;
  return <details className="panel alert-orchestration-panel">
    <summary>
      <span>
        <strong>{t("alerts.orchestration.evidenceTitle")}</strong>
        <small>{failed.length
          ? t("alerts.orchestration.evidenceFailures", { count: failed.length })
          : t("alerts.orchestration.evidenceDeliveries", { count: deliveredCount })}</small>
      </span>
      <ChevronDown size={16} aria-hidden="true" />
    </summary>
    <div>
      <div className="panel-header">
        <div><span className="eyebrow">{t("alerts.orchestration.eyebrow")}</span><h2>{t("alerts.orchestration.title")}</h2></div>
        <button type="button" className="secondary-button" disabled={loading} onClick={load}>
          <RefreshCw className={loading ? "spin" : ""} size={15} aria-hidden="true" />
          {t("alerts.orchestration.refresh")}
        </button>
      </div>
      {error && <p className="error-message" role="alert">{error}</p>}
      <div className="alert-orchestration-grid">
        <section>
          <h3><Send size={16} aria-hidden="true" /> {t("alerts.orchestration.deliveryLedger")}</h3>
          {deliveries.length ? <ul>{deliveries.slice(0, 20).map((delivery) => <li key={delivery.id} className={delivery.deadLetteredAt || delivery.abandonedAt ? "failed" : delivery.deliveredAt ? "delivered" : "pending"}>
            {delivery.deliveredAt ? <CheckCircle2 size={16} aria-hidden="true" /> : delivery.deadLetteredAt || delivery.abandonedAt ? <ShieldAlert size={16} aria-hidden="true" /> : <Clock3 size={16} aria-hidden="true" />}
            <span>
              <strong>{t("alerts.orchestration.deliveryLabel", { channel: delivery.channel, stage: delivery.stage })}</strong>
              <small>{delivery.deliveredAt
                ? t("alerts.orchestration.deliveredAt", { time: formatDate(delivery.deliveredAt, locale, t("alerts.orchestration.pending")) })
                : delivery.lastError ?? t("alerts.orchestration.queuedAttempt", { attempt: delivery.attempts, time: formatDate(delivery.availableAt, locale, t("alerts.orchestration.pending")) })}</small>
            </span>
            {(delivery.deadLetteredAt || delivery.abandonedAt) && <button type="button" className="secondary-button" disabled={retrying === delivery.id} onClick={() => void retry(delivery)}>
              {retrying === delivery.id ? <LoaderCircle className="spin" size={14} aria-hidden="true" /> : <RotateCcw size={14} aria-hidden="true" />}
              {t("alerts.orchestration.retry")}
            </button>}
          </li>)}</ul> : <p>{t("alerts.orchestration.noDeliveries")}</p>}
        </section>
        <section>
          <h3><CirclePlay size={16} aria-hidden="true" /> {t("alerts.orchestration.actionVerification")}</h3>
          {runs.length ? <ul>{runs.slice(0, 20).map((run) => <li key={run.id} className={run.status}>
            <RunStatusIcon run={run} />
            <span>
              <strong>{t("alerts.orchestration.runLabel", { metric: run.metric, status: run.status.replace("-", " ") })}</strong>
              <small>{run.resultValue === null
                ? t("alerts.orchestration.runWaiting", { baseline: run.baselineValue })
                : t("alerts.orchestration.runResult", { baseline: run.baselineValue, result: run.resultValue, count: run.sampleCount })}</small>
            </span>
          </li>)}</ul> : <p>{t("alerts.orchestration.noRuns")}</p>}
        </section>
      </div>
    </div>
  </details>;
}

export function ActionPlaybookLauncher({ alert }: Readonly<{ alert: AlertEvent }>) {
  const { locale, t } = useI18n();
  const [open, setOpen] = useState(false);
  const [playbooks, setPlaybooks] = useState<ActionPlaybook[]>([]);
  const [run, setRun] = useState<ActionRun | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const toggle = () => {
    setOpen((current) => !current);
    if (!open && !playbooks.length) {
      setBusy(true);
      void Promise.all([api.alertActionPlaybooks(alert.id), api.actionRuns({ alertEventId: alert.id })]).then(([items, existing]) => {
        setPlaybooks(items);
        setRun(existing[0] ?? null);
      }).catch((reason: unknown) => setError(message(reason, t("alerts.orchestration.operationFailed")))).finally(() => setBusy(false));
    }
  };
  const start = async (playbook: ActionPlaybook) => {
    setBusy(true);
    setError(null);
    try {
      setRun(await api.startActionRun({ playbookId: playbook.id, sensorId: alert.sensorId, alertEventId: alert.id }));
    } catch (reason) {
      setError(message(reason, t("alerts.orchestration.operationFailed")));
    } finally {
      setBusy(false);
    }
  };
  const complete = async () => {
    if (!run) return;
    setBusy(true);
    setError(null);
    try {
      setRun(await api.completeActionRun(run.id));
    } catch (reason) {
      setError(message(reason, t("alerts.orchestration.operationFailed")));
    } finally {
      setBusy(false);
    }
  };
  return <div className="action-playbook-launcher">
    <button type="button" className="secondary-button" aria-expanded={open} onClick={toggle}><CirclePlay size={15} aria-hidden="true" /> {t("alerts.orchestration.actionPlan")}</button>
    {open && <div className="action-playbook-menu">
      {busy && !run && <p><LoaderCircle className="spin" size={15} aria-hidden="true" /> {t("alerts.orchestration.loadingActions")}</p>}
      {run ? <>
        <strong>{playbooks.find((item) => item.id === run.playbookId)?.name ?? t("alerts.orchestration.actionInProgress")}</strong>
        <small>{run.status === "active"
          ? t("alerts.orchestration.performSteps")
          : run.status === "waiting"
            ? t("alerts.orchestration.waitingEvidence", { metric: run.metric, time: formatDate(run.verifyAfter, locale, t("alerts.orchestration.pending")) })
            : run.resultValue === null
              ? run.status
              : t("alerts.orchestration.runResultShort", { status: run.status, baseline: run.baselineValue, result: run.resultValue })}</small>
        {run.status === "active" && <button type="button" className="primary-button" disabled={busy} onClick={() => void complete()}>{t("alerts.orchestration.verifyResult")}</button>}
      </> : playbooks.map((playbook) => <article key={playbook.id}>
        <strong>{playbook.name}</strong><p>{playbook.description}</p><ol>{playbook.instructions.map((step) => <li key={step}>{step}</li>)}</ol>
        <button type="button" className="primary-button" disabled={busy} onClick={() => void start(playbook)}>{t("alerts.orchestration.startBaseline")}</button>
      </article>)}
      {!busy && !run && !playbooks.length && <p>{t("alerts.orchestration.noPlaybook")}</p>}
      {error && <p className="error-message" role="alert">{error}</p>}
    </div>}
  </div>;
}

function RunStatusIcon({ run }: Readonly<{ run: ActionRun }>) {
  return run.status === "verified" ? <CheckCircle2 size={16} aria-hidden="true" /> : run.status === "not-improved" ? <ShieldAlert size={16} aria-hidden="true" /> : <Clock3 size={16} aria-hidden="true" />;
}

function formatDate(value: string | null, locale: string, pending: string): string {
  return value ? new Intl.DateTimeFormat(locale, { dateStyle: "short", timeStyle: "short" }).format(new Date(value)) : pending;
}

function message(error: unknown, fallback: string): string {
  return error instanceof Error && error.message.trim() ? error.message : fallback;
}
