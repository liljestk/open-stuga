import { describe, expect, it } from 'vitest';

import {
  assessSensorQuality,
  createFiveZoneTopology,
  observedMedianCadenceSeconds,
  resampleClimateWindow,
  type SpatialClimateSample,
} from '../src/index.js';

function sample(sensorId: string, minute: number, temperatureC = 20, relativeHumidityPct = 45): SpatialClimateSample {
  return {
    sensorId,
    observedAt: new Date(Date.parse('2026-01-01T00:00:00.000Z') + minute * 60_000).toISOString(),
    temperatureC,
    relativeHumidityPct,
    sourceSequence: `${sensorId}:${minute}`,
  };
}

describe('resampling and quality', () => {
  it('uses observed cadence, deduplicates source sequence, and bounds carry-forward', () => {
    const samples = [sample('sensor-1', 0), sample('sensor-1', 1), sample('sensor-1', 3)];
    expect(observedMedianCadenceSeconds(samples)).toBe(90);
    const window = resampleClimateWindow([...samples, { ...samples[1]!, observedAt: samples[1]!.observedAt }], [], {
      startAt: '2026-01-01T00:00:00.000Z',
      endAt: '2026-01-01T00:10:00.000Z',
      targetBucketSeconds: 60,
      maximumCarryForwardSeconds: 120,
    });
    expect(window.observedCadenceSeconds['sensor-1']).toBe(90);
    expect(window.points.filter((point) => point.sensorId === 'sensor-1')).toHaveLength(6);
    expect(window.points.at(-1)?.bucketAt).toBe('2026-01-01T00:05:00.000Z');
    expect(window.points.at(-1)?.interpolation).toBe('carried');
  });

  it('selects the calibration valid at the reading time', () => {
    const window = resampleClimateWindow([sample('sensor-1', 0, 20), sample('sensor-1', 2, 20)], [
      {
        sensorId: 'sensor-1',
        validFrom: '2025-01-01T00:00:00.000Z',
        validTo: '2026-01-01T00:01:00.000Z',
        temperatureOffsetC: 1,
        humidityOffsetPct: 0,
        confidence: 1,
        method: 'manual',
      },
      {
        sensorId: 'sensor-1',
        validFrom: '2026-01-01T00:01:00.000Z',
        temperatureOffsetC: -1,
        humidityOffsetPct: 0,
        confidence: 1,
        method: 'manual',
      },
    ], {
      startAt: '2026-01-01T00:00:00.000Z',
      endAt: '2026-01-01T00:02:00.000Z',
    });
    expect(window.points[0]?.calibratedTemperatureC).toBe(21);
    expect(window.points.at(-1)?.calibratedTemperatureC).toBe(19);
  });

  it('aligns a calibrated sensor response delay and caps low-confidence quality', () => {
    const delayed = sample('sensor-1', 5, 20, 45);
    const highConfidence = resampleClimateWindow([delayed], [{
      sensorId: 'sensor-1',
      validFrom: '2025-01-01T00:00:00.000Z',
      temperatureOffsetC: 0,
      humidityOffsetPct: 0,
      responseLagSeconds: 120,
      confidence: 1,
      method: 'co-location',
    }], {
      startAt: '2026-01-01T00:00:00.000Z',
      endAt: '2026-01-01T00:05:00.000Z',
    });
    const lowConfidence = resampleClimateWindow([delayed], [{
      sensorId: 'sensor-1',
      validFrom: '2025-01-01T00:00:00.000Z',
      temperatureOffsetC: 0,
      humidityOffsetPct: 0,
      responseLagSeconds: 120,
      confidence: 0,
      method: 'estimated',
    }], {
      startAt: '2026-01-01T00:00:00.000Z',
      endAt: '2026-01-01T00:05:00.000Z',
    });
    expect(highConfidence.points[0]?.bucketAt).toBe('2026-01-01T00:03:00.000Z');
    expect(highConfidence.points[0]?.appliedResponseLagSeconds).toBe(120);
    expect(lowConfidence.points[0]?.bucketAt).toBe('2026-01-01T00:05:00.000Z');
    expect(lowConfidence.points[0]?.appliedResponseLagSeconds).toBe(0);
    expect(lowConfidence.points[0]?.pointQuality).toBeLessThan(highConfidence.points[0]?.pointQuality ?? 0);
  });

  it('quarantines malformed and post-calibration invalid readings', () => {
    const window = resampleClimateWindow([
      sample('sensor-1', 0),
      { ...sample('sensor-2', 0), relativeHumidityPct: 110 },
      { ...sample('sensor-3', 0), observedAt: 'not-a-time' },
    ], [{
      sensorId: 'sensor-1',
      validFrom: '2025-01-01T00:00:00.000Z',
      temperatureOffsetC: 0,
      humidityOffsetPct: 60,
      confidence: 1,
      method: 'manual',
    }], {
      startAt: '2026-01-01T00:00:00.000Z',
      endAt: '2026-01-01T00:01:00.000Z',
    });
    expect(window.points).toHaveLength(0);
    expect(window.rejected.map((item) => item.sensorId).sort()).toEqual(['sensor-1', 'sensor-2', 'sensor-3']);
  });

  it('marks missing/stale sensors and only calls a stable sensor flatlined when peers vary', () => {
    const topology = createFiveZoneTopology();
    const samples: SpatialClimateSample[] = [];
    for (let minute = 0; minute <= 8; minute += 1) {
      samples.push(sample('sensor-1', minute, 20, 45));
      samples.push(sample('sensor-2', minute, 20 + minute * 0.15, 45 + minute * 0.7));
    }
    const window = resampleClimateWindow(samples, [], {
      startAt: '2026-01-01T00:00:00.000Z',
      endAt: '2026-01-01T00:12:00.000Z',
      maximumCarryForwardSeconds: 120,
    });
    const quality = assessSensorQuality(window, topology, { staleFloorSeconds: 120 });
    expect(quality.find((item) => item.sensorId === 'sensor-1')?.reasons).toContain('flatline');
    expect(quality.find((item) => item.sensorId === 'sensor-3')?.state).toBe('offline');
    expect(quality.find((item) => item.sensorId === 'sensor-1')?.reasons).toContain('uncalibrated');
  });
});
