import type {
  SpatialConnection,
  SpatialLayerEngineInput,
  SpatialSensorBinding,
  SpatialTopology,
} from './contracts.js';

export type TopologyIssueCode =
  | 'scope-mismatch'
  | 'duplicate-frame'
  | 'duplicate-zone'
  | 'duplicate-connection'
  | 'duplicate-active-binding'
  | 'unknown-frame'
  | 'unknown-zone'
  | 'self-connection'
  | 'invalid-polygon'
  | 'invalid-validity-interval'
  | 'unbound-zone';

export interface TopologyIssue {
  severity: 'error' | 'warning';
  code: TopologyIssueCode;
  entityId: string;
  message: string;
}

export interface TopologyValidationResult {
  valid: boolean;
  issues: TopologyIssue[];
}

function duplicates(values: readonly string[]): Set<string> {
  const seen = new Set<string>();
  const repeated = new Set<string>();
  for (const value of values) {
    if (seen.has(value)) repeated.add(value);
    seen.add(value);
  }
  return repeated;
}

function intervalsOverlap(left: SpatialSensorBinding, right: SpatialSensorBinding): boolean {
  const leftStart = Date.parse(left.activeFrom);
  const rightStart = Date.parse(right.activeFrom);
  const leftEnd = left.activeTo === undefined ? Number.POSITIVE_INFINITY : Date.parse(left.activeTo);
  const rightEnd = right.activeTo === undefined ? Number.POSITIVE_INFINITY : Date.parse(right.activeTo);
  return leftStart < rightEnd && rightStart < leftEnd;
}

export function validateTopology(topology: SpatialTopology): TopologyValidationResult {
  const issues: TopologyIssue[] = [];
  const frameIds = new Set(topology.frames.map((frame) => frame.id));
  const zoneIds = new Set(topology.zones.map((zone) => zone.id));

  for (const id of duplicates(topology.frames.map((frame) => frame.id))) {
    issues.push({ severity: 'error', code: 'duplicate-frame', entityId: id, message: `Duplicate frame ${id}` });
  }
  for (const id of duplicates(topology.zones.map((zone) => zone.id))) {
    issues.push({ severity: 'error', code: 'duplicate-zone', entityId: id, message: `Duplicate zone ${id}` });
  }
  for (const id of duplicates(topology.connections.map((connection) => connection.id))) {
    issues.push({
      severity: 'error',
      code: 'duplicate-connection',
      entityId: id,
      message: `Duplicate connection ${id}`,
    });
  }

  for (const zone of topology.zones) {
    if (!frameIds.has(zone.frameId)) {
      issues.push({
        severity: 'error',
        code: 'unknown-frame',
        entityId: zone.id,
        message: `Zone ${zone.id} references unknown frame ${zone.frameId}`,
      });
    }
    if (zone.polygon !== undefined && zone.polygon.length < 3) {
      issues.push({
        severity: 'error',
        code: 'invalid-polygon',
        entityId: zone.id,
        message: `Zone ${zone.id} polygon needs at least three points`,
      });
    }
  }

  for (const connection of topology.connections) {
    if (!zoneIds.has(connection.zoneAId) || !zoneIds.has(connection.zoneBId)) {
      issues.push({
        severity: 'error',
        code: 'unknown-zone',
        entityId: connection.id,
        message: `Connection ${connection.id} references an unknown zone`,
      });
    }
    if (connection.zoneAId === connection.zoneBId) {
      issues.push({
        severity: 'error',
        code: 'self-connection',
        entityId: connection.id,
        message: `Connection ${connection.id} cannot connect a zone to itself`,
      });
    }
  }

  const bindingsBySensor = new Map<string, SpatialSensorBinding[]>();
  for (const binding of topology.sensorBindings) {
    if (!zoneIds.has(binding.zoneId)) {
      issues.push({
        severity: 'error',
        code: 'unknown-zone',
        entityId: binding.sensorId,
        message: `Sensor ${binding.sensorId} references unknown zone ${binding.zoneId}`,
      });
    }
    if (!frameIds.has(binding.frameId)) {
      issues.push({
        severity: 'error',
        code: 'unknown-frame',
        entityId: binding.sensorId,
        message: `Sensor ${binding.sensorId} references unknown frame ${binding.frameId}`,
      });
    }
    const start = Date.parse(binding.activeFrom);
    const end = binding.activeTo === undefined ? Number.POSITIVE_INFINITY : Date.parse(binding.activeTo);
    if (!Number.isFinite(start) || Number.isNaN(end) || end <= start) {
      issues.push({
        severity: 'error',
        code: 'invalid-validity-interval',
        entityId: binding.sensorId,
        message: `Sensor ${binding.sensorId} has an invalid binding interval`,
      });
    }
    const existing = bindingsBySensor.get(binding.sensorId) ?? [];
    for (const other of existing) {
      if (intervalsOverlap(binding, other)) {
        issues.push({
          severity: 'error',
          code: 'duplicate-active-binding',
          entityId: binding.sensorId,
          message: `Sensor ${binding.sensorId} has overlapping bindings`,
        });
      }
    }
    existing.push(binding);
    bindingsBySensor.set(binding.sensorId, existing);
  }

  const boundZoneIds = new Set(topology.sensorBindings.map((binding) => binding.zoneId));
  for (const zone of topology.zones) {
    if (zone.kind !== 'outdoor' && !boundZoneIds.has(zone.id)) {
      issues.push({
        severity: 'warning',
        code: 'unbound-zone',
        entityId: zone.id,
        message: `Zone ${zone.id} has no climate sensor`,
      });
    }
  }

  return { valid: issues.every((issue) => issue.severity !== 'error'), issues };
}

