import { describe, expect, it } from 'vitest';

import {
  GraphPropagationEngine,
  UnexplainedActivityEngine,
  createFiveZoneSimulation,
  type SpatialLayerEngineInput,
  type SpatialLayerSnapshot,
} from '../src/index.js';

function metricNumber(value: unknown): number {
  expect(typeof value).toBe('number');
  return value as number;
}

function inferActivity(input: SpatialLayerEngineInput): SpatialLayerSnapshot {
  const dependencySnapshots = new GraphPropagationEngine().infer(input);
  return new UnexplainedActivityEngine().infer({ ...input, dependencySnapshots })[0]!;
}

describe('deterministic five-zone inference replay', () => {
  it('infers repeated Kitchen -> Main -> Bedroom propagation only on configured edges', () => {
    const { input } = createFiveZoneSimulation({ scenario: 'humidity-propagation' });
    const snapshot = new GraphPropagationEngine().infer(input)[0]!;
    const kitchenMain = snapshot.connections.find((edge) => edge.connectionId === 'kitchen-main')!;
    const mainBedroom = snapshot.connections.find((edge) => edge.connectionId === 'main-bedroom')!;
    expect(kitchenMain.state).toBe('directed');
    expect(kitchenMain.fromZoneId).toBe('kitchen');
    expect(kitchenMain.toZoneId).toBe('main');
    expect(mainBedroom.state).toBe('directed');
    expect(mainBedroom.fromZoneId).toBe('main');
    expect(mainBedroom.toZoneId).toBe('bedroom');
    expect(metricNumber(kitchenMain.metrics.lagSeconds?.value)).toBeGreaterThanOrEqual(240);
    expect(metricNumber(kitchenMain.metrics.matchedEventCount?.value)).toBeGreaterThanOrEqual(2);
    expect(snapshot.connections).toHaveLength(input.topology.connections.length);
    expect(snapshot.connections.some((edge) => edge.connectionId === 'kitchen-bedroom')).toBe(false);
  });

  it('matches propagation only during intervals when the connection stays open', () => {
    const { input } = createFiveZoneSimulation({ scenario: 'humidity-propagation' });
    const start = Date.parse(input.windowStart);
    const atMinute = (minute: number): string => new Date(start + minute * 60_000).toISOString();
    input.topology.connections.find((connection) => connection.id === 'kitchen-main')!.enabled = false;

    input.connectionStateIntervals = [
      { connectionId: 'kitchen-main', startAt: atMinute(0), endAt: atMinute(40), enabled: false, openFraction: 0 },
      { connectionId: 'kitchen-main', startAt: atMinute(40), endAt: atMinute(65), enabled: true, openFraction: 1 },
      { connectionId: 'kitchen-main', startAt: atMinute(65), endAt: atMinute(121), enabled: false, openFraction: 0 },
    ];
    const closedDuringEvents = new GraphPropagationEngine().infer(input)[0]!;
    expect(closedDuringEvents.connections.find((edge) => edge.connectionId === 'kitchen-main')).toMatchObject({
      state: 'no-detectable-propagation',
      fromZoneId: null,
      toZoneId: null,
    });

    input.connectionStateIntervals = [
      { connectionId: 'kitchen-main', startAt: atMinute(0), endAt: atMinute(40), enabled: true, openFraction: 1 },
      { connectionId: 'kitchen-main', startAt: atMinute(40), endAt: atMinute(65), enabled: false, openFraction: 0 },
      { connectionId: 'kitchen-main', startAt: atMinute(65), endAt: atMinute(90), enabled: true, openFraction: 1 },
      { connectionId: 'kitchen-main', startAt: atMinute(90), endAt: atMinute(121), enabled: false, openFraction: 0 },
    ];
    const openDuringEvents = new GraphPropagationEngine().infer(input)[0]!;
    expect(openDuringEvents.connections.find((edge) => edge.connectionId === 'kitchen-main')).toMatchObject({
      state: 'directed',
      fromZoneId: 'kitchen',
      toZoneId: 'main',
    });
    expect(openDuringEvents.inputDigest).not.toBe(closedDuringEvents.inputDigest);
  });

  it('abstains from direction on a simultaneous common-mode heating event', () => {
    const { input } = createFiveZoneSimulation({ scenario: 'common-mode-heating' });
    const snapshot = new GraphPropagationEngine().infer(input)[0]!;
    expect(snapshot.connections.every((edge) => edge.state !== 'directed')).toBe(true);
    expect(snapshot.connections.every((edge) => edge.fromZoneId === null && edge.toZoneId === null)).toBe(true);
  });

  it('uses evidence scores, never probabilities, physical flow, or current-airflow claims', () => {
    const { input } = createFiveZoneSimulation({ scenario: 'humidity-propagation' });
    const snapshot = new GraphPropagationEngine().infer(input)[0]!;
    const metricKeys = snapshot.connections.flatMap((connection) => Object.keys(connection.metrics));
    expect(metricKeys).toContain('evidenceStrength');
    expect(metricKeys.join(' ')).not.toMatch(/probability|flowRate|exchangeRate|velocity/i);
    expect(snapshot.metadata?.['physicallyCalibrated']).toBe(false);
    expect(snapshot.metadata?.['emitsFlowRate']).toBe(false);
    expect(snapshot.warnings.join(' ')).toMatch(/not a measurement of current airflow/i);
  });

  it('marks a connection with a dropped endpoint as insufficient', () => {
    const { input } = createFiveZoneSimulation({ scenario: 'sensor-dropout' });
    const snapshot = new GraphPropagationEngine().infer(input)[0]!;
    expect(snapshot.connections.find((edge) => edge.connectionId === 'main-bedroom')?.state).toBe('insufficient-data');
  });

  it('requires three healthy indoor sensors for a house while allowing the threshold to be configured', () => {
    const { input } = createFiveZoneSimulation({ scenario: 'baseline' });
    const retained = new Set(['sensor-1', 'sensor-2']);
    input.topology.sensorBindings = input.topology.sensorBindings.filter((binding) => retained.has(binding.sensorId));
    input.samples = input.samples.filter((sample) => retained.has(sample.sensorId));
    input.calibrations = input.calibrations?.filter((calibration) => retained.has(calibration.sensorId));
    const insufficientPropagation = new GraphPropagationEngine().infer(input)[0]!;
    const insufficientActivity = inferActivity(input);
    expect(insufficientPropagation.status).toBe('insufficient_data');
    expect(insufficientPropagation.connections.every((edge) => edge.state === 'insufficient-data')).toBe(true);
    expect(insufficientPropagation.connections.every((edge) => edge.fromZoneId === null && edge.toZoneId === null)).toBe(true);
    expect(insufficientActivity.status).toBe('insufficient_data');
    expect(insufficientActivity.zones.every((zone) => zone.metrics.activityEvidenceScore?.value === 0)).toBe(true);

    input.config = { ...input.config, minimumHealthyIndoorSensors: 2 };
    expect(new GraphPropagationEngine().infer(input)[0]?.status).toBe('ready');
    expect(inferActivity(input).status).toBe('ready');
  });

  it('masks air-explained propagation from unexplained activity', () => {
    const { input } = createFiveZoneSimulation({ scenario: 'humidity-propagation' });
    const dependency = new GraphPropagationEngine().infer(input)[0]!;
    const snapshot = new UnexplainedActivityEngine().infer({ ...input, dependencySnapshots: [dependency] })[0]!;
    const bedroom = snapshot.zones.find((zone) => zone.zoneId === 'bedroom')!;
    expect(metricNumber(bedroom.metrics.airExplainedFraction?.value)).toBe(1);
    expect(metricNumber(bedroom.metrics.activityEvidenceScore?.value)).toBe(0);

    const withoutQualifiedConnection = structuredClone(dependency);
    const bedroomEdge = withoutQualifiedConnection.connections.find((edge) => edge.connectionId === 'main-bedroom')!;
    bedroomEdge.state = 'no-detectable-propagation';
    bedroomEdge.fromZoneId = null;
    bedroomEdge.toZoneId = null;
    bedroomEdge.metrics.evidenceStrength!.value = 0;
    const unmaskedSnapshot = new UnexplainedActivityEngine().infer({
      ...input,
      dependencySnapshots: [withoutQualifiedConnection],
    })[0]!;
    const unmasked = unmaskedSnapshot.zones.find((zone) => zone.zoneId === 'bedroom')!;
    expect(metricNumber(unmasked.metrics.airExplainedFraction?.value)).toBe(0);
    expect(metricNumber(unmasked.metrics.activityEvidenceScore?.value)).toBeGreaterThan(0);
    expect(unmaskedSnapshot.inputDigest).not.toBe(snapshot.inputDigest);
  });

  it('refuses to infer unexplained activity without its declared graph output', () => {
    const { input } = createFiveZoneSimulation({ scenario: 'local-activity' });
    expect(() => new UnexplainedActivityEngine().infer(input)).toThrow(/requires exactly one graph-propagation dependency/i);
  });

  it('raises a sustained local residual without emitting a trail or occupant count', () => {
    const { input } = createFiveZoneSimulation({ scenario: 'local-activity' });
    const snapshot = inferActivity(input);
    const kitchen = snapshot.zones.find((zone) => zone.zoneId === 'kitchen')!;
    expect(metricNumber(kitchen.metrics.activityEvidenceScore?.value)).toBeGreaterThan(0.7);
    expect(kitchen.metrics.state?.value).toBe('strong-unexplained-signal');
    expect(snapshot.connections).toEqual([]);
    expect(snapshot.metadata?.['emitsPeopleTrails']).toBe(false);
    expect(snapshot.metadata?.['emitsOccupantCount']).toBe(false);
    expect(snapshot.zones.flatMap((zone) => Object.keys(zone.metrics)).join(' ')).not.toMatch(/transition|occupancy|count/i);
  });

  it('retains simultaneous independent zone evidence instead of fabricating one route', () => {
    const { input } = createFiveZoneSimulation({ scenario: 'simultaneous-activity' });
    const snapshot = inferActivity(input);
    const strongZones = snapshot.zones
      .filter((zone) => metricNumber(zone.metrics.activityEvidenceScore?.value) > 0.7)
      .map((zone) => zone.zoneId)
      .sort();
    expect(strongZones).toEqual(['bedroom', 'kitchen']);
    expect(snapshot.connections).toHaveLength(0);
  });

  it('suppresses a known dehumidifier source with an explicit context reason', () => {
    const { input } = createFiveZoneSimulation({ scenario: 'dehumidifier' });
    const snapshot = inferActivity(input);
    const cellar = snapshot.zones.find((zone) => zone.zoneId === 'cellar')!;
    expect(metricNumber(cellar.metrics.contextPenalty?.value)).toBe(1);
    expect(metricNumber(cellar.metrics.activityEvidenceScore?.value)).toBe(0);
    expect(cellar.reasonCodes).toContain('context-dehumidifier-change');
  });

  it('keeps an open-ended persistent environmental source suppressed', () => {
    const { input } = createFiveZoneSimulation({ scenario: 'local-activity' });
    input.contextEvents = [{
      id: 'persistent-kitchen-source',
      kind: 'persistent-environmental-source',
      startAt: new Date(Date.parse(input.windowStart) - 24 * 60 * 60_000).toISOString(),
      zoneIds: ['kitchen'],
      strength: 1,
    }];
    const snapshot = inferActivity(input);
    const kitchen = snapshot.zones.find((zone) => zone.zoneId === 'kitchen')!;
    expect(kitchen.metrics.contextPenalty?.value).toBe(1);
    expect(kitchen.metrics.activityEvidenceScore?.value).toBe(0);
    expect(kitchen.reasonCodes).toContain('context-persistent-environmental-source');
  });

  it('is byte-for-byte deterministic for identical input', () => {
    const first = createFiveZoneSimulation({ scenario: 'humidity-propagation' });
    const second = createFiveZoneSimulation({ scenario: 'humidity-propagation' });
    expect(second.input).toEqual(first.input);
    const engine = new GraphPropagationEngine();
    expect(engine.infer(second.input)).toEqual(engine.infer(first.input));
  });

  it('uses calibration to remove a deterministic sensor offset', () => {
    const { input } = createFiveZoneSimulation({ scenario: 'sensor-offset' });
    const calibration = input.calibrations?.find((item) => item.sensorId === 'sensor-3');
    expect(calibration?.temperatureOffsetC).toBe(-1.4);
    const activity = inferActivity(input);
    expect(metricNumber(activity.zones.find((zone) => zone.zoneId === 'bedroom')?.metrics.activityEvidenceScore?.value)).toBe(0);
  });
});
