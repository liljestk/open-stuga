import { CircleDashed, Clock3, Info, TriangleAlert } from "lucide-react";
import type { DurableDerivedAnalyticsResponse } from "@climate-twin/contracts";
import { useI18n, type TranslationKey } from "../i18n";
import { useNow } from "../useNow";

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

function stateCopy(
  status: DurableDerivedAnalyticsResponse<unknown>,
  canRefresh: boolean,
): TranslationKey {
  if (status.state === "failed" && status.artifact === null) return "derived.failedNoResult";
  if (status.state === "idle") return canRefresh ? "derived.idle" : "derived.idleReadOnly";
  return `derived.${status.state}`;
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
  status: DurableDerivedAnalyticsResponse<unknown> | null,
): TranslationKey | null {
  if (status?.state !== "failed") return null;
  const code = status.job?.errorCode;
  return code ? FAILURE_REASON_KEYS.get(code) ?? null : null;
}

export function DerivedArtifactNotices({
  status,
  hasResult,
  canRefresh,
}: Readonly<DerivedArtifactNoticesProps>) {
  const { locale, t } = useI18n();
  const now = useNow();
  const generated = status?.artifact ? artifactTime(status.artifact.generatedAt, locale, now) : null;
  const StateIcon = status?.state === "failed"
    ? TriangleAlert
    : status?.state === "idle"
      ? Info
      : CircleDashed;

  const reasonKey = failureReasonKey(status);

  return <>
    {status && status.state !== "ready" && <p className="home-performance-notice" role="status">
      <StateIcon size={15} aria-hidden="true" />{t(stateCopy(status, canRefresh))}
    </p>}
    {reasonKey && <p className="home-performance-notice" role="status">
      <Info size={15} aria-hidden="true" />{t(reasonKey)}
    </p>}
    {status?.stale && hasResult && <p className="home-performance-notice" role="status">
      <TriangleAlert size={15} aria-hidden="true" />{t("derived.stale")}
    </p>}
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
