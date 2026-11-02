import type { CloudExportAppInputs, CloudExportProvider } from "@climate-twin/contracts";
import { useState, type FormEvent } from "react";
import { ExternalLink, LoaderCircle } from "lucide-react";
import { useI18n } from "../i18n";

export type CloudExportAppInput = CloudExportAppInputs[CloudExportProvider];

const GUIDES = {
  dropbox: {
    steps: ["dataExport.appSetupDropboxStep1", "dataExport.appSetupDropboxStep2", "dataExport.appSetupDropboxStep3"],
    console: "dataExport.appSetupDropboxConsole",
    consoleUrl: "dataExport.appSetupDropboxConsoleUrl",
  },
  "google-drive": {
    steps: ["dataExport.appSetupGoogleStep1", "dataExport.appSetupGoogleStep2", "dataExport.appSetupGoogleStep3"],
    console: "dataExport.appSetupGoogleConsole",
    consoleUrl: "dataExport.appSetupGoogleConsoleUrl",
  },
} as const satisfies Record<CloudExportProvider, { steps: readonly string[]; console: string; consoleUrl: string }>;

const TEXT_INPUT = { autoComplete: "off", autoCapitalize: "none", autoCorrect: "off", spellCheck: false } as const;

interface AppSetupProps {
  provider: CloudExportProvider;
  providerName: string;
  /** True when the current app was entered here, so it can be removed as well as replaced. */
  removable: boolean;
  busy: boolean;
  onSave: (app: CloudExportAppInput) => void;
  onRemove: () => void;
  onCancel: () => void;
}

/** Walks an Owner/Admin through registering their own Dropbox app or Google client and takes its ID. */
export function ExportDestinationAppSetup(props: Readonly<AppSetupProps>) {
  const { t } = useI18n();
  const [appKey, setAppKey] = useState("");
  const [clientId, setClientId] = useState("");
  const [clientSecret, setClientSecret] = useState("");
  const dropbox = props.provider === "dropbox";
  const app: CloudExportAppInput = dropbox ? { appKey: appKey.trim() } : { clientId: clientId.trim(), clientSecret: clientSecret.trim() };
  const complete = dropbox ? appKey.trim().length >= 8 : clientId.trim().length > 0 && clientSecret.trim().length >= 8;
  const guide = GUIDES[props.provider];
  const submit = (event: FormEvent) => {
    event.preventDefault();
    if (complete) props.onSave(app);
  };

  return <form className="export-destination-connect" onSubmit={submit}>
    <strong>{t("dataExport.appSetupTitle", { provider: props.providerName })}</strong>
    <p className="export-destinations-help">{t("dataExport.appSetupIntro", { provider: props.providerName })}</p>
    <ol>
      <li>
        <span>{t(guide.steps[0])}</span>
        <a className="secondary-button" href={t(guide.consoleUrl)} target="_blank" rel="noopener noreferrer"><ExternalLink size={15} aria-hidden="true" />{t(guide.console)}</a>
      </li>
      <li><span>{t(guide.steps[1])}</span></li>
      <li><span>{t(guide.steps[2])}</span></li>
      <li><div className="export-destination-app-fields">
        {dropbox
          ? <label className="field"><span>{t("dataExport.appSetupDropboxAppKey")}</span><input value={appKey} {...TEXT_INPUT} onChange={(event) => setAppKey(event.target.value)} /></label>
          : <>
            <label className="field"><span>{t("dataExport.appSetupGoogleClientId")}</span><input value={clientId} {...TEXT_INPUT} onChange={(event) => setClientId(event.target.value)} /></label>
            <label className="field"><span>{t("dataExport.appSetupGoogleClientSecret")}</span><input type="password" value={clientSecret} {...TEXT_INPUT} onChange={(event) => setClientSecret(event.target.value)} /></label>
          </>}
      </div></li>
    </ol>
    <p className="export-destinations-help">{t("dataExport.appSetupStored")}</p>
    <div className="export-destination-connect-actions">
      <button type="submit" className="primary-button" disabled={props.busy || !complete}>
        {props.busy && <LoaderCircle className="spin" size={15} aria-hidden="true" />}{t("dataExport.appSetupSave")}
      </button>
      {props.removable && <button type="button" className="secondary-button" disabled={props.busy} onClick={props.onRemove}>{t("dataExport.appSetupRemove")}</button>}
      <button type="button" className="secondary-button" disabled={props.busy} onClick={props.onCancel}>{t("dataExport.destinationCancel")}</button>
    </div>
  </form>;
}
