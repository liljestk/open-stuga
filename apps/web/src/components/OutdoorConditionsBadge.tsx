import { Compass, Droplets, LoaderCircle, PauseCircle, Thermometer, TriangleAlert, Wind } from "lucide-react";
import type { UnitSystem } from "@climate-twin/contracts";
import type { OutdoorBoundaryContext, PlanEdge } from "../outdoorContext";
import { useI18n, type TranslationKey } from "../i18n";

export interface OutdoorVisualizationState {
  context: OutdoorBoundaryContext | null;
  loading: boolean;
  unavailable: boolean;
  refreshFailed: boolean;
  hasLocation: boolean;
  replayActive: boolean;
  orientationDegrees?: number;
  timeZone: string;
  attribution?: string;
  station?: { name: string; distanceKm: number };
}

interface OutdoorConditionsBadgeProps {
  outdoor: OutdoorVisualizationState;
  units: UnitSystem;
  showCompass?: boolean;
}

function decimal(value: number, locale: string, digits = 1): string {
  return new Intl.NumberFormat(locale, { maximumFractionDigits: digits }).format(value);
}

function temperature(value: number | undefined, units: UnitSystem, locale: string): string | null {
  if (typeof value !== "number" || !Number.isFinite(value)) return null;
  return units === "imperial"
    ? `${decimal(value * 9 / 5 + 32, locale)} °F`
    : `${decimal(value, locale)} °C`;
}

function windSpeed(value: number | undefined, units: UnitSystem, locale: string): string | null {
  if (typeof value !== "number" || !Number.isFinite(value)) return null;
  return units === "imperial"
    ? `${decimal(value * 2.236936, locale)} mph`
    : `${decimal(value, locale)} m/s`;
}

function humidity(value: number | undefined, locale: string): string | null {
  return typeof value === "number" && Number.isFinite(value) ? `${decimal(value, locale, 0)}%` : null;
}

function stationDistance(value: number, units: UnitSystem, locale: string): string {
  return units === "imperial"
    ? `${decimal(value * 0.621371, locale)} mi`
    : `${decimal(value, locale)} km`;
}

function edgeKey(edge: PlanEdge): TranslationKey {
  return `outdoor.edge.${edge}` as TranslationKey;
}

function cardinalKey(cardinal: string): TranslationKey {
  return `outdoor.cardinal.${cardinal}` as TranslationKey;
}

function observedTime(timestamp: string, locale: string, timeZone: string): string {
  const parsed = new Date(timestamp);
  if (!Number.isFinite(parsed.getTime())) return timestamp;
  try {
    return new Intl.DateTimeFormat(locale, { timeStyle: "short", timeZone }).format(parsed);
  } catch {
    return new Intl.DateTimeFormat(locale, { timeStyle: "short" }).format(parsed);
  }
}

