import type { MeasurementDefinition } from "./measurement-analytics.js";

/**
 * The measurements every installation starts with. The API seeds them and keeps
 * their analytics fields (dimension, units, kind, aggregation) in sync; the web
 * uses the same list when no server definitions are loaded (demo mode, first
 * paint). Valid ranges are the ingestion limits; display ranges, precision and
 * interpolation are presentation defaults.
 */
export const BUILTIN_MEASUREMENT_DEFINITIONS: readonly MeasurementDefinition[] = [
  {
    id: "temperature", labels: { en: "Temperature", fi: "Lämpötila", sv: "Temperatur" }, unit: "°C", precision: 1,
    validMin: -80, validMax: 100, displayMin: 12, displayMax: 30, interpolationDelta: 0.35,
    colorScale: "thermal", builtin: true, enabled: true, spatialInterpolation: true, forecastSupported: true,
    dimension: "temperature", allowedUnits: ["°C", "°F"], kind: "gauge", defaultAggregation: "mean",
    genericHistoryEnabled: true, genericStatsEnabled: true,
  },
  {
    id: "humidity", labels: { en: "Humidity", fi: "Ilmankosteus", sv: "Luftfuktighet" }, unit: "%", precision: 0,
    validMin: 0, validMax: 100, displayMin: 20, displayMax: 90, interpolationDelta: 3,
    colorScale: "humidity", builtin: true, enabled: true, spatialInterpolation: true, forecastSupported: true,
    dimension: "relative_humidity", allowedUnits: ["%"], kind: "gauge", defaultAggregation: "mean",
    genericHistoryEnabled: true, genericStatsEnabled: true,
  },
  {
    id: "co2", labels: { en: "Carbon dioxide", fi: "Hiilidioksidi", sv: "Koldioxid" }, unit: "ppm", precision: 0,
    validMin: 0, validMax: 10_000, displayMin: 400, displayMax: 2_000, interpolationDelta: 50,
    colorScale: "air-quality", builtin: true, enabled: true, spatialInterpolation: true, forecastSupported: true,
    dimension: "co2_concentration", allowedUnits: ["ppm"], kind: "gauge", defaultAggregation: "mean",
    genericHistoryEnabled: true, genericStatsEnabled: true,
  },
  {
    id: "power", labels: { en: "Power", fi: "Teho", sv: "Effekt" }, unit: "W", precision: 0,
    validMin: null, validMax: null, displayMin: 0, displayMax: 10_000, interpolationDelta: 500,
    colorScale: "sequential", builtin: true, enabled: true, spatialInterpolation: false, forecastSupported: false,
    dimension: "power", allowedUnits: ["W", "kW"], kind: "rate", defaultAggregation: "time_weighted_mean",
    genericHistoryEnabled: true, genericStatsEnabled: true,
  },
  {
    id: "energy", labels: { en: "Electricity consumption", fi: "Sähkönkulutus", sv: "Elförbrukning" }, unit: "kWh", precision: 2,
    validMin: 0, validMax: null, displayMin: 0, displayMax: 50, interpolationDelta: 1,
    colorScale: "sequential", builtin: true, enabled: true, spatialInterpolation: false, forecastSupported: false,
    dimension: "energy", allowedUnits: ["Wh", "kWh"], kind: "cumulative_counter", defaultAggregation: "delta",
    genericHistoryEnabled: true, genericStatsEnabled: true,
  },
  {
    id: "electricity_price", labels: { en: "Electricity price", fi: "Sähkön hinta", sv: "Elpris" }, unit: "€/kWh", precision: 3,
    validMin: null, validMax: null, displayMin: -0.2, displayMax: 1, interpolationDelta: 0.05,
    colorScale: "sequential", builtin: true, enabled: true, spatialInterpolation: false, forecastSupported: false,
    dimension: "finite_scalar", allowedUnits: ["€/kWh"], kind: "gauge", defaultAggregation: "mean",
    genericHistoryEnabled: true, genericStatsEnabled: true,
  },
];
