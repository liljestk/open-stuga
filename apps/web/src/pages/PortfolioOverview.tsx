import { AlertTriangle, ArrowRight, Building2, CheckCircle2, ChevronDown, Clock3, CloudSun, HelpCircle, MapPin, RadioTower } from "lucide-react";
import type { AlertEvent, AlertRule, House, IntegrationStatus, Property, PropertyArea, Sensor } from "@climate-twin/contracts";
import { useI18n, type TranslationKey } from "../i18n";
import { formatInTimeZone } from "../dateTime";
import { useNow } from "../useNow";
import { deriveHouseMonitoring, monitoringPrimaryBlocker, type HouseMonitoringBlocker, type HouseMonitoringResult } from "../houseMonitoring";
import type { LatestMeasurements, MeasurementHistory } from "../measurements";
import { integrationForHouse } from "../integrationScope";

interface PortfolioOverviewProps {
  properties: Property[];
  propertyAreas: Array<Pick<PropertyArea, "id" | "propertyId">>;
  houses: House[];
  sensors: Sensor[];
  latestMeasurements: LatestMeasurements;
  measurementHistory: MeasurementHistory;
  alerts: AlertEvent[];
  alertRules: AlertRule[];
  integration: IntegrationStatus;
  onOpenProperty: (propertyId: string) => void;
  onOpenTwin: (houseId: string) => void;
  onOpenOutdoor: (houseId: string) => void;
  onOpenSetup: (houseId: string) => void;
  readOnly?: boolean;
}

function localTime(timezone: string, locale: string, now: number): string {
  return formatInTimeZone(now, locale, timezone, {
    weekday: "short",
    hour: "2-digit",
    minute: "2-digit",
    timeZoneName: "short",
  });
}

function blockerText(blocker: HouseMonitoringBlocker, t: ReturnType<typeof useI18n>["t"]): string {
  if (blocker.kind === "critical-alert") return t("overview.blocker.criticalAlert");
  if (blocker.kind === "warning-alert") return t("overview.blocker.warningAlert");
  if (blocker.kind === "information-alert") return t("overview.blocker.informationAlert");
  if (blocker.kind === "no-sensors") return t("overview.blocker.noSensors");
  if (blocker.kind === "missing-data") return t("overview.blocker.missingData", { count: blocker.count });
  if (blocker.kind === "stale-data") return t("overview.blocker.staleData", { count: blocker.count });
  if (blocker.kind === "source-disconnected") return t("overview.blocker.sourceDisconnected", { count: blocker.count });
  if (blocker.kind === "estimated-data") return t("overview.blocker.estimatedData", { count: blocker.count });
  return t("overview.blocker.agingData", { count: blocker.count });
}

function MonitoringIcon({ result }: { result: HouseMonitoringResult }) {
  if (result.status === "monitoring-ok") return <CheckCircle2 size={16} aria-hidden="true" />;
  if (result.status === "unknown") return <HelpCircle size={16} aria-hidden="true" />;
  return <AlertTriangle size={16} aria-hidden="true" />;
}

