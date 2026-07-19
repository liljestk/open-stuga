import type {
  SpatialClimateSample,
  SpatialContextEvent,
  SpatialLayerEngineInput,
  SpatialSensorCalibration,
  SpatialTopology,
} from './contracts.js';

export type FiveZoneScenario =
  | 'baseline'
  | 'humidity-propagation'
  | 'common-mode-heating'
  | 'exterior-infiltration'
  | 'local-activity'
  | 'dehumidifier'
  | 'sensor-offset'
  | 'sensor-dropout'
  | 'simultaneous-activity';

export interface FiveZoneSimulationOptions {
  scenario?: FiveZoneScenario;
  scopeKind?: 'house' | 'property';
  startAt?: string;
  durationMinutes?: number;
  cadenceSeconds?: 30 | 60;
}

export interface FiveZoneSimulation {
  input: SpatialLayerEngineInput;
  expected: {
    propagationPath: string[];
    activityZoneIds: string[];
    confoundedZoneIds: string[];
    droppedSensorIds: string[];
  };
}

const ZONES = [
  { id: 'kitchen', name: 'Kitchen', x: 1, y: 1, floorId: 'ground' },
  { id: 'main', name: 'Main room', x: 3, y: 1, floorId: 'ground' },
  { id: 'bedroom', name: 'Bedroom', x: 5, y: 1, floorId: 'ground' },
  { id: 'entry', name: 'Entry', x: 3, y: 3, floorId: 'ground' },
  { id: 'cellar', name: 'Cellar', x: 3, y: 1, floorId: 'cellar' },
] as const;

export function createFiveZoneTopology(scopeKind: 'house' | 'property' = 'house'): SpatialTopology {
  const scope = { kind: scopeKind, id: scopeKind === 'house' ? 'house-five-zone' : 'property-five-zone' } as const;
  return {
    scope,
    frames: [
      { id: 'ground-frame', version: '1', kind: scopeKind === 'house' ? 'floor-plan-2d' : 'property-local-3d', unit: 'm', floorId: 'ground' },
      { id: 'cellar-frame', version: '1', kind: 'building-local-3d', unit: 'm', floorId: 'cellar', origin: { x: 0, y: 0, z: 0 } },
    ],
    zones: ZONES.map((zone) => ({
      id: zone.id,
      name: zone.name,
      kind: scopeKind === 'property' && zone.id !== 'entry' ? 'building' : zone.id === 'cellar' ? 'cellar' : 'indoor',
      frameId: zone.floorId === 'cellar' ? 'cellar-frame' : 'ground-frame',
      floorId: zone.floorId,
      ...(scopeKind === 'house' ? { roomId: zone.id } : {}),
      centroid: { x: zone.x, y: zone.y, z: zone.floorId === 'cellar' ? -2.5 : 0 },
      polygon: [
        { x: zone.x - 0.8, y: zone.y - 0.8 },
        { x: zone.x + 0.8, y: zone.y - 0.8 },
        { x: zone.x + 0.8, y: zone.y + 0.8 },
        { x: zone.x - 0.8, y: zone.y + 0.8 },
      ],
      heightM: 2.4,
      volumeM3: 28,
      isEntryZone: zone.id === 'entry',
    })),
    connections: [
      { id: 'kitchen-main', zoneAId: 'kitchen', zoneBId: 'main', kind: 'open-passage', enabled: true, normallyOpen: true },
      { id: 'main-bedroom', zoneAId: 'main', zoneBId: 'bedroom', kind: 'door', enabled: true, normallyOpen: true },
      { id: 'main-entry', zoneAId: 'main', zoneBId: 'entry', kind: 'door', enabled: true, normallyOpen: true },
      { id: 'main-cellar', zoneAId: 'main', zoneBId: 'cellar', kind: 'stair', enabled: true, normallyOpen: false },
    ],
    sensorBindings: ZONES.map((zone, index) => ({
      sensorId: `sensor-${index + 1}`,
      zoneId: zone.id,
      frameId: zone.floorId === 'cellar' ? 'cellar-frame' : 'ground-frame',
      position: { x: zone.x, y: zone.y, z: zone.floorId === 'cellar' ? -1.4 : 1.1 },
      role: 'primary',
      activeFrom: '2020-01-01T00:00:00.000Z',
      placementRisks: [],
    })),
  };
}

function gaussian(minute: number, center: number, width: number): number {
  const scaled = (minute - center) / width;
  return Math.exp(-0.5 * scaled * scaled);
}

function smoothStep(minute: number, start: number, riseMinutes = 4): number {
  if (minute < start) return 0;
  return 1 - Math.exp(-(minute - start) / riseMinutes);
}

function deterministicNoise(minute: number, sensorIndex: number): { temperature: number; humidity: number } {
  return {
    temperature: 0.025 * Math.sin(minute * 0.41 + sensorIndex * 1.7),
    humidity: 0.08 * Math.sin(minute * 0.31 + sensorIndex * 1.1),
  };
}

