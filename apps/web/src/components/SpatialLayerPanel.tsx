import { AlertTriangle, Box, ChevronDown, FlaskConical, History, Map as MapIcon, Radar, RefreshCw, Waves, Wind } from "lucide-react";
import type { SpatialLayerEngineManifest, SpatialLayerSnapshot } from "../spatialLayers";
import type { UseSpatialLayersResult } from "../useSpatialLayers";
import type { AirflowEvidence } from "../airflowSimulation";
import type {
  ExperimentalLayerSuggestion,
  ExperimentalVisualizationId,
  SensorCoverageAssessment,
} from "../experimentalSpatialLayers";
import { formatInTimeZone } from "../dateTime";
import { useI18n, type TranslationKey } from "../i18n";
import { readLocalStorage, writeLocalStorage } from "../browserStorage";

export interface SpatialLayerPanelProps {
  layers: UseSpatialLayersResult;
  timeZone: string;
  historyAt?: number | null;
  compact?: boolean;
  onHistorySelect?: (timestamp: number) => void;
  visualization?: {
    selected: readonly ExperimentalVisualizationId[];
    mode: "plan" | "isometric";
    coverage: SensorCoverageAssessment;
    airflow: AirflowEvidence | null;
    suggestions: readonly ExperimentalLayerSuggestion[];
    onToggle: (layerId: ExperimentalVisualizationId, selected: boolean) => void;
  };
}

const spatialLayerPanelPreferenceKey = "stuga-spatial-layer-panel";

const knownReasons: Record<string, TranslationKey> = {
  "insufficient-data": "spatial.reason.insufficientData",
  insufficient_data: "spatial.reason.insufficientData",
  "sensor-stale": "spatial.reason.sensorStale",
  stale_sensor: "spatial.reason.sensorStale",
  uncalibrated: "spatial.reason.uncalibrated",
  "common-mode-event": "spatial.reason.commonMode",
  common_mode_event: "spatial.reason.commonMode",
  "air-explained": "spatial.reason.airExplained",
  air_explained: "spatial.reason.airExplained",
  "persistent-local-residual": "spatial.reason.localResidual",
  persistent_local_residual: "spatial.reason.localResidual",
  "equipment-confounder": "spatial.reason.equipment",
  equipment_confounder: "spatial.reason.equipment",
  "learning-baseline": "spatial.reason.learning",
  learning_baseline: "spatial.reason.learning",
  "configuration-incomplete": "spatial.reason.configuration",
  configuration_incomplete: "spatial.reason.configuration",
};

export function spatialLayerLabel(layerId: string, t: ReturnType<typeof useI18n>["t"]): string {
  if (layerId === "climate.scalar") return t("spatial.layer.scalar");
  if (layerId === "climate.temperature") return t("spatial.layer.temperature");
  if (layerId === "climate.relative-humidity") return t("spatial.layer.relativeHumidity");
  if (layerId === "climate.absolute-humidity") return t("spatial.layer.absoluteHumidity");
  if (layerId === "climate.humidity-ratio") return t("spatial.layer.humidityRatio");
  if (layerId === "sensor.quality") return t("spatial.layer.sensorQuality");
  if (layerId === "climate.propagation.experimental") return t("spatial.layer.propagation");
  if (layerId === "climate.unexplained-activity.research") return t("spatial.layer.activity");
  return layerId.split(/[._-]+/).map((part) => part ? `${part[0]!.toUpperCase()}${part.slice(1)}` : "").join(" ");
}

function manifestFor(layerId: string, engines: readonly SpatialLayerEngineManifest[]) {
  return engines.find((engine) => engine.layerIds.includes(layerId));
}

function reasonLabel(reason: string, t: ReturnType<typeof useI18n>["t"]): string {
  const key = knownReasons[reason];
  return key ? t(key) : t("spatial.reason.other", { code: reason.replaceAll(/[_-]+/g, " ") });
}

function snapshotReasons(snapshot: SpatialLayerSnapshot): string[] {
  return [...new Set([
    ...snapshot.reasonCodes,
    ...snapshot.zones.flatMap((zone) => [...(zone.reasonCodes ?? []), ...(zone.evidence?.reasonCodes ?? [])]),
    ...snapshot.connections.flatMap((connection) => [...(connection.reasonCodes ?? []), ...(connection.evidence?.reasonCodes ?? [])]),
  ])];
}

