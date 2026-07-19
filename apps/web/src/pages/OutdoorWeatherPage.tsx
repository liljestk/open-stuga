import {
  Check,
  ChevronDown,
  CloudRain,
  CloudSun,
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
  WeatherRecoveryStatus,
  WeatherWarning,
} from "@climate-twin/contracts";
import {
  ForecastWindowNavigator,
  FORECAST_WINDOW_LABEL_KEYS,
  MAX_FORECAST_HOURS,
  buildForecastWindows,
  formatWeatherPercent,
  formatWeatherPrecipitation,
  formatWeatherTemperature,
  formatWeatherWind,
  formatZonedForecastTime,
  type ForecastHorizonHours,
} from "../components/ForecastWindowNavigator";
import { useI18n, type Locale, type TranslationKey } from "../i18n";
import { ApiRequestError } from "../api";
import { useHouseWeather } from "../useHouseWeather";
import { homeRelevantWeatherWarnings } from "../weatherWarningRelevance";
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
  forecastDetails: string;
  forecastDetailsHelp: string;
  warningRegion: string;
  activeWarnings: string;
  warningUnverified: string;
  warningUnverifiedBody: string;
  warningChecking: string;
  warningCheckingBody: string;
  warningClear: string;
  warningClearBody: string;
  warningDetails: string;
  warningScopeNote: string;
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
  issueDetails: string;
  possibleCauses: string;
  recoverySteps: string;
  automaticRecovery: string;
  providerCause: string;
  connectionCause: string;
  locationCause: string;
  retryStep: string;
  locationStep: string;
  connectionStep: string;
  automaticRecoveryBody: string;
  nonReconstructible: string;
  outageDetected: string;
  affectedData: string;
  backfill: string;
  reportedProblem: string;
}

type Translate = (key: TranslationKey, values?: Record<string, string | number>) => string;

const copyKeys = {
  pageTitle: "outdoor.pageTitle",
  pageDescription: "outdoor.pageDescription",
  selectHouse: "outdoor.selectHouse",
  refresh: "outdoor.refresh",
  refreshing: "outdoor.refreshing",
  current: "outdoor.current",
  observed: "outdoor.observed",
  refreshFailed: "outdoor.pageRefreshFailed",
  updating: "outdoor.updating",
  noCurrent: "outdoor.noCurrent",
  noLocation: "outdoor.noLocation",
  noLocationBody: "outdoor.noLocationBody",
  configureLocation: "outdoor.configureLocation",
  providerDataUnavailable: "outdoor.providerDataUnavailable",
  providerDataUnavailableBody: "outdoor.providerDataUnavailableBody",
  fullSummary: "outdoor.fullSummary",
  forecastDetails: "outdoor.forecastDetails",
  forecastDetailsHelp: "outdoor.forecastDetailsHelp",
  warningRegion: "outdoor.warningRegion",
  activeWarnings: "outdoor.activeWarnings",
  warningUnverified: "outdoor.warningUnverified",
  warningUnverifiedBody: "outdoor.warningUnverifiedBody",
  warningChecking: "outdoor.warningChecking",
  warningCheckingBody: "outdoor.warningCheckingBody",
  warningClear: "outdoor.warningClear",
  warningClearBody: "outdoor.warningClearBody",
  warningDetails: "outdoor.warningDetails",
  warningScopeNote: "outdoor.warningScopeNote",
  valid: "outdoor.valid",
  areas: "outdoor.areas",
  openWarning: "outdoor.openWarning",
  opensNewWindow: "outdoor.opensNewWindow",
  advanced: "outdoor.advanced",
  advancedHelp: "outdoor.advancedHelp",
  sourceAvailability: "outdoor.sourceAvailability",
  allSourcesAvailable: "outdoor.allSourcesAvailable",
  unavailableSources: "outdoor.unavailableSources",
  provider: "outdoor.provider",
  coordinates: "outdoor.coordinates",
  fetched: "outdoor.fetched",
  issued: "outdoor.issued",
  station: "outdoor.stationLabel",
  notAvailable: "outdoor.notAvailable",
  issueDetails: "outdoor.issueDetails",
  possibleCauses: "outdoor.possibleCauses",
  recoverySteps: "outdoor.recoverySteps",
  automaticRecovery: "outdoor.automaticRecovery",
  providerCause: "outdoor.providerCause",
  connectionCause: "outdoor.connectionCause",
  locationCause: "outdoor.locationCause",
  retryStep: "outdoor.retryStep",
  locationStep: "outdoor.locationStep",
  connectionStep: "outdoor.connectionStep",
  automaticRecoveryBody: "outdoor.automaticRecoveryBody",
  nonReconstructible: "outdoor.nonReconstructible",
  outageDetected: "outdoor.outageDetected",
  affectedData: "outdoor.affectedData",
  backfill: "outdoor.backfill",
  reportedProblem: "outdoor.reportedProblem",
} as const satisfies Record<keyof OutdoorPageCopy, TranslationKey>;

