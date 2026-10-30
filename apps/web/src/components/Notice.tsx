import { CircleDashed, Info, TriangleAlert, X } from "lucide-react";
import { useState, type ReactNode } from "react";
import { readLocalStorage, writeLocalStorage } from "../browserStorage";
import { useI18n } from "../i18n";
import "./Notice.css";

export type NoticeTone = "info" | "warning" | "progress";

const DISMISSED_NOTICES_KEY = "climate-twin-dismissed-notices";
const TONE_ICONS = { info: Info, warning: TriangleAlert, progress: CircleDashed } as const;

function dismissedNotices(): Record<string, string> {
  try {
    const parsed: unknown = JSON.parse(readLocalStorage(DISMISSED_NOTICES_KEY) ?? "{}");
    return parsed && typeof parsed === "object" ? parsed as Record<string, string> : {};
  } catch {
    return {};
  }
}

interface NoticeProps {
  tone: NoticeTone;
  title: ReactNode;
  children?: ReactNode;
  /**
   * Names this notice's place in the UI so the viewer can hide it. A hidden
   * notice comes back as soon as its `fingerprint` changes, so closing "the
   * update failed" never hides a later, different failure.
   */
  dismissKey?: string;
  fingerprint?: string;
  className?: string;
}

/** One message with a title, optional detail and, when it has a `dismissKey`, a way to hide it. */
export function Notice({ tone, title, children, dismissKey, fingerprint = "", className = "" }: Readonly<NoticeProps>) {
  const { t } = useI18n();
  const [dismissed, setDismissed] = useState(dismissedNotices);
  if (dismissKey !== undefined && dismissed[dismissKey] === fingerprint) return null;
  const Icon = TONE_ICONS[tone];
  const dismiss = () => {
    if (dismissKey === undefined) return;
    const next = { ...dismissedNotices(), [dismissKey]: fingerprint };
    writeLocalStorage(DISMISSED_NOTICES_KEY, JSON.stringify(next));
    setDismissed(next);
  };
  return <div className={`notice ${tone} ${className}`.trim()} role="status">
    <Icon size={16} aria-hidden="true" />
    <div className="notice-copy">
      <strong>{title}</strong>
      {children && <div className="notice-body">{children}</div>}
    </div>
    {dismissKey !== undefined && <button type="button" className="notice-dismiss" onClick={dismiss} aria-label={t("notice.dismiss")} title={t("notice.dismiss")}>
      <X size={15} aria-hidden="true" />
    </button>}
  </div>;
}
