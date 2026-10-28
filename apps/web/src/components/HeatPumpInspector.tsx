import type { ReactNode } from "react";
import {
  ChevronDown,
  Droplets,
  Fan,
  Gauge,
  Home,
  Settings2,
  Snowflake,
  Target,
  Thermometer,
} from "lucide-react";
import type {
  HeatPumpMode,
  HeatPumpState,
  House,
  MeasurementDefinition,
  UnitSystem,
} from "@climate-twin/contracts";
import { formatInTimeZone } from "../dateTime";
import { estimateHeatPumpInfluence } from "../heatPumpImpact";
import {
  formatHeatPumpHumidity,
  formatHeatPumpTemperature,
  heatPumpName,
  humanizeHeatPumpValue,
  isHeatPumpStateFresh,
} from "../heatPumpPresentation";
import { formatMeasurement, measurementLabel } from "../measurements";
import { DEFAULT_SPATIAL_MAX_SAMPLE_AGE_MS } from "../spatialFreshness";
import { useI18n, type TranslationKey } from "../i18n";

const modeKeys = {
  auto: "heatPump.mode.auto",
  cool: "heatPump.mode.cool",
  dry: "heatPump.mode.dry",
  fan: "heatPump.mode.fan",
  heat: "heatPump.mode.heat",
} as const satisfies Record<HeatPumpMode, TranslationKey>;

const diagnosticLabelKeys = {
  environmentTemperatureRaw: "heatPump.diagnostic.environmentTemperature",
  indoorCoilTemperatureRaw: "heatPump.diagnostic.indoorCoilTemperature",
  outdoorTemperatureRaw: "heatPump.diagnostic.outdoorTemperature",
  compressorTemperatureRaw: "heatPump.diagnostic.compressorTemperature",
  waterSensorRaw: "heatPump.diagnostic.waterSensor",
  totalEnergyRaw: "heatPump.diagnostic.totalEnergy",
  energyConsumptionRaw: "heatPump.diagnostic.energyConsumption",
  sleepModeRaw: "heatPump.diagnostic.sleepMode",
  temperatureUnitRaw: "heatPump.diagnostic.temperatureUnit",
  temperatureRecordRaw: "heatPump.diagnostic.temperatureRecord",
  heatCoolTypeRaw: "heatPump.diagnostic.heatCoolType",
  faultCode: "heatPump.diagnostic.faultCode",
  allErrors: "heatPump.diagnostic.allErrors",
  shutdownFaults: "heatPump.diagnostic.shutdownFaults",
  subhealthFaults: "heatPump.diagnostic.subhealthFaults",
  wifiStatus: "heatPump.diagnostic.wifiStatus",
} as const satisfies Record<string, TranslationKey>;

const diagnosticMetricFields = {
  heat_pump_environment_temperature_raw: "environmentTemperatureRaw",
  heat_pump_indoor_coil_temperature_raw: "indoorCoilTemperatureRaw",
  heat_pump_outdoor_temperature_raw: "outdoorTemperatureRaw",
  heat_pump_compressor_temperature_raw: "compressorTemperatureRaw",
  heat_pump_water_sensor_raw: "waterSensorRaw",
  heat_pump_total_energy_raw: "totalEnergyRaw",
  heat_pump_energy_consumption_raw: "energyConsumptionRaw",
  heat_pump_sleep_mode_raw: "sleepModeRaw",
  heat_pump_temperature_unit_raw: "temperatureUnitRaw",
  heat_pump_temperature_record_raw: "temperatureRecordRaw",
  heat_pump_heat_cool_type_raw: "heatCoolTypeRaw",
  heat_pump_fault_code: "faultCode",
  heat_pump_all_errors: "allErrors",
  heat_pump_shutdown_faults: "shutdownFaults",
  heat_pump_subhealth_faults: "subhealthFaults",
  heat_pump_wifi_status: "wifiStatus",
} as const satisfies Record<string, keyof HeatPumpState["diagnostics"]>;

interface PrimaryDatum {
  id: string;
  label: string;
  value: string;
  icon: ReactNode;
}

