import type { MeasurementSample, Sensor, UnitSystem } from "@climate-twin/contracts";
import { relativeHumidityToSpecificHumidity, type ClimateSampleMatrix } from "../airflowSimulation";
import type { OutdoorBoundaryContext, PlanEdge } from "./context";
import { isSpatialSampleFresh, type SpatialFreshnessOptions } from "../spatial/freshness";
import type { ExperimentalDataSupport } from "../spatial/experimentalLayers";

export type OutdoorInfluenceMetric = "temperature" | "moisture";
export type OutdoorInfluenceDirection = "warming" | "cooling" | "moistening" | "drying" | "neutral";
export type OutdoorInfluenceAvailability = "ready" | "no-outdoor" | "no-indoor";

export interface OutdoorInfluenceEdge {
  edge: PlanEdge;
  strength: number;
  windward: boolean;
}

export interface OutdoorInfluenceEstimate {
  metric: OutdoorInfluenceMetric;
  availability: OutdoorInfluenceAvailability;
  direction: OutdoorInfluenceDirection;
  support: ExperimentalDataSupport;
  sensorCount: number;
  outdoorValue: number | null;
  indoorValue: number | null;
  difference: number | null;
  strength: number;
  stale: boolean;
  windDriven: boolean;
  windwardEdge: PlanEdge | null;
  edges: OutdoorInfluenceEdge[];
}

const edges: readonly PlanEdge[] = ["top", "right", "bottom", "left"];
const neutralThreshold = { temperature: .5, moisture: .35 } as const;
const strongDifference = { temperature: 14, moisture: 7 } as const;

function clamp(value: number, minimum = 0, maximum = 1): number {
  return Math.max(minimum, Math.min(maximum, value));
}

function freshSample(
  samples: ClimateSampleMatrix,
  sensorId: string,
  metric: string,
  freshness: SpatialFreshnessOptions,
): MeasurementSample | null {
  const sample = samples[sensorId]?.[metric];
  return sample && Number.isFinite(sample.value) && isSpatialSampleFresh(sample, freshness) ? sample : null;
}

function moistureGKg(temperatureC: number, relativeHumidityPercent: number, pressureHpa?: number): number {
  return relativeHumidityToSpecificHumidity(temperatureC, relativeHumidityPercent, pressureHpa) * 1_000;
}

function outdoorValue(context: OutdoorBoundaryContext | null, metric: OutdoorInfluenceMetric): number | null {
  if (!context) return null;
  const conditions = context.conditions;
  if (metric === "temperature") {
    return typeof conditions.temperatureC === "number" && Number.isFinite(conditions.temperatureC)
      ? conditions.temperatureC
      : null;
  }
  if (typeof conditions.temperatureC === "number" && Number.isFinite(conditions.temperatureC)
    && typeof conditions.relativeHumidityPercent === "number" && Number.isFinite(conditions.relativeHumidityPercent)) {
    return moistureGKg(conditions.temperatureC, conditions.relativeHumidityPercent, conditions.pressureHpa);
  }
  return typeof conditions.dewPointC === "number" && Number.isFinite(conditions.dewPointC)
    ? moistureGKg(conditions.dewPointC, 100, conditions.pressureHpa)
    : null;
}

function indoorValues(input: {
  metric: OutdoorInfluenceMetric;
  sensors: readonly Sensor[];
  samples: ClimateSampleMatrix;
  freshness: SpatialFreshnessOptions;
}): number[] {
  return input.sensors.flatMap((sensor) => {
    const temperature = freshSample(input.samples, sensor.id, "temperature", input.freshness);
    if (!temperature) return [];
    if (input.metric === "temperature") return [temperature.value];
    const humidity = freshSample(input.samples, sensor.id, "humidity", input.freshness);
    if (!humidity) return [];
    const skewMs = Math.abs(Date.parse(temperature.timestamp) - Date.parse(humidity.timestamp));
    if (!Number.isFinite(skewMs) || skewMs > Math.min(input.freshness.maxSampleAgeMs, 30 * 60_000)) return [];
    return [moistureGKg(temperature.value, humidity.value)];
  });
}

function directionFor(metric: OutdoorInfluenceMetric, difference: number): OutdoorInfluenceDirection {
  if (Math.abs(difference) < neutralThreshold[metric]) return "neutral";
  if (metric === "temperature") return difference > 0 ? "warming" : "cooling";
  return difference > 0 ? "moistening" : "drying";
}

