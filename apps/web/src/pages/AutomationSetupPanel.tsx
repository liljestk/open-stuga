import { useEffect, useMemo, useRef, useState, type FormEvent } from "react";
import {
  Check,
  ChevronDown,
  Copy,
  KeyRound,
  LoaderCircle,
  Send,
  ShieldCheck,
  Smartphone,
  Trash2,
  TriangleAlert,
} from "lucide-react";
import type {
  AppleNotesGrantCreated,
  AppleNotesGrantSummary,
  House,
  IntegrationStatus,
} from "@climate-twin/contracts";
import { API_BASE, api, type AppleNotesSetupMetadata } from "../api";
import { useI18n } from "../i18n";
import "./AutomationSetupPanel.css";

interface AutomationSetupPanelProps {
  integration: IntegrationStatus;
  house: House;
  houses: House[];
  onHouse: (houseId: string) => void;
  onIntegrationChange: (integration: IntegrationStatus) => void;
}

type Feedback = { kind: "success" | "error"; message: string } | null;

function errorMessage(error: unknown, fallback: string): string {
  return error instanceof Error && error.message.trim() ? error.message : fallback;
}

function absoluteIntegrationUrl(path: string): URL {
  const base = new URL(API_BASE, window.location.origin);
  if (/^https?:\/\//i.test(path)) return new URL(path);
  if (path.startsWith("/api/")) return new URL(path, base.origin);
  const suffix = path.startsWith("/") ? path : `/${path}`;
  return new URL(`${base.pathname.replace(/\/$/, "")}${suffix}`, base.origin);
}

export function AutomationSetupPanel({ integration, house, houses, onHouse, onIntegrationChange }: Readonly<AutomationSetupPanelProps>) {
  const { locale, t } = useI18n();
  const appleNotes = integration.appleNotes ?? {
    available: false,
    configured: false,
    grantCount: 0,
    lastSyncAt: null,
    error: null,
  };

  const [notesSetup, setNotesSetup] = useState<AppleNotesSetupMetadata | null>(null);
  const [notesGrants, setNotesGrants] = useState<AppleNotesGrantSummary[]>([]);
  const [loadingNotes, setLoadingNotes] = useState(false);
  const [notesLoadFailed, setNotesLoadFailed] = useState(false);
  const [grantHouseId, setGrantHouseId] = useState(house.id);
  const [deviceLabel, setDeviceLabel] = useState("");
  const [creatingGrant, setCreatingGrant] = useState(false);
  const [revokingGrantId, setRevokingGrantId] = useState<string | null>(null);
  const [createdGrant, setCreatedGrant] = useState<AppleNotesGrantCreated | null>(null);
  const [notesFeedback, setNotesFeedback] = useState<Feedback>(null);
  const [copyResult, setCopyResult] = useState<{ id: string; status: "copied" | "failed" } | null>(null);
  const activeHouseId = useRef(house.id);
  const createGrantGeneration = useRef(0);
  const revokeGrantGeneration = useRef(0);
  activeHouseId.current = house.id;

  useEffect(() => {
    createGrantGeneration.current += 1;
    revokeGrantGeneration.current += 1;
    setGrantHouseId(house.id);
    setDeviceLabel("");
    setCreatedGrant(null);
    setNotesFeedback(null);
    setCopyResult(null);
    setCreatingGrant(false);
    setRevokingGrantId(null);
  }, [house.id]);

  useEffect(() => {
    if (!appleNotes.available) return;
    let active = true;
    setLoadingNotes(true);
    setNotesLoadFailed(false);
    Promise.all([api.appleNotesSetup(), api.appleNotesGrants()])
      .then(([setup, grants]) => {
        if (!active) return;
        setNotesSetup(setup);
        setNotesGrants(grants);
      })
      .catch(() => {
        if (active) setNotesLoadFailed(true);
      })
      .finally(() => {
        if (active) setLoadingNotes(false);
      });
    return () => { active = false; };
  }, [appleNotes.available]);

  const createNotesGrant = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!deviceLabel.trim() || creatingGrant) return;
    const requestedHouseId = grantHouseId;
    const generation = ++createGrantGeneration.current;
    setCreatingGrant(true);
    setNotesFeedback(null);
    setCreatedGrant(null);
    try {
      const grant = await api.createAppleNotesGrant({ houseId: requestedHouseId, deviceLabel: deviceLabel.trim() });
      const grantSummary: AppleNotesGrantSummary = {
        id: grant.id,
        houseId: grant.houseId,
        deviceLabel: grant.deviceLabel,
        createdAt: grant.createdAt,
      };
      setNotesGrants((current) => [grantSummary, ...current.filter((item) => item.id !== grant.id)]);
      onIntegrationChange(grant.integration);
      if (activeHouseId.current !== requestedHouseId || createGrantGeneration.current !== generation) return;
      setCreatedGrant(grant);
      setDeviceLabel("");
      setNotesFeedback({ kind: "success", message: t("automations.notes.grantCreated") });
    } catch (error) {
      if (activeHouseId.current !== requestedHouseId || createGrantGeneration.current !== generation) return;
      setNotesFeedback({ kind: "error", message: errorMessage(error, t("automations.notes.grantFailed")) });
    } finally {
      if (activeHouseId.current === requestedHouseId && createGrantGeneration.current === generation) setCreatingGrant(false);
    }
  };

  const revokeGrant = async (id: string) => {
    if (revokingGrantId) return;
    const requestedHouseId = house.id;
    const generation = ++revokeGrantGeneration.current;
    setRevokingGrantId(id);
    setNotesFeedback(null);
    try {
      const result = await api.revokeAppleNotesGrant(id);
      setNotesGrants((current) => current.filter((grant) => grant.id !== id));
      onIntegrationChange(result.integration);
      if (activeHouseId.current !== requestedHouseId || revokeGrantGeneration.current !== generation) return;
      if (createdGrant?.id === id) setCreatedGrant(null);
      setNotesFeedback({ kind: "success", message: t("automations.notes.grantRevoked") });
    } catch (error) {
      if (activeHouseId.current !== requestedHouseId || revokeGrantGeneration.current !== generation) return;
      setNotesFeedback({ kind: "error", message: errorMessage(error, t("automations.notes.revokeFailed")) });
    } finally {
      if (activeHouseId.current === requestedHouseId && revokeGrantGeneration.current === generation) setRevokingGrantId(null);
    }
  };

  const copy = async (id: string, value: string) => {
    try {
      if (!navigator.clipboard?.writeText) throw new Error("Clipboard unavailable");
      await navigator.clipboard.writeText(value);
      setCopyResult({ id, status: "copied" });
    } catch {
      setCopyResult({ id, status: "failed" });
    }
  };

  const snapshotPath = notesSetup?.snapshotPath ?? "/integrations/apple-notes/snapshot";
  const capturePath = notesSetup?.capturePath ?? "/integrations/apple-notes/capture";
  const visibleCreatedGrant = createdGrant?.houseId === house.id ? createdGrant : null;
  const configuredHouseId = visibleCreatedGrant?.houseId ?? (grantHouseId === house.id ? grantHouseId : house.id);
  const snapshotUrl = useMemo(() => {
    const url = absoluteIntegrationUrl(snapshotPath);
    url.searchParams.set("houseId", configuredHouseId);
    return url.toString();
  }, [configuredHouseId, snapshotPath]);
  const captureUrl = useMemo(() => absoluteIntegrationUrl(capturePath).toString(), [capturePath]);
  const loopbackAddress = ["localhost", "127.0.0.1", "::1"].includes(window.location.hostname);
  const insecureAddress = window.location.protocol !== "https:";
  const selectedGrantHouse = houses.find((candidate) => candidate.id === configuredHouseId);
  const houseNotesGrants = useMemo(
    () => notesGrants.filter((grant) => grant.houseId === house.id),
    [house.id, notesGrants],
  );
  const captureExample = JSON.stringify({
    schema: "stuga.apple-notes-command/v1",
    operationId: t("automations.notes.recipe.operationIdValue"),
    houseId: configuredHouseId,
    title: t("automations.notes.recipe.titleValue"),
    description: t("automations.notes.recipe.descriptionValue"),
    basis: "condition-based",
    priority: "normal",
  }, null, 2);

  return <section className="automation-workspace" aria-labelledby="automation-workspace-title">
    <header className="automation-workspace-heading">
      <div><span className="eyebrow"><Smartphone size={14} aria-hidden="true" />{t("automations.homeEyebrow")}</span><h2 id="automation-workspace-title">{t("automations.homeTitle")}</h2><p>{t("automations.homeDescription")}</p></div>
      <span className="automation-count">{t("automations.configuredCount", { count: houseNotesGrants.length > 0 ? 1 : 0 })}</span>
    </header>

    <div className="automation-card-grid single-card">
      <details className="panel automation-card notes-card" aria-labelledby="notes-setup-title">
        <summary className="automation-card-heading"><span className="automation-card-icon notes"><Smartphone size={22} aria-hidden="true" /></span><div><span className="eyebrow">{t("automations.notes.eyebrow")}</span><h3 id="notes-setup-title">{t("automations.notes.title")}</h3><p>{t("automations.notes.description")}</p></div><span className={`automation-status ${houseNotesGrants.length > 0 ? "ready" : ""}`}>{houseNotesGrants.length > 0 ? t("automations.notes.grantsActive", { count: houseNotesGrants.length }) : t("automations.notConfigured")}</span><ChevronDown className="automation-card-chevron" size={18} aria-hidden="true" /></summary>

        <div className="automation-card-content">{!appleNotes.available || notesSetup?.available === false ? <div className="automation-unavailable"><TriangleAlert size={19} aria-hidden="true" /><div><strong>{t("automations.notes.unavailableTitle")}</strong><p>{t("automations.notes.unavailableBody")}</p></div></div> : <>
          <div className="notes-boundary"><TriangleAlert size={19} aria-hidden="true" /><div><strong>{t("automations.notes.manualTitle")}</strong><p>{t("automations.notes.manualBody")}</p></div></div>
          {(loopbackAddress || insecureAddress) && <div className="notes-connectivity-warning" role="note"><ShieldCheck size={18} aria-hidden="true" /><div><strong>{t("automations.notes.connectivityTitle")}</strong><p>{t(loopbackAddress ? "automations.notes.loopbackWarning" : "automations.notes.httpsWarning")}</p></div></div>}

          <form className="notes-grant-form" onSubmit={(event) => void createNotesGrant(event)}>
            <div><span className="eyebrow">{t("automations.notes.accessEyebrow")}</span><h4>{t("automations.notes.accessTitle")}</h4><p>{t("automations.notes.accessBody")}</p></div>
            <div className="notes-grant-fields">
              <label className="field"><span>{t("common.house")}</span><select value={grantHouseId} onChange={(event) => { setGrantHouseId(event.target.value); onHouse(event.target.value); setCreatedGrant(null); }}>{houses.map((candidate) => <option key={candidate.id} value={candidate.id}>{candidate.name}</option>)}</select></label>
              <label className="field"><span>{t("automations.notes.deviceLabel")}</span><input value={deviceLabel} maxLength={100} placeholder={t("automations.notes.devicePlaceholder")} onChange={(event) => setDeviceLabel(event.target.value)} required /></label>
            </div>
            <button type="submit" className="primary-button" disabled={!deviceLabel.trim() || creatingGrant}>{creatingGrant ? <LoaderCircle className="spin" size={16} aria-hidden="true" /> : <KeyRound size={16} aria-hidden="true" />}{t(creatingGrant ? "automations.notes.creatingGrant" : "automations.notes.createGrant")}</button>
          </form>

          {visibleCreatedGrant && <section className="notes-one-time-secret" aria-labelledby="notes-token-title">
            <div><Check size={18} aria-hidden="true" /><div><strong id="notes-token-title">{t("automations.notes.tokenTitle")}</strong><p>{t("automations.notes.tokenBody", { device: visibleCreatedGrant.deviceLabel, house: selectedGrantHouse?.name ?? visibleCreatedGrant.houseId })}</p></div></div>
            <CopyValue id="notes-token" label={t("automations.notes.tokenLabel")} value={visibleCreatedGrant.token} copyResult={copyResult} onCopy={copy} t={t} secret />
            <CopyValue id="notes-snapshot-url" label={t("automations.notes.snapshotUrl")} value={snapshotUrl} copyResult={copyResult} onCopy={copy} t={t} />
            <CopyValue id="notes-capture-url" label={t("automations.notes.captureUrl")} value={captureUrl} copyResult={copyResult} onCopy={copy} t={t} />
          </section>}

          <div className="notes-recipes">
            <details open={Boolean(visibleCreatedGrant)}><summary><span><Send size={16} aria-hidden="true" /><span><strong>{t("automations.notes.captureRecipeTitle")}</strong><small>{t("automations.notes.captureRecipeSummary")}</small></span></span><ChevronDown size={16} aria-hidden="true" /></summary><div><ol><li>{t("automations.notes.captureStep1")}</li><li>{t("automations.notes.captureStep2")}</li><li>{t("automations.notes.captureStep3")}</li><li>{t("automations.notes.captureStep4")}</li></ol><pre><code>{captureExample}</code></pre><p className="security-note"><KeyRound size={15} aria-hidden="true" />{t("automations.notes.authorizationHeader")}</p></div></details>
            <details><summary><span><Smartphone size={16} aria-hidden="true" /><span><strong>{t("automations.notes.snapshotRecipeTitle")}</strong><small>{t("automations.notes.snapshotRecipeSummary")}</small></span></span><ChevronDown size={16} aria-hidden="true" /></summary><div><ol><li>{t("automations.notes.snapshotStep1")}</li><li>{t("automations.notes.snapshotStep2")}</li><li>{t("automations.notes.snapshotStep3")}</li><li>{t("automations.notes.snapshotStep4")}</li></ol><p className="notes-caveat">{t("automations.notes.folderCaveat")}</p><p className="notes-caveat">{t("automations.notes.automationCaveat")}</p></div></details>
          </div>

          <section className="notes-grant-list" aria-labelledby="notes-grants-title"><div><h4 id="notes-grants-title">{t("automations.notes.activeGrants")}</h4>{loadingNotes && <LoaderCircle className="spin" size={16} aria-label={t("common.loading")} />}</div>{notesLoadFailed && <p className="automation-feedback error" role="alert"><TriangleAlert size={15} aria-hidden="true" />{t("automations.notes.loadFailed")}</p>}{!loadingNotes && !notesLoadFailed && houseNotesGrants.length === 0 ? <p>{t("automations.notes.noGrants")}</p> : <ul>{houseNotesGrants.map((grant) => { const grantHouse = houses.find((candidate) => candidate.id === grant.houseId); return <li key={grant.id}><span><strong>{grant.deviceLabel}</strong><small>{grantHouse?.name ?? grant.houseId} · {new Intl.DateTimeFormat(locale, { dateStyle: "medium" }).format(new Date(grant.createdAt))}</small></span><button type="button" className="icon-button danger-text" disabled={revokingGrantId === grant.id} onClick={() => void revokeGrant(grant.id)} aria-label={t("automations.notes.revokeGrant", { device: grant.deviceLabel })}>{revokingGrantId === grant.id ? <LoaderCircle className="spin" size={15} /> : <Trash2 size={15} />}</button></li>; })}</ul>}</section>
          {notesFeedback && <p className={`automation-feedback ${notesFeedback.kind}`} role={notesFeedback.kind === "error" ? "alert" : "status"}>{notesFeedback.kind === "success" ? <Check size={15} aria-hidden="true" /> : <TriangleAlert size={15} aria-hidden="true" />}{notesFeedback.message}</p>}
          <p className="automation-privacy-note"><ShieldCheck size={15} aria-hidden="true" />{t("automations.notes.privacy")}</p>
        </>}</div>
      </details>
    </div>
  </section>;
}

function CopyValue({ id, label, value, secret = false, copyResult, onCopy, t }: Readonly<{
  id: string;
  label: string;
  value: string;
  secret?: boolean;
  copyResult: { id: string; status: "copied" | "failed" } | null;
  onCopy: (id: string, value: string) => Promise<void>;
  t: ReturnType<typeof useI18n>["t"];
}>) {
  const status = copyResult?.id === id ? copyResult.status : null;
  return <label className="notes-copy-value"><span>{label}</span><span><input type={secret ? "password" : "text"} readOnly value={value} onFocus={(event) => event.currentTarget.select()} /><button type="button" className="icon-button" onClick={() => void onCopy(id, value)} aria-label={t("automations.notes.copyValue", { label })}><Copy size={15} aria-hidden="true" /></button></span>{status && <small className={status} role="status">{t(status === "copied" ? "automations.notes.copied" : "automations.notes.copyFailed")}</small>}</label>;
}