export function OutdoorConditionsBadge({ outdoor, units, showCompass = false }: OutdoorConditionsBadgeProps) {
  const { locale, t } = useI18n();
  const { context } = outdoor;

  if (outdoor.replayActive) {
    return (
      <aside className="outdoor-context-card compact muted" aria-label={t("outdoor.replayHidden")}>
        <PauseCircle size={16} aria-hidden="true" />
        <span><strong>{t("outdoor.title")}</strong><small>{t("outdoor.replayHidden")}</small></span>
      </aside>
    );
  }

  if (!outdoor.hasLocation) return null;

  if (!context && outdoor.loading) {
    return (
      <aside className="outdoor-context-card compact" aria-label={t("outdoor.loading")}>
        <LoaderCircle className="spin" size={16} aria-hidden="true" />
        <span><strong>{t("outdoor.title")}</strong><small>{t("outdoor.loading")}</small></span>
      </aside>
    );
  }

  if (!context && outdoor.unavailable) {
    return (
      <aside className="outdoor-context-card compact warning" aria-label={t("outdoor.unavailable")}>
        <TriangleAlert size={16} aria-hidden="true" />
        <span><strong>{t("outdoor.title")}</strong><small>{t("outdoor.unavailable")}</small></span>
      </aside>
    );
  }

  if (!context) return null;

  const outsideTemperature = temperature(context.conditions.temperatureC, units, locale);
  const outsideHumidity = humidity(context.conditions.relativeHumidityPercent, locale);
  const outsideWind = windSpeed(context.conditions.windSpeedMps, units, locale);
  const outsideGust = windSpeed(context.conditions.windGustMps, units, locale);
  const direction = context.windFromDegrees === null || context.windFromCardinal === null
    ? null
    : `${t(cardinalKey(context.windFromCardinal))} · ${decimal(context.windFromDegrees, locale, 0)}°`;
  const windwardSide = context.windwardEdge ? t(edgeKey(context.windwardEdge)) : null;
  const orientationKnown = outdoor.orientationDegrees !== undefined;
  const accessibleSummary = [
    outsideTemperature && t("outdoor.temperatureAria", { value: outsideTemperature }),
    outsideHumidity && t("outdoor.humidityAria", { value: outsideHumidity }),
    outsideWind && t("outdoor.windSpeedAria", { value: outsideWind }),
    outsideGust && t("outdoor.windGustAria", { value: outsideGust }),
    direction && t("outdoor.windFromAria", { value: direction }),
    windwardSide && t("outdoor.windwardAria", { edge: windwardSide }),
  ].filter(Boolean).join(". ");

  return (
    <aside className={`outdoor-context-card ${context.stale ? "stale" : ""}`} aria-label={`${t("outdoor.title")}. ${accessibleSummary}`}>
      <div className="outdoor-context-heading">
        <span><strong>{t("outdoor.title")}</strong><small>{t("outdoor.observedAt", { time: observedTime(context.observedAt, locale, outdoor.timeZone) })}</small></span>
        {context.stale && <b>{t("outdoor.stale")}</b>}
      </div>
      <div className="outdoor-context-values">
        {outsideTemperature && <span><Thermometer size={15} aria-hidden="true" /><b>{outsideTemperature}</b></span>}
        {outsideHumidity && <span><Droplets size={15} aria-hidden="true" /><b>{outsideHumidity}</b></span>}
        {(outsideWind || outsideGust || direction) && <span><Wind size={15} aria-hidden="true" /><b>{outsideWind ?? t("common.noData")}</b>{outsideGust && <small>{t("outdoor.gust", { value: outsideGust })}</small>}{direction && <small>{direction}</small>}</span>}
      </div>
      {orientationKnown && windwardSide && (
        <p className="outdoor-boundary-note"><Compass size={14} aria-hidden="true" />{t("outdoor.windwardEdge", { edge: windwardSide })}</p>
      )}
      {!orientationKnown && (
        <p className="outdoor-boundary-note setup"><Compass size={14} aria-hidden="true" />{t("outdoor.orientationNeeded")}</p>
      )}
      {orientationKnown && context.windFromDegrees === null && (
        <p className="outdoor-boundary-note"><Wind size={14} aria-hidden="true" />{t("outdoor.directionUnavailable")}</p>
      )}
      {outdoor.refreshFailed && (
        <p className="outdoor-boundary-note warning"><TriangleAlert size={14} aria-hidden="true" />{t("outdoor.refreshFailed")}</p>
      )}
      {showCompass && orientationKnown && (
        <div className="outdoor-compass" aria-label={t("outdoor.compassAria", { degrees: decimal(outdoor.orientationDegrees!, locale, 0) })}>
          <span className="outdoor-compass-dial" aria-hidden="true"><i style={{ transform: `rotate(${-outdoor.orientationDegrees!}deg)` }}>↑</i><b>{t("orientation.northShort")}</b></span>
          <small>{t("outdoor.planTop", { degrees: decimal(outdoor.orientationDegrees!, locale, 0) })}</small>
        </div>
      )}
      <small className="outdoor-model-note">{t("outdoor.boundaryOnly")}</small>
      {(outdoor.attribution || outdoor.station) && (
        <small className="outdoor-provenance">
          {outdoor.attribution}
          {outdoor.station && <span>{t("outdoor.station", { station: outdoor.station.name, distance: stationDistance(outdoor.station.distanceKm, units, locale) })}</span>}
        </small>
      )}
    </aside>
  );
}
