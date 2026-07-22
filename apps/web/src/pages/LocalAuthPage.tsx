import { useRef, useState, type FormEvent, type KeyboardEvent } from "react";
import { Eye, EyeOff, KeyRound, LoaderCircle, LockKeyhole, LogIn, ShieldCheck } from "lucide-react";
import { api, ApiRequestError } from "../api";
import { StugaMark } from "../components/StugaMark";
import { useI18n, type TranslationKey } from "../i18n";

export type LocalAuthMode = "setup" | "login" | "invitation";

// randomBytes(32).toString("base64url") is exactly 43 URL-safe characters.
const INVITATION_TOKEN_PATTERN = /^[A-Za-z0-9_-]{43}$/;
const INVITATION_SESSION_KEY = "stuga-invitation-token";

/** Pure parsing keeps the token stable when React probes initializers in Strict Mode. */
export function invitationTokenFromFragment(hash = window.location.hash): string | null {
  if (!hash.startsWith("#")) return null;
  const parameters = new URLSearchParams(hash.slice(1));
  const token = parameters.get("invite")?.trim() ?? "";
  return INVITATION_TOKEN_PATTERN.test(token) ? token : null;
}

export function clearInvitationFragment(): void {
  const parameters = new URLSearchParams(window.location.hash.slice(1));
  if (!parameters.has("invite")) return;
  window.history.replaceState(window.history.state, "", `${window.location.pathname}${window.location.search}`);
}

/** Read the handoff created by the public static bootstrap before Access redirects. */
export function invitationTokenFromBootstrapStorage(storage: Storage = window.sessionStorage): string | null {
  const token = storage.getItem(INVITATION_SESSION_KEY)?.trim() ?? "";
  return INVITATION_TOKEN_PATTERN.test(token) ? token : null;
}

export function clearInvitationBootstrapStorage(storage: Storage = window.sessionStorage): void {
  storage.removeItem(INVITATION_SESSION_KEY);
}

type AuthError = { key: TranslationKey; field: "email" | "password" | null };

function authError(error: unknown): AuthError {
  if (!(error instanceof ApiRequestError)) return { key: "auth.requestFailed", field: null };
  switch (error.code) {
    case "INVALID_EMAIL": return { key: "auth.invalidEmail", field: "email" };
    case "INVALID_PASSWORD": return { key: "auth.invalidPassword", field: "password" };
    case "INVALID_CREDENTIALS": return { key: "auth.invalidCredentials", field: "password" };
    case "AUTH_RATE_LIMITED": return { key: "auth.rateLimited", field: null };
    case "BOOTSTRAP_LOCAL_ONLY": return { key: "auth.setupLocalOnly", field: null };
    case "CROSS_SITE_REQUEST_REJECTED": return { key: "auth.originRejected", field: null };
    case "AUTH_ALREADY_INITIALIZED":
    case "SETUP_REQUIRED": return { key: "auth.stateChanged", field: null };
    case "INVITATION_EMAIL_MISMATCH": return { key: "auth.invitationEmailMismatch", field: "email" };
    case "ACCOUNT_EXISTS": return { key: "auth.accountExists", field: "email" };
    case "INVITATION_NOT_FOUND":
    case "INVALID_INVITATION_TOKEN": return { key: "auth.invitationInvalid", field: null };
    default: return { key: "auth.requestFailed", field: null };
  }
}

interface LocalAuthPageProps {
  mode: LocalAuthMode;
  invitationToken?: string | null;
  noticeKey?: TranslationKey | null;
  onAuthenticated: () => void;
  onAuthStateChanged?: () => void;
  onCancelInvitation?: () => void;
}

