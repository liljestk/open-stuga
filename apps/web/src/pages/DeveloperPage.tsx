import { useState } from "react";
import { Braces, Check, Clipboard, ExternalLink, Radio, ServerCog, TerminalSquare } from "lucide-react";
import { API_BASE, API_V2_BASE } from "../api";
import { useI18n } from "../i18n";

export function DeveloperPage() {
  const { t } = useI18n();
  const [copied, setCopied] = useState<string | null>(null);
  const origin = typeof window === "undefined" ? "http://localhost:8787" : window.location.origin;
  const absoluteBase = API_BASE.startsWith("http") ? API_BASE : `${origin}${API_BASE}`;
  const absoluteV2Base = API_V2_BASE.startsWith("http") ? API_V2_BASE : `${origin}${API_V2_BASE}`;
  const mcpCommand = "node apps/api/dist/mcp-server.js";

  const copy = async (id: string, value: string) => {
    try { await navigator.clipboard.writeText(value); setCopied(id); window.setTimeout(() => setCopied(null), 1500); } catch { /* Clipboard may be unavailable in non-secure local contexts. */ }
  };

  return (
    <>
      <header className="page-heading"><div><span className="eyebrow"><Braces size={14} aria-hidden="true" />v1 + v2</span><h1>{t("developer.title")}</h1><p>{t("developer.description")}</p></div></header>
      <div className="developer-grid">
        <section className="panel developer-card" aria-labelledby="api-title">
          <div className="developer-icon api" aria-hidden="true"><ServerCog size={23} /></div>
          <div><span className="eyebrow">REST + SSE</span><h2 id="api-title">{t("developer.api")}</h2><p>{t("developer.apiBody")}</p></div>
          <dl className="endpoint-list">
            <Endpoint label={t("developer.baseUrl")} value={absoluteBase} icon={<Braces size={15} />} copied={copied === "api"} onCopy={() => copy("api", absoluteBase)} />
            <Endpoint label={t("developer.measurementBaseUrl")} value={absoluteV2Base} icon={<Braces size={15} />} copied={copied === "api-v2"} onCopy={() => copy("api-v2", absoluteV2Base)} />
            <Endpoint label={t("developer.events")} value={`${absoluteBase}/events`} icon={<Radio size={15} />} copied={copied === "events"} onCopy={() => copy("events", `${absoluteBase}/events`)} />
            <Endpoint label={t("developer.measurementEvents")} value={`${absoluteV2Base}/measurements/events`} icon={<Radio size={15} />} copied={copied === "events-v2"} onCopy={() => copy("events-v2", `${absoluteV2Base}/measurements/events`)} />
            <div><dt><ExternalLink size={15} aria-hidden="true" />{t("developer.docs")}</dt><dd><a href={`${absoluteBase}/openapi.json`}>{absoluteBase}/openapi.json</a></dd></div>
          </dl>
        </section>
        <section className="panel developer-card" aria-labelledby="mcp-title">
          <div className="developer-icon mcp" aria-hidden="true"><TerminalSquare size={23} /></div>
          <div><span className="eyebrow">Model Context Protocol</span><h2 id="mcp-title">{t("developer.mcp")}</h2><p>{t("developer.mcpBody")}</p></div>
          <dl className="endpoint-list">
            <Endpoint label={t("developer.mcpCommand")} value={mcpCommand} icon={<TerminalSquare size={15} />} copied={copied === "mcp"} onCopy={() => copy("mcp", mcpCommand)} />
            <div><dt><Braces size={15} aria-hidden="true" />{t("developer.resources")}</dt><dd>{t("developer.resourceList")}</dd></div>
          </dl>
        </section>
      </div>
      <section className="panel route-table" aria-labelledby="routes-title">
        <div className="panel-header"><div><span className="eyebrow">/api/v1 · /api/v2</span><h2 id="routes-title">{t("developer.resources")}</h2></div></div>
        <div className="table-scroll"><table><thead><tr><th>{t("developer.method")}</th><th>{t("developer.route")}</th><th>{t("developer.resource")}</th></tr></thead><tbody>
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

function Endpoint({ label, value, icon, copied, onCopy }: { label: string; value: string; icon: React.ReactNode; copied: boolean; onCopy: () => void }) {
  const { t } = useI18n();
  return <div><dt>{icon}{label}</dt><dd><code>{value}</code><button type="button" className="icon-button small" onClick={onCopy} aria-label={`${t("developer.copy")}: ${label}`}>{copied ? <Check size={15} /> : <Clipboard size={15} />}</button><span className="sr-only" role="status">{copied ? t("developer.copied") : ""}</span></dd></div>;
}
