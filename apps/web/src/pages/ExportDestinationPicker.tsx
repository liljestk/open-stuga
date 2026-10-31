import type { CloudExportAccount, CloudExportConnection, CloudExportProvider, ExportDestinationKind, ExportDestinationStatus } from "@climate-twin/contracts";
import { useCallback, useEffect, useState, type FormEvent } from "react";
import { Cloud, ExternalLink, HardDrive, LoaderCircle } from "lucide-react";
import { api } from "../api";
import { confirmAction } from "../components/ConfirmationProvider";
import { EXPORT_DESTINATION_NAME_KEYS } from "../components/exportDestinationNames";
import { useI18n } from "../i18n";
import "./ExportDestinationPicker.css";

type Translate = ReturnType<typeof useI18n>["t"];

const PROVIDER_FOLDER_KEYS = {
  dropbox: "dataExport.destinationDropboxFolder",
  "google-drive": "dataExport.destinationGoogleDriveFolder",
} as const satisfies Record<CloudExportProvider, string>;
const POLL_MS = 3_000;

function message(error: unknown, fallback: string): string {
  return error instanceof Error ? error.message : fallback;
}

function readableUrl(value: string): string {
  try {
    const url = new URL(value);
    return `${url.host}${url.pathname === "/" ? "" : url.pathname}`;
  } catch {
    return value;
  }
}

function cloudDetail(account: CloudExportAccount, t: Translate): string {
  if (account.connected) return account.accountLabel ? t("dataExport.destinationConnectedAs", { account: account.accountLabel }) : t("dataExport.nasSetupConnected");
  return account.available ? t("dataExport.destinationSignInHint") : t("dataExport.destinationUnavailable");
}

interface OptionProps {
  kind: ExportDestinationKind;
  name: string;
  detail: string;
  cloud: boolean;
  selected: boolean;
  selectable: boolean;
  disabled: boolean;
  onSelect: (kind: ExportDestinationKind) => void;
  action?: React.ReactNode;
}

function DestinationOption(props: Readonly<OptionProps>) {
  const Icon = props.cloud ? Cloud : HardDrive;
  return <div className={`export-destination-option${props.selected ? " selected" : ""}${props.selectable ? "" : " unavailable"}`}>
    <label>
      <input type="radio" name="export-destination" value={props.kind} checked={props.selected} disabled={!props.selectable || props.disabled} onChange={() => props.onSelect(props.kind)} />
      <span className="export-destination-name"><Icon size={16} aria-hidden="true" />{props.name}</span>
      <small>{props.detail}</small>
    </label>
    {props.action}
  </div>;
}

interface ConnectionStepsProps {
  connection: CloudExportConnection;
  providerName: string;
  busy: boolean;
  onSubmitCode: (code: string) => void;
  onCancel: () => void;
  onRetry: () => void;
}

function ConnectionSteps(props: Readonly<ConnectionStepsProps>) {
  const { t } = useI18n();
  const [code, setCode] = useState("");
  const { connection, providerName } = props;
  // The device sign-in opens Google's code page, not Drive itself, so that link is named by its address.
  const openTarget = connection.method === "enter-code" ? readableUrl(connection.url) : providerName;
  const openLink = <a className="secondary-button" href={connection.url} target="_blank" rel="noopener noreferrer"><ExternalLink size={15} aria-hidden="true" />{t("dataExport.destinationOpenProvider", { provider: openTarget })}</a>;
  const cancel = <button type="button" className="secondary-button" disabled={props.busy} onClick={props.onCancel}>{t("dataExport.destinationCancel")}</button>;

  if (connection.error) {
    return <div className="export-destination-connect" aria-live="polite">
      <p className="inline-error" role="alert">{connection.error}</p>
      <div className="export-destination-connect-actions"><button type="button" className="primary-button" disabled={props.busy} onClick={props.onRetry}>{t("dataExport.destinationStartAgain")}</button>{cancel}</div>
    </div>;
  }
  if (connection.method === "enter-code") {
    return <div className="export-destination-connect" aria-live="polite">
      <strong>{t("dataExport.destinationConnectTitle", { provider: providerName })}</strong>
      <ol>
        <li><span>{t("dataExport.destinationEnterStep1", { url: readableUrl(connection.url) })}</span>{openLink}</li>
        <li><span>{t("dataExport.destinationEnterStep2")}</span><code className="export-destination-user-code">{connection.userCode}</code></li>
      </ol>
      <p className="export-destination-waiting" role="status"><LoaderCircle className="spin" size={15} aria-hidden="true" />{t("dataExport.destinationWaiting", { provider: providerName })}</p>
      <div className="export-destination-connect-actions">{cancel}</div>
    </div>;
  }
  const submit = (event: FormEvent) => {
    event.preventDefault();
    if (code.trim().length >= 8) props.onSubmitCode(code.trim());
  };
  return <form className="export-destination-connect" onSubmit={submit}>
    <strong>{t("dataExport.destinationConnectTitle", { provider: providerName })}</strong>
    <ol>
      <li><span>{t("dataExport.destinationPasteStep1", { provider: providerName })}</span>{openLink}</li>
      <li><label className="field"><span>{t("dataExport.destinationPasteStep2", { provider: providerName })}</span><input value={code} autoComplete="off" autoCapitalize="none" autoCorrect="off" spellCheck={false} onChange={(event) => setCode(event.target.value)} /></label></li>
    </ol>
    <div className="export-destination-connect-actions"><button type="submit" className="primary-button" disabled={props.busy || code.trim().length < 8}>{props.busy ? <LoaderCircle className="spin" size={15} aria-hidden="true" /> : null}{t("dataExport.destinationFinish")}</button>{cancel}</div>
  </form>;
}

