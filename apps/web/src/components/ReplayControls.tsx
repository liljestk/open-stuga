import { Pause, Play, Radio, RotateCcw } from "lucide-react";
import { useI18n } from "../i18n";

interface ReplayControlsProps {
  active: boolean;
  playing: boolean;
  timestamp: number;
  min: number;
  max: number;
  speed: number;
  onActive: (active: boolean) => void;
  onPlaying: (playing: boolean) => void;
  onTimestamp: (timestamp: number) => void;
  onSpeed: (speed: number) => void;
}

export function ReplayControls({ active, playing, timestamp, min, max, speed, onActive, onPlaying, onTimestamp, onSpeed }: ReplayControlsProps) {
  const { locale, t } = useI18n();
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
        <span><strong id="replay-title">{t("replay.title")}</strong><small>{active ? t("replay.active", { time: new Intl.DateTimeFormat(locale, { weekday: "short", hour: "2-digit", minute: "2-digit" }).format(timestamp) }) : t("replay.description")}</small></span>
      </div>
      <button type="button" className="round-action" onClick={togglePlayback} aria-label={playing ? t("replay.pause") : t("replay.play")}>
        {playing ? <Pause size={17} fill="currentColor" /> : <Play size={17} fill="currentColor" />}
      </button>
      <label className="timeline-field">
        <span className="sr-only">{t("replay.timeline")}</span>
        <input type="range" min={min} max={max} step={1000} value={timestamp} onChange={(event) => { onActive(true); onTimestamp(Number(event.target.value)); }} />
        <span className="timeline-labels"><time>{new Intl.DateTimeFormat(locale, { hour: "2-digit", minute: "2-digit" }).format(min)}</time><time>{new Intl.DateTimeFormat(locale, { hour: "2-digit", minute: "2-digit" }).format(max)}</time></span>
      </label>
      <label className="speed-field"><span>{t("replay.speed")}</span><select value={speed} onChange={(event) => onSpeed(Number(event.target.value))}><option value="1">1 min/s</option><option value="4">4 min/s</option><option value="12">12 min/s</option><option value="48">48 min/s</option></select></label>
      {active && <button type="button" className="secondary-button" onClick={() => { onActive(false); onPlaying(false); onTimestamp(max); }}><Radio size={15} aria-hidden="true" />{t("replay.live")}</button>}
    </section>
  );
}
