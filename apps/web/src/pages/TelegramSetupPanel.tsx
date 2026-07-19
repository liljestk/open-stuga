import { useEffect, useRef, useState, type FormEvent } from "react";
import {
  Check,
  ChevronDown,
  ExternalLink,
  KeyRound,
  LoaderCircle,
  MessageCircle,
  RefreshCw,
  Send,
  ShieldCheck,
  Trash2,
  TriangleAlert,
} from "lucide-react";
import type { IntegrationStatus, TelegramDiscoveryResult } from "@climate-twin/contracts";
import { api } from "../api";
import { useI18n } from "../i18n";
import "./AutomationSetupPanel.css";

export interface TelegramSetupPanelProps {
  integration: IntegrationStatus;
  onIntegrationChange: (integration: IntegrationStatus) => void;
  open?: boolean;
  onOpenChange?: (open: boolean) => void;
  readOnly?: boolean;
  titleId?: string;
}

type Feedback = { kind: "success" | "error"; message: string } | null;

function errorMessage(error: unknown, fallback: string): string {
  return error instanceof Error && error.message.trim() ? error.message : fallback;
}

export function TelegramSetupPanel({
  integration,
  onIntegrationChange,
  open,
  onOpenChange,
  readOnly = false,
  titleId = "workspace-telegram-setup-title",
}: Readonly<TelegramSetupPanelProps>) {
  const { locale, t } = useI18n();
  const telegram = integration.telegram ?? {
    available: false,
    configured: false,
    connected: false,
    botUsername: null,
    chatLabel: null,
    lastDeliveryAt: null,
    error: null,
  };
  const [botToken, setBotToken] = useState("");
  const [showBotToken, setShowBotToken] = useState(false);
  const [telegramEditing, setTelegramEditing] = useState(!telegram.configured);
  const [telegramDiscovery, setTelegramDiscovery] = useState<TelegramDiscoveryResult | null>(null);
  const [selectedChatId, setSelectedChatId] = useState("");
  const [discoveringTelegram, setDiscoveringTelegram] = useState(false);
  const [savingTelegram, setSavingTelegram] = useState(false);
  const [testingTelegram, setTestingTelegram] = useState(false);
  const [disconnectingTelegram, setDisconnectingTelegram] = useState(false);
  const [confirmDisconnect, setConfirmDisconnect] = useState(false);
  const [telegramFeedback, setTelegramFeedback] = useState<Feedback>(null);
  const telegramDiscoveryGeneration = useRef(0);
  const telegramDiscoveryController = useRef<AbortController | null>(null);

  useEffect(() => {
    if (telegram.configured) setTelegramEditing(false);
  }, [telegram.configured]);

  useEffect(() => () => {
    telegramDiscoveryGeneration.current += 1;
    telegramDiscoveryController.current?.abort();
  }, []);

  const discoverTelegram = async () => {
    if (!botToken.trim() || discoveringTelegram) return;
    const token = botToken.trim();
    const generation = ++telegramDiscoveryGeneration.current;
    telegramDiscoveryController.current?.abort();
    const controller = new AbortController();
    telegramDiscoveryController.current = controller;
    setDiscoveringTelegram(true);
    setTelegramFeedback(null);
    try {
      const result = await api.discoverTelegram(token, controller.signal);
      if (telegramDiscoveryGeneration.current !== generation) return;
      setTelegramDiscovery(result);
      setSelectedChatId((current) => result.chats.some((chat) => chat.id === current) ? current : result.chats[0]?.id ?? "");
      setTelegramFeedback({
        kind: result.chats.length ? "success" : "error",
        message: result.chats.length ? t("automations.telegram.chatsFound", { count: result.chats.length }) : t("automations.telegram.noChats"),
      });
    } catch (error) {
      if (telegramDiscoveryGeneration.current !== generation || controller.signal.aborted) return;
      setTelegramDiscovery(null);
      setSelectedChatId("");
      setTelegramFeedback({ kind: "error", message: errorMessage(error, t("automations.telegram.discoverFailed")) });
    } finally {
      if (telegramDiscoveryGeneration.current === generation) setDiscoveringTelegram(false);
    }
  };

  const saveTelegram = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!botToken.trim() || !selectedChatId || savingTelegram) return;
    setSavingTelegram(true);
    setTelegramFeedback(null);
    try {
      const result = await api.configureTelegram({ botToken: botToken.trim(), chatId: selectedChatId });
      onIntegrationChange(result.integration);
      setBotToken("");
      setShowBotToken(false);
      setTelegramDiscovery(null);
      setSelectedChatId("");
      setTelegramEditing(false);
      setTelegramFeedback({ kind: "success", message: t("automations.telegram.saved") });
    } catch (error) {
      setTelegramFeedback({ kind: "error", message: errorMessage(error, t("automations.telegram.saveFailed")) });
    } finally {
      setSavingTelegram(false);
    }
  };

  const testTelegram = async () => {
    if (testingTelegram) return;
    setTestingTelegram(true);
    setTelegramFeedback(null);
    try {
      const result = await api.testTelegram();
      if (result.ok) {
        try {
          onIntegrationChange(await api.integrations());
        } catch {
          // Delivery succeeded; live integration status can still refresh over SSE.
        }
      }
      setTelegramFeedback({ kind: result.ok ? "success" : "error", message: t(result.ok ? "automations.telegram.testPassed" : "automations.telegram.testFailed") });
    } catch (error) {
      setTelegramFeedback({ kind: "error", message: errorMessage(error, t("automations.telegram.testFailed")) });
    } finally {
      setTestingTelegram(false);
    }
  };

  const disconnectTelegram = async () => {
    if (disconnectingTelegram) return;
    setDisconnectingTelegram(true);
    setTelegramFeedback(null);
    try {
      const result = await api.disconnectTelegram();
      onIntegrationChange(result.integration);
      setConfirmDisconnect(false);
      setTelegramEditing(true);
      setTelegramFeedback({ kind: "success", message: t("automations.telegram.disconnected") });
    } catch (error) {
      setTelegramFeedback({ kind: "error", message: errorMessage(error, t("automations.telegram.disconnectFailed")) });
    } finally {
      setDisconnectingTelegram(false);
    }
  };

  if (readOnly) return null;

  const telegramBotUrl = telegramDiscovery?.botUsername
    ? `https://t.me/${telegramDiscovery.botUsername.replace(/^@/, "")}`
    : null;
  const formattedTelegramDelivery = telegram.lastDeliveryAt
    ? new Intl.DateTimeFormat(locale, { dateStyle: "medium", timeStyle: "short" }).format(new Date(telegram.lastDeliveryAt))
    : null;

  return <details
    className="panel automation-card telegram-card"
    aria-labelledby={titleId}
    {...(open === undefined ? {} : { open })}
    onToggle={(event) => onOpenChange?.(event.currentTarget.open)}
  >
    <summary className="automation-card-heading"><span className="automation-card-icon telegram"><MessageCircle size={22} aria-hidden="true" /></span><div><span className="eyebrow">{t("automations.telegram.eyebrow")}</span><h3 id={titleId}>{t("automations.telegram.title")}</h3><p>{t("automations.telegram.description")}</p></div><span className={`automation-status ${telegram.configured && telegram.connected ? "ready" : ""}`}>{telegram.configured && telegram.connected ? t("automations.ready") : telegram.configured ? t("automations.needsAttention") : t("automations.notConfigured")}</span><ChevronDown className="automation-card-chevron" size={18} aria-hidden="true" /></summary>

    <div className="automation-card-content">{!telegram.available ? <div className="automation-unavailable"><TriangleAlert size={19} aria-hidden="true" /><div><strong>{t("automations.telegram.unavailableTitle")}</strong><p>{t("automations.telegram.unavailableBody")}</p></div></div> : <>
      {window.location.protocol !== "https:" && !["localhost", "127.0.0.1", "::1"].includes(window.location.hostname) && telegramEditing && <div className="notes-connectivity-warning" role="note"><ShieldCheck size={18} aria-hidden="true" /><div><strong>{t("automations.notes.connectivityTitle")}</strong><p>{t("automations.telegram.httpsWarning")}</p></div></div>}
      {telegram.configured && !telegramEditing && <div className="automation-current-status">
        <div><span>{t("automations.telegram.bot")}</span><strong>{telegram.botUsername ? `@${telegram.botUsername.replace(/^@/, "")}` : t("automations.telegram.savedBot")}</strong></div>
        <div><span>{t("automations.telegram.destination")}</span><strong>{telegram.chatLabel ?? t("automations.telegram.savedChat")}</strong></div>
        <div><span>{t("automations.telegram.lastDelivery")}</span><strong>{formattedTelegramDelivery ?? t("automations.never")}</strong></div>
      </div>}
      {telegram.error && !telegramEditing && <p className="automation-provider-error" role="alert"><TriangleAlert size={15} aria-hidden="true" />{telegram.error}</p>}

      {telegram.configured && !telegramEditing ? <div className="automation-actions">
        <button type="button" className="primary-button" disabled={testingTelegram} onClick={() => void testTelegram()}>{testingTelegram ? <LoaderCircle className="spin" size={16} aria-hidden="true" /> : <Send size={16} aria-hidden="true" />}{t(testingTelegram ? "automations.telegram.testing" : "automations.telegram.sendTest")}</button>
        <button type="button" className="secondary-button" onClick={() => { setTelegramEditing(true); setTelegramFeedback(null); }}>{t("automations.telegram.change")}</button>
        {!confirmDisconnect ? <button type="button" className="text-button danger-text" onClick={() => setConfirmDisconnect(true)}>{t("automations.telegram.disconnect")}</button> : <span className="automation-confirm"><span>{t("automations.telegram.disconnectConfirm")}</span><button type="button" className="secondary-button danger-text" disabled={disconnectingTelegram} onClick={() => void disconnectTelegram()}>{disconnectingTelegram ? <LoaderCircle className="spin" size={15} aria-hidden="true" /> : <Trash2 size={15} aria-hidden="true" />}{t("automations.telegram.disconnectAction")}</button><button type="button" className="text-button" disabled={disconnectingTelegram} onClick={() => setConfirmDisconnect(false)}>{t("common.cancel")}</button></span>}
      </div> : <form className="automation-wizard" onSubmit={(event) => void saveTelegram(event)}>
        <ol className="automation-steps">
          <li><span>1</span><div><strong>{t("automations.telegram.stepBotFather")}</strong><p>{t("automations.telegram.stepBotFatherBody")}</p><a href="https://t.me/BotFather" target="_blank" rel="noreferrer">{t("automations.telegram.openBotFather")}<ExternalLink size={13} aria-hidden="true" /></a></div></li>
          <li><span>2</span><div><strong>{t("automations.telegram.stepToken")}</strong><p>{t("automations.telegram.stepTokenBody")}</p><label className="field"><span>{t("automations.telegram.token")}</span><input type={showBotToken ? "text" : "password"} value={botToken} autoComplete="off" autoCapitalize="none" spellCheck={false} onChange={(event) => { telegramDiscoveryGeneration.current += 1; telegramDiscoveryController.current?.abort(); setDiscoveringTelegram(false); setBotToken(event.target.value); setTelegramDiscovery(null); setSelectedChatId(""); setTelegramFeedback(null); }} required /></label><label className="show-secret"><input type="checkbox" checked={showBotToken} onChange={(event) => setShowBotToken(event.target.checked)} /><span>{t("automations.telegram.showToken")}</span></label><p className="security-note"><KeyRound size={15} aria-hidden="true" />{t("automations.telegram.tokenSecurity")}</p></div></li>
          <li><span>3</span><div><strong>{t("automations.telegram.stepChat")}</strong><p>{t("automations.telegram.stepChatBody")}</p>{telegramBotUrl && <a href={telegramBotUrl} target="_blank" rel="noreferrer">{t("automations.telegram.openBot")}<ExternalLink size={13} aria-hidden="true" /></a>}<button type="button" className="secondary-button" disabled={!botToken.trim() || discoveringTelegram} onClick={() => void discoverTelegram()}>{discoveringTelegram ? <LoaderCircle className="spin" size={16} aria-hidden="true" /> : <RefreshCw size={16} aria-hidden="true" />}{t(discoveringTelegram ? "automations.telegram.findingChats" : telegramDiscovery ? "automations.telegram.refreshChats" : "automations.telegram.findChats")}</button>{telegramDiscovery && telegramDiscovery.chats.length > 0 && <fieldset className="telegram-chat-list"><legend>{t("automations.telegram.chooseChat")}</legend>{telegramDiscovery.chats.map((chat) => <label key={chat.id}><input type="radio" name="telegram-chat" value={chat.id} checked={selectedChatId === chat.id} onChange={() => setSelectedChatId(chat.id)} /><span><strong>{chat.label}</strong>{chat.username && <small>@{chat.username.replace(/^@/, "")}</small>}</span></label>)}</fieldset>}</div></li>
          <li><span>4</span><div><strong>{t("automations.telegram.stepSave")}</strong><p>{t("automations.telegram.stepSaveBody")}</p><button type="submit" className="primary-button" disabled={!botToken.trim() || !selectedChatId || savingTelegram}>{savingTelegram ? <LoaderCircle className="spin" size={16} aria-hidden="true" /> : <ShieldCheck size={16} aria-hidden="true" />}{t(savingTelegram ? "common.saving" : "automations.telegram.save")}</button>{telegram.configured && <button type="button" className="text-button" disabled={savingTelegram} onClick={() => { setTelegramEditing(false); setBotToken(""); setTelegramDiscovery(null); setTelegramFeedback(null); }}>{t("common.cancel")}</button>}</div></li>
        </ol>
      </form>}
      {telegramFeedback && <p className={`automation-feedback ${telegramFeedback.kind}`} role={telegramFeedback.kind === "error" ? "alert" : "status"}>{telegramFeedback.kind === "success" ? <Check size={15} aria-hidden="true" /> : <TriangleAlert size={15} aria-hidden="true" />}{telegramFeedback.message}</p>}
      <p className="automation-privacy-note"><ShieldCheck size={15} aria-hidden="true" />{t("automations.telegram.privacy")}</p>
    </>}</div>
  </details>;
}
