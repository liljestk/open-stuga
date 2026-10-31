import { useCallback, useEffect, useState } from "react";
import { roleCanManageWorkspace, type AssistantAuthorizationDecision, type AssistantAuthorizationPreview } from "@climate-twin/contracts";
import { AlertTriangle, Check, CircleSlash, LoaderCircle, RotateCcw, ShieldCheck, X } from "lucide-react";
import { api, ApiRequestError } from "../api";
import { assistantNameKey } from "../assistantConnector";
import { StuguMark } from "../components/StuguMark";
import { useI18n, type TranslationKey } from "../i18n";
import { LocalAuthPage } from "./LocalAuthPage";
import "./AssistantConsentPage.css";

type BlockedKind = "setup" | "adminOnly" | "unavailable" | "unknownClient" | "invalid";

type ConsentState =
  | { kind: "checking" | "login" | "redirecting" }
  | { kind: BlockedKind }
  | { kind: "ready"; preview: AssistantAuthorizationPreview; email: string };

const blockedCopy: Record<BlockedKind, { title: TranslationKey; body: TranslationKey }> = {
  setup: { title: "assistantConnector.setupTitle", body: "assistantConnector.setupBody" },
  adminOnly: { title: "assistantConnector.adminOnlyTitle", body: "assistantConnector.adminOnlyBody" },
  unavailable: { title: "assistantConnector.unavailableTitle", body: "assistantConnector.unavailableBody" },
  unknownClient: { title: "assistantConnector.invalidTitle", body: "assistantConnector.unknownClientBody" },
  invalid: { title: "assistantConnector.invalidTitle", body: "assistantConnector.invalidBody" },
};

function failedPreviewState(error: unknown): ConsentState {
  if (!(error instanceof ApiRequestError)) return { kind: "unavailable" };
  if (error.code === "ASSISTANT_AUTHORIZATION_INVALID") return { kind: "invalid" };
  if (error.status === 400) return { kind: "unknownClient" };
  return { kind: error.status === 401 ? "login" : "unavailable" };
}

/** Signs the person in if needed, then checks the request before anything is shown as approvable. */
async function consentState(query: string): Promise<ConsentState> {
  let session;
  try {
    session = await api.session();
  } catch (error) {
    return { kind: error instanceof ApiRequestError && error.status === 401 ? "login" : "unavailable" };
  }
  if (session.setupRequired) return { kind: "setup" };
  if (!session.authenticated) return { kind: "login" };
  if (!roleCanManageWorkspace(session.tenant.role)) return { kind: "adminOnly" };
  try {
    return { kind: "ready", preview: await api.assistantAuthorizationPreview(query), email: session.principal.email ?? "" };
  } catch (error) {
    return failedPreviewState(error);
  }
}

interface AssistantConsentPageProps {
  /** The OAuth authorization query the page was opened with, without the leading "?". */
  query?: string;
  /** Leaves Stugu for the assistant's callback. */
  leave?: (url: string) => void;
}

/**
 * OAuth's authorization endpoint for assistant connections. It renders on its
 * own, outside the workspace shell, and only an Owner or Admin can approve.
 */
