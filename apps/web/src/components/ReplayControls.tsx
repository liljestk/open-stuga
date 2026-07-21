import { Activity, ArrowDown, ArrowUp, ChevronLeft, ChevronRight, Pause, Play, Radio, RotateCcw, SkipBack, SkipForward } from "lucide-react";
import { useEffect, useId, useState, type CSSProperties, type FormEvent } from "react";
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
  windowFrom?: string;
  windowTo?: string;
  resolutionSeconds?: number | null;
  loading?: boolean;
  partial?: boolean;
  sampleCount?: number;
  loadError?: string | null;
  onActive: (active: boolean) => void;
  onPlaying: (playing: boolean) => void;
  onTimestamp: (timestamp: number) => void;
  onSpeed: (speed: number) => void;
  onEventSelect?: (event: ReplayClimateEvent) => void;
  onWindowFrom?: (value: string) => void;
  onWindowTo?: (value: string) => void;
  onResolution?: (seconds: number | null) => void;
  onLoadWindow?: () => void;
}

const RESOLUTION_PRESETS = [
  { value: "raw", label: "Raw", seconds: null },
  { value: "60", label: "1m", seconds: 60 },
  { value: "300", label: "5m", seconds: 300 },
  { value: "900", label: "15m", seconds: 900 },
  { value: "3600", label: "1h", seconds: 3_600 },
  { value: "86400", label: "1d", seconds: 86_400 },
] as const;

function validResolution(value: number | null | undefined): number | null {
  if (value === null || value === undefined) return null;
  if (!Number.isFinite(value)) return null;
  const seconds = Math.trunc(value);
  return seconds >= 1 && seconds <= 86_400 ? seconds : null;
}

function resolutionModeFor(value: number | null | undefined): string {
  const seconds = validResolution(value);
  if (seconds === null) return "raw";
  return RESOLUTION_PRESETS.some((preset) => preset.seconds === seconds) ? String(seconds) : "custom";
}