export function LocalAuthPage({ mode, invitationToken = null, noticeKey = null, onAuthenticated, onAuthStateChanged, onCancelInvitation }: Readonly<LocalAuthPageProps>) {
  const { t } = useI18n();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [confirmation, setConfirmation] = useState("");
  const [pending, setPending] = useState(false);
  const [errorKey, setErrorKey] = useState<TranslationKey | null>(null);
  const [errorField, setErrorField] = useState<AuthError["field"]>(null);
  const [showPassword, setShowPassword] = useState(false);
  const [capsLock, setCapsLock] = useState(false);
  const emailRef = useRef<HTMLInputElement>(null);
  const passwordRef = useRef<HTMLInputElement>(null);
  const needsConfirmation = mode !== "login";
  const titleKey: TranslationKey = mode === "setup" ? "auth.setupTitle" : mode === "invitation" ? "auth.invitationTitle" : "auth.loginTitle";
  const descriptionKey: TranslationKey = mode === "setup" ? "auth.setupDescription" : mode === "invitation" ? "auth.invitationDescription" : "auth.loginDescription";
  const submitKey: TranslationKey = mode === "setup" ? "auth.createOwner" : mode === "invitation" ? "auth.activateAccount" : "auth.signIn";

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (pending) return;
    if (needsConfirmation && password !== confirmation) {
      setErrorKey("auth.passwordMismatch");
      setErrorField("password");
      passwordRef.current?.focus();
      return;
    }
    if (mode === "invitation" && !invitationToken) {
      setErrorKey("auth.invitationInvalid");
      return;
    }
    setPending(true);
    setErrorKey(null);
    setErrorField(null);
    try {
      if (mode === "setup") await api.setupOwner({ email, password });
      else if (mode === "login") await api.login({ email, password });
      else await api.registerInvitation({ token: invitationToken!, email, password });
      onAuthenticated();
    } catch (error) {
      setPassword("");
      setConfirmation("");
      if (onAuthStateChanged && error instanceof ApiRequestError && (error.code === "AUTH_ALREADY_INITIALIZED" || error.code === "SETUP_REQUIRED")) {
        onAuthStateChanged();
        return;
      }
      const nextError = authError(error);
      setErrorKey(nextError.key);
      setErrorField(nextError.field);
      window.setTimeout(() => (nextError.field === "email" ? emailRef.current : passwordRef.current)?.focus(), 0);
    } finally {
      setPending(false);
    }
  };

  return <main className="bootstrap-screen local-auth-screen">
    <section className="bootstrap-card local-auth-card" aria-labelledby="local-auth-title">
      <StugaMark />
      <span className="bootstrap-icon" aria-hidden="true">{mode === "setup" ? <ShieldCheck size={22} /> : mode === "invitation" ? <KeyRound size={22} /> : <LockKeyhole size={22} />}</span>
      <div><span className="eyebrow">{t(mode === "setup" ? "auth.setupEyebrow" : mode === "invitation" ? "auth.invitationEyebrow" : "auth.loginEyebrow")}</span><h1 id="local-auth-title">{t(titleKey)}</h1><p>{t(descriptionKey)}</p></div>
      {noticeKey && <p className="local-auth-notice" role="alert">{t(noticeKey)}</p>}
      <form className="local-auth-form" onSubmit={(event) => void submit(event)}>
        <div className="field"><label htmlFor="local-auth-email">{t("auth.email")}</label><input ref={emailRef} id="local-auth-email" type="text" inputMode="email" spellCheck={false} required autoComplete="email" aria-invalid={errorField === "email"} aria-describedby={errorField === "email" ? "local-auth-error" : undefined} value={email} onChange={(event) => { setEmail(event.target.value); setErrorField(null); }} /></div>
        <div className="field"><label htmlFor="local-auth-password">{t("auth.password")}</label><div className="password-input"><input ref={passwordRef} id="local-auth-password" type={showPassword ? "text" : "password"} required minLength={12} maxLength={1024} aria-invalid={errorField === "password"} aria-describedby={`local-auth-password-help${errorField === "password" ? " local-auth-error" : ""}`} autoComplete={mode === "login" ? "current-password" : "new-password"} value={password} onKeyDown={(event: KeyboardEvent<HTMLInputElement>) => setCapsLock(event.getModifierState("CapsLock"))} onKeyUp={(event: KeyboardEvent<HTMLInputElement>) => setCapsLock(event.getModifierState("CapsLock"))} onChange={(event) => { setPassword(event.target.value); setErrorField(null); }} /><button type="button" className="icon-button password-toggle" aria-label={t(showPassword ? "auth.hidePassword" : "auth.showPassword")} aria-pressed={showPassword} onClick={() => setShowPassword((visible) => !visible)}>{showPassword ? <EyeOff size={20} aria-hidden="true" /> : <Eye size={20} aria-hidden="true" />}</button></div><small id="local-auth-password-help">{t("auth.passwordHelp")}</small>{capsLock && <small className="caps-lock-notice" role="status">{t("auth.capsLock")}</small>}</div>
        {needsConfirmation && <div className="field"><label htmlFor="local-auth-confirmation">{t("auth.confirmPassword")}</label><input id="local-auth-confirmation" type={showPassword ? "text" : "password"} required minLength={12} maxLength={1024} autoComplete="new-password" value={confirmation} onChange={(event) => setConfirmation(event.target.value)} /></div>}
        {errorKey && <p id="local-auth-error" className="inline-error" role="alert">{t(errorKey)}</p>}
        <button type="submit" className="primary-button" disabled={pending}>{pending ? <LoaderCircle className="spin" size={16} aria-hidden="true" /> : <LogIn size={16} aria-hidden="true" />}{pending ? t("auth.working") : t(submitKey)}</button>
      </form>
      {mode === "invitation" && onCancelInvitation && <button type="button" className="text-button local-auth-cancel" disabled={pending} onClick={onCancelInvitation}>{t("auth.backToSignIn")}</button>}
    </section>
  </main>;
}