function snapshotSummary(snapshot: SpatialLayerSnapshot, t: ReturnType<typeof useI18n>["t"]): string {
  if (snapshot.status === "warming_up") return t("spatial.status.warming_up");
  if (snapshot.status === "insufficient_data") return t("spatial.status.insufficient_data");
  if (snapshot.status === "error") return t("spatial.status.error");
  if (snapshot.layerId === "climate.propagation.experimental") {
    const visible = snapshot.connections.filter((connection) => connection.state === "directed" || connection.state === "bidirectional").length;
    return visible ? t("spatial.summary.connections", { count: visible }) : t("spatial.summary.noPropagation");
  }
  if (snapshot.layerId === "climate.unexplained-activity.research") {
    const visible = snapshot.zones.filter((zone) => {
      const metric = zone.metrics.activityEvidenceScore ?? zone.metrics.activityProbability ?? zone.metrics.strength;
      return typeof metric?.value === "number" && metric.value >= .35;
    }).length;
    return visible ? t("spatial.summary.activityZones", { count: visible }) : t("spatial.summary.noActivity");
  }
  return t("spatial.summary.zones", { count: snapshot.zones.length });
}

function suggestionLabel(suggestion: ExperimentalLayerSuggestion, t: ReturnType<typeof useI18n>["t"]): string {
  const values: Record<string, string | number> = {
    floor: suggestion.floorName ?? t("nav.twin"),
    room: suggestion.roomName ?? suggestion.floorName ?? t("nav.twin"),
    count: suggestion.count ?? 1,
  };
  return t(`spatial.suggestion.${suggestion.code}` as TranslationKey, values);
}

function suggestionVisible(suggestion: ExperimentalLayerSuggestion, selected: readonly ExperimentalVisualizationId[]): boolean {
  return suggestion.layer === "both" || selected.includes(suggestion.layer);
}

