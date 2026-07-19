import type { SpatialClimateSample, SpatialSensorCalibration } from './contracts.js';
import { clamp } from './math.js';

export type PressureProvenance = 'observed' | 'configured' | 'standard-estimate';
export type SaturationSurface = 'water' | 'ice';

export interface PsychrometricResult {
  valid: boolean;
  reasons: string[];
  temperatureC: number;
  relativeHumidityPct: number;
  saturationSurface: SaturationSurface;
  saturationVaporPressureHpa: number | null;
  vaporPressureHpa: number | null;
  dewPointC: number | null;
  frostPointC: number | null;
  condensationPointC: number | null;
  condensationPointKind: 'dew' | 'frost' | null;
  absoluteHumidityGM3: number | null;
  humidityRatioGKg: number | null;
  pressureHpa: number;
  pressureProvenance: PressureProvenance;
}

export interface CalibratedPsychrometricSample extends SpatialClimateSample {
  calibratedTemperatureC: number;
  calibratedRelativeHumidityPct: number;
  calibrationConfidence: number;
  calibrationMethod: SpatialSensorCalibration['method'] | 'none';
  /** House-calibrated sensor response delay applied by the resampler. */
  responseLagSeconds: number;
  psychrometrics: PsychrometricResult;
}

export interface PsychrometricOptions {
  configuredPressureHpa?: number;
}

export function saturationVaporPressureHpa(temperatureC: number): number {
  return temperatureC >= 0
    ? saturationVaporPressureOverWaterHpa(temperatureC)
    : saturationVaporPressureOverIceHpa(temperatureC);
}

export function saturationVaporPressureOverWaterHpa(temperatureC: number): number {
  return 6.1121 * Math.exp((18.678 - temperatureC / 234.5) * (temperatureC / (257.14 + temperatureC)));
}

export function saturationVaporPressureOverIceHpa(temperatureC: number): number {
  return 6.1115 * Math.exp((23.036 - temperatureC / 333.7) * (temperatureC / (279.82 + temperatureC)));
}

function condensationPointFromVaporPressure(
  vaporPressureHpa: number,
  surface: SaturationSurface,
): number | null {
  if (!(vaporPressureHpa > 0)) return null;
  let lower = -100;
  let upper = 80;
  const saturation = surface === 'water' ? saturationVaporPressureOverWaterHpa : saturationVaporPressureOverIceHpa;
  if (vaporPressureHpa < saturation(lower) || vaporPressureHpa > saturation(upper)) {
    return null;
  }
  for (let iteration = 0; iteration < 80; iteration += 1) {
    const middle = (lower + upper) / 2;
    if (saturation(middle) < vaporPressureHpa) lower = middle;
    else upper = middle;
  }
  return (lower + upper) / 2;
}

