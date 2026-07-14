import {
  Check,
  CloudRain,
  CloudSun,
  Database,
  Droplets,
  ExternalLink,
  LoaderCircle,
  MapPin,
  RefreshCw,
  ShieldCheck,
  ThermometerSun,
  TriangleAlert,
  Wind,
} from "lucide-react";
import { useMemo } from "react";
import type {
  House,
  HouseWeather,
  OutdoorConditions,
  UnitSystem,
  WeatherWarning,
} from "@climate-twin/contracts";
import {
  ForecastWindowNavigator,
  MAX_FORECAST_HOURS,
  buildForecastWindows,
  formatWeatherPercent,
  formatWeatherPrecipitation,
  formatWeatherTemperature,
  formatWeatherWind,
  formatZonedForecastTime,
  type ForecastHorizonHours,
} from "../components/ForecastWindowNavigator";
import { useI18n, type Locale } from "../i18n";
import { useHouseWeather } from "../useHouseWeather";
import "./OutdoorWeatherPage.css";

interface OutdoorPageCopy {
  pageTitle: string;
  pageDescription: string;
  selectHouse: string;
  refresh: string;
  refreshing: string;
  current: string;
  observed: string;
  refreshFailed: string;
  updating: string;
  noCurrent: string;
  noLocation: string;
  noLocationBody: string;
  configureLocation: string;
  providerDataUnavailable: string;
  providerDataUnavailableBody: string;
  fullSummary: string;
  warningRegion: string;
  activeWarnings: string;
  warningUnverified: string;
  warningUnverifiedBody: string;
  warningChecking: string;
  warningCheckingBody: string;
  warningClear: string;
  warningClearBody: string;
  valid: string;
  areas: string;
  openWarning: string;
  opensNewWindow: string;
  advanced: string;
  advancedHelp: string;
  sourceAvailability: string;
  allSourcesAvailable: string;
  unavailableSources: string;
  provider: string;
  coordinates: string;
  fetched: string;
  issued: string;
  station: string;
  notAvailable: string;
}

