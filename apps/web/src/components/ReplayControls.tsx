import { Activity, ArrowDown, ArrowUp, Pause, Play, Radio, RotateCcw } from "lucide-react";
import { useId, type CSSProperties } from "react";
import type { MeasurementDefinition, Sensor, UnitSystem } from "@climate-twin/contracts";
import { useI18n } from "../i18n";
import { definitionFor, formatMeasurementDelta, measurementLabel } from "../measurements";
import type { ReplayClimateEvent } from "../replayEvents";

interface ReplayControlsProps {
  active: boolean;
  playing: boolean;
  timestamp: number;
  min: number;
  max: number;
  speed: number;
  timeZone: string;
  events?: ReplayClimateEvent[];
  sensors?: Sensor[];
  definitions?: MeasurementDefinition[];
  units?: UnitSystem;
  onActive: (active: boolean) => void;
  onPlaying: (playing: boolean) => void;
  onTimestamp: (timestamp: number) => void;
  onSpeed: (speed: number) => void;
  onEventSelect?: (event: ReplayClimateEvent) => void;
}

function validTimeZone(timeZone: string): string | undefined {
  try {
    return new Intl.DateTimeFormat("en", { timeZone }).resolvedOptions().timeZone;
  } catch {
    return undefined;
  }
}

function dateFormatter(locale: string, timeZone: string | undefined, options: Intl.DateTimeFormatOptions) {
  return new Intl.DateTimeFormat(locale, timeZone ? { ...options, timeZone } : options);
}

function calendarDay(timestamp: number, timeZone: string | undefined): string {
  const parts = dateFormatter("en", timeZone, { year: "numeric", month: "2-digit", day: "2-digit" }).formatToParts(timestamp);
  return ["year", "month", "day"].map((type) => parts.find((part) => part.type === type)?.value ?? "").join("-");
}

