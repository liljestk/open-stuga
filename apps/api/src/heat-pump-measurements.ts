import type {
  HeatPumpState,
  MeasurementDefinition,
  MeasurementSample,
} from "@climate-twin/contracts";

export const GREE_SENSOR_TAG = "integration:gree";
export const DETACHED_GREE_SENSOR_TAG = "integration:gree:detached";
export const HEAT_PUMP_SENSOR_TAG = "equipment:heat-pump";
export const UNPLACED_SENSOR_TAG = "unplaced";

export function heatPumpSensorId(connectionId: string): string {
  return `sensor-${connectionId}`;
}

type Labels = Record<"en" | "fi" | "sv", string>;

const labels = (en: string, fi: string, sv: string): Labels => ({ en, fi, sv });

function definition(
  id: string,
  names: Labels,
  options: Partial<MeasurementDefinition> = {},
): MeasurementDefinition {
  return {
    id,
    labels: names,
    unit: "",
    dimension: "finite_scalar",
    allowedUnits: [""],
    kind: "gauge",
    defaultAggregation: "mean",
    genericHistoryEnabled: true,
    genericStatsEnabled: true,
    precision: 0,
    validMin: null,
    validMax: null,
    displayMin: null,
    displayMax: null,
    interpolationDelta: 1,
    colorScale: "sequential",
    builtin: true,
    enabled: true,
    spatialInterpolation: false,
    forecastSupported: false,
    ...options,
  };
}

const binary = (id: string, names: Labels) => definition(id, names, {
  kind: "binary_state",
  defaultAggregation: "last",
  validMin: 0,
  validMax: 1,
  displayMin: 0,
  displayMax: 1,
});

const categorical = (id: string, names: Labels, maximum = 20) => definition(id, names, {
  kind: "categorical_state",
  defaultAggregation: "last",
  validMin: 0,
  validMax: maximum,
  displayMin: 0,
  displayMax: maximum,
});

const diagnosticCode = (id: string, names: Labels) => definition(id, names, {
  kind: "categorical_state",
  defaultAggregation: "last",
});

const raw = (id: string, names: Labels) => definition(id, names, {
  unit: "raw",
  allowedUnits: ["raw"],
  precision: 1,
  validMin: null,
  validMax: null,
});

