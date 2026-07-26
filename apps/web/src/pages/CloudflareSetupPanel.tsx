import { useCallback, useEffect, useId, useMemo, useRef, useState, type FormEvent } from "react";
import { CircleHelp, ExternalLink, LoaderCircle, ShieldCheck } from "lucide-react";
import {
  api,
  type CloudflareSetupOperation,
  type CloudflareSetupPhase,
  type CloudflareSetupStatus,
} from "../api";
import { useI18n, type TranslationKey } from "../i18n";

interface CloudflareSetupPanelProps {
  suggestedOrigin: string;
  onComplete: () => void | Promise<void>;
}

const activePhases = new Set<CloudflareSetupPhase>([
  "awaiting-approval",
  "queued",
  "provisioning",
  "applying",
  "verifying",
]);

const phaseLabelKeys: Record<CloudflareSetupPhase, TranslationKey> = {
  "awaiting-approval": "cloudflareSetup.phase.awaitingApproval",
  queued: "cloudflareSetup.phase.queued",
  provisioning: "cloudflareSetup.phase.provisioning",
  applying: "cloudflareSetup.phase.applying",
  verifying: "cloudflareSetup.phase.verifying",
  complete: "cloudflareSetup.phase.complete",
  failed: "cloudflareSetup.phase.failed",
};

function hostnameFromOrigin(origin: string): string {
  try {
    const hostname = new URL(origin).hostname.toLowerCase();
    return ["localhost", "127.0.0.1", "::1", "[::1]"].includes(hostname) ? "" : hostname;
  } catch {
    return "";
  }
}

function suggestedZone(hostname: string): string {
  const labels = hostname.split(".").filter(Boolean);
  return labels.length > 1 ? labels.slice(-2).join(".") : "";
}

function errorMessage(error: unknown, fallback: string): string {
  return error instanceof Error && error.message.trim() ? error.message : fallback;
}

function trustedAuthorizationUrl(value: string): string {
  const url = new URL(value);
  if (url.protocol !== "https:" || url.hostname !== "dash.cloudflare.com") {
    throw new Error("Stugu received an unexpected Cloudflare approval address.");
  }
  return url.href;
}