export function PortfolioOverview({
  properties,
  propertyAreas,
  houses,
  sensors,
  latestMeasurements,
  measurementHistory,
  alerts,
  alertRules,
  integration,
  onOpenProperty,
  onOpenTwin,
  onOpenOutdoor,
  onOpenSetup,
  readOnly = false,
}: PortfolioOverviewProps) {
  const { locale, t } = useI18n();
  const now = useNow();
  const propertySummary = (homeCount: number, areaCount: number) => `${t(homeCount === 1 ? "properties.homeCountOne" : "properties.homeCountMany", { count: homeCount })} · ${t(areaCount === 1 ? "properties.areaCountOne" : "properties.areaCountMany", { count: areaCount })}`;
  const monitoring = new Map(houses.map((house) => [house.id, deriveHouseMonitoring({
    house,
    sensors,
    latestMeasurements,
    measurementHistory,
    alerts,
    alertRules,
    integration: integrationForHouse(integration, house.id, Boolean(house.location)),
    referenceTime: now,
  })]));
  const monitoredHouses = houses.map((house) => ({ house, result: monitoring.get(house.id)! }));
  const propertyGroups = properties.map((property) => {
    const homes = monitoredHouses.filter(({ house }) => house.propertyId === property.id);
    return {
      property,
      areaCount: propertyAreas.filter((area) => area.propertyId === property.id).length,
      attentionHomes: homes.filter(({ result }) => result.status !== "monitoring-ok"),
      confirmedHomes: homes.filter(({ result }) => result.status === "monitoring-ok"),
    };
  });

  if (readOnly && properties.length === 0 && houses.length === 0) {
    return <div className="page-stack portfolio-overview">
      <header className="page-heading portfolio-heading"><div><span className="eyebrow">{t("properties.guestReadOnly")}</span><h1>{t("overview.title")}</h1><p>{t("overview.description")}</p></div></header>
      <section className="property-empty-page" aria-labelledby="portfolio-no-access-title"><MapPin size={28} aria-hidden="true" /><h2 id="portfolio-no-access-title">{t("properties.noAccessTitle")}</h2><p>{t("properties.noAccessBody")}</p></section>
    </div>;
  }

  const renderHouseCard = ({ house, result }: (typeof monitoredHouses)[number], Heading: "h3" | "h4" = "h3") => {
    const houseSensors = sensors.filter((sensor) => sensor.houseId === house.id && sensor.enabled);
    const primaryBlocker = monitoringPrimaryBlocker(result);
    const reportingCount = result.coverage.freshSensors;
    const alertCount = result.activeAlertCount;
    const locationReady = Boolean(house.location);
    const primaryRoutesToSetup = !readOnly && Boolean(primaryBlocker && !primaryBlocker.kind.endsWith("alert"));

    return (
      <article className="panel portfolio-card" key={house.id} data-monitoring-status={result.status}>
        <div className="portfolio-card-title">
          <span className="portfolio-home-icon" aria-hidden="true"><Building2 size={19} /></span>
          <div>
            <Heading>{house.name}</Heading>
            <p><Clock3 size={14} aria-hidden="true" />{localTime(house.timezone, locale, now)}</p>
          </div>
          {alertCount > 0 && <span className="portfolio-alert"><AlertTriangle size={14} aria-hidden="true" />{t("overview.alertCount", { count: alertCount })}</span>}
        </div>

        <div className={`portfolio-monitoring ${result.status}`}>
          <MonitoringIcon result={result} />
          <span><strong>{t(`overview.monitoring.${result.status}` as TranslationKey)}</strong><small>{primaryBlocker ? blockerText(primaryBlocker, t) : t("overview.blocker.none")}</small></span>
        </div>

        <dl className="portfolio-facts">
          <div>
            <dt><MapPin size={15} aria-hidden="true" />{t("overview.location")}</dt>
            <dd>{house.location?.label || (locationReady ? t("overview.locationReady") : t("overview.locationMissing"))}</dd>
          </div>
          <div>
            <dt><RadioTower size={15} aria-hidden="true" />{t("overview.sensors")}</dt>
            <dd>{t("overview.sensorCount", { count: houseSensors.length })} · {reportingCount === houseSensors.length && houseSensors.length > 0 ? t("overview.reporting") : reportingCount > 0 ? t("overview.partialReporting", { fresh: reportingCount, total: houseSensors.length }) : t("overview.waiting")}</dd>
          </div>
          <div>
            <dt><CloudSun size={15} aria-hidden="true" />{t("overview.outdoor")}</dt>
            <dd>{locationReady ? t("overview.outdoorReady") : t("overview.locationNeeded")}</dd>
          </div>
        </dl>

        <div className="portfolio-card-actions">
          {primaryRoutesToSetup
            ? <button type="button" className="primary-button" data-remediation="setup" aria-label={`${t("overview.finishSetup")}: ${house.name}`} onClick={() => onOpenSetup(house.id)}>{t("overview.finishSetup")}<ArrowRight size={15} aria-hidden="true" /></button>
            : <button type="button" className="primary-button" data-remediation="home" aria-label={`${t("overview.openHome")}: ${house.name}`} onClick={() => onOpenTwin(house.id)}>{t("overview.openHome")}<ArrowRight size={15} aria-hidden="true" /></button>}
          {locationReady
            ? <button type="button" className="secondary-button" aria-label={`${t("overview.openOutdoor")}: ${house.name}`} onClick={() => onOpenOutdoor(house.id)}>{t("overview.openOutdoor")}</button>
            : !readOnly && primaryRoutesToSetup
              ? <button type="button" className="secondary-button" aria-label={`${t("overview.openHome")}: ${house.name}`} onClick={() => onOpenTwin(house.id)}>{t("overview.openHome")}</button>
              : !readOnly
                ? <button type="button" className="secondary-button" aria-label={`${t("overview.finishSetup")}: ${house.name}`} onClick={() => onOpenSetup(house.id)}>{t("overview.finishSetup")}</button>
                : null}
        </div>
      </article>
    );
  };

  return (
    <div className="page-stack portfolio-overview">
      <header className="page-heading portfolio-heading">
        <div>
          <span className="eyebrow">{t(properties.length === 1 ? "overview.propertyCountOne" : "overview.propertyCountMany", { count: properties.length })}</span>
          <h1>{t("overview.title")}</h1>
          <p>{t("overview.description")}</p>
        </div>
      </header>

      {propertyGroups.map(({ property, areaCount, attentionHomes, confirmedHomes }) => <section className="panel portfolio-property" key={property.id} aria-labelledby={`portfolio-property-${property.id}`}>
        <div className="portfolio-card-title">
          <span className="portfolio-home-icon" aria-hidden="true"><MapPin size={19} /></span>
          <div>
            <span className="eyebrow">{t("properties.activeProperty")}</span>
            <h2 id={`portfolio-property-${property.id}`}>{property.name}</h2>
            <p>{propertySummary(attentionHomes.length + confirmedHomes.length, areaCount)}</p>
          </div>
          <button type="button" className="secondary-button" aria-label={`${t("nav.properties")}: ${property.name}`} onClick={() => onOpenProperty(property.id)}>{t("nav.properties")}<ArrowRight size={15} aria-hidden="true" /></button>
        </div>
        {attentionHomes.length === 0 && confirmedHomes.length === 0
          ? <p className="property-empty-copy">{t("properties.noHouses")}</p>
          : <>
            {attentionHomes.length > 0 && <section className="portfolio-attention-zone" aria-labelledby={`portfolio-attention-${property.id}`}>
              <div className="portfolio-attention">
                <span aria-hidden="true"><AlertTriangle size={20} /></span>
                <div><span className="eyebrow">{t("overview.needsAttention")}</span><h3 id={`portfolio-attention-${property.id}`}>{t(attentionHomes.length === 1 ? "overview.attentionHome" : "overview.attentionHomes", { count: attentionHomes.length })}</h3><p>{t("overview.attentionDescription")}</p></div>
              </div>
              <div className="portfolio-grid">{attentionHomes.map((home) => renderHouseCard(home, "h4"))}</div>
            </section>}
            {confirmedHomes.length > 0 && (attentionHomes.length > 0
              ? <details className="panel portfolio-system-summary portfolio-confirmed-homes">
                <summary><span><span className="eyebrow">{t("overview.homes")}</span><strong>{t("overview.monitoring.monitoring-ok")} · {confirmedHomes.length}</strong></span><ChevronDown size={18} aria-hidden="true" /></summary>
                <div className="portfolio-grid">{confirmedHomes.map((home) => renderHouseCard(home))}</div>
              </details>
              : <div className="portfolio-grid" aria-label={t("overview.homes")}>{confirmedHomes.map((home) => renderHouseCard(home))}</div>)}
          </>}
      </section>)}

      <details className="panel portfolio-system-summary">
        <summary><span><span className="eyebrow">{t("overview.connections")}</span><strong id="portfolio-system-heading">{t("overview.connectionTitle")}</strong></span><ChevronDown size={18} aria-hidden="true" /></summary>
        <ul>
          <li data-state={integration.homeAssistant.connected ? "ready" : "idle"}>Home Assistant · {integration.homeAssistant.connected ? t("common.connected") : t("common.notConnected")}</li>
          <li data-state={integration.tpLink.connected ? "ready" : "idle"}>TP-Link · {integration.tpLink.connected ? t("common.connected") : t("common.notConnected")}</li>
          <li data-state={integration.mock.mode === "real" ? "ready" : "idle"}>{integration.mock.mode === "real" ? t("setup.realDataMode") : t("setup.mockEnabled")}</li>
        </ul>
      </details>
    </div>
  );
}
