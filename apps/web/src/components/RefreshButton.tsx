import { RefreshCw } from "lucide-react";
import { useI18n } from "../i18n";

interface RefreshButtonProps {
  onClick: () => void;
  /** True from the click until the new data or result is in place, not only while a request is open. */
  busy: boolean;
  disabled?: boolean;
  label?: string;
  busyLabel?: string;
  className?: string;
}

/**
 * A refresh action that says what it is doing: the label changes while busy,
 * so progress shows even where reduced motion keeps the icon still.
 */
export function RefreshButton({ onClick, busy, disabled = false, label, busyLabel, className = "secondary-button" }: Readonly<RefreshButtonProps>) {
  const { t } = useI18n();
  return <button type="button" className={className} onClick={onClick} disabled={busy || disabled} aria-busy={busy}>
    <RefreshCw className={busy ? "spin" : ""} size={14} aria-hidden="true" />
    {busy ? busyLabel ?? t("common.refreshing") : label ?? t("common.refresh")}
  </button>;
}
