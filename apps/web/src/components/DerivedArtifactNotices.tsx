import { Clock3 } from "lucide-react";
import type { DurableDerivedAnalyticsResponse } from "@climate-twin/contracts";
import { useI18n, type TranslationKey } from "../i18n";
import { useNow } from "../useNow";
import { Notice, type NoticeTone } from "./Notice";

interface DerivedArtifactNoticesProps {
  status: DurableDerivedAnalyticsResponse<unknown> | null;
  hasResult: boolean;
  canRefresh: boolean;
}

function artifactTime(generatedAt: string, locale: string, now: number): {
  absolute: string;
  relative: string;
} | null {
  const timestamp = Date.parse(generatedAt);
  if (!Number.isFinite(timestamp)) return null;
  const differenceMs = timestamp - now;
  const absoluteDifferenceMs = Math.abs(differenceMs);
  const [divisor, unit]: [number, Intl.RelativeTimeFormatUnit] = absoluteDifferenceMs < 60_000
    ? [1_000, "second"]
    : absoluteDifferenceMs < 3_600_000
      ? [60_000, "minute"]
      : absoluteDifferenceMs < 86_400_000
        ? [3_600_000, "hour"]
        : [86_400_000, "day"];
  return {
    absolute: new Intl.DateTimeFormat(locale, { dateStyle: "medium", timeStyle: "short" }).format(timestamp),
    relative: new Intl.RelativeTimeFormat(locale, { numeric: "auto" }).format(Math.round(differenceMs / divisor), unit),
  };
}

// A Map rather than an object literal: the code is a server-stored string, and
// an object lookup would also find Object.prototype members ("constructor").
const FAILURE_REASON_KEYS: ReadonlyMap<string, TranslationKey> = new Map<string, TranslationKey>([
  ["HVAC_EVIDENCE_INSUFFICIENT", "derived.failedReason.hvacEvidence"],
  ["THERMAL_SCOPE_TOO_LARGE", "isolation.errorScopeHelp"],
  ["MOISTURE_SCOPE_TOO_LARGE", "moisture.errorScopeHelp"],
  ["HOME_PERFORMANCE_SCOPE_TOO_LARGE", "derived.failedReason.homePerformanceScope"],
  ["DERIVED_ARTIFACT_TOO_LARGE", "derived.failedReason.artifactSize"],
]);

function failureReasonKey(
  status: DurableDerivedAnalyticsResponse<unknown>,
): TranslationKey | null {
  if (status.state !== "failed") return null;
  const code = status.job?.errorCode;
  return code ? FAILURE_REASON_KEYS.get(code) ?? null : null;
}

interface DerivedNoticeCopy {
  tone: NoticeTone;
  title: TranslationKey;
  body: TranslationKey[];
}

/**
 * One notice per state. A failed refresh with a saved result used to show
 * "the update failed", the failure reason and "newer evidence is prepared"
 * as three separate warnings, the last one untrue once the job had failed.
 */
export function derivedNoticeCopy(
  status: DurableDerivedAnalyticsResponse<unknown>,
  hasResult: boolean,
  canRefresh: boolean,
): DerivedNoticeCopy | null {
  if (status.state === "idle") return { tone: "info", title: "derived.idleTitle", body: [canRefresh ? "derived.idle" : "derived.idleReadOnly"] };
  if (status.state === "queued" || status.state === "refreshing") {
    return { tone: "progress", title: `derived.${status.state}`, body: [hasResult ? "derived.keepsResult" : "derived.firstResult"] };
  }
  if (status.state === "failed") return failedNoticeCopy(status, hasResult);
  return status.stale && hasResult ? { tone: "info", title: "derived.staleTitle", body: ["derived.stale"] } : null;
}

function failedNoticeCopy(status: DurableDerivedAnalyticsResponse<unknown>, hasResult: boolean): DerivedNoticeCopy {
  const reason = failureReasonKey(status);
  const body: TranslationKey[] = reason ? [reason] : [];
  if (hasResult) body.push("derived.failedKeepsResult");
  if (status.job?.nextAttemptAt) body.push("derived.retriesAutomatically");
  return { tone: "warning", title: hasResult ? "derived.failed" : "derived.failedNoResult", body };
}

export function DerivedArtifactNotices({
  status,
  hasResult,
  canRefresh,
}: Readonly<DerivedArtifactNoticesProps>) {
  const { locale, t } = useI18n();
  const now = useNow();
  const generated = status?.artifact ? artifactTime(status.artifact.generatedAt, locale, now) : null;
  const copy = status ? derivedNoticeCopy(status, hasResult, canRefresh) : null;

  return <>
    {status && copy && <Notice
      tone={copy.tone}
      title={t(copy.title)}
      {...(copy.tone === "progress" ? {} : {
        dismissKey: `derived:${status.kind}:${status.houseId}:${status.dataMode}`,
        fingerprint: [status.state, status.job?.errorCode ?? "", status.artifact?.id ?? "", status.stale].join(":"),
      })}
    >
      {copy.body.map((key) => <p key={key}>{t(key)}</p>)}
    </Notice>}
    {status?.artifact && generated && <small className="derived-artifact-age">
      <Clock3 size={14} aria-hidden="true" />
      <span>{t("derived.generatedAt")} <time
        dateTime={status.artifact.generatedAt}
        title={generated.absolute}
        aria-label={`${generated.relative}; ${generated.absolute}`}
      >{generated.relative}</time></span>
    </small>}
  </>;
}