function oppositeEdge(edge: PlanEdge): PlanEdge {
  return ({ top: "bottom", right: "left", bottom: "top", left: "right" } as const)[edge];
}

function edgeInfluences(
  strength: number,
  windwardEdge: PlanEdge | null,
  windDriven: boolean,
): OutdoorInfluenceEdge[] {
  return edges.map((edge) => {
    const windWeight = !windDriven || !windwardEdge
      ? .72
      : edge === windwardEdge
        ? 1
        : edge === oppositeEdge(windwardEdge)
          ? .38
          : .62;
    return { edge, strength: clamp(strength * windWeight), windward: edge === windwardEdge };
  });
}

function emptyEstimate(
  metric: OutdoorInfluenceMetric,
  availability: Exclude<OutdoorInfluenceAvailability, "ready">,
  context: OutdoorBoundaryContext | null,
  sensorCount = 0,
): OutdoorInfluenceEstimate {
  return {
    metric,
    availability,
    direction: "neutral",
    support: "low",
    sensorCount,
    outdoorValue: outdoorValue(context, metric),
    indoorValue: null,
    difference: null,
    strength: 0,
    stale: context?.stale ?? false,
    windDriven: false,
    windwardEdge: context?.windwardEdge ?? null,
    edges: [],
  };
}

/**
 * Compares an outdoor boundary with fresh indoor readings. This expresses
 * directional pressure on the envelope, not a causal attribution or heat-flow
 * calculation.
 */
export function estimateOutdoorInfluence(input: {
  metric: OutdoorInfluenceMetric;
  sensors: readonly Sensor[];
  samples: ClimateSampleMatrix;
  freshness: SpatialFreshnessOptions;
  outdoor: OutdoorBoundaryContext | null;
}): OutdoorInfluenceEstimate {
  const outside = outdoorValue(input.outdoor, input.metric);
  if (outside === null) return emptyEstimate(input.metric, "no-outdoor", input.outdoor);
  const indoors = indoorValues(input);
  if (!indoors.length) return emptyEstimate(input.metric, "no-indoor", input.outdoor);

  const inside = indoors.reduce((sum, value) => sum + value, 0) / indoors.length;
  const difference = outside - inside;
  const direction = directionFor(input.metric, difference);
  const windSpeed = input.outdoor?.conditions.windSpeedMps;
  const windDriven = typeof windSpeed === "number" && Number.isFinite(windSpeed) && windSpeed >= 1
    && input.outdoor?.windwardEdge !== null;
  const windFactor = windDriven ? 1 + clamp(windSpeed! / 18) * .22 : 1;
  const normalized = direction === "neutral"
    ? .08
    : clamp((Math.abs(difference) - neutralThreshold[input.metric])
      / (strongDifference[input.metric] - neutralThreshold[input.metric]));
  const strength = clamp(normalized * windFactor * (input.outdoor?.stale ? .58 : 1));
  const support: ExperimentalDataSupport = !input.outdoor?.stale && indoors.length >= 2 ? "medium" : "low";

  return {
    metric: input.metric,
    availability: "ready",
    direction,
    support,
    sensorCount: indoors.length,
    outdoorValue: outside,
    indoorValue: inside,
    difference,
    strength,
    stale: input.outdoor?.stale ?? false,
    windDriven,
    windwardEdge: input.outdoor?.windwardEdge ?? null,
    edges: edgeInfluences(strength, input.outdoor?.windwardEdge ?? null, windDriven),
  };
}

export function formatOutdoorInfluenceValue(
  metric: OutdoorInfluenceMetric,
  value: number,
  units: UnitSystem,
  locale: string,
  difference = false,
): string {
  const number = metric === "temperature" && units === "imperial"
    ? difference ? value * 9 / 5 : value * 9 / 5 + 32
    : value;
  const formatted = new Intl.NumberFormat(locale, {
    maximumFractionDigits: 1,
    minimumFractionDigits: 1,
    signDisplay: difference ? "always" : "auto",
  }).format(number);
  if (metric === "moisture") return `${formatted} g/kg`;
  return `${formatted} \u00b0${units === "imperial" ? "F" : "C"}`;
}
