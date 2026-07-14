import { Compass, Droplets, Eye, EyeOff, LoaderCircle, PauseCircle, Thermometer, TriangleAlert, Wind } from "lucide-react";
import { useState, type CSSProperties } from "react";
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
  conditionColors?: { temperature?: string; humidity?: string };
}

interface OutdoorConditionsBadgeProps {
  outdoor: OutdoorVisualizationState;
  units: UnitSystem;
  showCompass?: boolean;
}

const outdoorPanelPreferenceKey = "climate-twin-outdoor-panel";

function decimal(value: number, locale: string, digits = 1): string {
  return new Intl.NumberFormat(locale, { maximumFractionDigits: digits }).format(value);
}

export function formatOutdoorTemperature(value: number | undefined, units: UnitSystem, locale: string): string | null {
  if (typeof value !== "number" || !Number.isFinite(value)) return null;
  return units === "imperial"
    ? `${decimal(value * 9 / 5 + 32, locale)} °F`
    : `${decimal(value, locale)} °C`;
}

export function formatOutdoorWindSpeed(value: number | undefined, units: UnitSystem, locale: string): string | null {
  if (typeof value !== "number" || !Number.isFinite(value)) return null;
  return units === "imperial"
    ? `${decimal(value * 2.236936, locale)} mph`
    : `${decimal(value, locale)} m/s`;
}

export function formatOutdoorHumidity(value: number | undefined, locale: string): string | null {
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
  const [collapsed, setCollapsed] = useState(() => {
    const preference = localStorage.getItem(outdoorPanelPreferenceKey);
    if (preference) return preference === "collapsed";
    return window.matchMedia?.("(max-width: 500px)").matches ?? false;
  });

  const setPanelCollapsed = (next: boolean) => {
    setCollapsed(next);
    localStorage.setItem(outdoorPanelPreferenceKey, next ? "collapsed" : "expanded");
  };

  if (!outdoor.hasLocation) return null;

  if (collapsed) {
    return (
      <aside className="outdoor-context-card collapsed" aria-label={`${t("outdoor.title")}. ${t("outdoor.collapsed")}`}>
        <button
          type="button"
          className="outdoor-context-toggle"
          aria-expanded="false"
          aria-label={t("outdoor.expand")}
          title={t("outdoor.expand")}
          onClick={() => setPanelCollapsed(false)}
        >
          <Eye size={15} aria-hidden="true" />
          <strong>{t("outdoor.title")}</strong>
        </button>
      </aside>
    );
  }

  const collapseControl = (
    <button
      type="button"
      className="outdoor-context-toggle"
      aria-expanded="true"
      aria-label={t("outdoor.collapse")}
      title={t("outdoor.collapse")}
      onClick={() => setPanelCollapsed(true)}
    >
      <EyeOff size={14} aria-hidden="true" />
    </button>
  );

  if (outdoor.replayActive) {
    return (
      <aside className="outdoor-context-card compact muted has-toggle" aria-label={t("outdoor.replayHidden")}>
        {collapseControl}
        <PauseCircle size={16} aria-hidden="true" />
        <span><strong>{t("outdoor.title")}</strong><small>{t("outdoor.replayHidden")}</small></span>
      </aside>
    );
  }

  if (!context && outdoor.loading) {
    return (
      <aside className="outdoor-context-card compact has-toggle" aria-label={t("outdoor.loading")}>
        {collapseControl}
        <LoaderCircle className="spin" size={16} aria-hidden="true" />
        <span><strong>{t("outdoor.title")}</strong><small>{t("outdoor.loading")}</small></span>
      </aside>
    );
  }

  if (!context && outdoor.unavailable) {
    return (
      <aside className="outdoor-context-card compact warning has-toggle" aria-label={t("outdoor.unavailable")}>
        {collapseControl}
        <TriangleAlert size={16} aria-hidden="true" />
        <span><strong>{t("outdoor.title")}</strong><small>{t("outdoor.unavailable")}</small></span>
      </aside>
    );
  }

  if (!context) return null;

  const outsideTemperature = formatOutdoorTemperature(context.conditions.temperatureC, units, locale);
  const outsideHumidity = formatOutdoorHumidity(context.conditions.relativeHumidityPercent, locale);
  const outsideWind = formatOutdoorWindSpeed(context.conditions.windSpeedMps, units, locale);
  const outsideGust = formatOutdoorWindSpeed(context.conditions.windGustMps, units, locale);
  const temperatureColor = outdoor.conditionColors?.temperature;
  const humidityColor = outdoor.conditionColors?.humidity;
  const temperatureStyle = temperatureColor
    ? ({ "--outdoor-condition-color": temperatureColor } as CSSProperties)
    : undefined;
  const humidityStyle = humidityColor
    ? ({ "--outdoor-condition-color": humidityColor } as CSSProperties)
    : undefined;
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
    <aside className={`outdoor-context-card has-toggle ${context.stale ? "stale" : ""}`} aria-label={`${t("outdoor.title")}. ${accessibleSummary}`}>
      {collapseControl}
      <div className="outdoor-context-heading">
        <span><strong>{t("outdoor.title")}</strong><small>{t("outdoor.observedAt", { time: observedTime(context.observedAt, locale, outdoor.timeZone) })}</small></span>
        {context.stale && <b>{t("outdoor.stale")}</b>}
      </div>
      <div className="outdoor-context-values">
        {outsideTemperature && <span className={temperatureColor ? "outdoor-condition-color outdoor-temperature-condition" : undefined} style={temperatureStyle}><Thermometer size={15} aria-hidden="true" /><b>{outsideTemperature}</b></span>}
        {outsideHumidity && <span className={humidityColor ? "outdoor-condition-color outdoor-humidity-condition" : undefined} style={humidityStyle}><Droplets size={15} aria-hidden="true" /><b>{outsideHumidity}</b></span>}
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
        <small className="outdoor-badge-provenance">
          {outdoor.attribution}
          {outdoor.station && <span>{t("outdoor.station", { station: outdoor.station.name, distance: stationDistance(outdoor.station.distanceKm, units, locale) })}</span>}
        </small>
      )}
    </aside>
  );
}