export function HeatPumpInspector({
  state,
  house,
  selectedDefinition,
  units,
  editing = false,
  referenceTimeMs = Date.now(),
  maxSampleAgeMs = DEFAULT_SPATIAL_MAX_SAMPLE_AGE_MS,
}: {
  state: HeatPumpState;
  house: House;
  selectedDefinition: MeasurementDefinition;
  units: UnitSystem;
  editing?: boolean;
  referenceTimeMs?: number;
  maxSampleAgeMs?: number;
}) {
  const { locale, t } = useI18n();
  const noData = t("common.noData");
  const floor = house.floors.find((candidate) => candidate.id === state.floorId) ?? null;
  const room = floor?.rooms.find((candidate) => candidate.id === state.roomId) ?? null;
  const fresh = isHeatPumpStateFresh(state, referenceTimeMs, maxSampleAgeMs);
  const availabilityLabel = !state.available
    ? t("heatPump.unavailable")
    : !fresh
      ? t("building.statusStale")
      : t("heatPump.reported");
  const statusLabel = !state.available
    ? t("heatPump.unavailable")
    : !fresh
      ? t("building.statusStale")
      : state.power === false
        ? t("heatPump.off")
        : state.power === true
          ? t("heatPump.on")
          : noData;
  const mode = state.selectedMode ? t(modeKeys[state.selectedMode]) : noData;
  const lastUpdate = Number.isFinite(Date.parse(state.observedAt))
    ? formatInTimeZone(state.observedAt, locale, house.timezone, { hour: "2-digit", minute: "2-digit", second: "2-digit" })
    : null;
  const detailedUpdate = Number.isFinite(Date.parse(state.observedAt))
    ? formatInTimeZone(state.observedAt, locale, house.timezone, { dateStyle: "short", timeStyle: "short" })
    : noData;
  const primary: PrimaryDatum[] = [
    {
      id: "temperature",
      label: t("setup.greeIndoor"),
      value: formatHeatPumpTemperature(state.currentTemperatureC, units, locale, noData),
      icon: <Thermometer size={16} aria-hidden="true" />,
    },
    {
      id: "heat_pump_target_temperature",
      label: t("setup.greeTarget"),
      value: formatHeatPumpTemperature(state.targetTemperatureC, units, locale, noData),
      icon: <Target size={16} aria-hidden="true" />,
    },
    ...(state.currentHumidityPercent !== null || state.targetHumidityPercent !== null
      || selectedDefinition.id === "humidity" || selectedDefinition.id === "heat_pump_target_humidity"
      ? [{
          id: "humidity",
          label: t("heatPump.indoorHumidity"),
          value: formatHeatPumpHumidity(state.currentHumidityPercent, locale, noData),
          icon: <Droplets size={16} aria-hidden="true" />,
        }, {
          id: "heat_pump_target_humidity",
          label: t("heatPump.targetHumidity"),
          value: formatHeatPumpHumidity(state.targetHumidityPercent, locale, noData),
          icon: <Target size={16} aria-hidden="true" />,
        }]
      : []),
    {
      id: "heat_pump_mode",
      label: t("setup.greeSelectedMode"),
      value: mode,
      icon: <Snowflake size={16} aria-hidden="true" />,
    },
    {
      id: "heat_pump_fan_speed",
      label: t("heatPump.fanSpeed"),
      value: humanizeHeatPumpValue(state.fanSpeed, noData),
      icon: <Fan size={16} aria-hidden="true" />,
    },
  ];
  const impact = estimateHeatPumpInfluence(state);
  const number = new Intl.NumberFormat(locale, { maximumFractionDigits: 1 });
  const evidence = impact.compressorEvidence && state.compressorFrequencyHz !== null
    ? t("heatPump.frequencyEvidence", { value: number.format(state.compressorFrequencyHz) })
    : t("heatPump.selectedModeEvidence");
  const booleanValue = (value: boolean | null) => value === null ? noData : t(value ? "common.on" : "common.off");
  const settings = [
    ["heatPump.horizontalSwing", humanizeHeatPumpValue(state.horizontalSwing, noData)],
    ["heatPump.verticalSwing", humanizeHeatPumpValue(state.verticalSwing, noData)],
    ["heatPump.freshAir", booleanValue(state.freshAir)],
    ["heatPump.anion", booleanValue(state.anion)],
    ["heatPump.sleep", booleanValue(state.sleep)],
    ["heatPump.light", booleanValue(state.light)],
    ["heatPump.quiet", booleanValue(state.quiet)],
    ["heatPump.turbo", booleanValue(state.turbo)],
    ["heatPump.xfan", booleanValue(state.xfan)],
    ["heatPump.steadyHeat", booleanValue(state.steadyHeat)],
    ["heatPump.powerSave", booleanValue(state.powerSave)],
    ["heatPump.cleanFilter", booleanValue(state.cleanFilter)],
    ["heatPump.waterFull", booleanValue(state.waterFull)],
    ["heatPump.dehumidifierMode", humanizeHeatPumpValue(state.dehumidifierMode, noData)],
  ] as const satisfies ReadonlyArray<readonly [TranslationKey, string]>;
  const diagnostics = Object.entries(state.diagnostics)
    .filter((entry): entry is [string, number] => Number.isFinite(entry[1]))
    .map(([key, value]) => ({
      key,
      label: Object.hasOwn(diagnosticLabelKeys, key)
        ? t(diagnosticLabelKeys[key as keyof typeof diagnosticLabelKeys])
        : humanizeHeatPumpValue(key, key),
      value,
    }));
  const selectedAdvancedValues: Readonly<Record<string, string>> = {
    heat_pump_available: state.available ? t("heatPump.reported") : t("heatPump.unavailable"),
    heat_pump_power: booleanValue(state.power),
    heat_pump_horizontal_swing: humanizeHeatPumpValue(state.horizontalSwing, noData),
    heat_pump_vertical_swing: humanizeHeatPumpValue(state.verticalSwing, noData),
    heat_pump_fresh_air: booleanValue(state.freshAir),
    heat_pump_anion: booleanValue(state.anion),
    heat_pump_sleep: booleanValue(state.sleep),
    heat_pump_light: booleanValue(state.light),
    heat_pump_quiet: booleanValue(state.quiet),
    heat_pump_turbo: booleanValue(state.turbo),
    heat_pump_xfan: booleanValue(state.xfan),
    heat_pump_steady_heat: booleanValue(state.steadyHeat),
    heat_pump_power_save: booleanValue(state.powerSave),
    heat_pump_clean_filter: booleanValue(state.cleanFilter),
    heat_pump_water_full: booleanValue(state.waterFull),
    heat_pump_dehumidifier_mode: humanizeHeatPumpValue(state.dehumidifierMode, noData),
    heat_pump_compressor_frequency: state.compressorFrequencyHz === null
      ? noData
      : `${number.format(state.compressorFrequencyHz)} Hz`,
  };
  const diagnosticField = Object.hasOwn(diagnosticMetricFields, selectedDefinition.id)
    ? diagnosticMetricFields[selectedDefinition.id as keyof typeof diagnosticMetricFields]
    : null;
  const selectedDiagnosticValue = diagnosticField ? state.diagnostics[diagnosticField] : undefined;
  const selectedAdvancedValue = selectedAdvancedValues[selectedDefinition.id]
    ?? (typeof selectedDiagnosticValue === "number" && Number.isFinite(selectedDiagnosticValue)
      ? formatMeasurement(selectedDiagnosticValue, selectedDefinition, units)
      : undefined);
  const visiblePrimary = primary.some((datum) => datum.id === selectedDefinition.id) || selectedAdvancedValue === undefined
    ? primary
    : [{
        id: selectedDefinition.id,
        label: measurementLabel(selectedDefinition, locale),
        value: selectedAdvancedValue,
        icon: <Gauge size={16} aria-hidden="true" />,
      }, ...primary];
  const model = [state.brand, state.model].filter(Boolean).join(" · ") || t("setup.greeDevice");
  const location = room?.name ?? floor?.name ?? t("common.noData");
  return <aside className={`sensor-inspector heat-pump-inspector ${editing ? "editing" : ""}`} aria-labelledby="selected-heat-pump-title">
    <div className="sensor-heading heat-pump-heading">
      <span className="heat-pump-device-glyph" aria-hidden="true"><span /><span /></span>
      <div><span className="eyebrow">{model}</span><h2 id="selected-heat-pump-title">{heatPumpName(state)}</h2><p><Home size={13} aria-hidden="true" />{location}</p></div>
      <span className={`heat-pump-status-pill ${!state.available ? "unavailable" : !fresh ? "stale" : state.power ? "on" : "off"}`} role="status"><i aria-hidden="true" />{statusLabel}</span>
    </div>
    <div className="sensor-current heat-pump-current" role="list" aria-label={t("twin.measurements")}>
      {visiblePrimary.map((datum) => <div key={datum.id} role="listitem" className={datum.id === selectedDefinition.id ? "selected" : undefined}>
        <span>{datum.icon}{datum.label}</span>
        <strong>{datum.value}</strong>
        <small><span className={`quality-dot ${fresh && state.available ? "good" : "stale"}`} aria-hidden="true" />{availabilityLabel}{lastUpdate && <time dateTime={state.observedAt}>{lastUpdate}</time>}</small>
      </div>)}
    </div>
    <p className={`heat-pump-evidence ${impact.kind} ${impact.compressorEvidence ? "reported" : "inferred"}`}>
      <span className="heat-pump-evidence-mark" aria-hidden="true" />
      <span><strong>{t(`heatPump.influence.${impact.kind}`)}</strong><small>{evidence}</small></span>
    </p>
    <dl className="sensor-meta heat-pump-meta">
      <div><dt>{t("common.floor")}</dt><dd>{floor?.name ?? noData}</dd></div>
      <div><dt>{t("twin.mountingHeight")}</dt><dd>{floor && state.z !== null ? `${number.format(state.z - floor.elevation)} m` : noData}</dd></div>
      <div><dt>{t("setup.greePower")}</dt><dd>{state.power === null ? noData : t(state.power ? "common.on" : "common.off")}</dd></div>
      <div><dt>{t("setup.greeActivity")}</dt><dd>{state.activity === "off" ? t("common.off") : t("setup.greeActivityUnknown")}</dd></div>
      <div><dt><Gauge size={15} aria-hidden="true" />{t("setup.greeCompressorFrequency")}</dt><dd>{state.compressorFrequencyHz === null ? noData : `${number.format(state.compressorFrequencyHz)} Hz`}</dd></div>
      <div><dt>{t("setup.sourceLastUpdate")}</dt><dd><time dateTime={state.observedAt}>{detailedUpdate}</time></dd></div>
    </dl>
    <details className="heat-pump-details">
      <summary><span><Settings2 size={16} aria-hidden="true" />{t("heatPump.settingsAndDiagnostics")}</span><ChevronDown size={16} aria-hidden="true" /></summary>
      <div className="heat-pump-details-content">
        <p>{t("heatPump.settingsHelp")}</p>
        <dl className="sensor-meta heat-pump-detail-list">
          {settings.map(([key, value]) => <div key={key}><dt>{t(key)}</dt><dd>{value}</dd></div>)}
          <div><dt>{t("setup.greeConnection")}</dt><dd>{t(state.transport === "ewpe-cloud" ? "setup.greeCloud" : "setup.greeLocal")}</dd></div>
          <div><dt>{t("heatPump.deviceId")}</dt><dd className="heat-pump-technical-value">{state.deviceId}</dd></div>
          <div><dt>{t("heatPump.connectionId")}</dt><dd className="heat-pump-technical-value">{state.connectionId}</dd></div>
          <div><dt>{t("heatPump.equipmentId")}</dt><dd className="heat-pump-technical-value">{state.equipmentId ?? noData}</dd></div>
          <div><dt>{t("heatPump.observedAt")}</dt><dd><time dateTime={state.observedAt}>{formatInTimeZone(state.observedAt, locale, house.timezone, { dateStyle: "short", timeStyle: "medium" })}</time></dd></div>
          <div><dt>{t("heatPump.receivedAt")}</dt><dd><time dateTime={state.receivedAt}>{formatInTimeZone(state.receivedAt, locale, house.timezone, { dateStyle: "short", timeStyle: "medium" })}</time></dd></div>
        </dl>
        <div className="heat-pump-diagnostics-heading"><strong>{t("heatPump.diagnostics")}</strong><p>{t("heatPump.diagnosticsHelp")}</p></div>
        {diagnostics.length > 0
          ? <dl className="sensor-meta heat-pump-detail-list heat-pump-diagnostics-list">{diagnostics.map((entry) => <div key={entry.key}><dt>{entry.label}</dt><dd>{number.format(entry.value)}</dd></div>)}</dl>
          : <p className="heat-pump-no-diagnostics">{t("heatPump.noDiagnostics")}</p>}
      </div>
    </details>
  </aside>;
}