const copyByLocale: Record<Locale, OutdoorPageCopy> = {
  en: {
    pageTitle: "Outdoor weather",
    pageDescription: "Current outdoor conditions, official warning status, and the next 48 hours for the selected house.",
    selectHouse: "Weather location",
    refresh: "Refresh",
    refreshing: "Refreshing…",
    current: "Current conditions",
    observed: "Observed",
    refreshFailed: "The latest refresh failed. Last available data remains visible.",
    updating: "Updating weather…",
    noCurrent: "No nearby current observation is available.",
    noLocation: "A weather location is needed",
    noLocationBody: "Set a WGS84 weather reference for this house before loading outdoor conditions.",
    configureLocation: "Configure location",
    providerDataUnavailable: "Outdoor weather is unavailable",
    providerDataUnavailableBody: "The saved location is unchanged. Retry the provider request in a moment.",
    fullSummary: "Full 48-hour summary",
    warningRegion: "Warning and coverage status",
    activeWarnings: "Active official warnings",
    warningUnverified: "Warning status could not be verified",
    warningUnverifiedBody: "Warning data is unavailable, stale, or could not be refreshed. Do not interpret this state as meaning there are no warnings.",
    warningChecking: "Checking official warning data",
    warningCheckingBody: "No warning conclusion is shown until the provider response is available.",
    warningClear: "No active warnings were returned",
    warningClearBody: "FMI warning data was available for this update. This is not a guarantee of warning coverage outside FMI's service or a replacement for local safety alerts.",
    valid: "Valid",
    areas: "Areas",
    openWarning: "Open official warning",
    opensNewWindow: "opens in a new window",
    advanced: "Advanced weather details",
    advancedHelp: "Additional measurements, exact provenance, and source availability.",
    sourceAvailability: "Source availability",
    allSourcesAvailable: "All requested FMI components were available.",
    unavailableSources: "Unavailable",
    provider: "Provider",
    coordinates: "Weather reference",
    fetched: "Fetched",
    issued: "Forecast issued",
    station: "Observation station",
    notAvailable: "Not available",
  },
  fi: {
    pageTitle: "Ulkoilman sää",
    pageDescription: "Valitun talon nykyiset ulko-olosuhteet, virallisten varoitusten tila ja seuraavat 48 tuntia.",
    selectHouse: "Sään sijainti",
    refresh: "Päivitä",
    refreshing: "Päivitetään…",
    current: "Nykyiset olosuhteet",
    observed: "Havaittu",
    refreshFailed: "Uusin päivitys epäonnistui. Viimeisimmät saatavilla olevat tiedot näytetään edelleen.",
    updating: "Päivitetään säätietoja…",
    noCurrent: "Lähistön nykyistä havaintoa ei ole saatavilla.",
    noLocation: "Sään sijainti tarvitaan",
    noLocationBody: "Aseta talolle WGS84-sääviite ennen ulko-olosuhteiden lataamista.",
    configureLocation: "Määritä sijainti",
    providerDataUnavailable: "Ulkoilman säätietoja ei ole saatavilla",
    providerDataUnavailableBody: "Tallennettu sijainti ei muuttunut. Yritä palveluntarjoajan hakua hetken kuluttua uudelleen.",
    fullSummary: "Koko 48 tunnin yhteenveto",
    warningRegion: "Varoitusten ja kattavuuden tila",
    activeWarnings: "Voimassa olevat viralliset varoitukset",
    warningUnverified: "Varoitusten tilaa ei voitu varmistaa",
    warningUnverifiedBody: "Varoitustiedot eivät ole saatavilla, ovat vanhentuneet tai niiden päivitys epäonnistui. Tämä tila ei tarkoita, ettei varoituksia olisi.",
    warningChecking: "Tarkistetaan virallisia varoituksia",
    warningCheckingBody: "Varoituksista ei tehdä päätelmää ennen palveluntarjoajan vastausta.",
    warningClear: "Voimassa olevia varoituksia ei palautettu",
    warningClearBody: "Ilmatieteen laitoksen varoitustiedot olivat saatavilla tässä päivityksessä. Tämä ei takaa kattavuutta palvelun ulkopuolella eikä korvaa paikallisia turvallisuusvaroituksia.",
    valid: "Voimassa",
    areas: "Alueet",
    openWarning: "Avaa virallinen varoitus",
    opensNewWindow: "avautuu uuteen ikkunaan",
    advanced: "Sään lisätiedot",
    advancedHelp: "Muut mittaukset, tarkka alkuperä ja lähteiden saatavuus.",
    sourceAvailability: "Lähteiden saatavuus",
    allSourcesAvailable: "Kaikki pyydetyt Ilmatieteen laitoksen osat olivat saatavilla.",
    unavailableSources: "Ei saatavilla",
    provider: "Palveluntarjoaja",
    coordinates: "Sääviite",
    fetched: "Haettu",
    issued: "Ennuste annettu",
    station: "Havaintoasema",
    notAvailable: "Ei saatavilla",
  },
};

function finite(value: number | undefined): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

function decimal(value: number, locale: string, maximumFractionDigits = 1): string {
  return new Intl.NumberFormat(locale, { maximumFractionDigits }).format(value);
}

function pressure(value: number | undefined, units: UnitSystem, locale: string): string {
  if (!finite(value)) return "—";
  return units === "imperial"
    ? `${decimal(value * 0.029529983, locale, 2)} inHg`
    : `${decimal(value, locale)} hPa`;
}

function visibility(value: number | undefined, units: UnitSystem, locale: string): string {
  if (!finite(value)) return "—";
  return units === "imperial"
    ? `${decimal(value / 1609.344, locale)} mi`
    : `${decimal(value / 1000, locale)} km`;
}

function stationDistance(value: number, units: UnitSystem, locale: string): string {
  return units === "imperial"
    ? `${decimal(value * 0.621371, locale)} mi`
    : `${decimal(value, locale)} km`;
}

export interface OutdoorForecastSummary {
  minimumTemperatureC: number | null;
  maximumTemperatureC: number | null;
  totalPrecipitationMm: number | null;
  maximumWindMps: number | null;
  maximumPrecipitationProbabilityPercent: number | null;
}

