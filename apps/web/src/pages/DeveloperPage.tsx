import { useEffect, useRef, useState } from "react";
import { Braces, Check, Clipboard, Cloud, ExternalLink, Radio, ServerCog, ShieldCheck, TerminalSquare, TriangleAlert } from "lucide-react";
import { API_BASE, API_V2_BASE } from "../api";
import { useI18n } from "../i18n";

export function DeveloperPage() {
  const { t } = useI18n();
  const [copyResult, setCopyResult] = useState<{ id: string; status: "copied" | "failed" } | null>(null);
  const clearCopyResultTimer = useRef<number | null>(null);
  const origin = typeof window === "undefined" ? "http://localhost:8787" : window.location.origin;
  const absoluteBase = API_BASE.startsWith("http") ? API_BASE : `${origin}${API_BASE}`;
  const absoluteV2Base = API_V2_BASE.startsWith("http") ? API_V2_BASE : `${origin}${API_V2_BASE}`;
  const hostedOpenApi = `${origin}/api/openapi.json`;
  const hostedRoutes = `${origin}/api/hosted-routes.json`;
  const mcpCommand = "node apps/api/dist/mcp-server.js";

  useEffect(() => () => {
    if (clearCopyResultTimer.current !== null) window.clearTimeout(clearCopyResultTimer.current);
  }, []);

  const showCopyResult = (id: string, status: "copied" | "failed") => {
    setCopyResult({ id, status });
    if (clearCopyResultTimer.current !== null) window.clearTimeout(clearCopyResultTimer.current);
    clearCopyResultTimer.current = window.setTimeout(() => setCopyResult(null), 2500);
  };

  const copy = async (id: string, value: string) => {
    let timeoutId: number | null = null;

    try {
      if (!navigator.clipboard?.writeText) throw new Error("Clipboard API is unavailable");
      await Promise.race([
        navigator.clipboard.writeText(value),
        new Promise<never>((_, reject) => {
          timeoutId = window.setTimeout(() => reject(new Error("Clipboard request timed out")), 1500);
        }),
      ]);
      showCopyResult(id, "copied");
    } catch {
      showCopyResult(id, "failed");
    } finally {
      if (timeoutId !== null) window.clearTimeout(timeoutId);
    }
  };

  return (
    <>
      <header className="page-heading"><div><span className="eyebrow"><Braces size={14} aria-hidden="true" />{t("developer.contractsEyebrow")}</span><h1>{t("developer.title")}</h1><p>{t("developer.description")}</p></div></header>
      <div className="developer-grid">
        <section className="panel developer-card" aria-labelledby="api-title">
          <div className="developer-icon api" aria-hidden="true"><ServerCog size={23} /></div>
          <div><span className="eyebrow">{t("developer.localRuntime")}</span><h2 id="api-title">{t("developer.api")}</h2><p>{t("developer.apiBody")}</p></div>
          <dl className="endpoint-list">
            <Endpoint label={t("developer.baseUrl")} value={absoluteBase} icon={<Braces size={15} />} status={copyResult?.id === "api" ? copyResult.status : null} onCopy={() => copy("api", absoluteBase)} />
            <Endpoint label={t("developer.measurementBaseUrl")} value={absoluteV2Base} icon={<Braces size={15} />} status={copyResult?.id === "api-v2" ? copyResult.status : null} onCopy={() => copy("api-v2", absoluteV2Base)} />
            <Endpoint label={t("developer.events")} value={`${absoluteBase}/events`} icon={<Radio size={15} />} status={copyResult?.id === "events" ? copyResult.status : null} onCopy={() => copy("events", `${absoluteBase}/events`)} />
            <Endpoint label={t("developer.measurementEvents")} value={`${absoluteV2Base}/measurements/events`} icon={<Radio size={15} />} status={copyResult?.id === "events-v2" ? copyResult.status : null} onCopy={() => copy("events-v2", `${absoluteV2Base}/measurements/events`)} />
            <div><dt><ExternalLink size={15} aria-hidden="true" />{t("developer.docs")}</dt><dd><a href={`${absoluteBase}/openapi.json`}>{absoluteBase}/openapi.json</a></dd></div>
          </dl>
        </section>
        <section className="panel developer-card" aria-labelledby="mcp-title">
          <div className="developer-icon mcp" aria-hidden="true"><TerminalSquare size={23} /></div>
          <div><span className="eyebrow">{t("developer.localRuntime")}</span><h2 id="mcp-title">{t("developer.mcp")}</h2><p>{t("developer.mcpBody")}</p></div>
          <dl className="endpoint-list">
            <Endpoint label={t("developer.mcpCommand")} value={mcpCommand} icon={<TerminalSquare size={15} />} status={copyResult?.id === "mcp" ? copyResult.status : null} onCopy={() => copy("mcp", mcpCommand)} />
            <div><dt><Braces size={15} aria-hidden="true" />{t("developer.resources")}</dt><dd>{t("developer.resourceList")}</dd></div>
          </dl>
        </section>
        <section className="panel developer-card hosted-developer-card" aria-labelledby="hosted-title">
          <div className="developer-icon hosted" aria-hidden="true"><Cloud size={23} /></div>
          <div><span className="eyebrow">{t("developer.hostedOnly")}</span><h2 id="hosted-title">{t("developer.hostedTitle")}</h2><p>{t("developer.hostedBody")}</p></div>
          <p className="developer-boundary"><ShieldCheck size={17} aria-hidden="true" />{t("developer.hostedBoundary")}</p>
          <dl className="endpoint-list">
            <Endpoint label={t("developer.hostedOpenApi")} value={hostedOpenApi} icon={<Braces size={15} />} status={copyResult?.id === "hosted-openapi" ? copyResult.status : null} onCopy={() => copy("hosted-openapi", hostedOpenApi)} />
            <Endpoint label={t("developer.hostedRoutes")} value={hostedRoutes} icon={<Braces size={15} />} status={copyResult?.id === "hosted-routes" ? copyResult.status : null} onCopy={() => copy("hosted-routes", hostedRoutes)} />
          </dl>
        </section>
      </div>
      <section className="panel route-table" aria-labelledby="routes-title">
        <div className="panel-header"><div><span className="eyebrow">{t("developer.localRuntime")} {"\u00b7"} /api/v1 {"\u00b7"} /api/v2</span><h2 id="routes-title">{t("developer.localRoutesTitle")}</h2></div></div>
        <div className="table-scroll" role="region" aria-labelledby="routes-title" tabIndex={0}><table><caption className="sr-only">{t("developer.routeTableCaption")}</caption><thead><tr><th>{t("developer.method")}</th><th>{t("developer.route")}</th><th>{t("developer.resource")}</th></tr></thead><tbody>
          <tr><td><code>GET</code></td><td><code>/houses</code></td><td>{t("developer.routeHouses")}</td></tr>
          <tr><td><code>GET</code></td><td><code>/snapshot?houseId=…</code></td><td>{t("developer.routeSnapshot")}</td></tr>
          <tr><td><code>GET</code></td><td><code>/readings?sensorId=…</code></td><td>{t("developer.routeReadings")}</td></tr>
          <tr><td><code>GET</code></td><td><code>/forecast?sensorId=…</code></td><td>{t("developer.routeForecast")}</td></tr>
          <tr><td><code>GET</code></td><td><code>/events</code></td><td>{t("developer.routeEvents")}</td></tr>
          <tr><td><code>POST</code></td><td><code>/observations</code></td><td>{t("developer.routeObservations")}</td></tr>
          <tr><td><code>GET v2</code></td><td><code>/measurement-definitions</code></td><td>{t("developer.routeDefinitions")}</td></tr>
          <tr><td><code>GET v2</code></td><td><code>/measurements/snapshot?houseId=…</code></td><td>{t("developer.routeMeasurementSnapshot")}</td></tr>
          <tr><td><code>GET v2</code></td><td><code>/measurements/history?sensorId=…&amp;metric=…</code></td><td>{t("developer.routeMeasurementHistory")}</td></tr>
          <tr><td><code>GET v2</code></td><td><code>/measurements/forecast?sensorId=…&amp;metric=…&amp;hours=…</code></td><td>{t("developer.routeMeasurementForecast")}</td></tr>
          <tr><td><code>GET v2</code></td><td><code>/measurements/events</code></td><td>{t("developer.routeMeasurementEvents")}</td></tr>
        </tbody></table></div>
      </section>
    </>
  );
}

function Endpoint({ label, value, icon, status, onCopy }: { label: string; value: string; icon: React.ReactNode; status: "copied" | "failed" | null; onCopy: () => void }) {
  const { t } = useI18n();
  let statusText = "";
  let statusIcon = <Clipboard size={15} aria-hidden="true" />;

  if (status === "copied") {
    statusText = t("developer.copied");
    statusIcon = <Check size={15} aria-hidden="true" />;
  } else if (status === "failed") {
    statusText = t("developer.copyFailed");
    statusIcon = <TriangleAlert size={15} aria-hidden="true" />;
  }

  return <div><dt>{icon}{label}</dt><dd><input className="endpoint-value" aria-label={label} readOnly value={value} onFocus={(event) => event.currentTarget.select()} /><button type="button" className="icon-button small" onClick={onCopy} aria-label={`${t("developer.copy")}: ${label}`} title={statusText || undefined}>{statusIcon}</button><span className="sr-only" role="status">{statusText}</span></dd></div>;
}