export function createFiveZoneSimulation(options: FiveZoneSimulationOptions = {}): FiveZoneSimulation {
  const scenario = options.scenario ?? 'baseline';
  const scopeKind = options.scopeKind ?? 'house';
  const start = Date.parse(options.startAt ?? '2026-01-15T08:00:00.000Z');
  const durationMinutes = options.durationMinutes ?? 120;
  const cadenceSeconds = options.cadenceSeconds ?? 60;
  const topology = createFiveZoneTopology(scopeKind);
  const samples: SpatialClimateSample[] = [];
  const contextEvents: SpatialContextEvent[] = [];
  const calibrations: SpatialSensorCalibration[] = topology.sensorBindings.map((binding) => ({
    sensorId: binding.sensorId,
    validFrom: '2020-01-01T00:00:00.000Z',
    temperatureOffsetC: scenario === 'sensor-offset' && binding.sensorId === 'sensor-3' ? -1.4 : 0,
    humidityOffsetPct: 0,
    confidence: 0.95,
    method: 'co-location',
  }));

  for (let seconds = 0; seconds <= durationMinutes * 60; seconds += cadenceSeconds) {
    const minute = seconds / 60;
    for (let sensorIndex = 0; sensorIndex < topology.sensorBindings.length; sensorIndex += 1) {
      const binding = topology.sensorBindings[sensorIndex];
      if (binding === undefined) continue;
      if (scenario === 'sensor-dropout' && binding.sensorId === 'sensor-3' && minute > 65) continue;
      const noise = deterministicNoise(minute, sensorIndex);
      let temperature = 20 + sensorIndex * 0.12 + noise.temperature;
      let humidity = 43 + sensorIndex * 0.35 + noise.humidity;
      if (binding.zoneId === 'cellar') {
        temperature -= 3;
        humidity += 15;
      }
      if (scenario === 'humidity-propagation') {
        const delays: Record<string, number> = { kitchen: 0, main: 5, bedroom: 10 };
        const delay = delays[binding.zoneId];
        if (delay !== undefined) {
          humidity += 7 * gaussian(minute, 30 + delay, 3.4) + 6 * gaussian(minute, 75 + delay, 3.4);
          temperature += 0.65 * gaussian(minute, 30 + delay, 4) + 0.55 * gaussian(minute, 75 + delay, 4);
        }
      }
      if (scenario === 'common-mode-heating') {
        temperature += 2.2 * smoothStep(minute, 45, 6);
        humidity -= 2.5 * smoothStep(minute, 45, 6);
      }
      if (scenario === 'exterior-infiltration') {
        if (binding.zoneId === 'entry') {
          temperature -= 2.4 * gaussian(minute, 55, 5);
          humidity -= 5 * gaussian(minute, 55, 5);
        }
        if (binding.zoneId === 'main') {
          temperature -= 1.2 * gaussian(minute, 61, 6);
          humidity -= 2.5 * gaussian(minute, 61, 6);
        }
      }
      if (scenario === 'local-activity' && binding.zoneId === 'kitchen') {
        temperature += 1.1 * smoothStep(minute, 92, 5);
        humidity += 5.5 * smoothStep(minute, 92, 5);
      }
      if (scenario === 'dehumidifier' && binding.zoneId === 'cellar') {
        humidity -= 8 * smoothStep(minute, 75, 8);
        temperature += 0.5 * smoothStep(minute, 75, 8);
      }
      if (scenario === 'simultaneous-activity' && (binding.zoneId === 'kitchen' || binding.zoneId === 'bedroom')) {
        const startMinute = binding.zoneId === 'kitchen' ? 92 : 96;
        temperature += 1 * smoothStep(minute, startMinute, 5);
        humidity += 5 * smoothStep(minute, startMinute, 5);
      }
      if (scenario === 'sensor-offset' && binding.sensorId === 'sensor-3') temperature += 1.4;
      const observedAt = new Date(start + seconds * 1000).toISOString();
      samples.push({
        sensorId: binding.sensorId,
        observedAt,
        receivedAt: new Date(start + seconds * 1000 + 500).toISOString(),
        temperatureC: temperature,
        relativeHumidityPct: humidity,
        pressureHpa: 1004,
        pressureSource: 'observed',
        sourceQuality: 0.98,
        sourceSequence: `${binding.sensorId}:${seconds}`,
      });
    }
  }
  if (scenario === 'common-mode-heating') {
    contextEvents.push({ id: 'heat-pump-1', kind: 'heat-pump-change', startAt: new Date(start + 45 * 60_000).toISOString(), strength: 1 });
  }
  if (scenario === 'exterior-infiltration') {
    contextEvents.push({ id: 'door-1', kind: 'door-open', startAt: new Date(start + 52 * 60_000).toISOString(), endAt: new Date(start + 58 * 60_000).toISOString(), zoneIds: ['entry'], strength: 1 });
  }
  if (scenario === 'dehumidifier') {
    contextEvents.push({ id: 'dehumidifier-1', kind: 'dehumidifier-change', startAt: new Date(start + 75 * 60_000).toISOString(), zoneIds: ['cellar'], strength: 1 });
  }
  const scope = topology.scope;
  const input: SpatialLayerEngineInput = {
    scope,
    topology,
    samples,
    calibrations,
    contextEvents,
    generatedAt: new Date(start + durationMinutes * 60_000).toISOString(),
    windowStart: new Date(start).toISOString(),
    windowEnd: new Date(start + durationMinutes * 60_000).toISOString(),
    configVersion: 'simulator-v1',
    targetBucketSeconds: cadenceSeconds,
    config: {
      propagationMinimumDistinctEvents: 2,
      propagationMaximumLagBuckets: 20,
      activityMaximumAgeBuckets: 35,
    },
  };
  return {
    input,
    expected: {
      propagationPath: scenario === 'humidity-propagation' ? ['kitchen', 'main', 'bedroom'] : [],
      activityZoneIds: scenario === 'local-activity'
        ? ['kitchen']
        : scenario === 'simultaneous-activity'
          ? ['kitchen', 'bedroom']
          : [],
      confoundedZoneIds: scenario === 'dehumidifier'
        ? ['cellar']
        : scenario === 'common-mode-heating'
          ? topology.zones.map((zone) => zone.id)
          : scenario === 'exterior-infiltration'
            ? ['entry']
            : [],
      droppedSensorIds: scenario === 'sensor-dropout' ? ['sensor-3'] : [],
    },
  };
}