/** The installation-wide choice of where scheduled exports go: the NAS, Dropbox, or Google Drive. */
export function ExportDestinationPicker({ nasConnected }: Readonly<{ nasConnected: boolean }>) {
  const { t } = useI18n();
  const [status, setStatus] = useState<ExportDestinationStatus | null>(null);
  const [busy, setBusy] = useState<string | null>("load");
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async (quiet = false) => {
    try {
      setStatus(await api.exportDestinations());
      if (!quiet) setError(null);
    } catch (loadError) {
      if (!quiet) setError(message(loadError, t("dataExport.destinationError")));
    } finally {
      if (!quiet) setBusy(null);
    }
  }, [t]);

  useEffect(() => { void load(); }, [load, nasConnected]);
  const waitingForApproval = status?.connection?.method === "enter-code" && !status.connection.error;
  useEffect(() => {
    if (!waitingForApproval) return;
    const timer = window.setInterval(() => void load(true), POLL_MS);
    return () => window.clearInterval(timer);
  }, [load, waitingForApproval]);

  const run = async (label: string, action: () => Promise<ExportDestinationStatus>) => {
    setBusy(label);
    setError(null);
    try {
      setStatus(await action());
    } catch (actionError) {
      setError(message(actionError, t("dataExport.destinationError")));
    } finally {
      setBusy(null);
    }
  };
  const providerName = (provider: CloudExportProvider) => t(EXPORT_DESTINATION_NAME_KEYS[provider]);
  const connect = (provider: CloudExportProvider) => void run(`connect-${provider}`, () => api.connectExportDestination(provider));
  const select = (kind: ExportDestinationKind) => {
    if (kind !== status?.selected) void run("select", () => api.selectExportDestination(kind));
  };
  const disconnect = async (provider: CloudExportProvider) => {
    if (!await confirmAction(t("dataExport.destinationDisconnectConfirm", { provider: providerName(provider) }), t("dataExport.destinationDisconnect"), true)) return;
    await run(`disconnect-${provider}`, () => api.disconnectExportDestination(provider));
  };

  const cloudAction = (account: CloudExportAccount) => {
    const label = account.connected ? t("dataExport.destinationDisconnect") : t("dataExport.destinationConnect");
    const name = providerName(account.provider);
    const accessibleLabel = account.connected
      ? t("dataExport.destinationDisconnectProvider", { provider: name })
      : t("dataExport.destinationConnectTitle", { provider: name });
    const working = busy === `connect-${account.provider}` || busy === `disconnect-${account.provider}`;
    if (!account.connected && !account.available) return undefined;
    return <button type="button" className={account.connected ? "secondary-button" : "primary-button"} aria-label={accessibleLabel} disabled={busy !== null}
      onClick={() => account.connected ? void disconnect(account.provider) : connect(account.provider)}>
      {working && <LoaderCircle className="spin" size={15} aria-hidden="true" />}{label}
    </button>;
  };

  const connection = status?.connection ?? null;
  return <fieldset className="export-destinations">
    <legend>{t("dataExport.destinationTitle")}</legend>
    <p className="export-destinations-help">{t("dataExport.destinationHelp")}</p>
    {busy === "load" && !status && <p role="status"><LoaderCircle className="spin" size={16} aria-hidden="true" /> {t("dataExport.destinationLoading")}</p>}
    {status && <div className="export-destination-options">
      <DestinationOption kind="nas" name={t(EXPORT_DESTINATION_NAME_KEYS.nas)} detail={status.nasConnected ? t("dataExport.nasSetupConnected") : t("dataExport.destinationNasMissing")}
        cloud={false} selected={status.selected === "nas"} selectable={status.nasConnected || status.selected === "nas"} disabled={busy !== null} onSelect={select} />
      {status.accounts.map((account) => <DestinationOption key={account.provider} kind={account.provider} name={providerName(account.provider)} detail={cloudDetail(account, t)}
        cloud selected={status.selected === account.provider} selectable={account.connected} disabled={busy !== null} onSelect={select} action={cloudAction(account)} />)}
      <div className="export-destination-option unavailable">
        <label><input type="radio" name="export-destination" value="icloud" disabled /><span className="export-destination-name"><Cloud size={16} aria-hidden="true" />{t("dataExport.destinationIcloud")}</span><small>{t("dataExport.destinationComingLater")}</small></label>
      </div>
    </div>}
    {connection && <ConnectionSteps key={connection.id} connection={connection} providerName={providerName(connection.provider)} busy={busy !== null}
      onSubmitCode={(code) => void run("code", () => api.submitExportDestinationCode(connection.provider, connection.id, code))}
      onCancel={() => void run("cancel", () => api.cancelExportDestinationConnection())}
      onRetry={() => connect(connection.provider)} />}
    {status && status.selected !== "nas" && status.ready && <p className="export-destinations-folder">{t(PROVIDER_FOLDER_KEYS[status.selected])}</p>}
    {error && <p className="inline-error" role="alert">{error}</p>}
  </fieldset>;
}