export const HEAT_PUMP_MEASUREMENT_DEFINITIONS: readonly MeasurementDefinition[] = [
  binary("heat_pump_available", labels("Available", "Saatavilla", "Tillgänglig")),
  binary("heat_pump_power", labels("Power state", "Virtatila", "Strömläge")),
  categorical("heat_pump_mode", labels("Operating mode", "Toimintatila", "Driftläge"), 4),
  definition("heat_pump_target_temperature", labels("Target temperature", "Tavoitelämpötila", "Måltemperatur"), {
    unit: "°C", dimension: "temperature", allowedUnits: ["°C", "°F"], precision: 1,
    validMin: -60, validMax: 100, displayMin: 15, displayMax: 30, interpolationDelta: 1,
  }),
  definition("heat_pump_target_humidity", labels("Target humidity", "Tavoitekosteus", "Målluftfuktighet"), {
    unit: "%", dimension: "relative_humidity", allowedUnits: ["%"],
    validMin: 0, validMax: 100, displayMin: 20, displayMax: 80, interpolationDelta: 5,
  }),
  categorical("heat_pump_fan_speed", labels("Fan speed", "Puhallusnopeus", "Fläkthastighet"), 255),
  categorical("heat_pump_horizontal_swing", labels("Horizontal swing", "Vaakasuuntainen puhallus", "Horisontell swing"), 255),
  categorical("heat_pump_vertical_swing", labels("Vertical swing", "Pystysuuntainen puhallus", "Vertikal swing"), 255),
  binary("heat_pump_fresh_air", labels("Fresh-air valve", "Raitisilmaventtiili", "Friskluftsventil")),
  binary("heat_pump_anion", labels("Air purification", "Ilmanpuhdistus", "Luftrening")),
  binary("heat_pump_sleep", labels("Sleep mode", "Unitila", "Sömnläge")),
  binary("heat_pump_light", labels("Display light", "Näytön valo", "Displaybelysning")),
  binary("heat_pump_quiet", labels("Quiet mode", "Hiljainen tila", "Tyst läge")),
  binary("heat_pump_turbo", labels("Turbo mode", "Turbotila", "Turboläge")),
  binary("heat_pump_xfan", labels("Coil-drying fan", "Kennon kuivauspuhallus", "Batteritorkning")),
  binary("heat_pump_steady_heat", labels("Steady heat", "Ylläpitolämpö", "Underhållsvärme")),
  binary("heat_pump_power_save", labels("Power saving", "Virransäästö", "Energisparläge")),
  binary("heat_pump_clean_filter", labels("Filter needs cleaning", "Suodatin on puhdistettava", "Filtret behöver rengöras")),
  binary("heat_pump_water_full", labels("Water tank full", "Vesisäiliö täynnä", "Vattenbehållaren full")),
  categorical("heat_pump_dehumidifier_mode", labels("Dehumidifier mode", "Kuivaintila", "Avfuktarläge"), 255),
  definition("heat_pump_compressor_frequency", labels("Compressor frequency", "Kompressorin taajuus", "Kompressorfrekvens"), {
    unit: "Hz", dimension: "frequency", allowedUnits: ["Hz"], precision: 1,
    validMin: 0, validMax: 300, displayMin: 0, displayMax: 150, interpolationDelta: 5,
  }),
  raw("heat_pump_environment_temperature_raw", labels("Environment temperature (raw)", "Ympäristölämpötila (raaka)", "Omgivningstemperatur (rå)")),
  raw("heat_pump_indoor_coil_temperature_raw", labels("Indoor coil temperature (raw)", "Sisäkennon lämpötila (raaka)", "Inomhusbatteriets temperatur (rå)")),
  raw("heat_pump_outdoor_temperature_raw", labels("Outdoor temperature (raw)", "Ulkolämpötila (raaka)", "Utomhustemperatur (rå)")),
  raw("heat_pump_compressor_temperature_raw", labels("Compressor temperature (raw)", "Kompressorin lämpötila (raaka)", "Kompressortemperatur (rå)")),
  raw("heat_pump_water_sensor_raw", labels("Water sensor (raw)", "Vesianturi (raaka)", "Vattensensor (rå)")),
  raw("heat_pump_total_energy_raw", labels("Total energy (raw)", "Kokonaisenergia (raaka)", "Total energi (rå)")),
  raw("heat_pump_energy_consumption_raw", labels("Energy consumption (raw)", "Energiankulutus (raaka)", "Energiförbrukning (rå)")),
  raw("heat_pump_sleep_mode_raw", labels("Sleep mode (raw)", "Unitila (raaka)", "Sömnläge (rå)")),
  raw("heat_pump_temperature_unit_raw", labels("Temperature unit (raw)", "Lämpötilayksikkö (raaka)", "Temperaturenhet (rå)")),
  raw("heat_pump_temperature_record_raw", labels("Temperature encoding (raw)", "Lämpötilakoodaus (raaka)", "Temperaturkodning (rå)")),
  raw("heat_pump_heat_cool_type_raw", labels("Heat/cool type (raw)", "Lämmitys-/jäähdytystyyppi (raaka)", "Värme-/kyltyp (rå)")),
  diagnosticCode("heat_pump_fault_code", labels("Fault code", "Vikakoodi", "Felkod")),
  diagnosticCode("heat_pump_all_errors", labels("All errors", "Kaikki virheet", "Alla fel")),
  diagnosticCode("heat_pump_shutdown_faults", labels("Shutdown faults", "Pysäytysviat", "Avstängningsfel")),
  diagnosticCode("heat_pump_subhealth_faults", labels("Subhealth faults", "Alijärjestelmäviat", "Delsystemfel")),
  diagnosticCode("heat_pump_wifi_status", labels("Wi-Fi status", "Wi-Fi-tila", "Wi-Fi-status")),
];

const modeCodes = { auto: 0, cool: 1, dry: 2, fan: 3, heat: 4 } as const;
const fanCodes: Record<string, number> = { auto: 0, low: 1, mediumlow: 2, medium: 3, mediumhigh: 4, high: 5 };
const horizontalCodes: Record<string, number> = {
  default: 0, fixed: 0, fullswing: 1, full: 1, left: 2, leftcenter: 3,
  middleleft: 3, center: 4, middle: 4, rightcenter: 5, middleright: 5, right: 6,
};
const verticalCodes: Record<string, number> = {
  default: 0, fixed: 0, fullswing: 1, full: 1, fixedupper: 2, top: 2,
  fixeduppermiddle: 3, middletop: 3, fixedmiddle: 4, middle: 4,
  fixedlowermiddle: 5, middlebottom: 5, fixedlower: 6, bottom: 6,
  swingupper: 7, swinguppermiddle: 8, swingmiddle: 9, swinglowermiddle: 10, swinglower: 11,
};
const dehumidifierCodes: Record<string, number> = { default: 0, aniononly: 9 };