export function AssistantConsentPage({
  query = window.location.search.replace(/^\?/u, ""),
  leave = (url) => window.location.assign(url),
}: Readonly<AssistantConsentPageProps>) {
  const { t } = useI18n();
  const [state, setState] = useState<ConsentState>({ kind: "checking" });
  const [pending, setPending] = useState<AssistantAuthorizationDecision | null>(null);
  const [decisionFailed, setDecisionFailed] = useState(false);

  const load = useCallback(() => {
    setState({ kind: "checking" });
    void consentState(query).then(setState);
  }, [query]);

  useEffect(() => {
    load();
  }, [load]);

  const decide = async (decision: AssistantAuthorizationDecision) => {
    setPending(decision);
    setDecisionFailed(false);
    try {
      const { redirectUrl } = await api.decideAssistantAuthorization({ query, decision });
      setState({ kind: "redirecting" });
      leave(redirectUrl);
    } catch {
      setDecisionFailed(true);
    } finally {
      setPending(null);
    }
  };

  if (state.kind === "login") return <LocalAuthPage mode="login" onAuthenticated={load} onAuthStateChanged={load} />;

  const progress = (label: TranslationKey) => (
    <output className="bootstrap-card assistant-consent-card" aria-live="polite">
      <StuguMark />
      <span className="bootstrap-icon" aria-hidden="true"><LoaderCircle className="spin" size={22} /></span>
      <div><h1>{t(label)}</h1></div>
    </output>
  );

  const blocked = (kind: BlockedKind) => (
    <section className="bootstrap-card assistant-consent-card" aria-labelledby="assistant-consent-title">
      <StuguMark />
      <span className="bootstrap-icon exception" aria-hidden="true">{kind === "adminOnly" ? <CircleSlash size={22} /> : <AlertTriangle size={22} />}</span>
      <div><span className="eyebrow">{t("assistantConnector.consentEyebrow")}</span><h1 id="assistant-consent-title">{t(blockedCopy[kind].title)}</h1><p>{t(blockedCopy[kind].body)}</p></div>
      {kind === "unavailable" && <button type="button" className="primary-button" onClick={load}><RotateCcw size={16} aria-hidden="true" />{t("assistantConnector.retry")}</button>}
      {kind === "invalid" && <button type="button" className="primary-button" disabled={pending !== null} onClick={() => void decide("deny")}>{t("assistantConnector.returnToAssistant")}</button>}
      {decisionFailed && <p className="inline-error" role="alert">{t("assistantConnector.decisionFailed")}</p>}
    </section>
  );

  const approval = (preview: AssistantAuthorizationPreview, email: string) => {
    const assistant = t(assistantNameKey(preview.assistant));
    return (
      <section className="bootstrap-card assistant-consent-card" aria-labelledby="assistant-consent-title">
        <StuguMark />
        <span className="bootstrap-icon" aria-hidden="true"><ShieldCheck size={22} /></span>
        <div><span className="eyebrow">{t("assistantConnector.consentEyebrow")}</span><h1 id="assistant-consent-title">{t("assistantConnector.consentTitle", { assistant })}</h1><p>{t("assistantConnector.consentBody", { assistant })}</p></div>
        <dl className="assistant-consent-facts">
          <div><dt>{t("assistantConnector.requestedBy")}</dt><dd>{preview.redirectOrigin}</dd></div>
          {preview.clientName && <div><dt>{t("assistantConnector.registeredAs")}</dt><dd>{preview.clientName}</dd></div>}
          <div><dt>{t("assistantConnector.signedInAs")}</dt><dd>{email}</dd></div>
        </dl>
        <div className="assistant-consent-scope">
          <div><h2><Check size={16} aria-hidden="true" />{t("assistantConnector.canTitle")}</h2><p>{t("assistantConnector.canList")}</p></div>
          <div><h2><X size={16} aria-hidden="true" />{t("assistantConnector.cannotTitle")}</h2><p>{t("assistantConnector.cannotList")}</p></div>
        </div>
        <p className="assistant-consent-privacy">{t("assistantConnector.privacy", { assistant })}</p>
        {decisionFailed && <p className="inline-error" role="alert">{t("assistantConnector.decisionFailed")}</p>}
        <div className="assistant-consent-actions">
          <button type="button" className="primary-button" disabled={pending !== null} onClick={() => void decide("approve")}>
            {pending === "approve" ? <LoaderCircle className="spin" size={16} aria-hidden="true" /> : <Check size={16} aria-hidden="true" />}{t("assistantConnector.approve")}
          </button>
          <button type="button" className="secondary-button" disabled={pending !== null} onClick={() => void decide("deny")}>{t("assistantConnector.deny")}</button>
        </div>
      </section>
    );
  };

  let card;
  if (state.kind === "checking") card = progress("assistantConnector.checking");
  else if (state.kind === "redirecting") card = progress("assistantConnector.returning");
  else if (state.kind === "ready") card = approval(state.preview, state.email);
  else card = blocked(state.kind);
  return <main className="bootstrap-screen assistant-consent">{card}</main>;
}
