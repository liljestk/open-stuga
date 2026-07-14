import { AlertTriangle, CloudSun, Eye, GitCompareArrows } from "lucide-react";
import type { AlertEvent, HouseWeather, ManualObservation, MeasurementDefinition, Sensor, UnitSystem, WeatherWarning } from "@climate-twin/contracts";
import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import type { TimeRange } from "../domain";
import { useI18n } from "../i18n";
import { displayUnit, formatMeasurement, measurementDomain, measurementLabel, measurementValue, toDisplayValue, type MeasurementHistory } from "../measurements";
import { formatInTimeZone } from "../dateTime";

interface RoomComparisonChartProps {
  sensors: Sensor[];
  selectedSensorId: string | null;
  history: MeasurementHistory;
  definition: MeasurementDefinition;
  units: UnitSystem;
  range: TimeRange;
  weather: HouseWeather | null;
  alerts: AlertEvent[];
  observations: ManualObservation[];
  warnings: WeatherWarning[];
  timeZone: string;
  onRange: (range: TimeRange) => void;
  onLoadSeries: (sensorId: string) => void;
}

interface SeriesPoint { timestamp: number; value: number }
interface ChartSeries { id: string; label: string; colorIndex: number; outdoor: boolean; points: SeriesPoint[] }
interface EventMarker { id: string; timestamp: number; kind: "alert" | "observation" | "weather"; label: string }

const width = 820;
const height = 284;
const margin = { top: 18, right: 20, bottom: 36, left: 60 };
const MAX_SERIES = 4;

function outdoorValue(definition: MeasurementDefinition, point: NonNullable<HouseWeather["current"]>): number | null {
  if (definition.id === "temperature") return point.temperatureC ?? null;
  if (definition.id === "humidity") return point.relativeHumidityPercent ?? null;
  return null;
}

function pathFor(points: SeriesPoint[], x: (timestamp: number) => number, y: (value: number) => number): string {
  return points.map((point, index) => `${index ? "L" : "M"}${x(point.timestamp).toFixed(1)} ${y(point.value).toFixed(1)}`).join(" ");
}

function nearest(points: SeriesPoint[], timestamp: number): SeriesPoint | null {
  return points.reduce<SeriesPoint | null>((candidate, point) => (
    !candidate || Math.abs(point.timestamp - timestamp) < Math.abs(candidate.timestamp - timestamp) ? point : candidate
  ), null);
}

function initialSensorIds(selectedSensorId: string | null, sensors: Sensor[]): string[] {
  if (selectedSensorId) return [selectedSensorId];
  const firstSensor = sensors[0];
  return firstSensor ? [firstSensor.id] : [];
}

function hoursForRange(range: TimeRange): number {
  if (range === "6h") return 6;
  if (range === "24h") return 24;
  return 168;
}

function tickAnchor(index: number, count: number): "start" | "middle" | "end" {
  if (index === 0) return "start";
  if (index === count - 1) return "end";
  return "middle";
}

function tickDateOptions(range: TimeRange): Intl.DateTimeFormatOptions {
  return range === "7d"
    ? { weekday: "short", hour: "2-digit" }
    : { hour: "2-digit", minute: "2-digit" };
}

