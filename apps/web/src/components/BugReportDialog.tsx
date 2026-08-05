import { useEffect, useMemo, useRef, useState, type FormEvent } from "react";
import { Bug, Download, Send, X } from "lucide-react";
import { BUG_REPORT_DESCRIPTION_MAX_LENGTH, type BugReportDiagnostics, type BugReportReceipt } from "@climate-twin/contracts";
import type { AppPage } from "../domain";
import { api, ApiRequestError } from "../api";
import { buildBugReportDiagnostics } from "../bugReportDiagnostics";
import { useI18n } from "../i18n";
import "./BugReportDialog.css";

interface BugReportDialogProps {
  page: AppPage;
  principalEmail?: string | null;
}

function downloadReport(value: unknown): void {
  const url = URL.createObjectURL(new Blob([`${JSON.stringify(value, null, 2)}\n`], { type: "application/json" }));
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = `stugu-bug-report-${new Date().toISOString().replace(/[:.]/gu, "-")}.json`;
  anchor.style.display = "none";
  document.body.append(anchor);
  anchor.click();
  anchor.remove();
  window.setTimeout(() => URL.revokeObjectURL(url), 0);
}

export function BugReportDialog({ page, principalEmail = null }: BugReportDialogProps) {
  const { locale, t } = useI18n();
  const triggerRef = useRef<HTMLButtonElement>(null);
  const dialogRef = useRef<HTMLDialogElement>(null);
  const descriptionRef = useRef<HTMLTextAreaElement>(null);
  const [open, setOpen] = useState(false);
  const [description, setDescription] = useState("");
  const [includeDiagnostics, setIncludeDiagnostics] = useState(true);
  const [contactAllowed, setContactAllowed] = useState(false);
  const [diagnostics, setDiagnostics] = useState<BugReportDiagnostics | null>(null);
  const [sending, setSending] = useState(false);
  const [receipt, setReceipt] = useState<BugReportReceipt | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [unconfigured, setUnconfigured] = useState(false);

  const payload = useMemo(() => ({
    description: description.trim(),
    ...(includeDiagnostics && diagnostics ? { diagnostics } : {}),
    ...(contactAllowed && principalEmail ? { contactEmail: principalEmail } : {}),
  }), [contactAllowed, description, diagnostics, includeDiagnostics, principalEmail]);

  useEffect(() => {
    const dialog = dialogRef.current;
    if (!dialog) return;
    if (open && !dialog.open) {
      if (typeof dialog.showModal === "function") dialog.showModal();
      else dialog.setAttribute("open", "");
      descriptionRef.current?.focus();
    } else if (!open && dialog.open) {
      if (typeof dialog.close === "function") dialog.close();
      else dialog.removeAttribute("open");
    }
  }, [open]);

  const show = () => {
    setDiagnostics(buildBugReportDiagnostics(page, locale));
    setReceipt(null);
    setError(null);
    setUnconfigured(false);
    setOpen(true);
  };

  const close = () => {
    setOpen(false);
    setSending(false);
    window.setTimeout(() => triggerRef.current?.focus(), 0);
  };

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (payload.description.length < 3 || sending) return;
    setSending(true);
    setError(null);
    try {
      setReceipt(await api.reportBug(payload));
      setUnconfigured(false);
    } catch (caught) {
      const missingRelay = caught instanceof ApiRequestError && caught.code === "BUG_REPORTING_UNAVAILABLE";
      setUnconfigured(missingRelay);
      setError(t(missingRelay ? "bugReport.errorUnavailable" : "bugReport.error"));
    } finally {
      setSending(false);
    }
  };

  return <>
    <button ref={triggerRef} type="button" className="bug-report-trigger" onClick={show}>
      <Bug size={15} aria-hidden="true" />
      <span>{t("bugReport.trigger")}</span>
    </button>
    <dialog
      ref={dialogRef}
      className="bug-report-dialog"
      aria-labelledby="bug-report-title"
      onCancel={(event) => { event.preventDefault(); close(); }}
      onClose={() => { if (open) close(); }}
    >
      <div className="bug-report-dialog__header">
        <div><span className="bug-report-dialog__eyebrow">{t("bugReport.eyebrow")}</span><h2 id="bug-report-title">{t("bugReport.title")}</h2></div>
        <button type="button" className="icon-button" aria-label={t("common.close")} onClick={close}><X size={18} aria-hidden="true" /></button>
      </div>
      {receipt ? <div className="bug-report-dialog__success" role="status">
        <h3>{t("bugReport.successTitle")}</h3>
        <p>{t("bugReport.successBody")}</p>
        <p><strong>{t("bugReport.reportId")}</strong> <code>{receipt.reportId}</code></p>
        <button type="button" className="primary-button" onClick={close}>{t("common.close")}</button>
      </div> : <form onSubmit={(event) => void submit(event)}>
        <p className="bug-report-dialog__intro">{t("bugReport.intro")}</p>
        <label className="bug-report-dialog__description">
          <span>{t("bugReport.descriptionLabel")}</span>
          <textarea
            ref={descriptionRef}
            required
            minLength={3}
            maxLength={BUG_REPORT_DESCRIPTION_MAX_LENGTH}
            rows={6}
            value={description}
            placeholder={t("bugReport.descriptionHint")}
            onChange={(event) => setDescription(event.target.value)}
          />
        </label>
        <label className="bug-report-dialog__choice">
          <input type="checkbox" checked={includeDiagnostics} onChange={(event) => setIncludeDiagnostics(event.target.checked)} />
          <span><strong>{t("bugReport.includeDiagnostics")}</strong><small>{t("bugReport.diagnosticsPrivacy")}</small></span>
        </label>
        {includeDiagnostics && diagnostics && <details className="bug-report-dialog__details">
          <summary>{t("bugReport.reviewDiagnostics")}</summary>
          <pre>{JSON.stringify(diagnostics, null, 2)}</pre>
        </details>}
        {principalEmail && <label className="bug-report-dialog__choice">
          <input type="checkbox" checked={contactAllowed} onChange={(event) => setContactAllowed(event.target.checked)} />
          <span>{t("bugReport.contact", { email: principalEmail })}</span>
        </label>}
        {error && <p className="bug-report-dialog__error" role="alert">{error}{unconfigured && <small>{t("bugReport.errorUnavailableHelp")}</small>}</p>}
        <div className="bug-report-dialog__actions">
          <button type="button" className="secondary-button" onClick={() => downloadReport(payload)}><Download size={15} aria-hidden="true" />{t("bugReport.download")}</button>
          <span />
          <button type="button" className="secondary-button" onClick={close}>{t("common.cancel")}</button>
          <button type="submit" className="primary-button" disabled={sending || payload.description.length < 3}><Send size={15} aria-hidden="true" />{t(sending ? "bugReport.sending" : "bugReport.send")}</button>
        </div>
      </form>}
    </dialog>
  </>;
}
