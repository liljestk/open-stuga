import { useEffect, useMemo, useState } from "react";
import {
  Check,
  ChevronRight,
  CircleDot,
  CloudRain,
  CloudSun,
  Database,
  Droplets,
  ExternalLink,
  Home,
  Link2,
  LoaderCircle,
  LockKeyhole,
  MapPin,
  RadioTower,
  RefreshCw,
  Router,
  ShieldCheck,
  ThermometerSun,
  Trash2,
  TriangleAlert,
  Wind,
} from "lucide-react";
import type {
  House,
  HouseLocation,
  HouseWeather,
  IntegrationStatus,
  UnitSystem,
} from "@climate-twin/contracts";
import { api } from "../api";
import { HouseLocationMap } from "../components/HouseLocationMap";
import { useI18n } from "../i18n";

interface IntegrationsPageProps {
  integration: IntegrationStatus;
  house: House;
  houses: House[];
  units: UnitSystem;
  onHouse: (houseId: string) => void;
  onLocationChange: (location: HouseLocation | null) => Promise<void>;
}

type Feedback = { kind: "success" | "error"; message: string } | null;
type WeatherLoadState = "idle" | "loading" | "ready" | "error";

function finite(value: number | undefined): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

function dateTime(value: string | null | undefined, locale: string, timeZone: string, options?: Intl.DateTimeFormatOptions): string | null {
  if (!value) return null;
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) return null;
  try {
    return new Intl.DateTimeFormat(locale, { ...(options ?? { dateStyle: "short", timeStyle: "short" }), timeZone }).format(date);
  } catch {
    return new Intl.DateTimeFormat(locale, options ?? { dateStyle: "short", timeStyle: "short" }).format(date);
  }
}

function decimal(value: number, locale: string, maximumFractionDigits = 1): string {
  return new Intl.NumberFormat(locale, { maximumFractionDigits }).format(value);
}

function temperature(value: number | undefined, units: UnitSystem, locale: string): string | null {
  if (!finite(value)) return null;
  return units === "imperial"
    ? `${decimal(value * 9 / 5 + 32, locale)} °F`
    : `${decimal(value, locale)} °C`;
}

function windSpeed(value: number | undefined, units: UnitSystem, locale: string): string | null {
  if (!finite(value)) return null;
  return units === "imperial"
    ? `${decimal(value * 2.236936, locale)} mph`
    : `${decimal(value, locale)} m/s`;
}

function precipitation(value: number | undefined, units: UnitSystem, locale: string): string | null {
  if (!finite(value)) return null;
  return units === "imperial"
    ? `${decimal(value / 25.4, locale, 2)} in`
    : `${decimal(value, locale)} mm`;
}

function snowDepth(value: number | undefined, units: UnitSystem, locale: string): string | null {
  if (!finite(value)) return null;
  return units === "imperial"
    ? `${decimal(value / 2.54, locale)} in`
    : `${decimal(value, locale)} cm`;
}

function pressure(value: number | undefined, units: UnitSystem, locale: string): string | null {
  if (!finite(value)) return null;
  return units === "imperial"
    ? `${decimal(value * 0.029529983, locale, 2)} inHg`
    : `${decimal(value, locale)} hPa`;
}

function visibility(value: number | undefined, units: UnitSystem, locale: string): string | null {
  if (!finite(value)) return null;
  return units === "imperial"
    ? `${decimal(value / 1609.344, locale)} mi`
    : `${decimal(value / 1000, locale)} km`;
}

function distance(value: number, units: UnitSystem, locale: string): { distance: string; unit: string } {
  return units === "imperial"
    ? { distance: decimal(value * 0.621371, locale), unit: "mi" }
    : { distance: decimal(value, locale), unit: "km" };
}

function percent(value: number | undefined, locale: string): string | null {
  return finite(value) ? `${decimal(value, locale, 0)}%` : null;
}

function code(value: number | undefined, locale: string): string | null {
  return finite(value) ? decimal(value, locale, 0) : null;
}

