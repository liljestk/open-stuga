import { useEffect, useRef, useState, type ReactNode } from "react";
import { AlertTriangle } from "lucide-react";
import { useI18n } from "../i18n";
import "./ConfirmationProvider.css";

interface ConfirmationRequest {
  message: string;
  confirmLabel: string;
  destructive: boolean;
  returnFocus: HTMLElement | null;
  resolve: (confirmed: boolean) => void;
}

type ConfirmationHandler = (message: string, confirmLabel: string, destructive: boolean) => Promise<boolean>;

let confirmationHandler: ConfirmationHandler | null = null;

export function confirmAction(message: string, confirmLabel: string, destructive = true): Promise<boolean> {
  if (confirmationHandler) return confirmationHandler(message, confirmLabel, destructive);
  return Promise.resolve(false);
}

export function ConfirmationProvider({ children }: Readonly<{ children: ReactNode }>) {
  const { t } = useI18n();
  const [active, setActive] = useState<ConfirmationRequest | null>(null);
  const activeRef = useRef<ConfirmationRequest | null>(null);
  const queueRef = useRef<ConfirmationRequest[]>([]);
  const dialogRef = useRef<HTMLDialogElement>(null);
  const cancelRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    const handle: ConfirmationHandler = (message, confirmLabel, destructive) => new Promise<boolean>((resolve) => {
      const request = {
        message,
        confirmLabel,
        destructive,
        returnFocus: document.activeElement instanceof HTMLElement ? document.activeElement : null,
        resolve,
      };
      if (activeRef.current) {
        queueRef.current.push(request);
        return;
      }
      activeRef.current = request;
      setActive(request);
    });
    confirmationHandler = handle;
    return () => {
      if (confirmationHandler === handle) confirmationHandler = null;
      activeRef.current?.resolve(false);
      for (const request of queueRef.current) request.resolve(false);
      queueRef.current = [];
    };
  }, []);

  useEffect(() => {
    if (!active) return;
    const dialog = dialogRef.current;
    if (dialog && !dialog.open) {
      if (typeof dialog.showModal === "function") dialog.showModal();
      else dialog.setAttribute("open", "");
    }
    cancelRef.current?.focus();
  }, [active]);

  const settle = (confirmed: boolean) => {
    const current = activeRef.current;
    if (!current) return;
    const dialog = dialogRef.current;
    if (dialog && typeof dialog.close === "function") dialog.close();
    else dialog?.removeAttribute("open");
    current.resolve(confirmed);
    const next = queueRef.current.shift() ?? null;
    activeRef.current = next;
    setActive(next);
    if (!next) current.returnFocus?.focus();
  };

  return <>
    {children}
    <dialog
      ref={dialogRef}
      className="confirmation-dialog"
      aria-labelledby={active ? "confirmation-title" : undefined}
      aria-describedby={active ? "confirmation-message" : undefined}
      onCancel={(event) => {
        event.preventDefault();
        settle(false);
      }}
      onKeyDown={(event) => {
        if (event.key === "Escape") {
          event.preventDefault();
          settle(false);
        }
      }}
    >
      {active && <div className="confirmation-dialog__body">
        <span className={`confirmation-dialog__icon ${active.destructive ? "destructive" : "caution"}`} aria-hidden="true"><AlertTriangle size={22} /></span>
        <div>
          <h2 id="confirmation-title">{active.confirmLabel}</h2>
          <p id="confirmation-message">{active.message}</p>
        </div>
        <div className="confirmation-dialog__actions">
          <button ref={cancelRef} type="button" className="secondary-button" onClick={() => settle(false)}>{t("common.cancel")}</button>
          <button type="button" className={active.destructive ? "danger-button" : "primary-button"} onClick={() => settle(true)}>{active.confirmLabel}</button>
        </div>
      </div>}
    </dialog>
  </>;
}
