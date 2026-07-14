import { AlertTriangle, ArrowRight, Building2, Clock3, CloudSun, MapPin, RadioTower } from "lucide-react";
import type { House, IntegrationStatus, MeasurementSample, Sensor } from "@climate-twin/contracts";
import { useI18n } from "../i18n";
import { formatInTimeZone } from "../dateTime";
import { useNow } from "../useNow";

interface PortfolioOverviewProps {
  houses: House[];
  sensors: Sensor[];
  latestMeasurements: Record<string, Record<string, MeasurementSample>>;
  openAlertSensorIds: ReadonlySet<string>;
  integration: IntegrationStatus;
  onOpenTwin: (houseId: string) => void;
  onOpenOutdoor: (houseId: string) => void;
  onOpenSetup: (houseId: string) => void;
}

function localTime(timezone: string, locale: string, now: number): string {
  return formatInTimeZone(now, locale, timezone, {
    weekday: "short",
    hour: "2-digit",
    minute: "2-digit",
    timeZoneName: "short",
  });
}

function newestSample(
  sensorIds: ReadonlySet<string>,
  latest: Record<string, Record<string, MeasurementSample>>,
): MeasurementSample | null {
  return Object.entries(latest)
    .filter(([sensorId]) => sensorIds.has(sensorId))
    .flatMap(([, measurements]) => Object.values(measurements))
    .sort((first, second) => Date.parse(second.timestamp) - Date.parse(first.timestamp))[0] ?? null;
}

export function PortfolioOverview({
  houses,
  sensors,
  latestMeasurements,
  openAlertSensorIds,
  integration,
  onOpenTwin,
  onOpenOutdoor,
  onOpenSetup,
}: PortfolioOverviewProps) {
  const { locale, t } = useI18n();
  const now = useNow();

  return (
    <div className="page-stack portfolio-overview">
      <header className="page-heading portfolio-heading">
        <div>
          <span className="eyebrow">{t("overview.eyebrow", { count: houses.length })}</span>
          <h1>{t("overview.title")}</h1>
          <p>{t("overview.description")}</p>
        </div>
      </header>

      <section className="portfolio-grid" aria-label={t("overview.homes")}> 
        {houses.map((house) => {
          const houseSensors = sensors.filter((sensor) => sensor.houseId === house.id && sensor.enabled);
          const sensorIds = new Set(houseSensors.map((sensor) => sensor.id));
          const newest = newestSample(sensorIds, latestMeasurements);
          const newestTimestamp = newest ? Date.parse(newest.timestamp) : Number.NaN;
          const age = now - newestTimestamp;
          const reporting = Number.isFinite(age) && newestTimestamp <= now + 5 * 60_000 && age < 30 * 60_000;
          const alertCount = houseSensors.filter((sensor) => openAlertSensorIds.has(sensor.id)).length;
          const ready = Boolean(house.location);

          return (
            <article className="panel portfolio-card" key={house.id}>
              <div className="portfolio-card-title">
                <span className="portfolio-home-icon" aria-hidden="true"><Building2 size={19} /></span>
                <div>
                  <h2>{house.name}</h2>
                  <p><Clock3 size={14} aria-hidden="true" />{localTime(house.timezone, locale, now)}</p>
                </div>
                {alertCount > 0 && <span className="portfolio-alert"><AlertTriangle size={14} aria-hidden="true" />{t("overview.alertCount", { count: alertCount })}</span>}
              </div>

              <dl className="portfolio-facts">
                <div>
                  <dt><MapPin size={15} aria-hidden="true" />{t("overview.location")}</dt>
                  <dd>{house.location?.label || (ready ? t("overview.locationReady") : t("overview.locationMissing"))}</dd>
                </div>
                <div>
                  <dt><RadioTower size={15} aria-hidden="true" />{t("overview.sensors")}</dt>
                  <dd>{t("overview.sensorCount", { count: houseSensors.length })} · {reporting ? t("overview.reporting") : t("overview.waiting")}</dd>
                </div>
                <div>
                  <dt><CloudSun size={15} aria-hidden="true" />{t("overview.outdoor")}</dt>
                  <dd>{ready ? t("overview.outdoorReady") : t("overview.locationNeeded")}</dd>
                </div>
              </dl>

              <div className="portfolio-card-actions">
                <button type="button" className="primary-button" aria-label={`${t("overview.openHome")}: ${house.name}`} onClick={() => onOpenTwin(house.id)}>
                  {t("overview.openHome")}<ArrowRight size={15} aria-hidden="true" />
                </button>
                {ready
                  ? <button type="button" className="secondary-button" aria-label={`${t("overview.openOutdoor")}: ${house.name}`} onClick={() => onOpenOutdoor(house.id)}>{t("overview.openOutdoor")}</button>
                  : <button type="button" className="secondary-button" aria-label={`${t("overview.finishSetup")}: ${house.name}`} onClick={() => onOpenSetup(house.id)}>{t("overview.finishSetup")}</button>}
              </div>
            </article>
          );
        })}
      </section>

      <section className="panel portfolio-system-summary" aria-labelledby="portfolio-system-heading">
        <div>
          <span className="eyebrow">{t("overview.connections")}</span>
          <h2 id="portfolio-system-heading">{t("overview.connectionTitle")}</h2>
        </div>
        <ul>
          <li data-state={integration.homeAssistant.connected ? "ready" : "idle"}>Home Assistant · {integration.homeAssistant.connected ? t("common.connected") : t("common.notConnected")}</li>
          <li data-state={integration.tpLink.connected ? "ready" : "idle"}>TP-Link · {integration.tpLink.connected ? t("common.connected") : t("common.notConnected")}</li>
          <li data-state={integration.mock.mode === "real" ? "ready" : "idle"}>{integration.mock.mode === "real" ? t("setup.realDataMode") : t("setup.mockEnabled")}</li>
        </ul>
      </section>
    </div>
  );
}