export function validateEngineInput(input: SpatialLayerEngineInput): TopologyValidationResult {
  const validation = validateTopology(input.topology);
  if (input.scope.kind !== input.topology.scope.kind || input.scope.id !== input.topology.scope.id) {
    validation.issues.unshift({
      severity: 'error',
      code: 'scope-mismatch',
      entityId: input.scope.id,
      message: 'Engine input scope does not match topology scope',
    });
    validation.valid = false;
  }
  return validation;
}

export function activeBindingAt(
  bindings: readonly SpatialSensorBinding[],
  sensorId: string,
  observedAt: string,
): SpatialSensorBinding | undefined {
  const timestamp = Date.parse(observedAt);
  return bindings.find((binding) => {
    if (binding.sensorId !== sensorId) return false;
    const start = Date.parse(binding.activeFrom);
    const end = binding.activeTo === undefined ? Number.POSITIVE_INFINITY : Date.parse(binding.activeTo);
    return timestamp >= start && timestamp < end;
  });
}

export function enabledConnections(topology: SpatialTopology): SpatialConnection[] {
  return topology.connections.filter((connection) => connection.enabled);
}

export function buildAdjacency(topology: SpatialTopology): Map<string, Array<{ zoneId: string; connectionId: string }>> {
  const adjacency = new Map<string, Array<{ zoneId: string; connectionId: string }>>();
  for (const zone of topology.zones) adjacency.set(zone.id, []);
  for (const connection of enabledConnections(topology)) {
    adjacency.get(connection.zoneAId)?.push({ zoneId: connection.zoneBId, connectionId: connection.id });
    adjacency.get(connection.zoneBId)?.push({ zoneId: connection.zoneAId, connectionId: connection.id });
  }
  return adjacency;
}

export function areAdjacent(topology: SpatialTopology, leftZoneId: string, rightZoneId: string): boolean {
  return enabledConnections(topology).some(
    (connection) =>
      (connection.zoneAId === leftZoneId && connection.zoneBId === rightZoneId) ||
      (connection.zoneAId === rightZoneId && connection.zoneBId === leftZoneId),
  );
}
