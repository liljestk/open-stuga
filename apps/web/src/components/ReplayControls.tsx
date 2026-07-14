import { Pause, Play, Radio, RotateCcw } from "lucide-react";
import { useI18n } from "../i18n";

interface ReplayControlsProps {
  active: boolean;
  playing: boolean;
  timestamp: number;
  min: number;
  max: number;
  speed: number;
  timeZone: string;
  onActive: (active: boolean) => void;
  onPlaying: (playing: boolean) => void;
  onTimestamp: (timestamp: number) => void;
  onSpeed: (speed: number) => void;
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

export function ReplayControls({ active, playing, timestamp, min, max, speed, timeZone, onActive, onPlaying, onTimestamp, onSpeed }: ReplayControlsProps) {
  const { locale, t } = useI18n();
  const resolvedTimeZone = validTimeZone(timeZone);
  const rangeCrossesDay = calendarDay(min, resolvedTimeZone) !== calendarDay(max, resolvedTimeZone);
  const activeTime = dateFormatter(locale, resolvedTimeZone, rangeCrossesDay
    ? { dateStyle: "medium", timeStyle: "short" }
    : { weekday: "short", hour: "2-digit", minute: "2-digit" }).format(timestamp);
  const timelineFormatter = dateFormatter(locale, resolvedTimeZone, rangeCrossesDay
    ? { dateStyle: "medium", timeStyle: "short" }
    : { hour: "2-digit", minute: "2-digit" });
  const speedLabel = (value: number) => t(value === 1 ? "replay.minutePerSecond" : "replay.minutesPerSecond", { count: value });
  const togglePlayback = () => {
    if (playing) {
      onPlaying(false);
      return;
    }
    onActive(true);
    if (!active || timestamp >= max) onTimestamp(min);
    onPlaying(true);
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
      <label className="timeline-field">
        <span className="sr-only">{t("replay.timeline")}</span>
        <input type="range" min={min} max={max} step={1000} value={timestamp} onChange={(event) => { onActive(true); onTimestamp(Number(event.target.value)); }} />
        <span className="timeline-labels"><time dateTime={new Date(min).toISOString()}>{timelineFormatter.format(min)}</time><time dateTime={new Date(max).toISOString()}>{timelineFormatter.format(max)}</time></span>
      </label>
      <label className="speed-field"><span>{t("replay.speed")}</span><select value={speed} onChange={(event) => onSpeed(Number(event.target.value))}>{[1, 4, 12, 48].map((value) => <option key={value} value={value}>{speedLabel(value)}</option>)}</select></label>
      {active && <button type="button" className="secondary-button" onClick={() => { onActive(false); onPlaying(false); onTimestamp(max); }}><Radio size={15} aria-hidden="true" />{t("replay.live")}</button>}
    </section>
  );
}
