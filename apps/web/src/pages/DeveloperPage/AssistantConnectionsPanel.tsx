import { useCallback, useEffect, useState, type ReactNode } from "react";
import type { AssistantConnection } from "@climate-twin/contracts";
import { LoaderCircle, MessagesSquare, ShieldAlert, Unplug } from "lucide-react";
import { api } from "../../api";
import { assistantNameKey } from "../../assistantConnector";
import { confirmAction } from "../../components/ConfirmationProvider";
import { useI18n } from "../../i18n";
import "./AssistantConnectionsPanel.css";

interface AssistantConnectionsPanelProps {
  /** Whether this browser reached Stugu over HTTPS, which Claude and ChatGPT require. */
  secureOrigin: boolean;
  /** The copyable connector URL row. */
  children: ReactNode;
}

/** How to connect Claude or ChatGPT, and the connections an Owner or Admin has approved. */
export function AssistantConnectionsPanel({ secureOrigin, children }: Readonly<AssistantConnectionsPanelProps>) {
  const { locale, t } = useI18n();
  const [connections, setConnections] = useState<AssistantConnection[] | null>(null);
  const [loadFailed, setLoadFailed] = useState(false);
  const [revokingId, setRevokingId] = useState<string | null>(null);
  const [revokeFailed, setRevokeFailed] = useState(false);

  const load = useCallback(() => {
    setLoadFailed(false);
    void api.assistantConnections().then(setConnections, () => setLoadFailed(true));
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  const formatDate = (value: string) => new Intl.DateTimeFormat(locale, { dateStyle: "medium" }).format(new Date(value));

  const revoke = async (connection: AssistantConnection) => {
    const assistant = t(assistantNameKey(connection.assistant));
    if (!await confirmAction(t("assistantConnector.revokeConfirm", { assistant }), t("assistantConnector.revoke"), true)) return;
    setRevokingId(connection.id);
    setRevokeFailed(false);
    try {
      setConnections(await api.revokeAssistantConnection(connection.id));
    } catch {
      setRevokeFailed(true);
    } finally {
      setRevokingId(null);
    }
  };

  const connectionList = () => {
    if (loadFailed) return <p className="assistant-connections-feedback" role="alert">{t("assistantConnector.loadFailed")}</p>;
    if (connections === null) return <LoaderCircle className="spin" size={16} aria-label={t("common.loading")} />;
    if (connections.length === 0) return <p>{t("assistantConnector.none")}</p>;
    return (
      <ul>
        {connections.map((connection) => {
          const assistant = t(assistantNameKey(connection.assistant));
          return (
            <li key={connection.id}>
              <span>
                <strong>{assistant}{connection.clientName && connection.clientName !== assistant ? ` · ${connection.clientName}` : ""}</strong>
                <small>{t("assistantConnector.approvedBy", { email: connection.approvedBy, date: formatDate(connection.createdAt) })}</small>
                <small>{connection.lastUsedAt ? t("assistantConnector.lastUsed", { date: formatDate(connection.lastUsedAt) }) : t("assistantConnector.neverUsed")}</small>
              </span>
              <button type="button" className="secondary-button" disabled={revokingId !== null} onClick={() => void revoke(connection)}>
                {revokingId === connection.id ? <LoaderCircle className="spin" size={15} aria-hidden="true" /> : <Unplug size={15} aria-hidden="true" />}
                {t("assistantConnector.revoke")}
              </button>
            </li>
          );
        })}
      </ul>
    );
  };

  return (
    <section className="panel developer-card assistant-connections" aria-labelledby="assistant-connections-title">
      <div className="developer-icon mcp" aria-hidden="true"><MessagesSquare size={23} /></div>
      <div><span className="eyebrow">{t("assistantConnector.panelEyebrow")}</span><h2 id="assistant-connections-title">{t("assistantConnector.panelTitle")}</h2><p>{t("assistantConnector.panelBody")}</p></div>
      {children}
      {!secureOrigin && <p className="assistant-connections-feedback warning"><ShieldAlert size={15} aria-hidden="true" />{t("assistantConnector.httpsRequired")}</p>}
      <ol className="assistant-connections-steps">
        <li>{t("assistantConnector.stepClaude")}</li>
        <li>{t("assistantConnector.stepChatgpt")}</li>
        <li>{t("assistantConnector.stepLocal")}</li>
      </ol>
      <div className="assistant-connections-list">
        <h3>{t("assistantConnector.connectionsTitle")}</h3>
        {connectionList()}
        {revokeFailed && <p className="assistant-connections-feedback" role="alert">{t("assistantConnector.revokeFailed")}</p>}
      </div>
    </section>
  );
}