export function calculatePsychrometrics(
  temperatureC: number,
  relativeHumidityPct: number,
  pressureHpa = 1013.25,
  pressureProvenance: PressureProvenance = 'standard-estimate',
): PsychrometricResult {
  const reasons: string[] = [];
  if (!Number.isFinite(temperatureC) || temperatureC < -80 || temperatureC > 80) reasons.push('temperature-out-of-range');
  if (!Number.isFinite(relativeHumidityPct) || relativeHumidityPct < 0 || relativeHumidityPct > 100) {
    reasons.push('humidity-out-of-range');
  }
  if (!Number.isFinite(pressureHpa) || pressureHpa < 300 || pressureHpa > 1200) reasons.push('pressure-out-of-range');
  const surface: SaturationSurface = temperatureC < 0 ? 'ice' : 'water';
  if (reasons.length > 0) {
    return {
      valid: false,
      reasons,
      temperatureC,
      relativeHumidityPct,
      saturationSurface: surface,
      saturationVaporPressureHpa: null,
      vaporPressureHpa: null,
      dewPointC: null,
      frostPointC: null,
      condensationPointC: null,
      condensationPointKind: null,
      absoluteHumidityGM3: null,
      humidityRatioGKg: null,
      pressureHpa,
      pressureProvenance,
    };
  }

  const saturation = saturationVaporPressureHpa(temperatureC);
  const vapor = (relativeHumidityPct / 100) * saturation;
  if (vapor >= pressureHpa) {
    return {
      valid: false,
      reasons: ['vapor-pressure-exceeds-total-pressure'],
      temperatureC,
      relativeHumidityPct,
      saturationSurface: surface,
      saturationVaporPressureHpa: saturation,
      vaporPressureHpa: vapor,
      dewPointC: null,
      frostPointC: null,
      condensationPointC: null,
      condensationPointKind: null,
      absoluteHumidityGM3: null,
      humidityRatioGKg: null,
      pressureHpa,
      pressureProvenance,
    };
  }

  const dewPointC = condensationPointFromVaporPressure(vapor, 'water');
  const frostPointC = condensationPointFromVaporPressure(vapor, 'ice');
  const condensationPointKind = vapor === 0 ? null : surface === 'ice' ? 'frost' : 'dew';
  return {
    valid: true,
    reasons,
    temperatureC,
    relativeHumidityPct,
    saturationSurface: surface,
    saturationVaporPressureHpa: saturation,
    vaporPressureHpa: vapor,
    dewPointC,
    frostPointC,
    condensationPointC: condensationPointKind === 'frost' ? frostPointC : dewPointC,
    condensationPointKind,
    absoluteHumidityGM3: vapor === 0 ? 0 : (216.7 * vapor) / (temperatureC + 273.15),
    humidityRatioGKg: vapor === 0 ? 0 : 1000 * 0.621945 * (vapor / (pressureHpa - vapor)),
    pressureHpa,
    pressureProvenance,
  };
}

export function calibrationAt(
  calibrations: readonly SpatialSensorCalibration[],
  sensorId: string,
  observedAt: string,
): SpatialSensorCalibration | undefined {
  const timestamp = Date.parse(observedAt);
  return calibrations
    .filter((calibration) => {
      if (calibration.sensorId !== sensorId) return false;
      const start = Date.parse(calibration.validFrom);
      const end = calibration.validTo === undefined ? Number.POSITIVE_INFINITY : Date.parse(calibration.validTo);
      return timestamp >= start && timestamp < end;
    })
    .sort((left, right) => Date.parse(right.validFrom) - Date.parse(left.validFrom))[0];
}

export function calibrateAndConvert(
  sample: SpatialClimateSample,
  calibrations: readonly SpatialSensorCalibration[] = [],
  options: PsychrometricOptions = {},
): CalibratedPsychrometricSample {
  const calibration = calibrationAt(calibrations, sample.sensorId, sample.observedAt);
  const temperature = sample.temperatureC + (calibration?.temperatureOffsetC ?? 0);
  const humidity = sample.relativeHumidityPct + (calibration?.humidityOffsetPct ?? 0);
  let pressure = 1013.25;
  let pressureProvenance: PressureProvenance = 'standard-estimate';
  if (sample.pressureHpa !== undefined) {
    pressure = sample.pressureHpa;
    pressureProvenance = sample.pressureSource ?? 'observed';
  } else if (options.configuredPressureHpa !== undefined) {
    pressure = options.configuredPressureHpa;
    pressureProvenance = 'configured';
  }
  return {
    ...sample,
    calibratedTemperatureC: temperature,
    calibratedRelativeHumidityPct: humidity,
    calibrationConfidence: clamp(calibration?.confidence ?? 0),
    calibrationMethod: calibration?.method ?? 'none',
    responseLagSeconds:
      calibration?.responseLagSeconds !== undefined && Number.isFinite(calibration.responseLagSeconds)
        ? Math.max(0, calibration.responseLagSeconds)
        : 0,
    psychrometrics: calculatePsychrometrics(temperature, humidity, pressure, pressureProvenance),
  };
}