export function summarizeOutdoorForecast(points: readonly OutdoorConditions[]): OutdoorForecastSummary {
  const temperatures = points.flatMap((point) => finite(point.temperatureC) ? [point.temperatureC] : []);
  const precipitation = points.flatMap((point) => finite(point.precipitation1hMm)
    ? [point.precipitation1hMm]
    : finite(point.precipitationIntensityMmPerHour) ? [point.precipitationIntensityMmPerHour] : []);
  const wind = points.flatMap((point) => [
    point.windSpeedMps,
    point.windGustMps,
    point.maximumWindSpeedMps,
    point.maximumWindGustMps,
  ].filter(finite));
  const probabilities = points.flatMap((point) => finite(point.precipitationProbabilityPercent)
    ? [point.precipitationProbabilityPercent]
    : []);
  return {
    minimumTemperatureC: temperatures.length ? Math.min(...temperatures) : null,
    maximumTemperatureC: temperatures.length ? Math.max(...temperatures) : null,
    totalPrecipitationMm: precipitation.length ? precipitation.reduce((sum, value) => sum + value, 0) : null,
    maximumWindMps: wind.length ? Math.max(...wind) : null,
    maximumPrecipitationProbabilityPercent: probabilities.length ? Math.max(...probabilities) : null,
  };
}

function warningValidity(warning: WeatherWarning, locale: Locale, timeZone: string, copy: OutdoorPageCopy): string {
  const start = warning.onsetAt ?? warning.effectiveAt;
  if (!start && !warning.expiresAt) return copy.notAvailable;
  return `${start ? formatZonedForecastTime(start, locale, timeZone) : "—"} – ${warning.expiresAt ? formatZonedForecastTime(warning.expiresAt, locale, timeZone) : "—"}`;
}

function unavailableLabel(source: HouseWeather["unavailable"][number], locale: Locale): string {
  const labels = locale === "fi"
    ? { observation: "havainnot", forecast: "ennuste", "short-range": "lyhyen ajan täydennys", warnings: "varoitukset" }
    : { observation: "observations", forecast: "forecast", "short-range": "short-range supplement", warnings: "warnings" };
  return labels[source];
}

function WarningCoverageArea({
  weather,
  loading,
  error,
  house,
  locale,
  copy,
}: {
  weather: HouseWeather | null;
  loading: boolean;
  error: Error | null;
  house: House;
  locale: Locale;
  copy: OutdoorPageCopy;
}) {
  const warnings = weather?.warnings ?? [];
  const warningStatus = weather?.componentStatus?.warnings;
  const authoritativeClear = warningStatus
    ? warningStatus.availability === "available"
      && warningStatus.coverage === "covered"
      && warningStatus.emptyResultIsAuthoritative
      && !warningStatus.stale
    : Boolean(weather && !weather.unavailable.includes("warnings") && weather.provider === "fmi");
  const unverified = Boolean(error || weather?.stale || weather?.unavailable.includes("warnings")
    || (warnings.length === 0 && !authoritativeClear));
  const checking = Boolean(house.location && loading && !weather);

  return (
    <section
      className={`outdoor-warning-area ${warnings.length ? "has-warning" : unverified ? "unverified" : "clear"}`}
      aria-labelledby="outdoor-warning-title"
      aria-live="polite"
      aria-atomic="false"
    >
      <div className="outdoor-warning-heading">
        <span>{warnings.length ? <TriangleAlert aria-hidden="true" /> : unverified ? <TriangleAlert aria-hidden="true" /> : <ShieldCheck aria-hidden="true" />}</span>
        <div>
          <small>{copy.warningRegion}</small>
          <h2 id="outdoor-warning-title">
            {warnings.length ? copy.activeWarnings : checking ? copy.warningChecking : unverified || !weather ? copy.warningUnverified : copy.warningClear}
          </h2>
        </div>
      </div>

      {warnings.length > 0 ? (
        <div className="outdoor-warning-list">
          {unverified && <p className="outdoor-warning-caveat">{copy.warningUnverifiedBody}</p>}
          {warnings.map((warning, index) => {
            const warningTitle = warning.headline || warning.event;
            const warningTitleId = `outdoor-warning-${index}-title`;
            return (
              <article key={warning.id} className={`outdoor-warning-item ${warning.severity}`} aria-labelledby={warningTitleId}>
                <div><h3 id={warningTitleId}>{warningTitle}</h3><span>{warning.severity}</span></div>
                {warning.description && <p>{warning.description}</p>}
                <dl>
                  <div><dt>{copy.valid}</dt><dd>{warningValidity(warning, locale, house.timezone, copy)}</dd></div>
                  {warning.areas.length > 0 && <div><dt>{copy.areas}</dt><dd>{warning.areas.join(", ")}</dd></div>}
                </dl>
                {warning.web && <a href={warning.web} target="_blank" rel="noreferrer" aria-label={`${copy.openWarning}: ${warningTitle} (${copy.opensNewWindow})`}>{copy.openWarning}<ExternalLink size={13} aria-hidden="true" /></a>}
              </article>
            );
          })}
        </div>
      ) : (
        <p>{checking ? copy.warningCheckingBody : unverified || !weather ? copy.warningUnverifiedBody : copy.warningClearBody}</p>
      )}
    </section>
  );
}

