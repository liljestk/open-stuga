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
} from "../../components/ForecastWindowNavigator";
import { useI18n, type Locale, type TranslationKey } from "../../i18n";
import { ApiRequestError } from "../../api";
import { useHouseWeather } from "../../useHouseWeather";
import { homeRelevantWeatherWarnings } from "../../weatherWarningRelevance";
import "../OutdoorWeatherPage.css";
import { OutdoorWeatherViewProps, WarningCoverageArea, WeatherIssueDetails, backfillLabelKeys, decimal, finite, outageComponentLabel, pressure, recoveryFromError, stationDistance, summarizeOutdoorForecast, translateCopy, unavailableLabel, visibility } from "./01-outdoor-page-copy-to-outdoor-weather-view-props";

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