export function CloudflareSetupPanel({
  suggestedOrigin,
  onComplete,
}: Readonly<CloudflareSetupPanelProps>) {
  const { t } = useI18n();
  const initialHostname = useMemo(() => hostnameFromOrigin(suggestedOrigin), [suggestedOrigin]);
  const [status, setStatus] = useState<CloudflareSetupStatus | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [submitError, setSubmitError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [fallbackApprovalUrl, setFallbackApprovalUrl] = useState<string | null>(null);
  const [hostname, setHostname] = useState(initialHostname);
  const [zone, setZone] = useState(() => suggestedZone(initialHostname));
  const [ownerEmail, setOwnerEmail] = useState("");
  const [accountId, setAccountId] = useState("");
  const [zoneId, setZoneId] = useState("");
  const [oauthClientToken, setOauthClientToken] = useState("");
  const [oauthTokenHelpOpen, setOauthTokenHelpOpen] = useState(false);
  const [runtimeToken, setRuntimeToken] = useState("");
  const oauthTokenInputId = useId();
  const oauthTokenHelpId = useId();
  const hydrated = useRef(false);
  const completedOperation = useRef<string | null>(null);

  const refresh = useCallback(async () => {
    try {
      const next = await api.cloudflareSetupStatus();
      setStatus(next);
      setLoadError(null);
      if (!hydrated.current) {
        const configuredHostname = next.configuration.hostname ?? initialHostname;
        setHostname(configuredHostname);
        setZone(next.configuration.suggestedZone ?? suggestedZone(configuredHostname));
        setOwnerEmail(next.configuration.ownerEmail ?? "");
        hydrated.current = true;
      }
    } catch (error) {
      setLoadError(errorMessage(error, t("cloudflareSetup.loadFailed")));
    }
  }, [initialHostname, t]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const operation = status?.operation ?? null;
  const operationActive = Boolean(operation && activePhases.has(operation.phase));

  useEffect(() => {
    if (!operationActive) return undefined;
    const timer = window.setInterval(() => void refresh(), 3_000);
    return () => window.clearInterval(timer);
  }, [operationActive, refresh]);

  useEffect(() => {
    if (operation?.phase !== "complete" || completedOperation.current === operation.id) return;
    completedOperation.current = operation.id;
    void onComplete();
  }, [onComplete, operation]);

  useEffect(() => {
    if (hydrated.current || !initialHostname) return;
    setHostname(initialHostname);
    setZone(suggestedZone(initialHostname));
  }, [initialHostname]);

  async function requestApproval(): Promise<void> {
    setSubmitting(true);
    setSubmitError(null);
    setFallbackApprovalUrl(null);
    const popup = window.open(
      "about:blank",
      "stugu-cloudflare-approval",
      "popup,width=720,height=780",
    );
    try {
      const result = await api.startCloudflareSetup({
        mode: "stuguby-coordinator",
        hostname: hostname.trim(),
        zone: zone.trim(),
        ownerEmail: ownerEmail.trim(),
        accountId: accountId.trim() || null,
        zoneId: zoneId.trim() || null,
        oauthClientToken: status?.configuration.oauthClientConfigured ? null : oauthClientToken,
        runtimeToken: status?.configuration.runtimeTokenAvailable ? null : runtimeToken,
      });
      const authorizationUrl = trustedAuthorizationUrl(result.authorizationUrl);
      setStatus((current) => current ? { ...current, operation: result.operation } : current);
      setOauthClientToken("");
      setRuntimeToken("");
      if (popup) {
        try {
          popup.opener = null;
          popup.location.replace(authorizationUrl);
        } catch {
          popup.close();
          setFallbackApprovalUrl(authorizationUrl);
        }
      } else {
        setFallbackApprovalUrl(authorizationUrl);
      }
    } catch (error) {
      popup?.close();
      setOauthClientToken("");
      setRuntimeToken("");
      setSubmitError(errorMessage(error, t("cloudflareSetup.startFailed")));
      await refresh();
    } finally {
      setSubmitting(false);
    }
  }

  async function startSetup(event: FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();
    await requestApproval();
  }

  if (!status) {
    return <div className="cloudflare-setup-loading" aria-live="polite">
      {loadError
        ? <p className="inline-error" role="alert">{loadError}</p>
        : <><LoaderCircle className="spin" size={18} aria-hidden="true" /><span>{t("cloudflareSetup.loading")}</span></>}
      {loadError && <button type="button" className="secondary-button" onClick={() => void refresh()}>{t("stuguby.retry")}</button>}
    </div>;
  }

  if (!status.canConfigure) {
    return <div className="stuguby-setup-required" role="note">
      <ShieldCheck size={20} aria-hidden="true" />
      <div>
        <strong>{t("cloudflareSetup.localOnlyTitle")}</strong>
        <p>{t("cloudflareSetup.localOnlyBody")}</p>
        <a href={status.localConfigureUrl}>{t("cloudflareSetup.openLocal")}</a>
      </div>
    </div>;
  }

  if (!status.capability.available) {
    const upgradeRequired = status.capability.reason === "agent-upgrade-required";
    return <div className="stuguby-setup-required" role="note">
      <ShieldCheck size={20} aria-hidden="true" />
      <div>
        <strong>{t(upgradeRequired ? "cloudflareSetup.agentUpgradeTitle" : "cloudflareSetup.agentOfflineTitle")}</strong>
        <p>{t(upgradeRequired ? "cloudflareSetup.agentUpgradeBody" : "cloudflareSetup.agentOfflineBody")}</p>
      </div>
    </div>;
  }

  return <form className="cloudflare-setup-form" onSubmit={(event) => void startSetup(event)}>
    <div className="stuguby-setup-required" role="note">
      <ShieldCheck size={20} aria-hidden="true" />
      <div><strong>{t("stuguby.secureSharingTitle")}</strong><p>{t("cloudflareSetup.intro")}</p></div>
    </div>

    {operation && <div
      className={`cloudflare-setup-operation is-${operation.phase}`}
      role={operation.phase === "failed" ? "alert" : "status"}
      aria-live="polite"
    >
      {operationActive && <LoaderCircle className="spin" size={18} aria-hidden="true" />}
      <div>
        <strong>{t(phaseLabelKeys[operation.phase])}</strong>
        {operation.phase === "failed" && operation.detail && <p>{operation.detail}</p>}
        {operation.phase === "awaiting-approval" && <button
          type="button"
          className="secondary-button"
          disabled={submitting}
          onClick={() => void requestApproval()}
        >
          {submitting && <LoaderCircle className="spin" size={16} aria-hidden="true" />}
          {t(submitting ? "cloudflareSetup.starting" : "cloudflareSetup.reopenApproval")}
        </button>}
      </div>
    </div>}

    {fallbackApprovalUrl && <p className="cloudflare-setup-approval" role="status">
      {t("cloudflareSetup.popupBlocked")}{" "}
      <a href={fallbackApprovalUrl} target="_blank" rel="noreferrer">
        {t("cloudflareSetup.openApproval")} <ExternalLink size={14} aria-hidden="true" />
      </a>
    </p>}

    {!operationActive && operation?.phase !== "complete" && <>
      <div className="cloudflare-setup-grid">
        <label className="field">
          <span>{t("cloudflareSetup.hostname")}</span>
          <input required inputMode="url" spellCheck={false} value={hostname} onChange={(event) => setHostname(event.target.value)} placeholder={t("cloudflareSetup.hostnamePlaceholder")} />
          <small>{t("cloudflareSetup.hostnameHelp")}</small>
        </label>
        <label className="field">
          <span>{t("cloudflareSetup.zone")}</span>
          <input required inputMode="url" spellCheck={false} value={zone} onChange={(event) => setZone(event.target.value)} placeholder={t("cloudflareSetup.zonePlaceholder")} />
          <small>{t("cloudflareSetup.zoneHelp")}</small>
        </label>
      </div>
      <label className="field">
        <span>{t("cloudflareSetup.ownerEmail")}</span>
        <input required type="email" autoComplete="email" value={ownerEmail} onChange={(event) => setOwnerEmail(event.target.value)} />
        <small>{t("cloudflareSetup.ownerEmailHelp")}</small>
      </label>

      {!status.configuration.oauthClientConfigured && <div className="field">
        <label htmlFor={oauthTokenInputId}>{t("cloudflareSetup.oauthToken")}</label>
        <input
          id={oauthTokenInputId}
          required
          type="password"
          autoComplete="off"
          spellCheck={false}
          value={oauthClientToken}
          aria-describedby={oauthTokenHelpOpen ? oauthTokenHelpId : undefined}
          onChange={(event) => setOauthClientToken(event.target.value)}
        />
        <button
          type="button"
          className="text-button cloudflare-token-help-toggle"
          aria-expanded={oauthTokenHelpOpen}
          aria-controls={oauthTokenHelpId}
          onClick={() => setOauthTokenHelpOpen((open) => !open)}
        >
          <CircleHelp size={14} aria-hidden="true" />
          {t(oauthTokenHelpOpen ? "cloudflareSetup.hideOauthTokenHelp" : "cloudflareSetup.showOauthTokenHelp")}
        </button>
        <div id={oauthTokenHelpId} className="cloudflare-token-help" hidden={!oauthTokenHelpOpen}>
          <ol>
            <li>
              <a href="https://dash.cloudflare.com/profile/api-tokens" target="_blank" rel="noreferrer">
                {t("cloudflareSetup.createToken")} <ExternalLink size={13} aria-hidden="true" />
              </a>
            </li>
            <li>{t("cloudflareSetup.oauthTokenScopeStep")}</li>
            <li>{t("cloudflareSetup.oauthTokenAccountStep")}</li>
            <li>{t("cloudflareSetup.oauthTokenOptionalStep")}</li>
            <li>{t("cloudflareSetup.oauthTokenUseStep")}</li>
          </ol>
        </div>
      </div>}

      {!status.configuration.runtimeTokenAvailable && <label className="field">
        <span>{t("cloudflareSetup.runtimeToken")}</span>
        <input required type="password" autoComplete="off" spellCheck={false} value={runtimeToken} onChange={(event) => setRuntimeToken(event.target.value)} />
        <small>{t("cloudflareSetup.runtimeTokenHelp")}</small>
      </label>}

      <details className="stuguby-subdetails">
        <summary>{t("nav.advanced")}</summary>
        <div className="stuguby-subdetails-body cloudflare-setup-grid">
          {!status.configuration.accountIdKnown && <label className="field">
            <span>{t("cloudflareSetup.accountId")}</span>
            <input maxLength={32} spellCheck={false} value={accountId} onChange={(event) => setAccountId(event.target.value)} />
          </label>}
          {!status.configuration.zoneIdKnown && <label className="field">
            <span>{t("cloudflareSetup.zoneId")}</span>
            <input maxLength={32} spellCheck={false} value={zoneId} onChange={(event) => setZoneId(event.target.value)} />
          </label>}
          <small>{t("cloudflareSetup.idsHelp")}</small>
        </div>
      </details>

      {submitError && <p className="inline-error" role="alert">{submitError}</p>}
      <button className="primary-button" disabled={submitting}>
        {submitting ? <LoaderCircle className="spin" size={16} aria-hidden="true" /> : <ShieldCheck size={16} aria-hidden="true" />}
        {t(submitting ? "cloudflareSetup.starting" : operation?.phase === "failed" ? "cloudflareSetup.tryAgain" : "cloudflareSetup.begin")}
      </button>
      <p className="cloudflare-setup-privacy">{t("cloudflareSetup.privacy")}</p>
    </>}
  </form>;
}

export const cloudflareSetupActive = (operation: CloudflareSetupOperation | null): boolean => (
  Boolean(operation && activePhases.has(operation.phase))
);