function translateCopy(t: Translate): OutdoorPageCopy {
  return Object.fromEntries(
    Object.entries(copyKeys).map(([name, key]) => [name, t(key)]),
  ) as unknown as OutdoorPageCopy;
}

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

function unavailableLabel(source: HouseWeather["unavailable"][number], t: Translate): string {
  const labels: Record<HouseWeather["unavailable"][number], TranslationKey> = {
    observation: "weather.observations",
    forecast: "weather.forecast",
    "short-range": "weather.shortRangeForecast",
    warnings: "weather.warnings",
  };
  return t(labels[source]);
}

function recoveryFromError(error: Error | null): WeatherRecoveryStatus | null {
  if (!(error instanceof ApiRequestError) || !error.details || typeof error.details !== "object") return null;
  const recovery = (error.details as { recovery?: unknown }).recovery;
  if (!recovery || typeof recovery !== "object" || typeof (recovery as { active?: unknown }).active !== "boolean") return null;
  return recovery as WeatherRecoveryStatus;
}

function outageComponentLabel(component: WeatherRecoveryStatus["affectedComponents"][number], t: Translate): string {
  return component === "service" ? t("outdoor.weatherService") : unavailableLabel(component, t);
}

const backfillLabelKeys = {
  "not-needed": "outdoor.backfillState.notNeeded",
  pending: "outdoor.backfillState.pending",
  running: "outdoor.backfillState.running",
  complete: "outdoor.backfillState.complete",
  partial: "outdoor.backfillState.partial",
  failed: "outdoor.backfillState.failed",
  "not-supported": "outdoor.backfillState.notSupported",
} as const satisfies Record<WeatherRecoveryStatus["observationBackfill"]["state"], TranslationKey>;

function WeatherIssueDetails({
  recovery,
  house,
  locale,
  copy,
  t,
  onConfigureLocation,
}: {
  recovery: WeatherRecoveryStatus | null | undefined;
  house: House;
  locale: Locale;
  copy: OutdoorPageCopy;
  t: Translate;
  onConfigureLocation?: () => void;
}) {
  const affected = recovery?.affectedComponents.map((component) => outageComponentLabel(component, t)).join(", ") ?? "";
  const backfill = recovery?.observationBackfill;
  return (
    <details className="outdoor-issue-details">
      <summary><span><strong>{copy.issueDetails}</strong><small>{copy.automaticRecovery}</small></span><ChevronDown size={16} aria-hidden="true" /></summary>
      <div className="outdoor-issue-details-body">
        <section>
          <h3>{copy.possibleCauses}</h3>
          <ul>
            <li>{copy.providerCause}</li>
            <li>{copy.connectionCause}</li>
            <li>{copy.locationCause}</li>
          </ul>
        </section>
        <section>
          <h3>{copy.recoverySteps}</h3>
          <ol>
            <li>{copy.retryStep}</li>
            <li>{copy.locationStep}</li>
            <li>{copy.connectionStep}</li>
          </ol>
          {onConfigureLocation && <button type="button" className="outdoor-inline-action" onClick={onConfigureLocation}>{copy.configureLocation}</button>}
        </section>
        <section>
          <h3>{copy.automaticRecovery}</h3>
          <p>{copy.automaticRecoveryBody}</p>
          <p>{copy.nonReconstructible}</p>
          {recovery && (
            <dl className="outdoor-recovery-status">
              {recovery.activeSince && <div><dt>{copy.outageDetected}</dt><dd><time dateTime={recovery.activeSince}>{formatZonedForecastTime(recovery.activeSince, locale, house.timezone)}</time></dd></div>}
              {affected && <div><dt>{copy.affectedData}</dt><dd>{affected}</dd></div>}
              {recovery.lastError && <div><dt>{copy.reportedProblem}</dt><dd>{recovery.lastError}</dd></div>}
              <div><dt>{copy.backfill}</dt><dd>{t(backfillLabelKeys[backfill?.state ?? "not-needed"], { count: backfill?.recoveredPoints ?? 0 })}</dd></div>
              {backfill?.error && <div><dt>{t("outdoor.lastRecoveryError")}</dt><dd>{backfill.error}</dd></div>}
            </dl>
          )}
        </section>
      </div>
    </details>
  );
}

