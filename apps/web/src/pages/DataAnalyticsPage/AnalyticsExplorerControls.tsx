import { useI18n } from "../../i18n";
import { formatInTimeZone } from "../../dateTime";
import type { DataMode, AnalyticsViewDefinition } from "@climate-twin/contracts";
import { AnalyticsRangeControls } from "./AnalyticsRangeControls";
import { SavedAnalyticsViews } from "./SavedAnalyticsViews";
import { analyticsViewDefinition } from "./explorerViews";
import type { AnalyticsLocationState } from "./explorerState";

export function AnalyticsExplorerControls(props: {
  houseId: string; dataMode: DataMode; enabled: boolean; readOnly: boolean;
  state: AnalyticsLocationState; from: number; to: number; brush: boolean;
  selection: { start: string; end: string } | null;
  onApplyView: (definition: AnalyticsViewDefinition) => boolean;
  onBrush: (enabled: boolean) => void; onApplyWindow: (window: { start: string; end: string }) => void; onReset: () => void;
}) {
  const { t, locale } = useI18n();
  if (!props.enabled) return null;
  const absolute = props.state.absoluteRange;
  return <div className="analytics-explorer-controls">
    {absolute && <p role="status">{t("analyticsViews.selectedInterval", { start: formatInTimeZone(absolute.start, locale, "UTC", { dateStyle: "medium", timeStyle: "short" }), end: formatInTimeZone(absolute.end, locale, "UTC", { dateStyle: "medium", timeStyle: "short" }) })}</p>}
    <SavedAnalyticsViews houseId={props.houseId} dataMode={props.dataMode} readOnly={props.readOnly}
      definition={analyticsViewDefinition(props.state)} onApply={props.onApplyView} />
    <AnalyticsRangeControls window={{ start: new Date(props.from).toISOString(), end: new Date(props.to).toISOString() }}
      identity={absolute ? `${absolute.start}:${absolute.end}` : props.state.range} absolute={Boolean(absolute)} brush={props.brush} selection={props.selection}
      onBrush={props.onBrush} onApply={props.onApplyWindow} onReset={props.onReset} />
  </div>;
}