export function SpatialLayerPanel({ layers, timeZone, historyAt = null, compact = false, onHistorySelect, visualization }: SpatialLayerPanelProps) {
  const { locale, t } = useI18n();
  if (!layers.available) return null;
  const supportedLayerIds = [...new Set(layers.engines.flatMap((engine) => engine.layerIds))];
  const historical = [...layers.history]
    .sort((left, right) => Date.parse(left.generatedAt) - Date.parse(right.generatedAt));
  const timeline = [...new Map(historical.map((snapshot) => [snapshot.generatedAt, snapshot])).values()];
  const selectedTimelineIndex = timeline.reduce((best, snapshot, index) => {
    if (historyAt === null || Date.parse(snapshot.generatedAt) > historyAt) return best;
    return index;
  }, 0);
  const quality = layers.snapshots.length
    ? Math.min(...layers.snapshots.map((snapshot) => snapshot.qualityScore))
    : null;

  return (
    <details
      className={`spatial-layer-panel ${compact ? "compact" : ""}`}
      open={readLocalStorage(spatialLayerPanelPreferenceKey) === "expanded" || undefined}
      onToggle={(event) => writeLocalStorage(spatialLayerPanelPreferenceKey, event.currentTarget.open ? "expanded" : "collapsed")}
    >
      <summary className="spatial-layer-heading">
        <span className="spatial-layer-icon" aria-hidden="true"><Waves size={18} /></span>
        <span className="spatial-layer-heading-copy">
          <span className="eyebrow"><FlaskConical size={13} aria-hidden="true" />{t("spatial.eyebrow")}</span>
          <strong>{t("spatial.title")}</strong>
          <p>{t("spatial.description")}</p>
        </span>
        <span className="spatial-maturity-badge">{t("spatial.experimental")}</span>
        <ChevronDown className="spatial-layer-chevron" size={18} aria-hidden="true" />
      </summary>

      <div className="spatial-layer-content">

        {visualization && <section className="spatial-visualizations" aria-labelledby="spatial-visualizations-title">
          <div className="spatial-section-heading">
            <span><strong id="spatial-visualizations-title">{t("spatial.visualizations.title")}</strong><small>{t("spatial.visualizations.description")}</small></span>
            <span className="spatial-view-badge">{visualization.mode === "plan" ? <MapIcon size={13} aria-hidden="true" /> : <Box size={13} aria-hidden="true" />}{visualization.mode === "plan" ? t("spatial.mode2d") : t("spatial.mode3d")}</span>
          </div>
          <div className="spatial-visualization-selector" role="group" aria-label={t("spatial.visualizations.selector")}>
            {(["air-movement", "sensor-coverage"] as const).map((layerId) => {
              const selected = visualization.selected.includes(layerId);
              const isAir = layerId === "air-movement";
              const support = isAir ? visualization.airflow?.support ?? "low" : visualization.coverage.support;
              return <button
                key={layerId}
                type="button"
                aria-pressed={selected}
                onClick={() => visualization.onToggle(layerId, !selected)}
              >
                <span className="spatial-visualization-icon" aria-hidden="true">{isAir ? <Wind size={18} /> : <Radar size={18} />}</span>
                <span><strong>{isAir ? t("spatial.airflow.title") : t("spatial.coverage.title")}</strong><small>{isAir ? t("spatial.airflow.short") : t("spatial.coverage.short")}</small></span>
                <em data-support={support}>{t(`spatial.airflow.support.${support}` as TranslationKey)}</em>
              </button>;
            })}
          </div>
          {visualization.selected.length > 0 && <div className="spatial-visualization-evidence">
            {visualization.selected.includes("air-movement") && <article data-support={visualization.airflow?.support ?? "low"}>
              <span className="spatial-visualization-icon" aria-hidden="true"><Wind size={16} /></span>
              <span><strong>{visualization.airflow && visualization.airflow.temperatureSensors >= 2 ? t("spatial.airflow.estimateReady") : t("spatial.airflow.needsData")}</strong><small>{t("spatial.airflow.evidence", {
                temperature: visualization.airflow?.temperatureSensors ?? 0,
                humidity: visualization.airflow?.humiditySensors ?? 0,
                tracer: visualization.airflow?.tracerSensors ?? 0,
              })}</small></span>
            </article>}
            {visualization.selected.includes("sensor-coverage") && <article data-support={visualization.coverage.support}>
              <span className="spatial-visualization-icon" aria-hidden="true"><Radar size={16} /></span>
              <span><strong>{t("spatial.coverage.support", { support: Math.round(visualization.coverage.coverageScore * 100) })}</strong><small>{t("spatial.coverage.evidence", {
                fresh: visualization.coverage.freshTemperatureSensors,
                total: visualization.coverage.enabledSensors,
                paired: visualization.coverage.pairedHumiditySensors,
              })}</small></span>
            </article>}
          </div>}
          {visualization.selected.length > 0 && visualization.suggestions.some((suggestion) => suggestionVisible(suggestion, visualization.selected)) && <div className="spatial-suggestions">
            <AlertTriangle size={17} aria-hidden="true" />
            <span><strong>{t("spatial.suggestions.title")}</strong><small>{t("spatial.suggestions.description")}</small></span>
            <ul>{visualization.suggestions.filter((suggestion) => suggestionVisible(suggestion, visualization.selected)).slice(0, 6).map((suggestion) => <li key={suggestion.id}>{suggestionLabel(suggestion, t)}</li>)}</ul>
          </div>}
        </section>}

        <section className="spatial-stored-layers">
          <div className="spatial-section-heading"><span><strong>{t("spatial.stored.title")}</strong><small>{t("spatial.stored.description")}</small></span></div>
          <div className="spatial-layer-selector" role="group" aria-label={t("spatial.selector")}>{supportedLayerIds.map((layerId) => {
        const selected = layers.selectedLayerIds.includes(layerId);
        const manifest = manifestFor(layerId, layers.engines);
        return <button
          key={layerId}
          type="button"
          aria-pressed={selected}
          onClick={() => layers.setLayerSelected(layerId, !selected)}
        >
          <span>{spatialLayerLabel(layerId, t)}</span>
          <small>{t(`spatial.maturity.${manifest?.maturity ?? "research"}` as TranslationKey)}</small>
        </button>;
        })}<button type="button" className="spatial-refresh" disabled={layers.refreshing} aria-label={t("spatial.refresh")} title={t("spatial.refresh")} onClick={() => void layers.refresh()}><RefreshCw size={17} className={layers.refreshing ? "spin" : ""} aria-hidden="true" /></button></div>
        </section>

        {layers.error && layers.snapshots.length > 0 && <p className="spatial-retained-warning" role="status"><AlertTriangle size={14} aria-hidden="true" />{t("spatial.refreshFailed")}</p>}
        {layers.historyLoading && <p className="spatial-loading" role="status">{t("spatial.loadingHistory")}</p>}
        {layers.selectedLayerIds.length > 0 && !layers.loading && !layers.historyLoading && layers.snapshots.length === 0 && <p className="spatial-empty" role="status">{t("spatial.noSnapshot")}</p>}

        {layers.snapshots.length > 0 && <div className="spatial-layer-summaries">{layers.snapshots.map((snapshot) => {
        const stale = layers.staleLayerIds.includes(snapshot.layerId);
        const reasons = snapshotReasons(snapshot);
        return <article key={`${snapshot.layerId}:${snapshot.generatedAt}`} data-status={snapshot.status} data-stale={stale || undefined}>
          <div><strong>{spatialLayerLabel(snapshot.layerId, t)}</strong><span>{snapshotSummary(snapshot, t)}</span></div>
          <dl>
            <div><dt>{t("spatial.quality")}</dt><dd>{Math.round(snapshot.qualityScore * 100)}%</dd></div>
            <div><dt>{t("spatial.updated")}</dt><dd><time dateTime={snapshot.generatedAt}>{formatInTimeZone(snapshot.generatedAt, locale, timeZone, { hour: "2-digit", minute: "2-digit", second: "2-digit" })}</time></dd></div>
          </dl>
          <span className={`spatial-snapshot-state ${stale ? "stale" : snapshot.status}`}>{stale ? t("spatial.stale") : t(`spatial.status.${snapshot.status}` as TranslationKey)}</span>
          <details>
            <summary>{t("spatial.explanation")}<ChevronDown size={14} aria-hidden="true" /></summary>
            <div className="spatial-explanation">
              <p>{snapshot.layerId === "climate.unexplained-activity.research" ? t("spatial.activityDisclaimer") : t("spatial.inferenceDisclaimer")}</p>
              {reasons.length > 0 && <ul>{reasons.map((reason) => <li key={reason}>{reasonLabel(reason, t)}</li>)}</ul>}
              {snapshot.warnings.length > 0 && <ul className="spatial-warnings">{snapshot.warnings.map((warning, index) => <li key={`${warning}:${index}`}>{warning}</li>)}</ul>}
              <dl>
                <div><dt>{t("spatial.model")}</dt><dd>{snapshot.model.id} {snapshot.model.version}</dd></div>
                <div><dt>{t("spatial.window")}</dt><dd><time dateTime={snapshot.windowStart}>{formatInTimeZone(snapshot.windowStart, locale, timeZone, { hour: "2-digit", minute: "2-digit" })}</time>{"\u2013"}<time dateTime={snapshot.windowEnd}>{formatInTimeZone(snapshot.windowEnd, locale, timeZone, { hour: "2-digit", minute: "2-digit" })}</time></dd></div>
              </dl>
            </div>
          </details>
        </article>;
        })}</div>}

        {timeline.length > 1 && onHistorySelect && <div className="spatial-timeline">
          <label htmlFor="spatial-layer-timeline"><History size={14} aria-hidden="true" /><span>{t("spatial.timeline")}</span></label>
          <input
            id="spatial-layer-timeline"
            type="range"
            min={0}
            max={timeline.length - 1}
            step={1}
            value={Math.min(selectedTimelineIndex, timeline.length - 1)}
            aria-valuetext={formatInTimeZone(timeline[Math.min(selectedTimelineIndex, timeline.length - 1)]!.generatedAt, locale, timeZone, { dateStyle: "medium", timeStyle: "short" })}
            onChange={(event) => onHistorySelect(Date.parse(timeline[Number(event.target.value)]!.generatedAt))}
          />
        </div>}
        {quality !== null && <span className="sr-only" role="status">{t("spatial.textSummary", { layers: layers.snapshots.length, quality: Math.round(quality * 100) })}</span>}
      </div>
    </details>
  );
}