function WarningCoverageArea({
  weather,
  loading,
  error,
  house,
  locale,
  copy,
  t,
  onConfigureLocation,
}: {
  weather: HouseWeather | null;
  loading: boolean;
  error: Error | null;
  house: House;
  locale: Locale;
  copy: OutdoorPageCopy;
  t: Translate;
  onConfigureLocation?: () => void;
}) {
  const warnings = homeRelevantWeatherWarnings(weather?.warnings ?? []);
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
      className={`outdoor-warning-area ${warnings.length ? "has-warning" : unverified ? "unverified" : "clear compact-clear"}`}
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
                <dl className="outdoor-warning-glance">
                  <div><dt>{copy.valid}</dt><dd>{warningValidity(warning, locale, house.timezone, copy)}</dd></div>
                </dl>
                {(warning.description || warning.areas.length > 0 || warning.web) && (
                  <details className="outdoor-warning-details">
                    <summary><span><strong>{copy.warningDetails}</strong><small>{warning.event}</small></span><ChevronDown size={16} aria-hidden="true" /></summary>
                    <div className="outdoor-warning-details-body">
                      {warning.description && <p>{warning.description}</p>}
                      {warning.areas.length > 0 && <dl><div><dt>{copy.areas}</dt><dd>{warning.areas.join(", ")}</dd></div></dl>}
                      {warning.web && <a href={warning.web} target="_blank" rel="noreferrer" aria-label={`${copy.openWarning}: ${warningTitle} (${copy.opensNewWindow})`}>{copy.openWarning}<ExternalLink size={13} aria-hidden="true" /></a>}
                    </div>
                  </details>
                )}
              </article>
            );
          })}
        </div>
      ) : (checking || unverified || !weather) ? <p>{checking ? copy.warningCheckingBody : copy.warningUnverifiedBody}</p> : null}
      {unverified && !checking && (
        <WeatherIssueDetails
          recovery={weather?.recovery ?? recoveryFromError(error)}
          house={house}
          locale={locale}
          copy={copy}
          t={t}
          {...(onConfigureLocation ? { onConfigureLocation } : {})}
        />
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
  const copy = useMemo(() => translateCopy(t), [t]);
  const forecastWindowLabels = useMemo(() => FORECAST_WINDOW_LABEL_KEYS.map((key) => t(key)), [t]);
  const horizonPoints = useMemo(
    () => buildForecastWindows(weather?.forecast ?? [], horizonHours, forecastWindowLabels).flatMap((window) => window.points),
    [forecastWindowLabels, horizonHours, weather?.forecast],
  );
  const summary = useMemo(() => summarizeOutdoorForecast(horizonPoints), [horizonPoints]);
  const current = weather?.current ?? null;
  const refreshFailed = Boolean(error && weather);
  const recovery = weather?.recovery ?? recoveryFromError(error);
  const warningStatus = weather?.componentStatus?.warnings;
  const warningsVerified = warningStatus
    ? warningStatus.availability === "available"
      && warningStatus.coverage === "covered"
      && warningStatus.emptyResultIsAuthoritative
      && !warningStatus.stale
    : Boolean(weather && weather.provider === "fmi" && !weather.unavailable.includes("warnings") && !weather.stale);
  const warningIssueVisible = Boolean(error || !warningsVerified);
  const locationName = house.location?.label || house.name;
  const freshnessLabel = refreshFailed
    ? copy.refreshFailed
    : weather?.stale ? t("weather.stale") : loading && weather ? copy.updating : weather ? t("weather.fresh") : null;
  const freshnessNeedsExplanation = Boolean(weather?.stale || refreshFailed);
  const freshnessProblem = recovery?.lastError ?? (refreshFailed ? error?.message : null);
  const freshnessAffected = recovery?.affectedComponents
    .map((component) => outageComponentLabel(component, t))
    .join(", ") ?? "";

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
          {house.location && (weather || loading || !error) && <button type="button" className="outdoor-weather-refresh" disabled={loading} onClick={() => void onRefresh()}>
            {loading ? <LoaderCircle className="spin" size={16} aria-hidden="true" /> : <RefreshCw size={16} aria-hidden="true" />}
            {loading ? copy.refreshing : copy.refresh}
          </button>}
        </div>
      </header>

      {!house.location ? (
        <section className="outdoor-weather-state" aria-labelledby="outdoor-location-needed-title">
          <MapPin size={28} aria-hidden="true" />
          <h2 id="outdoor-location-needed-title">{copy.noLocation}</h2>
          <p>{copy.noLocationBody}</p>
          {onConfigureLocation && <button type="button" className="primary-button" onClick={onConfigureLocation}>{copy.configureLocation}</button>}
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
          <WeatherIssueDetails
            recovery={recovery}
            house={house}
            locale={locale}
            copy={copy}
            t={t}
            {...(onConfigureLocation ? { onConfigureLocation } : {})}
          />
        </section>
      ) : (
        <>
          {weather && <WarningCoverageArea
            weather={weather}
            loading={loading}
            error={error}
            house={house}
            locale={locale}
            copy={copy}
            t={t}
            {...(onConfigureLocation ? { onConfigureLocation } : {})}
          />}

          <section className="outdoor-current-card" aria-labelledby="outdoor-current-title">
            <div className="outdoor-current-heading">
              <div><span>{t("weather.outdoorNow")}</span><h2 id="outdoor-current-title">{copy.current}</h2><small>{locationName}</small></div>
              {freshnessLabel && (freshnessNeedsExplanation ? (
                <>
                  <details className="outdoor-freshness-details">
                    <summary
                      className="outdoor-freshness stale"
                      aria-label={`${freshnessLabel}. ${t("outdoor.staleDetailsTitle")}`}
                    >
                      <TriangleAlert size={14} aria-hidden="true" />
                      <span>{freshnessLabel}</span>
                      <ChevronDown className="outdoor-freshness-chevron" size={14} aria-hidden="true" />
                    </summary>
                    <div className="outdoor-freshness-details-body">
                      <strong>{t("outdoor.staleDetailsTitle")}</strong>
                      <p>{refreshFailed ? t("outdoor.refreshFailedDetailsBody") : t("outdoor.staleDetailsBody")}</p>
                      <dl>
                        {current && <div><dt>{copy.observed}</dt><dd><time dateTime={current.timestamp}>{formatZonedForecastTime(current.timestamp, locale, house.timezone)}</time></dd></div>}
                        {weather && <div><dt>{copy.fetched}</dt><dd><time dateTime={weather.fetchedAt}>{formatZonedForecastTime(weather.fetchedAt, locale, house.timezone)}</time></dd></div>}
                        {recovery?.activeSince && <div><dt>{copy.outageDetected}</dt><dd><time dateTime={recovery.activeSince}>{formatZonedForecastTime(recovery.activeSince, locale, house.timezone)}</time></dd></div>}
                        {freshnessAffected && <div><dt>{copy.affectedData}</dt><dd>{freshnessAffected}</dd></div>}
                        {freshnessProblem && <div><dt>{copy.reportedProblem}</dt><dd>{freshnessProblem}</dd></div>}
                      </dl>
                      <p className="outdoor-freshness-retry-note">{copy.retryStep}</p>
                    </div>
                  </details>
                  <span className="sr-only" role="status" aria-live="polite" aria-atomic="true">
                    {`${freshnessLabel}. ${copy.fetched} ${weather ? formatZonedForecastTime(weather.fetchedAt, locale, house.timezone) : ""}`.trim()}
                  </span>
                </>
              ) : (
                <strong
                  className="outdoor-freshness fresh"
                  role="status"
                  aria-live="polite"
                  aria-atomic="true"
                  aria-label={loading
                    ? copy.updating
                    : `${freshnessLabel}. ${copy.fetched} ${weather ? formatZonedForecastTime(weather.fetchedAt, locale, house.timezone) : ""}`.trim()}
                ><Check size={14} aria-hidden="true" />{freshnessLabel}</strong>
              ))}
            </div>

            {current ? (
              <div className="outdoor-current-values">
                <div className="temperature"><ThermometerSun size={24} aria-hidden="true" /><span><strong>{formatWeatherTemperature(current.temperatureC, units, locale)}</strong><small>{weather?.provider === "open-meteo" ? t("outdoor.modelled") : copy.observed} <time dateTime={current.timestamp}>{formatZonedForecastTime(current.timestamp, locale, house.timezone)}</time></small></span></div>
                <div><Droplets size={18} aria-hidden="true" /><span><small>{t("weather.humidity")}</small><strong>{formatWeatherPercent(current.relativeHumidityPercent, locale)}</strong></span></div>
                <div><Wind size={18} aria-hidden="true" /><span><small>{t("weather.wind")}</small><strong>{formatWeatherWind(current.windSpeedMps, units, locale)}</strong></span></div>
                <div><CloudRain size={18} aria-hidden="true" /><span><small>{t("weather.precipitation1h")}</small><strong>{formatWeatherPrecipitation(current.precipitation1hMm ?? current.precipitationIntensityMmPerHour, units, locale)}</strong></span></div>
              </div>
            ) : (
              <>
                <p className="outdoor-weather-empty">{copy.noCurrent}</p>
                {weather?.unavailable.includes("observation") && !warningIssueVisible && (
                  <WeatherIssueDetails
                    recovery={recovery}
                    house={house}
                    locale={locale}
                    copy={copy}
                    t={t}
                    {...(onConfigureLocation ? { onConfigureLocation } : {})}
                  />
                )}
              </>
            )}
          </section>

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

              <details className="outdoor-forecast-details">
                <summary><span><strong>{copy.forecastDetails}</strong><small>{copy.forecastDetailsHelp}</small></span><ChevronDown size={18} aria-hidden="true" /></summary>
                <ForecastWindowNavigator
                  points={weather.forecast}
                  houseName={house.name}
                  houseId={house.id}
                  timeZone={house.timezone}
                  units={units}
                  locale={locale}
                  horizonHours={horizonHours}
                />
              </details>

              <details className="outdoor-advanced-details">
                <summary><span><strong>{copy.advanced}</strong><small>{copy.advancedHelp}</small></span><ChevronDown size={18} aria-hidden="true" /></summary>
                <div className="outdoor-advanced-content">
                  <p className="outdoor-warning-scope">{copy.warningScopeNote}</p>
                  {advancedDetails.length > 0 && <dl className="outdoor-advanced-grid">{advancedDetails.map((item) => <div key={item.label}><dt>{item.label}</dt><dd>{item.value}</dd></div>)}</dl>}
                  <dl className="outdoor-source-details">
                    <div><dt>{copy.provider}</dt><dd>{weather.provider.toUpperCase()} · {weather.provider === "open-meteo" ? <a href="https://open-meteo.com/" target="_blank" rel="noreferrer">{weather.attribution}</a> : weather.attribution}</dd></div>
                    {weather.observationStation && <div><dt>{copy.station}</dt><dd>{weather.observationStation.name} · {stationDistance(weather.observationStation.distanceKm, units, locale)}</dd></div>}
                    <div><dt>{copy.coordinates}</dt><dd>{decimal(weather.location.latitude, locale, 5)}, {decimal(weather.location.longitude, locale, 5)}</dd></div>
                    <div><dt>{copy.fetched}</dt><dd>{formatZonedForecastTime(weather.fetchedAt, locale, house.timezone)}</dd></div>
                    <div><dt>{copy.issued}</dt><dd>{weather.forecastIssuedAt ? formatZonedForecastTime(weather.forecastIssuedAt, locale, house.timezone) : copy.notAvailable}</dd></div>
                    <div><dt>{copy.sourceAvailability}</dt><dd>{weather.unavailable.length ? `${copy.unavailableSources}: ${weather.unavailable.map((source) => unavailableLabel(source, t)).join(", ")}` : copy.allSourcesAvailable}</dd></div>
                    {recovery && recovery.observationBackfill.state !== "not-needed" && (
                      <div><dt>{copy.backfill}</dt><dd>{t(backfillLabelKeys[recovery.observationBackfill.state], { count: recovery.observationBackfill.recoveredPoints })}</dd></div>
                    )}
                  </dl>
                </div>
              </details>
            </>
          )}
        </>
      )}

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
