import { useEffect, useId, useMemo, useRef, useState } from "react";
import type { OutdoorConditions, UnitSystem } from "@climate-twin/contracts";
import { getDateTimeFormatter } from "../dateTime";
import { useI18n, type Locale, type TranslationKey } from "../i18n";
import { Tabs } from "./Tabs";

export const FORECAST_WINDOW_HOURS = 12;
export const MAX_FORECAST_HOURS = 48;

export type ForecastHorizonHours = 12 | 24 | 36 | 48;

export const FORECAST_WINDOW_LABEL_KEYS = [
  "forecast.window.next12",
  "forecast.window.12to24",
  "forecast.window.24to36",
  "forecast.window.36to48",
] as const satisfies readonly TranslationKey[];

const FORECAST_WINDOW_QUERY_KEY = "forecast";
const FORECAST_WINDOW_QUERY_VALUES = ["0-12", "12-24", "24-36", "36-48"] as const;

function forecastWindowFromLocation(): number {
  if (typeof window === "undefined") return 0;
  const value = new URLSearchParams(window.location.search).get(FORECAST_WINDOW_QUERY_KEY);
  const index = FORECAST_WINDOW_QUERY_VALUES.indexOf(value as typeof FORECAST_WINDOW_QUERY_VALUES[number]);
  return Math.max(0, index);
}

function forecastWindowLocationIsCanonical(index: number): boolean {
  if (typeof window === "undefined") return true;
  const value = new URLSearchParams(window.location.search).get(FORECAST_WINDOW_QUERY_KEY);
  return index === 0 ? value === null : value === FORECAST_WINDOW_QUERY_VALUES[index];
}

function writeForecastWindowToLocation(index: number, mode: "push" | "replace"): void {
  if (typeof window === "undefined") return;
  const url = new URL(window.location.href);
  const value = FORECAST_WINDOW_QUERY_VALUES[index];
  if (!value || index === 0) url.searchParams.delete(FORECAST_WINDOW_QUERY_KEY);
  else url.searchParams.set(FORECAST_WINDOW_QUERY_KEY, value);

  const next = `${url.pathname}${url.search}${url.hash}`;
  const current = `${window.location.pathname}${window.location.search}${window.location.hash}`;
  if (next !== current) window.history[`${mode}State`](window.history.state, "", next);
}

function isFiniteNumber(value: number | undefined): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

function decimal(value: number, locale: string, maximumFractionDigits = 1): string {
  return new Intl.NumberFormat(locale, { maximumFractionDigits }).format(value);
}

export function formatWeatherTemperature(value: number | undefined, units: UnitSystem, locale: string): string {
  if (!isFiniteNumber(value)) return "—";
  return units === "imperial"
    ? `${decimal(value * 9 / 5 + 32, locale)} °F`
    : `${decimal(value, locale)} °C`;
}

export function formatWeatherWind(value: number | undefined, units: UnitSystem, locale: string): string {
  if (!isFiniteNumber(value)) return "—";
  return units === "imperial"
    ? `${decimal(value * 2.236936, locale)} mph`
    : `${decimal(value, locale)} m/s`;
}

export function formatWeatherPrecipitation(value: number | undefined, units: UnitSystem, locale: string): string {
  if (!isFiniteNumber(value)) return "—";
  return units === "imperial"
    ? `${decimal(value / 25.4, locale, 2)} in`
    : `${decimal(value, locale)} mm`;
}

export function formatWeatherPercent(value: number | undefined, locale: string): string {
  return isFiniteNumber(value) ? `${decimal(value, locale, 0)}%` : "—";
}

/**
 * Include the calendar date and numeric UTC offset so repeated DST hours and
 * forecasts for remote houses remain unambiguous.
 */
export function formatZonedForecastTime(timestamp: string, locale: string, timeZone: string): string {
  const date = new Date(timestamp);
  if (!Number.isFinite(date.getTime())) return timestamp;
  const options: Intl.DateTimeFormatOptions = {
    weekday: "short",
    year: "numeric",
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    timeZoneName: "shortOffset",
  };
  try {
    return getDateTimeFormatter(locale, { ...options, timeZone }).format(date);
  } catch {
    return getDateTimeFormatter(locale, { ...options, timeZone: "UTC" }).format(date);
  }
}

function timestampValue(point: OutdoorConditions): number | null {
  const value = Date.parse(point.timestamp);
  return Number.isFinite(value) ? value : null;
}

