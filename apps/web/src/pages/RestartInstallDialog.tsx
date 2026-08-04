import { RotateCw, ShieldCheck } from "lucide-react";
import { useEffect, useRef } from "react";
import type { HostReadyToRestartBinding } from "../api";
import { useI18n } from "../i18n";

interface RestartInstallDialogProps {
  open: boolean;
  binding: HostReadyToRestartBinding | null;
  busy: boolean;
  onCancel: () => void;
  onConfirm: () => void;
}

export function RestartInstallDialog({
  open,
  binding,
  busy,
  onCancel,
  onConfirm,
}: RestartInstallDialogProps) {
  const { t } = useI18n();
  const dialogRef = useRef<HTMLDialogElement>(null);
  const cancelRef = useRef<HTMLButtonElement>(null);
  const returnFocusRef = useRef<HTMLElement | null>(null);

  useEffect(() => {
    const dialog = dialogRef.current;
    if (!dialog) return;
    if (!open) {
      if (dialog.open && typeof dialog.close === "function") dialog.close();
      else dialog.removeAttribute("open");
      const focusTarget = returnFocusRef.current;
      returnFocusRef.current = null;
      if (focusTarget?.isConnected) window.setTimeout(() => focusTarget.focus(), 0);
      return;
    }
    returnFocusRef.current = document.activeElement instanceof HTMLElement
      ? document.activeElement
      : null;
    if (!dialog.open) {
      if (typeof dialog.showModal === "function") dialog.showModal();
      else dialog.setAttribute("open", "");
    }
    cancelRef.current?.focus();
  }, [open]);

  const close = () => {
    onCancel();
  };

  return <dialog
    ref={dialogRef}
    className="restart-install-dialog"
    aria-labelledby="restart-install-title"
    aria-describedby="restart-install-summary"
    onCancel={(event) => {
      event.preventDefault();
      if (!busy) close();
    }}
  >
    {binding && <div className="restart-install-dialog__body">
      <span className="restart-install-dialog__icon" aria-hidden="true"><RotateCw size={23} /></span>
      <div className="restart-install-dialog__copy">
        <span className="eyebrow">{t("updates.restart.eyebrow")}</span>
        <h2 id="restart-install-title">{t("updates.restart.title")}</h2>
        <p id="restart-install-summary">{t("updates.restart.summary", {
          version: binding.targetVersion,
          generation: binding.targetGeneration,
        })}</p>
        <ul>
          <li>{t("updates.restart.restartCount")}</li>
          <li>{t("updates.restart.reconnect")}</li>
          <li>{t("updates.restart.fallback")}</li>
          <li>{t("updates.restart.applicationFollows")}</li>
        </ul>
        <details className="restart-install-binding">
          <summary><ShieldCheck size={15} aria-hidden="true" />{t("updates.restart.binding")}</summary>
          <dl>
            <div><dt>{t("updates.restart.operation")}</dt><dd><code>{binding.operationId}</code></dd></div>
            <div><dt>{t("updates.restart.digest")}</dt><dd><code>{binding.targetDigest}</code></dd></div>
          </dl>
        </details>
      </div>
      <div className="restart-install-dialog__actions">
        <button ref={cancelRef} type="button" className="secondary-button" disabled={busy} onClick={close}>
          {t("common.cancel")}
        </button>
        <button type="button" className="primary-button" disabled={busy} onClick={onConfirm}>
          <RotateCw size={16} aria-hidden="true" />
          {busy ? t("updates.action.restarting") : t("updates.action.restartAndInstall")}
        </button>
      </div>
    </div>}
  </dialog>;
}
