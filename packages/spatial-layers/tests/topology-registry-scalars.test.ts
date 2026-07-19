import { describe, expect, it } from 'vitest';

import {
  ClimateScalarEngine,
  GraphPropagationEngine,
  SpatialLayerEngineRegistry,
  UnexplainedActivityEngine,
  areAdjacent,
  createBuiltinSpatialLayerRegistry,
  createFiveZoneSimulation,
  createFiveZoneTopology,
  validateTopology,
  type SpatialLayerEngine,
} from '../src/index.js';

describe('topology, registry, and scalar layers', () => {
  it('validates references, self-connections, polygons, and overlapping bindings', () => {
    const topology = createFiveZoneTopology();
    topology.connections.push({
      id: 'bad-edge',
      zoneAId: 'kitchen',
      zoneBId: 'missing',
      kind: 'unknown',
      enabled: true,
    });
    topology.connections.push({
      id: 'self-edge',
      zoneAId: 'main',
      zoneBId: 'main',
      kind: 'unknown',
      enabled: true,
    });
    topology.sensorBindings.push({
      ...topology.sensorBindings[0]!,
      zoneId: 'main',
      activeFrom: '2025-01-01T00:00:00.000Z',
    });
    topology.zones[0]!.polygon = [{ x: 0, y: 0 }, { x: 1, y: 0 }];
    const result = validateTopology(topology);
    expect(result.valid).toBe(false);
    expect(result.issues.map((issue) => issue.code)).toEqual(
      expect.arrayContaining(['unknown-zone', 'self-connection', 'duplicate-active-binding', 'invalid-polygon']),
    );
  });

  it('only reports configured enabled adjacency', () => {
    const topology = createFiveZoneTopology();
    expect(areAdjacent(topology, 'kitchen', 'main')).toBe(true);
    expect(areAdjacent(topology, 'kitchen', 'bedroom')).toBe(false);
    topology.connections[0]!.enabled = false;
    expect(areAdjacent(topology, 'kitchen', 'main')).toBe(false);
  });

  it('emits renderer-neutral scalar layers with stable coordinates for a house', () => {
    const { input } = createFiveZoneSimulation({ scenario: 'baseline' });
    const snapshots = new ClimateScalarEngine().infer(input);
    expect(snapshots.map((snapshot) => snapshot.layerId)).toEqual([
      'climate.temperature',
      'climate.relative-humidity',
      'climate.absolute-humidity',
      'climate.humidity-ratio',
      'sensor.quality',
    ]);
    const temperature = snapshots[0]!;
    expect(temperature.scope.kind).toBe('house');
    expect(temperature.coordinateFrames).toEqual(input.topology.frames);
    expect(temperature.zones).toHaveLength(5);
    expect(temperature.points).toHaveLength(5);
    expect(temperature.zones[0]?.frameId).toBe('ground-frame');
    expect(temperature.zones[0]?.anchor).toBeDefined();
    const serialized = JSON.stringify(snapshots);
    expect(serialized).not.toContain('Â');
    expect(serialized).not.toMatch(/svg|three|particle|animation/i);
    expect(serialized).toContain('degC');
    expect(serialized).toContain('g/m3');
  });

  it('uses the same scalar engine for property building zones and site sensor points', () => {
    const { input } = createFiveZoneSimulation({ scopeKind: 'property' });
    const snapshot = new ClimateScalarEngine().infer(input)[0]!;
    expect(snapshot.scope.kind).toBe('property');
    expect(snapshot.zones).toHaveLength(5);
    expect(snapshot.points).toHaveLength(5);
    expect(input.topology.frames[0]?.kind).toBe('property-local-3d');
    expect(input.topology.frames[0]?.version).toBe('1');
  });

  it('keeps carried readings in the binding valid at their source timestamp', () => {
    const { input } = createFiveZoneSimulation({ scenario: 'baseline' });
    input.samples = [input.samples.find((sample) => sample.sensorId === 'sensor-1')!];
    input.samples[0]!.observedAt = '2026-01-01T00:00:00.000Z';
    input.windowStart = '2026-01-01T00:00:00.000Z';
    input.windowEnd = '2026-01-01T00:03:00.000Z';
    input.generatedAt = input.windowEnd;
    const original = input.topology.sensorBindings.find((binding) => binding.sensorId === 'sensor-1')!;
    input.topology.sensorBindings = [{
      ...original,
      activeFrom: '2025-01-01T00:00:00.000Z',
      activeTo: '2026-01-01T00:01:00.000Z',
    }, {
      ...original,
      zoneId: 'main',
      activeFrom: '2026-01-01T00:01:00.000Z',
    }];
    const temperature = new ClimateScalarEngine().infer(input)[0]!;
    expect(temperature.zones.map((zone) => zone.zoneId)).toEqual(['kitchen']);
    expect(temperature.points[0]?.zoneId).toBe('kitchen');
  });

  it('includes bucket resolution in model provenance', () => {
    const { input } = createFiveZoneSimulation({ scenario: 'baseline' });
    const sixty = new ClimateScalarEngine().infer({ ...input, targetBucketSeconds: 60 })[0]!;
    const thirty = new ClimateScalarEngine().infer({ ...input, targetBucketSeconds: 30 })[0]!;
    expect(thirty.inputDigest).not.toBe(sixty.inputDigest);
  });

  it('registers built-ins, prevents duplicate IDs, and runs all requested engines', async () => {
    const registry = createBuiltinSpatialLayerRegistry();
    expect(registry.list().map((manifest) => manifest.id)).toEqual([
      'climate-scalars',
      'graph-propagation',
      'unexplained-activity',
    ]);
    expect(registry.health().every((health) => health.state === 'available')).toBe(true);
    expect(() => registry.register(new ClimateScalarEngine())).toThrow(/already registered/);
    const { input } = createFiveZoneSimulation({ scenario: 'baseline' });
    const snapshots = await registry.inferAll(input);
    expect(snapshots).toHaveLength(7);
    expect(new Set(snapshots.map((snapshot) => snapshot.layerId)).size).toBe(7);

    const custom = new SpatialLayerEngineRegistry();
    expect(() => custom.resolve('missing')).toThrow(/Unknown spatial layer engine/);
  });

  it('recursively executes unrequested dependencies and records their versioned provenance', async () => {
    const registry = createBuiltinSpatialLayerRegistry();
    const { input } = createFiveZoneSimulation({ scenario: 'humidity-propagation' });
    const snapshots = await registry.inferAll(input, ['unexplained-activity']);
    expect(snapshots.map((snapshot) => snapshot.model.id)).toEqual(['graph-propagation', 'unexplained-activity']);
    const propagation = snapshots[0]!;
    const activity = snapshots[1]!;
    expect(activity.metadata?.['propagationDependencyModelVersion']).toBe(propagation.model.version);
    expect(activity.metadata?.['propagationDependencyInputDigest']).toBe(propagation.inputDigest);

    const changedDependency = structuredClone(propagation);
    changedDependency.inputDigest = 'changed-upstream-input';
    const changedActivity = new UnexplainedActivityEngine().infer({
      ...input,
      dependencySnapshots: [changedDependency],
    })[0]!;
    expect(changedActivity.inputDigest).not.toBe(activity.inputDigest);
  });

  it('passes frozen dependency snapshots and suppresses dependents after missing or failed prerequisites', async () => {
    let frozenDependencyObserved = false;
    const frozenConsumer: SpatialLayerEngine = {
      manifest: {
        id: 'frozen-consumer', version: '1.0.0', maturity: 'research', title: 'Frozen consumer', description: 'Test',
        supportedScopes: ['house'], requiredMetrics: ['temperatureC', 'relativeHumidityPct'], producedLayerIds: [],
        dependencies: ['graph-propagation'],
      },
      infer(input) {
        frozenDependencyObserved = Object.isFrozen(input.dependencySnapshots) &&
          Object.isFrozen(input.dependencySnapshots?.[0]) &&
          Object.isFrozen(input.dependencySnapshots?.[0]?.connections);
        return [];
      },
    };
    const { input } = createFiveZoneSimulation({ scenario: 'baseline' });
    await new SpatialLayerEngineRegistry()
      .register(new GraphPropagationEngine())
      .register(frozenConsumer)
      .inferAll(input, ['frozen-consumer']);
    expect(frozenDependencyObserved).toBe(true);

    let failedDependentRuns = 0;
    const failing: SpatialLayerEngine = {
      manifest: {
        id: 'failing-prerequisite', version: '1.0.0', maturity: 'research', title: 'Failing', description: 'Test',
        supportedScopes: ['house'], requiredMetrics: [], producedLayerIds: [],
      },
      infer() { throw new Error('dependency failed'); },
    };
    const failedDependent: SpatialLayerEngine = {
      manifest: {
        id: 'failed-dependent', version: '1.0.0', maturity: 'research', title: 'Dependent', description: 'Test',
        supportedScopes: ['house'], requiredMetrics: [], producedLayerIds: [], dependencies: ['failing-prerequisite'],
      },
      infer() { failedDependentRuns += 1; return []; },
    };
    await expect(new SpatialLayerEngineRegistry().register(failing).register(failedDependent)
      .inferAll(input, ['failed-dependent'])).rejects.toThrow('dependency failed');
    expect(failedDependentRuns).toBe(0);

    let missingDependentRuns = 0;
    const missingDependent: SpatialLayerEngine = {
      ...failedDependent,
      manifest: { ...failedDependent.manifest, id: 'missing-dependent', dependencies: ['not-registered'] },
      infer() { missingDependentRuns += 1; return []; },
    };
    await expect(new SpatialLayerEngineRegistry().register(missingDependent)
      .inferAll(input, ['missing-dependent'])).rejects.toThrow(/Unknown spatial layer engine/);
    expect(missingDependentRuns).toBe(0);
  });
});