export interface ForecastWindow {
  index: number;
  label: string;
  start: number;
  end: number;
  points: OutdoorConditions[];
}

export function buildForecastWindows(
  points: readonly OutdoorConditions[],
  horizonHours: ForecastHorizonHours = MAX_FORECAST_HOURS,
  windowLabels: readonly string[],
): ForecastWindow[] {
  const validPoints = points
    .flatMap((point) => {
      const timestamp = timestampValue(point);
      return timestamp === null ? [] : [{ point, timestamp }];
    })
    .sort((left, right) => left.timestamp - right.timestamp);
  const configuredCount = Math.max(1, Math.min(4, Math.ceil(horizonHours / FORECAST_WINDOW_HOURS)));
  if (validPoints.length === 0) {
    return [{ index: 0, label: windowLabels[0] ?? "", start: 0, end: 0, points: [] }];
  }

  const anchor = validPoints[0]!.timestamp;
  const last = validPoints.at(-1)!.timestamp;
  const windowMs = FORECAST_WINDOW_HOURS * 3_600_000;
  const dataCount = Math.max(1, Math.floor((last - anchor) / windowMs) + 1);
  const count = Math.min(configuredCount, dataCount);

  return Array.from({ length: count }, (_, index) => {
    const start = anchor + index * windowMs;
    const end = start + windowMs;
    return {
      index,
      label: windowLabels[index] ?? windowLabels[0] ?? "",
      start,
      end,
      points: validPoints
        .filter((entry) => entry.timestamp >= start && entry.timestamp < end)
        .map((entry) => entry.point),
    };
  });
}

export interface ForecastWindowNavigatorProps {
  points: readonly OutdoorConditions[];
  houseName: string;
  houseId: string;
  timeZone: string;
  units: UnitSystem;
  locale: Locale;
  horizonHours?: ForecastHorizonHours;
}

