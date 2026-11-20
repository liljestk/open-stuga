import { isOneOf, type AnalyticsResolution } from "@climate-twin/contracts";
import { useI18n } from "../../i18n";
import { ANALYTICS_RESOLUTIONS } from "./explorerState";

export function AnalyticsResolutionControl(props: { resolution: AnalyticsResolution; onChange: (resolution: AnalyticsResolution) => void }) {
  const { t, locale } = useI18n();
  const choices = [...new Set<AnalyticsResolution>([...ANALYTICS_RESOLUTIONS, props.resolution])];
  const label = (value: AnalyticsResolution) => isOneOf(value, ANALYTICS_RESOLUTIONS)
    ? t(`analytics.resolution_${value}`)
    : new Intl.NumberFormat(locale, { style: "unit", unit: "minute", unitDisplay: "long" }).format(Number(value.slice(0, -1)));
  return <label className="field"><span>{t("analytics.resolution")}</span><select value={props.resolution} onChange={(event) => {
    const value = choices.find((choice) => choice === event.target.value);
    if (value) props.onChange(value);
  }}>{choices.map((choice) => <option key={choice} value={choice}>{label(choice)}</option>)}</select></label>;
}