export function RoomComparisonChart(props: Readonly<RoomComparisonChartProps>) {
  const { locale, t } = useI18n();
  const [selectedIds, setSelectedIds] = useState<string[]>(() => initialSensorIds(props.selectedSensorId, props.sensors));
  const [outdoorVisible, setOutdoorVisible] = useState(true);
  const [limitVisible, setLimitVisible] = useState(false);
  const [focusedTimestamp, setFocusedTimestamp] = useState<number | null>(null);
  const loadSeriesRef = useRef(props.onLoadSeries);
  const now = Date.now();
  const rangeHours = hoursForRange(props.range);
  const from = now - rangeHours * 60 * 60_000;
  const activeSensorIds = useMemo(() => new Set(props.sensors.map((sensor) => sensor.id)), [props.sensors]);

  useEffect(() => {
    setSelectedIds((current) => {
      const valid = current.filter((id) => activeSensorIds.has(id));
      if (props.selectedSensorId && activeSensorIds.has(props.selectedSensorId) && !valid.includes(props.selectedSensorId)) {
        return [props.selectedSensorId, ...valid].slice(0, MAX_SERIES);
      }
      if (valid.length) return valid;
      const firstSensor = props.sensors[0];
      return firstSensor ? [firstSensor.id] : [];
    });
  }, [activeSensorIds, props.selectedSensorId, props.sensors]);

  useEffect(() => {
    loadSeriesRef.current = props.onLoadSeries;
  }, [props.onLoadSeries]);

  useEffect(() => {
    selectedIds.filter((sensorId) => sensorId !== props.selectedSensorId).forEach((sensorId) => loadSeriesRef.current(sensorId));
  }, [selectedIds, props.selectedSensorId, props.definition.id, props.range]);

  const outdoorAvailable = (props.definition.id === "temperature" || props.definition.id === "humidity")
    && Boolean(props.weather?.current || props.weather?.forecast.length);
  const series = useMemo<ChartSeries[]>(() => {
    const indoor = selectedIds.flatMap((sensorId, index) => {
      const sensor = props.sensors.find((candidate) => candidate.id === sensorId);
      if (!sensor) return [];
      const points = (props.history[sensorId]?.[props.definition.id] ?? [])
        .filter((sample) => sample.quality !== "stale" && Date.parse(sample.timestamp) >= from)
        .flatMap((sample) => {
          const value = measurementValue(sample, props.definition.id);
          const timestamp = Date.parse(sample.timestamp);
          return value === undefined || !Number.isFinite(timestamp) ? [] : [{ timestamp, value }];
        });
      return [{ id: sensor.id, label: sensor.room.trim() || sensor.name, colorIndex: index, outdoor: false, points }];
    });
    if (!outdoorVisible || !outdoorAvailable || !props.weather) return indoor;
    const weatherPoints = [props.weather.current, ...props.weather.forecast]
      .flatMap((conditions) => {
        if (!conditions) return [];
        const value = outdoorValue(props.definition, conditions);
        const timestamp = Date.parse(conditions.timestamp);
        return value === null || !Number.isFinite(timestamp) || timestamp < from || timestamp > now + 5 * 60_000 ? [] : [{ timestamp, value }];
      })
      .sort((left, right) => left.timestamp - right.timestamp)
      .filter((point, index, points) => index === 0 || point.timestamp !== points[index - 1]!.timestamp);
    return [...indoor, { id: "outdoor", label: t("decision.outdoor"), colorIndex: 4, outdoor: true, points: weatherPoints }];
  }, [selectedIds, props.sensors, props.history, props.definition, props.weather, outdoorAvailable, outdoorVisible, from, t]);
  const allPoints = series.flatMap((item) => item.points);
  const timeMin = from;
  const timeMax = now;
  const domain = measurementDomain(props.definition, allPoints.map((point) => point.value));
  const plotWidth = width - margin.left - margin.right;
  const plotHeight = height - margin.top - margin.bottom;
  const x = (timestamp: number) => margin.left + (timestamp - timeMin) / Math.max(timeMax - timeMin, 1) * plotWidth;
  const y = (value: number) => margin.top + ((domain?.max ?? 1) - value) / Math.max((domain?.max ?? 1) - (domain?.min ?? 0), Number.EPSILON) * plotHeight;
  const markers = useMemo<EventMarker[]>(() => [
    ...props.alerts.flatMap((alert) => {
      if (!selectedIds.includes(alert.sensorId)) return [];
      return [{ id: `alert:${alert.id}`, timestamp: Date.parse(alert.startedAt), kind: "alert" as const, label: t("activity.alertTitle", { sensor: props.sensors.find((sensor) => sensor.id === alert.sensorId)?.name ?? alert.sensorId }) }];
    }),
    ...props.observations.map((observation) => ({ id: `observation:${observation.id}`, timestamp: Date.parse(observation.occurredAt), kind: "observation" as const, label: observation.note })),
    ...props.warnings.flatMap((warning) => {
      const timestamp = Date.parse(warning.onsetAt ?? warning.effectiveAt ?? "");
      return Number.isFinite(timestamp) ? [{ id: `weather:${warning.id}`, timestamp, kind: "weather" as const, label: warning.headline }] : [];
    }),
  ].filter((marker) => Number.isFinite(marker.timestamp) && marker.timestamp >= timeMin && marker.timestamp <= timeMax), [props.alerts, props.observations, props.warnings, props.sensors, selectedIds, timeMin, timeMax, t]);
  const yTicks = domain ? Array.from({ length: 4 }, (_, index) => domain.max - (domain.max - domain.min) * index / 3) : [];
  const xTicks = Array.from({ length: 5 }, (_, index) => timeMin + (timeMax - timeMin) * index / 4);
  const focused = focusedTimestamp === null ? [] : series.flatMap((item) => {
    const point = nearest(item.points, focusedTimestamp);
    return point && Math.abs(point.timestamp - focusedTimestamp) <= 45 * 60_000 ? [{ series: item, point }] : [];
  });

  const toggleSensor = (sensorId: string) => {
    setLimitVisible(false);
    if (selectedIds.includes(sensorId)) {
      if (selectedIds.length > 1) setSelectedIds(selectedIds.filter((id) => id !== sensorId));
      return;
    }
    if (selectedIds.length >= MAX_SERIES) {
      setLimitVisible(true);
      return;
    }
    setSelectedIds([...selectedIds, sensorId]);
  };

  let chartContent: ReactNode;
  if (!allPoints.length || !domain) {
    chartContent = <div className="empty-state">{t("common.noData")}</div>;
  } else {
    const focusedLabel = focusedTimestamp === null
      ? null
      : formatInTimeZone(focusedTimestamp, locale, props.timeZone, { dateStyle: "medium", timeStyle: "short" });
    chartContent = (
      <div className="comparison-chart-wrap">
        <svg className="comparison-chart" viewBox={`0 0 ${width} ${height}`} role="img" aria-label={t("decision.compareAria", { metric: measurementLabel(props.definition, locale) })}>
          <g className="chart-grid" aria-hidden="true">{yTicks.map((tick) => <line key={tick} x1={margin.left} x2={width - margin.right} y1={y(tick)} y2={y(tick)} />)}</g>
          <g className="chart-axis" aria-hidden="true">
            {yTicks.map((tick) => <text key={tick} x={margin.left - 9} y={y(tick) + 4} textAnchor="end">{toDisplayValue(tick, props.definition, props.units).toFixed(props.definition.precision)}</text>)}
            {xTicks.map((tick, index) => <text key={tick} x={x(tick)} y={height - 10} textAnchor={tickAnchor(index, xTicks.length)}>{formatInTimeZone(tick, locale, props.timeZone, tickDateOptions(props.range))}</text>)}
            <text x="7" y="15">{displayUnit(props.definition, props.units)}</text>
          </g>
          <g className="comparison-events">{markers.map((marker, index) => <g key={marker.id} className={marker.kind} role="img" aria-label={`${marker.label}, ${formatInTimeZone(marker.timestamp, locale, props.timeZone, { dateStyle: "medium", timeStyle: "short" })}`}><line x1={x(marker.timestamp)} x2={x(marker.timestamp)} y1={margin.top + (index % 3) * 5} y2={height - margin.bottom} /><circle cx={x(marker.timestamp)} cy={margin.top + (index % 3) * 5} r="3" /></g>)}</g>
          <g className="comparison-lines" aria-hidden="true">{series.map((item) => item.points.length > 1 && <path key={item.id} d={pathFor(item.points, x, y)} className={`comparison-line series-${item.outdoor ? "outdoor" : item.colorIndex}`} />)}</g>
          <g className="comparison-points">{series.flatMap((item) => item.points.filter((_, index) => index % Math.max(1, Math.floor(item.points.length / 28)) === 0 || index === item.points.length - 1).map((point) => <circle key={`${item.id}:${point.timestamp}`} cx={x(point.timestamp)} cy={y(point.value)} r="7" className={`series-${item.outdoor ? "outdoor" : item.colorIndex}`} tabIndex={0} role="img" aria-label={`${item.label}, ${formatMeasurement(point.value, props.definition, props.units)}, ${formatInTimeZone(point.timestamp, locale, props.timeZone, { dateStyle: "medium", timeStyle: "short" })}`} onFocus={() => setFocusedTimestamp(point.timestamp)} onBlur={() => setFocusedTimestamp(null)} onMouseEnter={() => setFocusedTimestamp(point.timestamp)} onMouseLeave={() => setFocusedTimestamp(null)} />))}</g>
          {focusedTimestamp !== null && <line className="comparison-focus-line" x1={x(focusedTimestamp)} x2={x(focusedTimestamp)} y1={margin.top} y2={height - margin.bottom} aria-hidden="true" />}
        </svg>
        {focused.length > 0 && focusedLabel && <output className="comparison-tooltip"><time>{focusedLabel}</time>{focused.map(({ series: item, point }) => <span key={item.id}><i aria-hidden="true" className={`series-dot series-${item.outdoor ? "outdoor" : item.colorIndex}`} />{item.label}<strong>{formatMeasurement(point.value, props.definition, props.units)}</strong></span>)}</output>}
        <div className="comparison-event-key" aria-label={t("decision.eventsOnChart")}><span><AlertTriangle size={12} aria-hidden="true" />{t("nav.alerts")}</span><span><Eye size={12} aria-hidden="true" />{t("observations.title")}</span><span><CloudSun size={12} aria-hidden="true" />{t("activity.weather")}</span></div>
      </div>
    );
  }

  return (
    <section className="panel comparison-chart-panel" aria-labelledby="comparison-chart-heading">
      <div className="panel-header comparison-heading">
        <div><span className="eyebrow"><GitCompareArrows size={13} aria-hidden="true" />{t("decision.compareEyebrow")}</span><h2 id="comparison-chart-heading">{t("decision.compareTitle", { metric: measurementLabel(props.definition, locale) })}</h2></div>
        <fieldset className="segmented compact comparison-range"><legend className="sr-only">{t("chart.history")}</legend>{(["6h", "24h", "7d"] as const).map((item) => <button key={item} type="button" aria-pressed={props.range === item} onClick={() => props.onRange(item)}>{t(`chart.range${item}`)}</button>)}</fieldset>
      </div>
      <fieldset className="comparison-picker"><legend className="sr-only">{t("decision.compareRooms")}</legend>
        {props.sensors.map((sensor) => {
          const colorIndex = selectedIds.indexOf(sensor.id);
          return <button key={sensor.id} type="button" className={`series-chip ${colorIndex >= 0 ? `series-${colorIndex}` : "series-idle"}`} aria-pressed={colorIndex >= 0} onClick={() => toggleSensor(sensor.id)}>{sensor.room.trim() || sensor.name}</button>;
        })}
        {outdoorAvailable && <button type="button" className="series-chip series-outdoor" aria-pressed={outdoorVisible} onClick={() => setOutdoorVisible((visible) => !visible)}><CloudSun size={13} aria-hidden="true" />{t("decision.outdoor")}</button>}
      </fieldset>
      {limitVisible && <output className="comparison-limit">{t("decision.compareLimit", { count: MAX_SERIES })}</output>}
      {chartContent}
    </section>
  );
}