export function ForecastWindowNavigator({
  points,
  houseName,
  houseId,
  timeZone,
  units,
  locale,
  horizonHours = MAX_FORECAST_HOURS,
}: ForecastWindowNavigatorProps) {
  const { t } = useI18n();
  const id = useId().replaceAll(":", "");
  const [selectedWindow, setSelectedWindow] = useState(forecastWindowFromLocation);
  const scope = useRef({ houseId, horizonHours, path: typeof window === "undefined" ? "" : window.location.pathname });
  const windowLabels = useMemo(() => FORECAST_WINDOW_LABEL_KEYS.map((key) => t(key)), [t]);
  const windows = useMemo(
    () => buildForecastWindows(points, horizonHours, windowLabels),
    [horizonHours, points, windowLabels],
  );
  const activeIndex = Math.min(selectedWindow, windows.length - 1);
  const activeWindow = windows[activeIndex]!;

  useEffect(() => {
    const path = typeof window === "undefined" ? "" : window.location.pathname;
    const houseChanged = scope.current.houseId !== houseId;
    const horizonChanged = scope.current.horizonHours !== horizonHours;
    const pathChanged = scope.current.path !== path;
    scope.current = { houseId, horizonHours, path };

    if (horizonChanged || (houseChanged && !pathChanged)) {
      setSelectedWindow(0);
      writeForecastWindowToLocation(0, "replace");
      return;
    }

    const requested = forecastWindowFromLocation();
    const next = Math.min(requested, windows.length - 1);
    setSelectedWindow(next);
    if (next !== requested || !forecastWindowLocationIsCanonical(next)) {
      writeForecastWindowToLocation(next, "replace");
    }
  }, [houseId, horizonHours, windows.length]);

  useEffect(() => {
    const restoreWindow = () => {
      if (window.location.pathname !== scope.current.path) return;
      const next = Math.min(forecastWindowFromLocation(), windows.length - 1);
      setSelectedWindow(next);
      if (!forecastWindowLocationIsCanonical(next)) writeForecastWindowToLocation(next, "replace");
    };
    window.addEventListener("popstate", restoreWindow);
    return () => window.removeEventListener("popstate", restoreWindow);
  }, [windows.length]);

  const selectWindow = (index: number) => {
    setSelectedWindow(index);
    writeForecastWindowToLocation(index, "push");
  };

  const range = activeWindow.start
    ? `${formatZonedForecastTime(new Date(activeWindow.start).toISOString(), locale, timeZone)} – ${formatZonedForecastTime(new Date(activeWindow.end).toISOString(), locale, timeZone)}`
    : activeWindow.label;
  const caption = t("forecast.tableCaption", { house: houseName, window: activeWindow.label });
  const mobileLabel = t("forecast.mobileListLabel", { house: houseName, window: activeWindow.label });

  return (
    <section className="outdoor-forecast-navigator" aria-labelledby={`${id}-forecast-title`}>
      <div className="outdoor-forecast-heading">
        <div>
          <span>{horizonHours} h</span>
          <h2 id={`${id}-forecast-title`}>{t("forecast.title")}</h2>
        </div>
        <p><strong>{t("forecast.windowRange")}:</strong> {range}</p>
      </div>

      <Tabs
        className="outdoor-forecast-tabs"
        label={t("forecast.navigationLabel")}
        items={windows.map((window, index) => ({ id: String(index), label: window.label, count: window.points.length }))}
        selected={String(activeIndex)}
        onSelect={(index) => selectWindow(Number(index))}
        tabId={(index) => `${id}-forecast-tab-${index}`}
        panelId={() => `${id}-forecast-panel`}
      />

      <div
        className="outdoor-forecast-panel"
        id={`${id}-forecast-panel`}
        role="tabpanel"
        aria-labelledby={`${id}-forecast-tab-${activeIndex}`}
        tabIndex={0}
      >
        {activeWindow.points.length === 0 ? (
          <p className="outdoor-weather-empty">{t("forecast.noPoints")}</p>
        ) : (
          <>
            <div className="outdoor-forecast-table-scroll">
              <table className="outdoor-forecast-table">
                <caption>{caption}</caption>
                <thead>
                  <tr>
                    <th scope="col">{t("forecast.time")}</th>
                    <th scope="col">{t("forecast.temperature")}</th>
                    <th scope="col">{t("forecast.precipitation")}</th>
                    <th scope="col">{t("forecast.wind")}</th>
                    <th scope="col">{t("forecast.humidity")}</th>
                    <th scope="col">{t("forecast.cloudCover")}</th>
                  </tr>
                </thead>
                <tbody>
                  {activeWindow.points.map((point, index) => (
                    <tr key={`${point.timestamp}-${index}`}>
                      <td><time dateTime={point.timestamp}>{formatZonedForecastTime(point.timestamp, locale, timeZone)}</time></td>
                      <td>{formatWeatherTemperature(point.temperatureC, units, locale)}</td>
                      <td>
                        {formatWeatherPrecipitation(point.precipitation1hMm ?? point.precipitationIntensityMmPerHour, units, locale)}
                        {isFiniteNumber(point.precipitationProbabilityPercent) && <small>{formatWeatherPercent(point.precipitationProbabilityPercent, locale)}</small>}
                      </td>
                      <td>
                        {formatWeatherWind(point.windSpeedMps, units, locale)}
                        {isFiniteNumber(point.windGustMps) && <small>{t("forecast.gust", { value: formatWeatherWind(point.windGustMps, units, locale) })}</small>}
                      </td>
                      <td>{formatWeatherPercent(point.relativeHumidityPercent, locale)}</td>
                      <td>{formatWeatherPercent(point.cloudCoverPercent, locale)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>

            <ul className="outdoor-forecast-cards" aria-label={mobileLabel}>
              {activeWindow.points.map((point, index) => (
                <li key={`${point.timestamp}-${index}`}>
                  <time dateTime={point.timestamp}>{formatZonedForecastTime(point.timestamp, locale, timeZone)}</time>
                  <strong>{formatWeatherTemperature(point.temperatureC, units, locale)}</strong>
                  <dl>
                    <div><dt>{t("forecast.precipitation")}</dt><dd>{formatWeatherPrecipitation(point.precipitation1hMm ?? point.precipitationIntensityMmPerHour, units, locale)}</dd></div>
                    <div><dt>{t("forecast.wind")}</dt><dd>{formatWeatherWind(point.windSpeedMps, units, locale)}</dd></div>
                    <div><dt>{t("forecast.humidity")}</dt><dd>{formatWeatherPercent(point.relativeHumidityPercent, locale)}</dd></div>
                    <div><dt>{t("forecast.cloudCover")}</dt><dd>{formatWeatherPercent(point.cloudCoverPercent, locale)}</dd></div>
                  </dl>
                </li>
              ))}
            </ul>
          </>
        )}
      </div>
    </section>
  );
}
