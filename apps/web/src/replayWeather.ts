import type { OutdoorConditions, OutdoorTemperatureSample } from "@climate-twin/contracts";

export function replayOutdoorSampleAt(
  samples: readonly OutdoorTemperatureSample[],
  timestamp: number,
): OutdoorTemperatureSample | null {
  let selected: OutdoorTemperatureSample | null = null;
  let selectedTimestamp = Number.NEGATIVE_INFINITY;
  for (const sample of samples) {
    const sampleTimestamp = Date.parse(sample.timestamp);
    if (!Number.isFinite(sampleTimestamp) || sampleTimestamp > timestamp || sampleTimestamp <= selectedTimestamp) continue;
    selected = sample;
    selectedTimestamp = sampleTimestamp;
  }
  return selected;
}

export function replayOutdoorConditions(sample: OutdoorTemperatureSample): OutdoorConditions {
  return {
    ...sample.conditions,
    timestamp: sample.conditions?.timestamp ?? sample.timestamp,
    temperatureC: sample.conditions?.temperatureC ?? sample.temperatureC,
  };
}

export function replayOutdoorAttribution(sample: OutdoorTemperatureSample): string | null {
  if (sample.source.startsWith("fmi-")) return "Finnish Meteorological Institute open data";
  if (sample.source.startsWith("open-meteo-")) return "Weather data by Open-Meteo.com (CC BY 4.0)";
  return null;
}
