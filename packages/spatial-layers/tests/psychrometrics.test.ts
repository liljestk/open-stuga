import { describe, expect, it } from 'vitest';

import {
  calculatePsychrometrics,
  calibrateAndConvert,
  saturationVaporPressureHpa,
} from '../src/index.js';

describe('psychrometrics', () => {
  it('matches a known normal-indoor conversion point', () => {
    const point = calculatePsychrometrics(20, 50);
    expect(point.valid).toBe(true);
    expect(point.saturationSurface).toBe('water');
    expect(point.saturationVaporPressureHpa).toBeCloseTo(23.38, 1);
    expect(point.vaporPressureHpa).toBeCloseTo(11.69, 1);
    expect(point.dewPointC).toBeCloseTo(9.27, 1);
    expect(point.absoluteHumidityGM3).toBeCloseTo(8.64, 1);
    expect(point.humidityRatioGKg).toBeCloseTo(7.26, 1);
    expect(point.pressureProvenance).toBe('standard-estimate');
  });

  it('uses a phase-aware frost point below freezing and the water branch at zero', () => {
    const cold = calculatePsychrometrics(-20, 80, 1000, 'observed');
    const boundary = calculatePsychrometrics(0, 80, 1000, 'observed');
    expect(cold.valid).toBe(true);
    expect(cold.saturationSurface).toBe('ice');
    expect(cold.condensationPointKind).toBe('frost');
    expect(cold.condensationPointC).toBe(cold.frostPointC);
    expect(cold.dewPointC).not.toBe(cold.frostPointC);
    expect(boundary.saturationSurface).toBe('water');
    expect(boundary.condensationPointKind).toBe('dew');
    expect(boundary.condensationPointC).toBe(boundary.dewPointC);
    expect(Math.abs(saturationVaporPressureHpa(-0.0001) - saturationVaporPressureHpa(0))).toBeLessThan(0.01);
  });

  it('does not invent a finite dew or frost point at zero RH', () => {
    const point = calculatePsychrometrics(18, 0);
    expect(point.valid).toBe(true);
    expect(point.vaporPressureHpa).toBe(0);
    expect(point.dewPointC).toBeNull();
    expect(point.frostPointC).toBeNull();
    expect(point.condensationPointC).toBeNull();
    expect(point.condensationPointKind).toBeNull();
    expect(point.absoluteHumidityGM3).toBe(0);
    expect(point.humidityRatioGKg).toBe(0);
  });

  it('reports pressure provenance independently of the numeric value', () => {
    expect(calculatePsychrometrics(20, 50, 1013.25, 'observed').pressureProvenance).toBe('observed');
    expect(calculatePsychrometrics(20, 50, 1013.25, 'configured').pressureProvenance).toBe('configured');
    expect(calculatePsychrometrics(20, 50).pressureProvenance).toBe('standard-estimate');
  });

  it('applies the effective calibration before conversion and rejects offset overflow', () => {
    const sample = {
      sensorId: 'sensor-1',
      observedAt: '2026-01-01T00:00:00.000Z',
      temperatureC: 19,
      relativeHumidityPct: 96,
    };
    const calibrated = calibrateAndConvert(sample, [{
      sensorId: 'sensor-1',
      validFrom: '2025-01-01T00:00:00.000Z',
      temperatureOffsetC: 1,
      humidityOffsetPct: -2,
      confidence: 0.9,
      method: 'co-location',
    }]);
    expect(calibrated.calibratedTemperatureC).toBe(20);
    expect(calibrated.calibratedRelativeHumidityPct).toBe(94);
    expect(calibrated.psychrometrics.temperatureC).toBe(20);
    expect(calibrated.calibrationMethod).toBe('co-location');

    const invalid = calibrateAndConvert(sample, [{
      sensorId: 'sensor-1',
      validFrom: '2025-01-01T00:00:00.000Z',
      temperatureOffsetC: 0,
      humidityOffsetPct: 5,
      confidence: 1,
      method: 'manual',
    }]);
    expect(invalid.psychrometrics.valid).toBe(false);
    expect(invalid.psychrometrics.reasons).toContain('humidity-out-of-range');
  });

  it('rejects values outside the documented calculation domain', () => {
    expect(calculatePsychrometrics(-81, 50).valid).toBe(false);
    expect(calculatePsychrometrics(20, 101).valid).toBe(false);
    expect(calculatePsychrometrics(20, 50, 200).valid).toBe(false);
  });
});
