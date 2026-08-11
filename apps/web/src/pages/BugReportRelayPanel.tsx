import { useEffect, useState, type FormEvent } from "react";
import { Bug, CheckCircle2, CircleAlert, KeyRound, LoaderCircle, ShieldCheck, Trash2 } from "lucide-react";
import {
  BUG_REPORT_RELAY_TOKEN_MIN_LENGTH,
  BUG_REPORT_RELAY_URL_MAX_LENGTH,
  type BugReportRelaySettings,
} from "@climate-twin/contracts";
import { api, ApiRequestError } from "../api";
import { confirmAction } from "../components/ConfirmationProvider";
import { formatInTimeZone } from "../dateTime";
import { useI18n } from "../i18n";
import "./BugReportRelayPanel.css";

type Feedback = { kind: "success" | "error"; message: string } | null;

function errorMessage(error: unknown, fallback: string): string {
  return (error instanceof ApiRequestError || error instanceof Error) && error.message.trim() ? error.message : fallback;
}

export function BugReportRelayPanel() {
  const { locale, t } = useI18n();
  const [settings, setSettings] = useState<BugReportRelaySettings | null>(null);
  const [unavailable, setUnavailable] = useState(false);
  const [url, setUrl] = useState("");
  const [token, setToken] = useState("");
  const [showToken, setShowToken] = useState(false);
  const [editing, setEditing] = useState(false);
  const [saving, setSaving] = useState(false);
  const [removing, setRemoving] = useState(false);
  const [feedback, setFeedback] = useState<Feedback>(null);

  useEffect(() => {
    let active = true;
    void (async () => {
      try {
        const loaded = await api.bugReportRelay();
        if (!active) return;
        setSettings(loaded);
        setUrl(loaded.url ?? "");
      } catch (error) {
        if (!active) return;
        // Members never administer the relay; the panel stays hidden instead of showing a denial.
        if (error instanceof ApiRequestError && (error.status === 403 || error.status === 404)) setUnavailable(true);
        else setFeedback({ kind: "error", message: errorMessage(error, t("bugReport.relay.loadFailed")) });
      }
    })();
    return () => { active = false; };
  }, [t]);

  const save = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (saving || !url.trim() || token.trim().length < BUG_REPORT_RELAY_TOKEN_MIN_LENGTH) return;
    setSaving(true);
    setFeedback(null);
    try {
      const saved = await api.configureBugReportRelay({ url: url.trim(), token: token.trim() });
      setSettings(saved);
      setUrl(saved.url ?? "");
      setToken("");
      setShowToken(false);
      setEditing(false);
      setFeedback({ kind: "success", message: t("bugReport.relay.saved") });
    } catch (error) {
      setFeedback({ kind: "error", message: errorMessage(error, t("bugReport.relay.saveFailed")) });
    } finally {
      setSaving(false);
    }
  };

  const remove = async () => {
    if (removing) return;
    if (!await confirmAction(t("bugReport.relay.removeConfirm"), t("bugReport.relay.removeAction"))) return;
    setRemoving(true);
    setFeedback(null);
    try {
      const cleared = await api.clearBugReportRelay();
      setSettings(cleared);
      setUrl("");
      setToken("");
      setEditing(false);
      setFeedback({ kind: "success", message: t("bugReport.relay.removed") });
    } catch (error) {
      setFeedback({ kind: "error", message: errorMessage(error, t("bugReport.relay.removeFailed")) });
    } finally {
      setRemoving(false);
    }
  };

  if (unavailable) return null;

  const configured = settings?.configured ?? false;
  const showForm = Boolean(settings?.editable) && (!configured || editing);
  const savedAt = settings?.updatedAt
    ? formatInTimeZone(settings.updatedAt, locale, undefined, { dateStyle: "medium", timeStyle: "short" })
    : null;

  return <section className="panel bug-report-relay-panel" aria-labelledby="bug-report-relay-title">
    <div className="bug-report-relay-heading">
      <Bug size={19} aria-hidden="true" />
      <div>
        <span className="eyebrow">{t("bugReport.relay.eyebrow")}</span>
        <h2 id="bug-report-relay-title">{t("bugReport.relay.title")}</h2>
        <p>{t("bugReport.relay.description")}</p>
      </div>
      <span className={`bug-report-relay-state ${configured ? "ready" : "missing"}`}>
        {configured ? <CheckCircle2 size={14} aria-hidden="true" /> : <CircleAlert size={14} aria-hidden="true" />}
        {t(configured ? "bugReport.relay.statusConfigured" : "bugReport.relay.statusMissing")}
      </span>
    </div>

    {!settings ? <p className="bug-report-relay-loading" role="status">
      <LoaderCircle className="spin" size={16} aria-hidden="true" />{t("bugReport.relay.loading")}
    </p> : <>
      {configured && <dl className="bug-report-relay-current">
        <div><dt>{t("bugReport.relay.destination")}</dt><dd><code>{settings.url}</code></dd></div>
        <div>
          <dt>{t("bugReport.relay.lastSaved")}</dt>
          <dd>{savedAt ?? t(settings.source === "environment" ? "bugReport.relay.sourceEnvironment" : "bugReport.relay.sourceStored")}</dd>
        </div>
      </dl>}

      {!settings.editable && <p className="bug-report-relay-note" role="note">
        <ShieldCheck size={15} aria-hidden="true" />{t("bugReport.relay.environmentOwned")}
      </p>}

      {showForm ? <form className="bug-report-relay-form" onSubmit={(event) => void save(event)}>
        <label className="field">
          <span>{t("bugReport.relay.destination")}</span>
          <input
            required
            type="url"
            inputMode="url"
            maxLength={BUG_REPORT_RELAY_URL_MAX_LENGTH}
            autoComplete="off"
            spellCheck={false}
            value={url}
            placeholder={t("bugReport.relay.destinationPlaceholder")}
            onChange={(event) => { setUrl(event.target.value); setFeedback(null); }}
          />
          <small>{t("bugReport.relay.destinationHelp")}</small>
        </label>
        <label className="field">
          <span>{t("bugReport.relay.token")}</span>
          <input
            required
            type={showToken ? "text" : "password"}
            minLength={BUG_REPORT_RELAY_TOKEN_MIN_LENGTH}
            autoComplete="off"
            autoCapitalize="none"
            spellCheck={false}
            value={token}
            onChange={(event) => { setToken(event.target.value); setFeedback(null); }}
          />
          <small>{t("bugReport.relay.tokenHelp", { count: BUG_REPORT_RELAY_TOKEN_MIN_LENGTH })}</small>
        </label>
        <label className="show-secret">
          <input type="checkbox" checked={showToken} onChange={(event) => setShowToken(event.target.checked)} />
          <span>{t("bugReport.relay.showToken")}</span>
        </label>
        <p className="bug-report-relay-note"><KeyRound size={15} aria-hidden="true" />{t("bugReport.relay.tokenSecurity")}</p>
        <div className="bug-report-relay-actions">
          <button type="submit" className="primary-button" disabled={saving || !url.trim() || token.trim().length < BUG_REPORT_RELAY_TOKEN_MIN_LENGTH}>
            {saving ? <LoaderCircle className="spin" size={16} aria-hidden="true" /> : <ShieldCheck size={16} aria-hidden="true" />}
            {t(saving ? "common.saving" : "bugReport.relay.save")}
          </button>
          {configured && <button type="button" className="text-button" disabled={saving} onClick={() => { setEditing(false); setToken(""); setUrl(settings.url ?? ""); setFeedback(null); }}>
            {t("common.cancel")}
          </button>}
        </div>
      </form> : settings.editable && <div className="bug-report-relay-actions">
        <button type="button" className="secondary-button" onClick={() => { setEditing(true); setToken(""); setFeedback(null); }}>
          {t("bugReport.relay.change")}
        </button>
        <button type="button" className="text-button danger-text" disabled={removing} onClick={() => void remove()}>
          {removing ? <LoaderCircle className="spin" size={15} aria-hidden="true" /> : <Trash2 size={15} aria-hidden="true" />}
          {t("bugReport.relay.remove")}
        </button>
      </div>}
    </>}

    {feedback && <p
      className={`bug-report-relay-feedback ${feedback.kind}`}
      role={feedback.kind === "error" ? "alert" : "status"}
    >
      {feedback.kind === "success" ? <CheckCircle2 size={15} aria-hidden="true" /> : <CircleAlert size={15} aria-hidden="true" />}
      {feedback.message}
    </p>}
  </section>;
}