export function ReplayControls({
  active,
  playing,
  timestamp,
  min,
  max,
  speed,
  timeZone,
  events = [],
  sensors = [],
  definitions = [],
  units = "metric",
  onActive,
  onPlaying,
  onTimestamp,
  onSpeed,
  onEventSelect,
}: ReplayControlsProps) {
  const { locale, t } = useI18n();
  const timelineId = useId();
  const resolvedTimeZone = validTimeZone(timeZone);
  const rangeCrossesDay = calendarDay(min, resolvedTimeZone) !== calendarDay(max, resolvedTimeZone);
  const activeTime = dateFormatter(locale, resolvedTimeZone, rangeCrossesDay
    ? { dateStyle: "medium", timeStyle: "short" }
    : { weekday: "short", hour: "2-digit", minute: "2-digit" }).format(timestamp);
  const timelineFormatter = dateFormatter(locale, resolvedTimeZone, rangeCrossesDay
    ? { dateStyle: "medium", timeStyle: "short" }
    : { hour: "2-digit", minute: "2-digit" });
  const eventTimeFormatter = dateFormatter(locale, resolvedTimeZone, rangeCrossesDay
    ? { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" }
    : { hour: "2-digit", minute: "2-digit" });
  const visibleEvents = events
    .filter((event) => Number.isFinite(event.timestamp) && event.timestamp >= min && event.timestamp <= max)
    .sort((left, right) => left.timestamp - right.timestamp);
  const selectedEventId = visibleEvents.find((event) => Math.abs(event.timestamp - timestamp) <= 1_000)?.id ?? null;
  const speedLabel = (value: number) => t(value === 1 ? "replay.minutePerSecond" : "replay.minutesPerSecond", { count: value });
  const describeEvent = (event: ReplayClimateEvent) => {
    const definition = definitionFor(definitions, event.metric);
    const metric = measurementLabel(definition, locale);
    const room = sensors.find((sensor) => sensor.id === event.sensorId)?.room.trim()
      || sensors.find((sensor) => sensor.id === event.sensorId)?.name
      || t("replay.unknownRoom");
    const absoluteDelta = Math.abs(event.delta);
    const delta = event.metric === "humidity"
      ? t(absoluteDelta === 1 ? "replay.humidityPoint" : "replay.humidityPoints", {
        count: absoluteDelta.toFixed(definition.precision),
      })
      : formatMeasurementDelta(absoluteDelta, definition, units);
    return t(event.direction === "drop" ? "replay.changeDrop" : "replay.changeRise", { metric, delta, room });
  };
  const togglePlayback = () => {
    if (playing) {
      onPlaying(false);
      return;
    }
    onActive(true);
    if (!active || timestamp >= max) onTimestamp(min);
    onPlaying(true);
  };
  const selectEvent = (event: ReplayClimateEvent) => {
    onPlaying(false);
    onActive(true);
    onTimestamp(event.timestamp);
    onEventSelect?.(event);
    window.setTimeout(() => {
      const matchingButton = Array.from(document.querySelectorAll<HTMLButtonElement>("[data-replay-event-id]"))
        .find((button) => button.dataset.replayEventId === event.id);
      matchingButton?.focus();
    }, 0);
  };
  return (
    <section className={`replay-bar ${active ? "active" : ""}`} aria-labelledby="replay-title">
      <div className="replay-title">
        <span className="replay-icon" aria-hidden="true"><RotateCcw size={17} /></span>
        <span><strong id="replay-title">{t("replay.title")}</strong><small>{active ? t("replay.active", { time: activeTime }) : t("replay.description")}</small></span>
      </div>
      <button type="button" className="round-action" onClick={togglePlayback} aria-label={playing ? t("replay.pause") : t("replay.play")}>
        {playing ? <Pause size={17} fill="currentColor" /> : <Play size={17} fill="currentColor" />}
      </button>
      <div className="timeline-field">
        <label className="sr-only" htmlFor={timelineId}>{t("replay.timeline")}</label>
        <div className="replay-track">
          <input id={timelineId} type="range" min={min} max={max} step={1000} value={timestamp} aria-valuetext={activeTime} onChange={(event) => { onActive(true); onTimestamp(Number(event.target.value)); }} />
          {visibleEvents.length > 0 && <span className="replay-event-ticks" aria-hidden="true">
            {visibleEvents.map((event) => {
              const position = (event.timestamp - min) / Math.max(max - min, 1) * 100;
              return <i
                key={event.id}
                className={selectedEventId === event.id ? "selected" : ""}
                data-direction={event.direction}
                style={{ "--replay-event-position": `${Math.max(0, Math.min(100, position))}%` } as CSSProperties}
              />;
            })}
          </span>}
        </div>
        <span className="timeline-labels"><time dateTime={new Date(min).toISOString()}>{timelineFormatter.format(min)}</time><time dateTime={new Date(max).toISOString()}>{timelineFormatter.format(max)}</time></span>
        {visibleEvents.length > 0 && <div className="replay-events" role="group" aria-label={t("replay.majorChanges")}>
          <span className="replay-events-label"><Activity size={13} aria-hidden="true" />{t("replay.majorChanges")}</span>
          <div className="replay-event-list">
            {visibleEvents.map((event) => {
              const description = describeEvent(event);
              const eventTime = eventTimeFormatter.format(event.timestamp);
              return <button
                key={event.id}
                type="button"
                className="replay-event-button"
                aria-current={selectedEventId === event.id ? "time" : undefined}
                aria-label={t("replay.seekEvent", { event: description, time: eventTime })}
                data-replay-event-id={event.id}
                onClick={() => selectEvent(event)}
              >
                {event.direction === "drop" ? <ArrowDown size={14} aria-hidden="true" /> : <ArrowUp size={14} aria-hidden="true" />}
                <span><strong>{description}</strong><time dateTime={new Date(event.timestamp).toISOString()}>{eventTime}</time></span>
              </button>;
            })}
          </div>
        </div>}
      </div>
      <label className="speed-field"><span>{t("replay.speed")}</span><select value={speed} onChange={(event) => onSpeed(Number(event.target.value))}>{[1, 4, 12, 48].map((value) => <option key={value} value={value}>{speedLabel(value)}</option>)}</select></label>
      {active && <button type="button" className="secondary-button" onClick={() => { onActive(false); onPlaying(false); onTimestamp(max); }}><Radio size={15} aria-hidden="true" />{t("replay.live")}</button>}
    </section>
  );
}
