import { describe, expect, it } from 'vitest';

import { createFiveZoneSimulation } from '../src/index.js';
import { connectionValue } from '../src/propagation-engine.js';
import { propagationConfig, type DirectedPropagationEvidence, type EdgePropagationEvidence } from '../src/propagation-signals.js';

function directed(fromZoneId: string, toZoneId: string, evidenceScore: number, matchedEventCount: number, sourceEventCount = matchedEventCount): DirectedPropagationEvidence {
  return {
    fromZoneId,
    toZoneId,
    evidenceScore,
    matchedEventCount,
    sourceEventCount,
    lagSeconds: 120,
    temperatureEvidence: evidenceScore / 2,
    humidityEvidence: evidenceScore,
    matches: [],
  };
}

function fixture() {
  const { input } = createFiveZoneSimulation({ scenario: 'humidity-propagation' });
  const connection = input.topology.connections.find((candidate) => candidate.id === 'kitchen-main')!;
  const edge = (forwardScore: number, reverseScore: number, overrides: Partial<EdgePropagationEvidence> = {}): EdgePropagationEvidence => ({
    connection,
    forward: directed(connection.zoneAId, connection.zoneBId, forwardScore, 3),
    reverse: directed(connection.zoneBId, connection.zoneAId, reverseScore, 3),
    endpointCoverage: 0.9,
    ...overrides,
  });
  return { input, connection, edge, config: propagationConfig(input) };
}

describe('connection propagation classification', () => {
  it('classifies coverage, direction, bidirectional and absent evidence', () => {
    const { input, connection, edge, config } = fixture();
    const classify = (value: EdgePropagationEvidence) => {
      const result = connectionValue(input, value, config);
      return { state: result.state, from: result.fromZoneId, to: result.toZoneId, direction: result.style?.direction, reasons: result.reasonCodes };
    };

    expect(classify(edge(0.9, 0.1, { endpointCoverage: 0.2 }))).toEqual({
      state: 'insufficient-data', from: null, to: null, direction: 'none', reasons: ['insufficient-endpoint-coverage'],
    });
    expect(classify(edge(0.8, 0.75))).toEqual({
      state: 'bidirectional-evidence', from: null, to: null, direction: 'both', reasons: ['distinct-events-support-both-directions'],
    });
    expect(classify(edge(0.9, 0.2))).toEqual({
      state: 'directed', from: connection.zoneAId, to: connection.zoneBId, direction: 'a-to-b', reasons: ['repeated-delayed-propagation-evidence'],
    });
    expect(classify(edge(0.2, 0.9))).toEqual({
      state: 'directed', from: connection.zoneBId, to: connection.zoneAId, direction: 'b-to-a', reasons: ['repeated-delayed-propagation-evidence'],
    });
    expect(classify(edge(0.1, 0.1))).toEqual({
      state: 'no-detectable-propagation', from: null, to: null, direction: 'none', reasons: ['events-present-without-repeatable-edge-propagation'],
    });
    expect(classify(edge(0.1, 0.1, {
      forward: directed(connection.zoneAId, connection.zoneBId, 0.1, 0, 0),
      reverse: directed(connection.zoneBId, connection.zoneAId, 0.1, 0, 0),
    }))).toEqual({
      state: 'uncertain', from: null, to: null, direction: 'none', reasons: ['no-distinct-qualifying-events'],
    });
  });

  it('discounts evidence during a known confounding source and styles the edge', () => {
    const { input, connection, edge, config } = fixture();
    const withContext = {
      ...input,
      contextEvents: [{
        id: 'shower',
        kind: 'persistent-environmental-source' as const,
        startAt: input.windowStart,
        zoneIds: [connection.zoneAId],
        strength: 1,
      }],
    };

    const discounted = connectionValue(withContext as typeof input, edge(0.9, 0.2), config);
    expect(discounted.metrics.contextPenalty!.value).toBe(1);
    expect(discounted.metrics.forwardEvidenceStrength!.value).toBeCloseTo(0.225);
    expect(discounted.reasonCodes).toContain('known-source-context-penalty');
    expect(discounted.state).toBe('no-detectable-propagation');
    expect(discounted.style).toMatchObject({ palette: 'air', lineStyle: 'dotted', direction: 'none' });

    const strong = connectionValue(input, edge(0.9, 0.2), config);
    expect(strong.style).toMatchObject({ palette: 'air', lineStyle: 'solid', direction: 'a-to-b', emphasis: 0.9 });
    expect(strong.style?.opacity).toBeCloseTo(0.25 + 0.9 * 0.75);
    expect(connectionValue(input, edge(0.8, 0.75), config).style?.lineStyle).toBe('dashed');
    expect(connectionValue(input, edge(0.9, 0.1, { endpointCoverage: 0.2 }), config).style)
      .toMatchObject({ palette: 'neutral', opacity: 0.25 });
  });

  it('draws configured anchors in a shared frame or falls back to zone centroids', () => {
    const { input, connection, edge, config } = fixture();
    const zoneA = input.topology.zones.find((zone) => zone.id === connection.zoneAId)!;
    const zoneB = input.topology.zones.find((zone) => zone.id === connection.zoneBId)!;
    const { anchors: _configuredAnchors, ...withoutAnchors } = connection;

    const centroids = connectionValue(input, edge(0.9, 0.2, { connection: withoutAnchors }), config);
    expect(centroids.anchors).toEqual([zoneA.centroid, zoneB.centroid]);
    expect(centroids.anchorRefs).toEqual([
      { frameId: zoneA.frameId, position: zoneA.centroid },
      { frameId: zoneB.frameId, position: zoneB.centroid },
    ]);

    const anchors = [{ x: 1, y: 2, z: 0 }, { x: 3, y: 4, z: 0 }];
    const configured = connectionValue(input, edge(0.9, 0.2, { connection: { ...connection, anchors } }), config);
    expect(configured.anchors).toEqual(anchors);
    if (zoneA.frameId === zoneB.frameId) {
      expect(configured.frameId).toBe(zoneA.frameId);
      expect(configured.anchorRefs).toEqual(anchors.map((position) => ({ frameId: zoneA.frameId, position })));
    }

    const crossFrameInput = {
      ...input,
      topology: {
        ...input.topology,
        zones: input.topology.zones.map((zone) => (zone.id === zoneB.id ? { ...zone, frameId: 'other-frame' } : zone)),
      },
    };
    const crossFrame = connectionValue(crossFrameInput, edge(0.9, 0.2, { connection: { ...connection, anchors } }), config);
    expect(crossFrame.frameId).toBeUndefined();
    expect(crossFrame.anchors).toEqual(anchors);
    expect(crossFrame.anchorRefs).toBeUndefined();
    expect(Object.keys(crossFrame)).not.toContain('frameId');
  });
});