function enumCode(value: string | null, codes: Record<string, number>): number | null {
  if (!value) return null;
  const normalized = value.toLocaleLowerCase("en").replaceAll(/[^a-z0-9]/gu, "");
  if (Object.hasOwn(codes, normalized)) return codes[normalized]!;
  const unknown = /^unknown(\d+)$/u.exec(normalized);
  return unknown ? Number(unknown[1]) : null;
}

const boolNumber = (value: boolean | null): number | null => value === null ? null : value ? 1 : 0;

const diagnosticMetrics: ReadonlyArray<[keyof HeatPumpState["diagnostics"], string]> = [
  ["environmentTemperatureRaw", "heat_pump_environment_temperature_raw"],
  ["indoorCoilTemperatureRaw", "heat_pump_indoor_coil_temperature_raw"],
  ["outdoorTemperatureRaw", "heat_pump_outdoor_temperature_raw"],
  ["compressorTemperatureRaw", "heat_pump_compressor_temperature_raw"],
  ["waterSensorRaw", "heat_pump_water_sensor_raw"],
  ["totalEnergyRaw", "heat_pump_total_energy_raw"],
  ["energyConsumptionRaw", "heat_pump_energy_consumption_raw"],
  ["sleepModeRaw", "heat_pump_sleep_mode_raw"],
  ["temperatureUnitRaw", "heat_pump_temperature_unit_raw"],
  ["temperatureRecordRaw", "heat_pump_temperature_record_raw"],
  ["heatCoolTypeRaw", "heat_pump_heat_cool_type_raw"],
  ["faultCode", "heat_pump_fault_code"],
  ["allErrors", "heat_pump_all_errors"],
  ["shutdownFaults", "heat_pump_shutdown_faults"],
  ["subhealthFaults", "heat_pump_subhealth_faults"],
  ["wifiStatus", "heat_pump_wifi_status"],
];

const units = new Map<string, string>([
  ["temperature", "°C"],
  ["humidity", "%"],
  ...HEAT_PUMP_MEASUREMENT_DEFINITIONS.map((item) => [item.id, item.unit] as const),
]);

export function heatPumpMeasurementSamples(state: HeatPumpState): MeasurementSample[] {
  const values: Array<[string, number | null]> = [
    ["temperature", state.currentTemperatureC],
    ["humidity", state.currentHumidityPercent],
    ["heat_pump_available", state.available ? 1 : 0],
    ["heat_pump_power", boolNumber(state.power)],
    ["heat_pump_mode", state.selectedMode === null ? null : modeCodes[state.selectedMode]],
    ["heat_pump_target_temperature", state.targetTemperatureC],
    ["heat_pump_target_humidity", state.targetHumidityPercent],
    ["heat_pump_fan_speed", enumCode(state.fanSpeed, fanCodes)],
    ["heat_pump_horizontal_swing", enumCode(state.horizontalSwing, horizontalCodes)],
    ["heat_pump_vertical_swing", enumCode(state.verticalSwing, verticalCodes)],
    ["heat_pump_fresh_air", boolNumber(state.freshAir)],
    ["heat_pump_anion", boolNumber(state.anion)],
    ["heat_pump_sleep", boolNumber(state.sleep)],
    ["heat_pump_light", boolNumber(state.light)],
    ["heat_pump_quiet", boolNumber(state.quiet)],
    ["heat_pump_turbo", boolNumber(state.turbo)],
    ["heat_pump_xfan", boolNumber(state.xfan)],
    ["heat_pump_steady_heat", boolNumber(state.steadyHeat)],
    ["heat_pump_power_save", boolNumber(state.powerSave)],
    ["heat_pump_clean_filter", boolNumber(state.cleanFilter)],
    ["heat_pump_water_full", boolNumber(state.waterFull)],
    ["heat_pump_dehumidifier_mode", enumCode(state.dehumidifierMode, dehumidifierCodes)],
    ["heat_pump_compressor_frequency", state.compressorFrequencyHz],
    ...diagnosticMetrics.map(([field, metric]) => [metric, state.diagnostics[field] ?? null] as [string, number | null]),
  ];
  return values.flatMap(([metric, value]) => value === null || !Number.isFinite(value) ? [] : [{
    sensorId: heatPumpSensorId(state.connectionId),
    metric,
    value,
    canonicalUnit: units.get(metric) ?? "",
    timestamp: state.observedAt,
    source: "gree" as const,
    quality: state.available || metric === "heat_pump_available" ? "good" as const : "stale" as const,
  }]);
}
