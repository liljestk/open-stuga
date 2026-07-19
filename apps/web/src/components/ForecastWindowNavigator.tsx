import { useEffect, useId, useMemo, useRef, useState, type KeyboardEvent } from "react";
import type { OutdoorConditions, UnitSystem } from "@climate-twin/contracts";
import { useI18n, type Locale, type TranslationKey } from "../i18n";

export const FORECAST_WINDOW_HOURS = 12;
export const MAX_FORECAST_HOURS = 48;

export type ForecastHorizonHours = 12 | 24 | 36 | 48;

export const FORECAST_WINDOW_LABEL_KEYS = [
  "forecast.window.next12",
  "forecast.window.12to24",
  "forecast.window.24to36",
  "forecast.window.36to48",
] as const satisfies readonly TranslationKey[];

function finite(value: number | undefined): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

function decimal(value: number, locale: string, maximumFractionDigits = 1): string {
  return new Intl.NumberFormat(locale, { maximumFractionDigits }).format(value);
}

export function formatWeatherTemperature(value: number | undefined, units: UnitSystem, locale: string): string {
  if (!finite(value)) return "—";
  return units === "imperial"
    ? `${decimal(value * 9 / 5 + 32, locale)} °F`
    : `${decimal(value, locale)} °C`;
}

export function formatWeatherWind(value: number | undefined, units: UnitSystem, locale: string): string {
  if (!finite(value)) return "—";
  return units === "imperial"
    ? `${decimal(value * 2.236936, locale)} mph`
    : `${decimal(value, locale)} m/s`;
}

export function formatWeatherPrecipitation(value: number | undefined, units: UnitSystem, locale: string): string {
  if (!finite(value)) return "—";
  return units === "imperial"
    ? `${decimal(value / 25.4, locale, 2)} in`
    : `${decimal(value, locale)} mm`;
}

export function formatWeatherPercent(value: number | undefined, locale: string): string {
  return finite(value) ? `${decimal(value, locale, 0)}%` : "—";
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
    return new Intl.DateTimeFormat(locale, { ...options, timeZone }).format(date);
  } catch {
    return new Intl.DateTimeFormat(locale, { ...options, timeZone: "UTC" }).format(date);
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
  const [selectedWindow, setSelectedWindow] = useState(0);
  const tabs = useRef<Array<HTMLButtonElement | null>>([]);
  const windowLabels = useMemo(() => FORECAST_WINDOW_LABEL_KEYS.map((key) => t(key)), [t]);
  const windows = useMemo(
    () => buildForecastWindows(points, horizonHours, windowLabels),
    [horizonHours, points, windowLabels],
  );
  const activeIndex = Math.min(selectedWindow, windows.length - 1);
  const activeWindow = windows[activeIndex]!;

  useEffect(() => {
    setSelectedWindow(0);
  }, [houseId, horizonHours]);

  useEffect(() => {
    setSelectedWindow((current) => Math.min(current, windows.length - 1));
  }, [windows.length]);

  const selectAndFocus = (index: number) => {
    const next = (index + windows.length) % windows.length;
    setSelectedWindow(next);
    tabs.current[next]?.focus();
  };

  const handleTabKey = (event: KeyboardEvent<HTMLButtonElement>, index: number) => {
    if (event.key === "ArrowRight") {
      event.preventDefault();
      selectAndFocus(index + 1);
    } else if (event.key === "ArrowLeft") {
      event.preventDefault();
      selectAndFocus(index - 1);
    } else if (event.key === "Home") {
      event.preventDefault();
      selectAndFocus(0);
    } else if (event.key === "End") {
      event.preventDefault();
      selectAndFocus(windows.length - 1);
    }
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

      <div className="outdoor-forecast-tabs" role="tablist" aria-label={t("forecast.navigationLabel")}>
        {windows.map((window, index) => (
          <button
            key={window.index}
            ref={(element) => { tabs.current[index] = element; }}
            type="button"
            role="tab"
            id={`${id}-forecast-tab-${index}`}
            aria-selected={activeIndex === index}
            aria-controls={`${id}-forecast-panel`}
            tabIndex={activeIndex === index ? 0 : -1}
            onClick={() => setSelectedWindow(index)}
            onKeyDown={(event) => handleTabKey(event, index)}
          >
            {window.label}
            <small>{window.points.length}</small>
          </button>
        ))}
      </div>

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
                        {finite(point.precipitationProbabilityPercent) && <small>{formatWeatherPercent(point.precipitationProbabilityPercent, locale)}</small>}
                      </td>
                      <td>
                        {formatWeatherWind(point.windSpeedMps, units, locale)}
                        {finite(point.windGustMps) && <small>{t("forecast.gust", { value: formatWeatherWind(point.windGustMps, units, locale) })}</small>}
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