export interface OutdoorWeatherViewProps {
  house: House;
  houses?: readonly House[];
  units: UnitSystem;
  weather: HouseWeather | null;
  loading: boolean;
  error: Error | null;
  onRefresh: () => void | Promise<void>;
  onHouseChange?: (houseId: string) => void;
  onConfigureLocation?: () => void;
  horizonHours?: ForecastHorizonHours;
}

export function OutdoorWeatherView({
  house,
  houses = [house],
  units,
  weather,
  loading,
  error,
  onRefresh,
  onHouseChange,
  onConfigureLocation,
  horizonHours = MAX_FORECAST_HOURS,
}: OutdoorWeatherViewProps) {
  const { locale, t } = useI18n();
  const copy = copyByLocale[locale];
  const horizonPoints = useMemo(
    () => buildForecastWindows(weather?.forecast ?? [], horizonHours, locale).flatMap((window) => window.points),
    [horizonHours, locale, weather?.forecast],
  );
  const summary = useMemo(() => summarizeOutdoorForecast(horizonPoints), [horizonPoints]);
  const current = weather?.current ?? null;
  const refreshFailed = Boolean(error && weather);
  const locationName = house.location?.label || house.name;
  const freshnessLabel = refreshFailed
    ? copy.refreshFailed
    : weather?.stale ? t("weather.stale") : loading && weather ? copy.updating : weather ? t("weather.fresh") : null;

  const advancedDetails = current ? [
    { label: t("weather.dewPoint"), value: formatWeatherTemperature(current.dewPointC, units, locale) },
    { label: t("weather.pressure"), value: pressure(current.pressureHpa, units, locale) },
    { label: t("weather.gust"), value: formatWeatherWind(current.windGustMps, units, locale) },
    { label: t("weather.windDirection"), value: finite(current.windDirectionDegrees) ? `${decimal(current.windDirectionDegrees, locale, 0)}°` : "—" },
    { label: t("weather.cloudCover"), value: formatWeatherPercent(current.cloudCoverPercent, locale) },
    { label: t("weather.visibility"), value: visibility(current.visibilityMeters, units, locale) },
    { label: t("weather.precipitationProbability"), value: formatWeatherPercent(current.precipitationProbabilityPercent, locale) },
    { label: t("weather.weatherSymbol"), value: finite(current.weatherSymbolCode ?? current.presentWeatherCode) ? decimal((current.weatherSymbolCode ?? current.presentWeatherCode) as number, locale, 0) : "—" },
  ] : [];

  return (
    <div className="outdoor-weather-page">
      <header className="page-heading outdoor-weather-page-heading">
        <div>
          <span className="outdoor-weather-eyebrow"><CloudSun size={15} aria-hidden="true" />{weather?.provider === "fmi" ? t("weather.eyebrow") : copy.provider}</span>
          <h1>{copy.pageTitle}</h1>
          <p>{copy.pageDescription}</p>
        </div>
        <div className="outdoor-weather-heading-actions">
          {houses.length > 1 && (
            <label>
              <span>{copy.selectHouse}</span>
              <select value={house.id} disabled={!onHouseChange} onChange={(event) => onHouseChange?.(event.target.value)}>
                {houses.map((candidate) => <option key={candidate.id} value={candidate.id}>{candidate.name}</option>)}
              </select>
            </label>
          )}
          <button type="button" className="outdoor-weather-refresh" disabled={loading || !house.location} onClick={() => void onRefresh()}>
            {loading ? <LoaderCircle className="spin" size={16} aria-hidden="true" /> : <RefreshCw size={16} aria-hidden="true" />}
            {loading ? copy.refreshing : copy.refresh}
          </button>
        </div>
      </header>

      {!house.location ? (
        <section className="outdoor-weather-state" aria-labelledby="outdoor-location-needed-title">
          <MapPin size={28} aria-hidden="true" />
          <h2 id="outdoor-location-needed-title">{copy.noLocation}</h2>
          <p>{copy.noLocationBody}</p>
          {onConfigureLocation && <button type="button" onClick={onConfigureLocation}>{copy.configureLocation}</button>}
        </section>
      ) : !weather && loading ? (
        <section className="outdoor-weather-state" aria-live="polite" aria-busy="true">
          <LoaderCircle className="spin" size={28} aria-hidden="true" />
          <h2>{copy.updating}</h2>
        </section>
      ) : !weather && error ? (
        <section className="outdoor-weather-state error" role="alert">
          <TriangleAlert size={28} aria-hidden="true" />
          <h2>{copy.providerDataUnavailable}</h2>
          <p>{copy.providerDataUnavailableBody}</p>
          <button type="button" onClick={() => void onRefresh()}><RefreshCw size={15} aria-hidden="true" />{copy.refresh}</button>
        </section>
      ) : (
        <>
          {refreshFailed && <div className="outdoor-refresh-failure" role="status"><TriangleAlert size={16} aria-hidden="true" /><span>{copy.refreshFailed}</span><button type="button" onClick={() => void onRefresh()}>{copy.refresh}</button></div>}

          <section className="outdoor-current-card" aria-labelledby="outdoor-current-title">
            <div className="outdoor-current-heading">
              <div><span>{t("weather.outdoorNow")}</span><h2 id="outdoor-current-title">{copy.current}</h2><small>{locationName}</small></div>
              {freshnessLabel && <strong
                className={`outdoor-freshness ${weather?.stale || refreshFailed ? "stale" : "fresh"}`}
                role="status"
                aria-live="polite"
                aria-atomic="true"
                aria-label={loading
                  ? copy.updating
                  : `${freshnessLabel}. ${copy.fetched} ${weather ? formatZonedForecastTime(weather.fetchedAt, locale, house.timezone) : ""}`.trim()}
              >{weather?.stale || refreshFailed ? <TriangleAlert size={14} aria-hidden="true" /> : <Check size={14} aria-hidden="true" />}{freshnessLabel}</strong>}
            </div>

            {current ? (
              <>
                <div className="outdoor-current-values">
                  <div className="temperature"><ThermometerSun size={24} aria-hidden="true" /><span><strong>{formatWeatherTemperature(current.temperatureC, units, locale)}</strong><small>{weather?.provider === "open-meteo" ? (locale === "fi" ? "Mallinnettu" : "Modelled") : copy.observed} <time dateTime={current.timestamp}>{formatZonedForecastTime(current.timestamp, locale, house.timezone)}</time></small></span></div>
                  <div><Droplets size={18} aria-hidden="true" /><span><small>{t("weather.humidity")}</small><strong>{formatWeatherPercent(current.relativeHumidityPercent, locale)}</strong></span></div>
                  <div><Wind size={18} aria-hidden="true" /><span><small>{t("weather.wind")}</small><strong>{formatWeatherWind(current.windSpeedMps, units, locale)}</strong></span></div>
                  <div><CloudRain size={18} aria-hidden="true" /><span><small>{t("weather.precipitation1h")}</small><strong>{formatWeatherPrecipitation(current.precipitation1hMm ?? current.precipitationIntensityMmPerHour, units, locale)}</strong></span></div>
                </div>
                <div className="outdoor-provenance">
                  <Database size={15} aria-hidden="true" />
                  <span><strong>{weather?.provider === "open-meteo" ? <a href="https://open-meteo.com/" target="_blank" rel="noreferrer">{weather.attribution}</a> : weather?.attribution}</strong><small>{copy.fetched} {weather ? formatZonedForecastTime(weather.fetchedAt, locale, house.timezone) : "—"}</small></span>
                  {weather?.observationStation && <span><strong>{copy.station}</strong><small>{weather.observationStation.name} · {stationDistance(weather.observationStation.distanceKm, units, locale)}</small></span>}
                </div>
              </>
            ) : (
              <p className="outdoor-weather-empty">{copy.noCurrent}</p>
            )}
          </section>

          {weather && <WarningCoverageArea weather={weather} loading={loading} error={error} house={house} locale={locale} copy={copy} />}

          {weather && (
            <>
              <section className="outdoor-full-summary" aria-labelledby="outdoor-summary-title">
                <div><span>48 h</span><h2 id="outdoor-summary-title">{copy.fullSummary}</h2></div>
                <dl>
                  <div><dt>{t("weather.temperatureRange")}</dt><dd>{formatWeatherTemperature(summary.minimumTemperatureC ?? undefined, units, locale)} – {formatWeatherTemperature(summary.maximumTemperatureC ?? undefined, units, locale)}</dd></div>
                  <div><dt>{t("weather.totalPrecipitation")}</dt><dd>{formatWeatherPrecipitation(summary.totalPrecipitationMm ?? undefined, units, locale)}</dd></div>
                  <div><dt>{t("weather.maximumWind")}</dt><dd>{formatWeatherWind(summary.maximumWindMps ?? undefined, units, locale)}</dd></div>
                  <div><dt>{t("weather.maximumPrecipitationProbability")}</dt><dd>{formatWeatherPercent(summary.maximumPrecipitationProbabilityPercent ?? undefined, locale)}</dd></div>
                </dl>
              </section>

              <ForecastWindowNavigator
                points={weather.forecast}
                houseName={house.name}
                houseId={house.id}
                timeZone={house.timezone}
                units={units}
                locale={locale}
                horizonHours={horizonHours}
              />

              <details className="outdoor-advanced-details">
                <summary><span><strong>{copy.advanced}</strong><small>{copy.advancedHelp}</small></span></summary>
                <div className="outdoor-advanced-content">
                  {advancedDetails.length > 0 && <dl className="outdoor-advanced-grid">{advancedDetails.map((item) => <div key={item.label}><dt>{item.label}</dt><dd>{item.value}</dd></div>)}</dl>}
                  <dl className="outdoor-source-details">
                    <div><dt>{copy.provider}</dt><dd>{weather.provider.toUpperCase()} · {weather.attribution}</dd></div>
                    <div><dt>{copy.coordinates}</dt><dd>{decimal(weather.location.latitude, locale, 5)}, {decimal(weather.location.longitude, locale, 5)}</dd></div>
                    <div><dt>{copy.fetched}</dt><dd>{formatZonedForecastTime(weather.fetchedAt, locale, house.timezone)}</dd></div>
                    <div><dt>{copy.issued}</dt><dd>{weather.forecastIssuedAt ? formatZonedForecastTime(weather.forecastIssuedAt, locale, house.timezone) : copy.notAvailable}</dd></div>
                    <div><dt>{copy.sourceAvailability}</dt><dd>{weather.unavailable.length ? `${copy.unavailableSources}: ${weather.unavailable.map((source) => unavailableLabel(source, locale)).join(", ")}` : copy.allSourcesAvailable}</dd></div>
                  </dl>
                </div>
              </details>
            </>
          )}
        </>
      )}

      {!weather && <WarningCoverageArea weather={null} loading={loading} error={error} house={house} locale={locale} copy={copy} />}
    </div>
  );
}

export interface OutdoorWeatherPageProps {
  house: House;
  houses?: readonly House[];
  units: UnitSystem;
  enabled?: boolean;
  onHouseChange?: (houseId: string) => void;
  onConfigureLocation?: () => void;
}

/** Connected page for App wiring. The existing hook owns its 48-hour request and refresh cycle. */
export function OutdoorWeatherPage({
  house,
  houses = [house],
  units,
  enabled = true,
  onHouseChange,
  onConfigureLocation,
}: OutdoorWeatherPageProps) {
  const weatherState = useHouseWeather(house, enabled);
  return (
    <OutdoorWeatherView
      house={house}
      houses={houses}
      units={units}
      weather={weatherState.weather}
      loading={weatherState.loading}
      error={weatherState.error}
      onRefresh={weatherState.refresh}
      {...(onHouseChange ? { onHouseChange } : {})}
      {...(onConfigureLocation ? { onConfigureLocation } : {})}
    />
  );
}
