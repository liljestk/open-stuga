import { useEffect, useState } from "react";
import { isAnalyticsViewRange } from "@climate-twin/contracts";
import { useI18n } from "../../i18n";

interface Window { start: string; end: string }
export function AnalyticsRangeControls(props: {
  window: Window;
  identity: string;
  absolute: boolean;
  brush: boolean;
  selection: Window | null;
  onBrush: (enabled: boolean) => void;
  onApply: (window: Window) => void;
  onReset: () => void;
}) {
  const { t } = useI18n();
  const [start, setStart] = useState(props.window.start.slice(0, 16));
  const [end, setEnd] = useState(props.window.end.slice(0, 16));
  const [open, setOpen] = useState(false);
  const [error, setError] = useState(false);
  const restore = () => { setStart(props.window.start.slice(0, 16)); setEnd(props.window.end.slice(0, 16)); setError(false); props.onBrush(false); };
  useEffect(restore, [props.identity]);
  useEffect(() => { if (props.brush) setOpen(true); }, [props.brush]);
  useEffect(() => {
    if (!props.selection) return;
    setOpen(true); setStart(props.selection.start.slice(0, 16)); setEnd(props.selection.end.slice(0, 16)); setError(false);
  }, [props.selection]);
  return <details className="analytics-view-controls" open={open} onToggle={(event) => setOpen(event.currentTarget.open)}>
    <summary>{t("analyticsViews.interval")}</summary>
    <form onSubmit={(event) => {
      event.preventDefault();
      const range = { kind: "absolute", start: `${start}:00.000Z`, end: `${end}:00.000Z` };
      if (!isAnalyticsViewRange(range) || range.kind !== "absolute" || Date.parse(range.end) > Date.now()) { setError(true); return; }
      props.onApply(range); props.onBrush(false); setError(false);
    }}>
      <p>{t("analyticsViews.utcHint")}</p>
      <div className="analytics-view-fields">
        <label className="field"><span>{t("analyticsViews.start")}</span><input type="datetime-local" value={start} onInput={(event) => setStart(event.currentTarget.value)} onChange={(event) => setStart(event.target.value)} required /></label>
        <label className="field"><span>{t("analyticsViews.end")}</span><input type="datetime-local" value={end} onInput={(event) => setEnd(event.currentTarget.value)} onChange={(event) => setEnd(event.target.value)} required /></label>
      </div>
      <label className="analytics-brush-toggle"><input type="checkbox" checked={props.brush} onChange={(event) => props.onBrush(event.target.checked)} />{t("analyticsViews.brush")}</label>
      {error && <p className="inline-error" role="alert">{t("analyticsViews.invalidRange")}</p>}
      <div className="analytics-view-actions">
        <button type="submit" className="primary-button">{t("analyticsViews.applyRange")}</button>
        <button type="button" className="secondary-button" onClick={restore}>{t("common.cancel")}</button>
        {props.absolute && <button type="button" className="secondary-button" onClick={props.onReset}>{t("analyticsViews.rolling")}</button>}
      </div>
    </form>
  </details>;
}