function replayEventMetadata(event: ReplayClimateEvent): { significance: string | null; autoTags: string[] } {
  const candidate = event as unknown as { significance?: unknown; autoTags?: unknown };
  const significance = typeof candidate.significance === "string" && candidate.significance.trim()
    ? candidate.significance.trim()
    : typeof candidate.significance === "number" && Number.isFinite(candidate.significance)
      ? String(candidate.significance)
      : null;
  const autoTags = Array.isArray(candidate.autoTags)
    ? [...new Set(candidate.autoTags.flatMap((tag) => typeof tag === "string" && tag.trim() ? [tag.trim()] : []))]
    : [];
  return { significance, autoTags };
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
  windowFrom,
  windowTo,
  resolutionSeconds,
  loading = false,
  partial = false,
  sampleCount,
  loadError = null,
  onActive,
  onPlaying,
  onTimestamp,
  onSpeed,
  onEventSelect,
  onWindowFrom,
  onWindowTo,
  onResolution,
  onLoadWindow,
}: ReplayControlsProps) {
  const { locale, t } = useI18n();
  const replayTitleId = useId();
  const timelineId = useId();
  const resolutionId = useId();
  const [resolutionMode, setResolutionMode] = useState(() => resolutionModeFor(resolutionSeconds));
  const [customResolution, setCustomResolution] = useState(() => {
    const initial = validResolution(resolutionSeconds);
    return String(initial !== null && resolutionModeFor(initial) === "custom" ? initial : 30);
  });
  useEffect(() => {
    const mode = resolutionModeFor(resolutionSeconds);
    setResolutionMode(mode);
    const seconds = validResolution(resolutionSeconds);
    if (mode === "custom" && seconds !== null) setCustomResolution(String(seconds));
  }, [resolutionSeconds]);
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
  const previousEvent = visibleEvents.filter((event) => event.timestamp < timestamp - 1_000).at(-1);
  const nextEvent = visibleEvents.find((event) => event.timestamp > timestamp + 1_000);
  const configuredFrameSeconds = validResolution(resolutionSeconds);
  const frameStepMs = (configuredFrameSeconds ?? 1) * 1_000;
  const historyWindowEnabled = Boolean(onWindowFrom || onWindowTo || onResolution || onLoadWindow);
  const customResolutionNumber = Number(customResolution);
  const customResolutionValid = Number.isInteger(customResolutionNumber)
    && customResolutionNumber >= 1
    && customResolutionNumber <= 86_400;
  const canLoadWindow = Boolean(onLoadWindow && windowFrom && windowTo
    && (resolutionMode !== "custom" || customResolutionValid));
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
  const seekFrame = (direction: -1 | 1) => {
    onPlaying(false);
    onActive(true);
    onTimestamp(Math.max(min, Math.min(max, timestamp + direction * frameStepMs)));
  };
  const changeResolution = (value: string) => {
    setResolutionMode(value);
    if (value === "custom") {
      if (customResolutionValid) onResolution?.(customResolutionNumber);
      return;
    }
    const preset = RESOLUTION_PRESETS.find((candidate) => candidate.value === value);
    if (preset) onResolution?.(preset.seconds);
  };
  const changeCustomResolution = (value: string) => {
    setCustomResolution(value);
    const seconds = Number(value);
    if (Number.isInteger(seconds) && seconds >= 1 && seconds <= 86_400) onResolution?.(seconds);
  };
  const loadWindow = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!loading && canLoadWindow) onLoadWindow?.();
  };
  const recordingStatus = loading
    ? t("replay.loadingRecording")
    : sampleCount !== undefined
      ? t(sampleCount === 1 ? "replay.sampleLoaded" : "replay.samplesLoaded", {
        count: new Intl.NumberFormat(locale).format(sampleCount),
      })
      : null;
  return (
    <section className={`replay-bar ${active ? "active" : ""}`} aria-labelledby={replayTitleId}>
      <div className="replay-transport">
        <div className="replay-title">
          <span className="replay-icon" aria-hidden="true"><RotateCcw size={17} /></span>
          <div><h3 id={replayTitleId}>{t("replay.title")}</h3><small>{active ? t("replay.active", { time: activeTime }) : t("replay.description")}</small></div>
        </div>
        <div className="replay-playback-controls" role="group" aria-label={t("replay.navigation")}>
          <button type="button" className="round-action replay-play-toggle" onClick={togglePlayback} aria-label={playing ? t("replay.pause") : t("replay.play")}>
            {playing ? <Pause size={17} fill="currentColor" /> : <Play size={17} fill="currentColor" />}
          </button>
          <span className="replay-frame-controls">
            <button type="button" className="replay-seek-button" aria-label={t("replay.previousFrame")} title={t("replay.previousFrame")} disabled={timestamp <= min} onClick={() => seekFrame(-1)}><ChevronLeft size={17} aria-hidden="true" /></button>
            <button type="button" className="replay-seek-button" aria-label={t("replay.nextFrame")} title={t("replay.nextFrame")} disabled={timestamp >= max} onClick={() => seekFrame(1)}><ChevronRight size={17} aria-hidden="true" /></button>
          </span>
        </div>
        <div className="timeline-field">
          <label className="sr-only" htmlFor={timelineId}>{t("replay.timeline")}</label>
          <div className="replay-track">
            <input id={timelineId} type="range" min={min} max={max} step={frameStepMs} value={timestamp} aria-valuetext={activeTime} onChange={(event) => { onActive(true); onTimestamp(Number(event.target.value)); }} />
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
        </div>
        <div className="replay-transport-options">
          <label className="speed-field"><span>{t("replay.speed")}</span><select value={speed} onChange={(event) => onSpeed(Number(event.target.value))}>{[1, 4, 12, 48].map((value) => <option key={value} value={value}>{speedLabel(value)}</option>)}</select></label>
          {active && <button type="button" className="secondary-button replay-live-button" onClick={() => { onActive(false); onPlaying(false); onTimestamp(max); }}><Radio size={15} aria-hidden="true" />{t("replay.live")}</button>}
        </div>
      </div>
      <div className={`replay-events-section ${visibleEvents.length === 0 ? "empty" : ""}`}>
        <div className="replay-events-toolbar">
          <span className="replay-events-label"><Activity size={15} aria-hidden="true" />{t("replay.majorChanges")}</span>
          {visibleEvents.length > 0 && <span className="replay-detected-event-controls">
            <button type="button" className="replay-seek-button" aria-label={t("replay.previousEvent")} title={t("replay.previousEvent")} disabled={!previousEvent} onClick={() => previousEvent && selectEvent(previousEvent)}><SkipBack size={16} aria-hidden="true" /></button>
            <button type="button" className="replay-seek-button" aria-label={t("replay.nextEvent")} title={t("replay.nextEvent")} disabled={!nextEvent} onClick={() => nextEvent && selectEvent(nextEvent)}><SkipForward size={16} aria-hidden="true" /></button>
          </span>}
        </div>
        {visibleEvents.length > 0 ? <div className="replay-event-list" role="group" aria-label={t("replay.majorChanges")}>
          {visibleEvents.map((event) => {
            const description = describeEvent(event);
            const eventTime = eventTimeFormatter.format(event.timestamp);
            const metadata = replayEventMetadata(event);
            const seekLabel = t("replay.seekEvent", { event: description, time: eventTime });
            const metadataLabel = [
              ...(metadata.significance ? [t("replay.significance", { value: metadata.significance })] : []),
              ...metadata.autoTags.map((tag) => t("replay.autoTag", { value: tag })),
            ].join(". ");
            return <button
              key={event.id}
              type="button"
              className="replay-event-button"
              aria-current={selectedEventId === event.id ? "time" : undefined}
              aria-label={metadataLabel ? `${seekLabel}. ${metadataLabel}` : seekLabel}
              data-replay-event-id={event.id}
              onClick={() => selectEvent(event)}
            >
              {event.direction === "drop" ? <ArrowDown size={14} aria-hidden="true" /> : <ArrowUp size={14} aria-hidden="true" />}
              <span><strong>{description}</strong><time dateTime={new Date(event.timestamp).toISOString()}>{eventTime}</time>
                {(metadata.significance || metadata.autoTags.length > 0) && <span className="replay-event-metadata" aria-hidden="true">
                  {metadata.significance && <span className="replay-event-significance">{metadata.significance}</span>}
                  {metadata.autoTags.map((tag) => <span key={tag} className="replay-event-auto-tag">#{tag}</span>)}
                </span>}
              </span>
            </button>;
          })}
        </div> : <p className="replay-events-empty">{t("replay.noEvents")}</p>}
      </div>
      {historyWindowEnabled && <form className="replay-window-form" aria-label={t("replay.historyWindow")} aria-busy={loading} onSubmit={loadWindow}>
        <div className="replay-window-heading"><Activity size={16} aria-hidden="true" /><span><strong>{t("replay.historyWindow")}</strong><small>{t("replay.localTime", { timeZone })}</small></span></div>
        <label className="replay-window-field"><span>{t("replay.from")}</span><input type="datetime-local" step="1" required value={windowFrom ?? ""} max={windowTo || undefined} disabled={loading || !onWindowFrom} onChange={(event) => onWindowFrom?.(event.target.value)} /></label>
        <label className="replay-window-field"><span>{t("replay.to")}</span><input type="datetime-local" step="1" required value={windowTo ?? ""} min={windowFrom || undefined} disabled={loading || !onWindowTo} onChange={(event) => onWindowTo?.(event.target.value)} /></label>
        <div className="replay-window-resolution">
          <label htmlFor={resolutionId}>{t("replay.resolution")}</label>
          <div><select id={resolutionId} value={resolutionMode} disabled={loading || !onResolution} onChange={(event) => changeResolution(event.target.value)}>
            {RESOLUTION_PRESETS.map((preset) => <option key={preset.value} value={preset.value}>{preset.value === "raw" ? t("replay.rawResolution") : preset.label}</option>)}
            <option value="custom">{t("replay.customResolution")}</option>
          </select>
          {resolutionMode === "custom" && <label className="replay-custom-resolution"><span className="sr-only">{t("replay.customSeconds")}</span><input type="number" min="1" max="86400" step="1" required aria-label={t("replay.customSeconds")} aria-invalid={!customResolutionValid} value={customResolution} disabled={loading || !onResolution} onChange={(event) => changeCustomResolution(event.target.value)} /><span>s</span></label>}</div>
        </div>
        <button type="submit" className={`${active ? "secondary-button" : "primary-button"} replay-window-load`} disabled={loading || !canLoadWindow}>{loading ? t("replay.loadingRecording") : t("replay.loadRecording")}</button>
        {(recordingStatus || partial || loadError) && <div className="replay-window-status" aria-live="polite">
          {recordingStatus && <p role="status">{recordingStatus}</p>}
          {partial && <p className="replay-window-partial" role="status">{t("replay.partialRecording")}</p>}
          {loadError && <p className="inline-error" role="alert">{loadError}</p>}
        </div>}
      </form>}
    </section>
  );
}