export function IntegrationsPage({ integration, house, houses, units, onHouse, onLocationChange }: IntegrationsPageProps) {
  const { locale, t } = useI18n();
  const [testing, setTesting] = useState(false);
  const [result, setResult] = useState<"success" | "failure" | null>(null);
  const [latitude, setLatitude] = useState("");
  const [longitude, setLongitude] = useState("");
  const [locationLabel, setLocationLabel] = useState("");
  const [savingLocation, setSavingLocation] = useState(false);
  const [locationFeedback, setLocationFeedback] = useState<Feedback>(null);
  const [weather, setWeather] = useState<HouseWeather | null>(null);
  const [weatherLoadState, setWeatherLoadState] = useState<WeatherLoadState>("idle");
  const [reloadWeather, setReloadWeather] = useState(0);
  const localDateTime = (value: string | null | undefined, options?: Intl.DateTimeFormatOptions) => dateTime(value, locale, house.timezone, options);

  useEffect(() => {
    setLatitude(house.location ? String(house.location.latitude) : "");
    setLongitude(house.location ? String(house.location.longitude) : "");
    setLocationLabel(house.location?.label ?? "");
  }, [house.id, house.location?.label, house.location?.latitude, house.location?.longitude]);

  useEffect(() => { setLocationFeedback(null); }, [house.id]);

  useEffect(() => {
    if (!house.location) {
      setWeather(null);
      setWeatherLoadState("idle");
      return;
    }
    let active = true;
    setWeatherLoadState("loading");
    void api.houseWeather(house.id, 48).then((next) => {
      if (!active) return;
      setWeather(next);
      setWeatherLoadState("ready");
    }).catch(() => {
      if (!active) return;
      setWeather(null);
      setWeatherLoadState("error");
    });
    return () => { active = false; };
  }, [house.id, house.location?.latitude, house.location?.longitude, reloadWeather]);

  const draftLocation = useMemo<HouseLocation | null>(() => {
    if (!latitude.trim() || !longitude.trim()) return null;
    const parsedLatitude = Number(latitude);
    const parsedLongitude = Number(longitude);
    if (!Number.isFinite(parsedLatitude) || !Number.isFinite(parsedLongitude)
      || parsedLatitude < -90 || parsedLatitude > 90 || parsedLongitude < -180 || parsedLongitude > 180) return null;
    const label = locationLabel.trim();
    return { latitude: parsedLatitude, longitude: parsedLongitude, ...(label ? { label } : {}) };
  }, [latitude, locationLabel, longitude]);

  const testConnection = async () => {
    setTesting(true);
    setResult(null);
    try {
      const response = await api.testHomeAssistant();
      setResult(response.ok ? "success" : "failure");
    } catch { setResult("failure"); }
    finally { setTesting(false); }
  };

  const saveLocation = async () => {
    if (!draftLocation) {
      setLocationFeedback({ kind: "error", message: t("weather.invalidLocation") });
      return;
    }
    setSavingLocation(true);
    setLocationFeedback(null);
    try {
      await onLocationChange(draftLocation);
      setLocationFeedback({ kind: "success", message: t("weather.locationSaved") });
    } catch {
      setLocationFeedback({ kind: "error", message: t("weather.locationSaveError") });
    } finally {
      setSavingLocation(false);
    }
  };

  const removeLocation = async () => {
    setSavingLocation(true);
    setLocationFeedback(null);
    try {
      await onLocationChange(null);
      setLatitude("");
      setLongitude("");
      setLocationLabel("");
      setWeather(null);
      setWeatherLoadState("idle");
      setLocationFeedback({ kind: "success", message: t("weather.locationRemoved") });
    } catch {
      setLocationFeedback({ kind: "error", message: t("weather.locationSaveError") });
    } finally {
      setSavingLocation(false);
    }
  };

  const updateFromMap = (location: { latitude: number; longitude: number }) => {
    setLatitude(location.latitude.toFixed(6));
    setLongitude(location.longitude.toFixed(6));
    setLocationFeedback(null);
  };

  const steps = [
    { icon: Router, title: t("setup.step1"), body: t("setup.step1body"), complete: true },
    { icon: Home, title: t("setup.step2"), body: t("setup.step2body"), complete: integration.homeAssistant.configured },
    { icon: Link2, title: t("setup.step3"), body: t("setup.step3body"), complete: integration.homeAssistant.connected },
    { icon: ThermometerSun, title: t("setup.step4"), body: t("setup.step4body"), complete: integration.homeAssistant.mappedEntities > 0 },
  ];
  const completeCount = steps.filter((step) => step.complete).length;

  const currentDetails = weather?.current ? [
    { label: t("weather.temperature"), value: temperature(weather.current.temperatureC, units, locale) },
    { label: t("weather.dewPoint"), value: temperature(weather.current.dewPointC, units, locale) },
    { label: t("weather.humidity"), value: percent(weather.current.relativeHumidityPercent, locale) },
    { label: t("weather.pressure"), value: pressure(weather.current.pressureHpa, units, locale) },
    { label: t("weather.wind"), value: windSpeed(weather.current.windSpeedMps, units, locale) },
    { label: t("weather.gust"), value: windSpeed(weather.current.windGustMps, units, locale) },
    { label: t("weather.windDirection"), value: finite(weather.current.windDirectionDegrees) ? `${decimal(weather.current.windDirectionDegrees, locale, 0)}°` : null },
    { label: t("weather.maximumWind"), value: windSpeed(weather.current.maximumWindSpeedMps, units, locale) },
    { label: t("weather.maximumWindGust"), value: windSpeed(weather.current.maximumWindGustMps, units, locale) },
    { label: t("weather.precipitation1h"), value: precipitation(weather.current.precipitation1hMm, units, locale) },
    { label: t("weather.precipitationIntensity"), value: precipitation(weather.current.precipitationIntensityMmPerHour, units, locale) },
    { label: t("weather.precipitationProbability"), value: percent(weather.current.precipitationProbabilityPercent, locale) },
    { label: t("weather.precipitationForm"), value: code(weather.current.precipitationFormCode, locale) },
    { label: t("weather.potentialPrecipitationForm"), value: code(weather.current.potentialPrecipitationFormCode, locale) },
    { label: t("weather.snowDepth"), value: snowDepth(weather.current.snowDepthCm, units, locale) },
    { label: t("weather.cloudCover"), value: percent(weather.current.cloudCoverPercent, locale) },
    { label: t("weather.lowCloudCover"), value: percent(weather.current.lowCloudCoverPercent, locale) },
    { label: t("weather.mediumCloudCover"), value: percent(weather.current.mediumCloudCoverPercent, locale) },
    { label: t("weather.highCloudCover"), value: percent(weather.current.highCloudCoverPercent, locale) },
    { label: t("weather.visibility"), value: visibility(weather.current.visibilityMeters, units, locale) },
    { label: t("weather.fogIntensity"), value: code(weather.current.fogIntensity, locale) },
    { label: t("weather.radiation"), value: finite(weather.current.globalRadiationWm2) ? `${decimal(weather.current.globalRadiationWm2, locale)} W/m²` : null },
    { label: t("weather.weatherSymbol"), value: code(weather.current.weatherSymbolCode, locale) },
    { label: t("weather.presentWeather"), value: code(weather.current.presentWeatherCode, locale) },
    { label: t("weather.thunderRisk"), value: percent(weather.current.thunderstormProbabilityPercent, locale) },
    { label: t("weather.frostRisk"), value: percent(weather.current.frostProbabilityPercent, locale) },
    { label: t("weather.severeFrostRisk"), value: percent(weather.current.severeFrostProbabilityPercent, locale) },
  ].filter((item): item is { label: string; value: string } => item.value !== null) : [];

  const forecastSummary = useMemo(() => {
    const points = weather?.forecast ?? [];
    const temperatures = points.flatMap((point) => finite(point.temperatureC) ? [point.temperatureC] : []);
    const precipitationValues = points.flatMap((point) => finite(point.precipitation1hMm)
      ? [point.precipitation1hMm]
      : finite(point.precipitationIntensityMmPerHour) ? [point.precipitationIntensityMmPerHour] : []);
    const windValues = points.flatMap((point) => [
      point.windSpeedMps,
      point.windGustMps,
      point.maximumWindSpeedMps,
      point.maximumWindGustMps,
    ].filter(finite));
    const precipitationProbabilities = points.flatMap((point) => finite(point.precipitationProbabilityPercent) ? [point.precipitationProbabilityPercent] : []);
    return {
      minimumTemperature: temperatures.length ? Math.min(...temperatures) : undefined,
      maximumTemperature: temperatures.length ? Math.max(...temperatures) : undefined,
      totalPrecipitation: precipitationValues.length ? precipitationValues.reduce((sum, value) => sum + value, 0) : undefined,
      maximumWind: windValues.length ? Math.max(...windValues) : undefined,
      precipitationProbability: precipitationProbabilities.length ? Math.max(...precipitationProbabilities) : undefined,
    };
  }, [weather]);

  const unavailableLabel = (source: HouseWeather["unavailable"][number]) => {
    if (source === "observation") return t("weather.observations");
    if (source === "forecast") return t("weather.forecast");
    if (source === "short-range") return t("weather.shortRangeForecast");
    return t("weather.warnings");
  };
  const warningsUnavailable = weather?.unavailable.includes("warnings") ?? false;

  return (
    <>
      <header className="page-heading">
        <div><span className="eyebrow"><RadioTower size={14} aria-hidden="true" />TP-Link Tapo + Home Assistant</span><h1>{t("setup.title")}</h1><p>{t("setup.description")}</p></div>
        <span className={`integration-pill ${integration.homeAssistant.connected ? "connected" : ""}`}><span aria-hidden="true" />{integration.homeAssistant.connected ? t("common.connected") : t("common.notConnected")}</span>
      </header>
      <div className="setup-layout">
        <section className="panel setup-steps" aria-labelledby="setup-progress-title">
          <div className="panel-header setup-progress"><div><span className="eyebrow" id="setup-progress-title">{t("setup.progress")}</span><h2>{completeCount} / {steps.length}</h2></div><div className="progress-track" role="progressbar" aria-valuemin={0} aria-valuemax={steps.length} aria-valuenow={completeCount}><span style={{ width: `${completeCount / steps.length * 100}%` }} /></div></div>
          <ol className="step-list">
            {steps.map((step, index) => {
              const Icon = step.icon;
              return <li key={step.title} className={step.complete ? "complete" : ""}><span className="step-number">{step.complete ? <Check size={16} aria-hidden="true" /> : index + 1}</span><span className="step-icon" aria-hidden="true"><Icon size={20} /></span><div><h3>{step.title}</h3><p>{step.body}</p></div>{index < steps.length - 1 && <ChevronRight className="step-chevron" size={18} aria-hidden="true" />}</li>;
            })}
          </ol>
        </section>
        <div className="setup-side">
          <section className="panel connection-card" aria-labelledby="connection-heading">
            <div className="panel-header"><div><span className="eyebrow">Home Assistant</span><h2 id="connection-heading">{t("setup.step3")}</h2></div><span className="ha-mark" aria-hidden="true"><Home size={22} /></span></div>
            <div className="connection-check">
              <pre className="env-example" aria-label="Home Assistant environment variables"><code>HA_URL=http://homeassistant.local:8123{"\n"}HA_TOKEN=••••••••{"\n"}HA_ENTITY_MAP_FILE=./config/home-assistant.entities.json</code></pre>
              <p className="security-note"><LockKeyhole size={15} aria-hidden="true" />{t("setup.security")}</p>
              <button type="button" className="primary-button full-width" disabled={testing} onClick={() => void testConnection()}>{testing ? <LoaderCircle className="spin" size={16} aria-hidden="true" /> : <Link2 size={16} aria-hidden="true" />}{testing ? t("common.loading") : t("common.test")}</button>
              {result && <p className={`test-result ${result}`} role="status">{result === "success" ? <ShieldCheck size={17} aria-hidden="true" /> : <CircleDot size={17} aria-hidden="true" />}{result === "success" ? t("setup.testSuccess") : t("setup.testFailure")}</p>}
            </div>
          </section>
          <section className="panel integration-status" aria-label={t("status.dataSource")}>
            <div><span className={`status-symbol ${integration.homeAssistant.connected ? "positive" : ""}`}><Home size={17} aria-hidden="true" /></span><span><strong>Home Assistant</strong><small>{t("setup.mapped", { count: integration.homeAssistant.mappedEntities })}</small></span><b>{integration.homeAssistant.connected ? t("common.on") : t("common.off")}</b></div>
            <div><span className={`status-symbol ${integration.mock.enabled ? "positive" : ""}`}><RadioTower size={17} aria-hidden="true" /></span><span><strong>{t("setup.mockEnabled")}</strong><small>{integration.mock.intervalMs / 1000}s</small></span><b>{integration.mock.enabled ? t("common.on") : t("common.off")}</b></div>
            <div><span className={`status-symbol ${integration.webhook.configured ? "positive" : ""}`}><ExternalLink size={17} aria-hidden="true" /></span><span><strong>DayOps / OpenWearable webhook</strong><small>{integration.webhook.lastDeliveryAt ? t("setup.lastEvent", { time: localDateTime(integration.webhook.lastDeliveryAt) ?? "—" }) : t("common.noData")}</small></span><b>{integration.webhook.configured ? t("common.on") : t("common.off")}</b></div>
            <div><span className={`status-symbol ${integration.weather.configuredHouses > 0 && !integration.weather.error ? "positive" : ""}`}><CloudSun size={17} aria-hidden="true" /></span><span><strong>{t("weather.fmiIntegration")}</strong><small>{integration.weather.error ?? (integration.weather.lastSuccessAt ? t("weather.lastSuccess", { time: localDateTime(integration.weather.lastSuccessAt) ?? "—" }) : t("weather.configuredHouses", { count: integration.weather.configuredHouses }))}</small></span><b>FMI</b></div>
          </section>
        </div>
      </div>

      <section className="weather-section" aria-labelledby="weather-title">
        <header className="weather-heading">
          <div><span className="eyebrow"><CloudSun size={14} aria-hidden="true" />{t("weather.eyebrow")}</span><h2 id="weather-title">{t("weather.title")}</h2><p>{t("weather.description", { house: house.name })}</p></div>
          <div className="weather-heading-actions">
            <label className="weather-house-picker"><span>{t("common.house")}</span><select value={house.id} onChange={(event) => onHouse(event.target.value)}>{houses.map((candidate) => <option key={candidate.id} value={candidate.id}>{candidate.name}</option>)}</select></label>
            {weather && <span className={`weather-freshness ${weather.stale ? "stale" : "fresh"}`}>{weather.stale ? <TriangleAlert size={14} aria-hidden="true" /> : <Check size={14} aria-hidden="true" />}{weather.stale ? t("weather.stale") : t("weather.fresh")}</span>}
          </div>
        </header>

        <div className="weather-location-grid">
          <section className="panel weather-location-card" aria-labelledby="weather-location-title">
            <div className="panel-header"><div><span className="eyebrow">{house.name}</span><h3 id="weather-location-title">{t("weather.locationTitle")}</h3></div><span className="weather-card-icon"><MapPin size={20} aria-hidden="true" /></span></div>
            <p className="weather-card-description">{t("weather.locationDescription")}</p>
            <HouseLocationMap value={draftLocation} onChange={updateFromMap} ariaLabel={t("weather.mapLabel")} markerLabel={t("weather.markerLabel", { house: house.name })} />
            <p className="weather-map-hint">{t("weather.mapHint")}</p>
            <div className="weather-location-fields">
              <label className="field"><span>{t("weather.latitude")}</span><input type="number" min={-90} max={90} step="any" inputMode="decimal" value={latitude} onChange={(event) => { setLatitude(event.target.value); setLocationFeedback(null); }} required /></label>
              <label className="field"><span>{t("weather.longitude")}</span><input type="number" min={-180} max={180} step="any" inputMode="decimal" value={longitude} onChange={(event) => { setLongitude(event.target.value); setLocationFeedback(null); }} required /></label>
              <label className="field weather-location-label"><span>{t("weather.locationLabel")} <small>{t("common.optional")}</small></span><input type="text" maxLength={200} value={locationLabel} placeholder={t("weather.locationPlaceholder")} onChange={(event) => setLocationLabel(event.target.value)} /></label>
            </div>
            <div className="weather-location-actions">
              <button type="button" className="primary-button" disabled={savingLocation || !draftLocation} onClick={() => void saveLocation()}>{savingLocation ? <LoaderCircle className="spin" size={16} aria-hidden="true" /> : <MapPin size={16} aria-hidden="true" />}{savingLocation ? t("common.saving") : t("weather.saveLocation")}</button>
              {house.location && <button type="button" className="secondary-button" disabled={savingLocation} onClick={() => void removeLocation()}><Trash2 size={16} aria-hidden="true" />{t("weather.removeLocation")}</button>}
            </div>
            {locationFeedback && <p className={`weather-feedback ${locationFeedback.kind}`} role="status">{locationFeedback.kind === "success" ? <Check size={15} aria-hidden="true" /> : <TriangleAlert size={15} aria-hidden="true" />}{locationFeedback.message}</p>}
          </section>

          <section className="panel weather-current-card" aria-labelledby="weather-current-title">
            <div className="panel-header"><div><span className="eyebrow">{t("weather.outdoorNow")}</span><h3 id="weather-current-title">{t("weather.currentTitle")}</h3></div><span className="weather-card-icon current"><ThermometerSun size={20} aria-hidden="true" /></span></div>
            {!house.location && <div className="weather-empty"><MapPin size={26} aria-hidden="true" /><strong>{t("weather.noLocation")}</strong><p>{t("weather.noLocationDescription")}</p></div>}
            {house.location && weatherLoadState === "loading" && <div className="weather-empty" role="status"><LoaderCircle className="spin" size={26} aria-hidden="true" /><strong>{t("weather.loading")}</strong></div>}
            {house.location && weatherLoadState === "error" && <div className="weather-empty error" role="alert"><TriangleAlert size={26} aria-hidden="true" /><strong>{t("weather.unavailable")}</strong><p>{t("weather.unavailableDescription")}</p><button type="button" className="secondary-button" onClick={() => setReloadWeather((value) => value + 1)}><RefreshCw size={15} aria-hidden="true" />{t("weather.retry")}</button></div>}
            {weatherLoadState === "ready" && weather && (
              <>
                <div className="weather-meta">
                  <span>{t("weather.fetchedAt", { time: localDateTime(weather.fetchedAt) ?? "—" })}</span>
                  {weather.forecastIssuedAt && <span>{t("weather.issuedAt", { time: localDateTime(weather.forecastIssuedAt) ?? "—" })}</span>}
                  {weather.observationStation && <span>{t("weather.stationDistance", { station: weather.observationStation.name, ...distance(weather.observationStation.distanceKm, units, locale) })}</span>}
                </div>
                {weather.unavailable.length > 0 && <div className="weather-unavailable" role="status"><TriangleAlert size={15} aria-hidden="true" /><span>{t("weather.partialData")}</span>{weather.unavailable.map((source) => <b key={source}>{unavailableLabel(source)}</b>)}</div>}
                {weather.current && <div className="weather-current-hero"><span><CloudSun size={25} aria-hidden="true" /></span><div><strong>{temperature(weather.current.temperatureC, units, locale) ?? "—"}</strong><small>{localDateTime(weather.current.timestamp) ?? "—"}</small></div><div><Wind size={15} aria-hidden="true" />{windSpeed(weather.current.windSpeedMps, units, locale) ?? "—"}</div><div><Droplets size={15} aria-hidden="true" />{percent(weather.current.relativeHumidityPercent, locale) ?? "—"}</div></div>}
                {weather.current ? <dl className="weather-detail-grid">{currentDetails.map((item) => <div key={item.label}><dt>{item.label}</dt><dd>{item.value}</dd></div>)}</dl> : <div className="weather-empty compact"><CloudSun size={23} aria-hidden="true" /><strong>{t("weather.observationUnavailable")}</strong></div>}
              </>
            )}
          </section>
        </div>

        {weatherLoadState === "ready" && weather && (
          <>
            <section className="weather-summary" aria-label={t("weather.forecastSummary")}>
              <div><ThermometerSun size={18} aria-hidden="true" /><span><small>{t("weather.temperatureRange")}</small><strong>{temperature(forecastSummary.minimumTemperature, units, locale) ?? "—"} – {temperature(forecastSummary.maximumTemperature, units, locale) ?? "—"}</strong></span></div>
              <div><CloudRain size={18} aria-hidden="true" /><span><small>{t("weather.totalPrecipitation")}</small><strong>{precipitation(forecastSummary.totalPrecipitation, units, locale) ?? "—"}</strong></span></div>
              <div><Wind size={18} aria-hidden="true" /><span><small>{t("weather.maximumWind")}</small><strong>{windSpeed(forecastSummary.maximumWind, units, locale) ?? "—"}</strong></span></div>
              <div><Droplets size={18} aria-hidden="true" /><span><small>{t("weather.maximumPrecipitationProbability")}</small><strong>{percent(forecastSummary.precipitationProbability, locale) ?? "—"}</strong></span></div>
            </section>

            <section className="panel weather-forecast-card" aria-labelledby="weather-forecast-title">
              <div className="panel-header"><div><span className="eyebrow">48 h</span><h3 id="weather-forecast-title">{t("weather.forecastTitle")}</h3><p>{t("weather.forecastDescription")}</p></div><CloudSun size={21} aria-hidden="true" /></div>
              {weather.forecast.length ? <div className="table-scroll"><table><thead><tr><th>{t("weather.time")}</th><th>{t("weather.temperature")}</th><th>{t("weather.precipitation")}</th><th>{t("weather.wind")}</th><th>{t("weather.humidity")}</th><th>{t("weather.cloudCover")}</th><th>{t("weather.weatherSymbol")}</th></tr></thead><tbody>{weather.forecast.slice(0, 48).map((point, index) => <tr key={`${point.timestamp}-${index}`}><td><time dateTime={point.timestamp}>{localDateTime(point.timestamp, { weekday: "short", hour: "2-digit", minute: "2-digit" }) ?? "—"}</time></td><td>{temperature(point.temperatureC, units, locale) ?? "—"}</td><td>{precipitation(point.precipitation1hMm ?? point.precipitationIntensityMmPerHour, units, locale) ?? "—"}{finite(point.precipitationProbabilityPercent) && <small>{percent(point.precipitationProbabilityPercent, locale)}</small>}</td><td>{windSpeed(point.windSpeedMps, units, locale) ?? "—"}{finite(point.windGustMps) && <small>{t("weather.gustShort", { value: windSpeed(point.windGustMps, units, locale) ?? "—" })}</small>}</td><td>{percent(point.relativeHumidityPercent, locale) ?? "—"}</td><td>{percent(point.cloudCoverPercent, locale) ?? "—"}</td><td>{code(point.weatherSymbolCode ?? point.presentWeatherCode, locale) ?? "—"}</td></tr>)}</tbody></table></div> : <div className="weather-empty compact"><CloudSun size={23} aria-hidden="true" /><strong>{t("weather.forecastUnavailable")}</strong></div>}
            </section>

            <section className="panel weather-warnings-card" aria-labelledby="weather-warnings-title">
              <div className="panel-header"><div><span className="eyebrow">{t("weather.officialWarnings")}</span><h3 id="weather-warnings-title">{t("weather.warningsTitle")}</h3></div><TriangleAlert size={21} aria-hidden="true" /></div>
              {weather.warnings.length ? <div className="weather-warning-list">{weather.warnings.map((warning) => <article key={warning.id} className={`weather-warning ${warning.severity}`}><div><span className="warning-severity">{warning.severity}</span><h4>{warning.headline || warning.event}</h4></div><p>{warning.description}</p><dl><div><dt>{t("weather.validity")}</dt><dd>{localDateTime(warning.onsetAt ?? warning.effectiveAt) ?? "—"} – {localDateTime(warning.expiresAt) ?? "—"}</dd></div>{warning.areas.length > 0 && <div><dt>{t("weather.areas")}</dt><dd>{warning.areas.join(", ")}</dd></div>}</dl>{warning.web && <a href={warning.web} target="_blank" rel="noreferrer">{t("weather.openWarning")}<ExternalLink size={13} aria-hidden="true" /></a>}</article>)}</div> : warningsUnavailable ? <div className="weather-no-warnings unavailable" role="status"><TriangleAlert size={20} aria-hidden="true" /><span><strong>{t("weather.warningsUnavailable")}</strong><small>{t("weather.warningsUnavailableDescription")}</small></span></div> : <div className="weather-no-warnings"><ShieldCheck size={20} aria-hidden="true" /><span><strong>{t("weather.noWarnings")}</strong><small>{t("weather.noWarningsDescription")}</small></span></div>}
            </section>

            <footer className="weather-attribution"><Database size={16} aria-hidden="true" /><span>{weather.attribution}</span><a href="https://www.ilmatieteenlaitos.fi/avoin-data-avattavat-aineistot" target="_blank" rel="noreferrer">{t("weather.openFmi")}<ExternalLink size={13} aria-hidden="true" /></a></footer>
          </>
        )}
      </section>
    </>
  );
}
