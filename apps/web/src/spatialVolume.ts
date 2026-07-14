import type { MeasurementDefinition, MeasurementSample, Sensor } from "@climate-twin/contracts";
import { measurementColor, measurementDomain, measurementValue } from "./measurements";
import { isSpatialSampleFresh, type SpatialFreshnessOptions } from "./spatialFreshness";

export interface Point3D { x: number; y: number; z: number }
export interface VolumeFieldPoint extends Point3D { value: number }

export interface VolumeBounds {
  width: number;
  depth: number;
  minZ: number;
  maxZ: number;
}

export interface VolumeCell extends VolumeFieldPoint {
  width: number;
  depth: number;
  height: number;
  color: string;
  confidence: number;
}

export interface SpatialVolume extends VolumeBounds {
  cells: VolumeCell[];
  min: number;
  max: number;
  columns: number;
  rows: number;
  layers: number;
  sampleCount: number;
  distinctZCount: number;
  anchorZSpan: number;
  verticalSupport: boolean;
  anchors: VolumeFieldPoint[];
}

export interface VolumeCloudBlob extends Point3D {
  id: string;
  radiusX: number;
  radiusY: number;
  radiusZ: number;
  value: number;
  color: string;
  opacity: number;
  level: "high" | "low" | "level";
}

export interface VolumeFlowEstimate {
  id: string;
  from: VolumeFieldPoint;
  to: VolumeFieldPoint;
  difference: number;
  strength: number;
  hasVerticalComponent: boolean;
}

export interface CameraOrbit {
  yaw: number;
  pitch: number;
  zoom: number;
}

export interface ProjectionViewport {
  width: number;
  height: number;
  padding?: number;
}

export interface ProjectedPoint3D {
  x: number;
  y: number;
  depth: number;
}

function anchorLevel(value: number, minimum: number, maximum: number): VolumeCloudBlob["level"] {
  if (maximum === minimum) return "level";
  return value === maximum ? "high" : "low";
}

function normalizedLevel(value: number): VolumeCloudBlob["level"] {
  if (value > .58) return "high";
  if (value < .42) return "low";
  return "level";
}

function safeBounds(bounds: VolumeBounds): VolumeBounds {
  return {
    width: Math.max(1, bounds.width),
    depth: Math.max(1, bounds.depth),
    minZ: Number.isFinite(bounds.minZ) ? bounds.minZ : 0,
    maxZ: Number.isFinite(bounds.maxZ) && bounds.maxZ > bounds.minZ ? bounds.maxZ : bounds.minZ + 1,
  };
}

function volumePoints(
  sensors: Sensor[],
  samples: Record<string, MeasurementSample>,
  definition: MeasurementDefinition,
  freshness: SpatialFreshnessOptions,
): VolumeFieldPoint[] {
  return sensors.flatMap((sensor) => {
    if (!sensor.enabled) return [];
    const sample = samples[sensor.id];
    if (!isSpatialSampleFresh(sample, freshness)) return [];
    const value = measurementValue(sample, definition.id);
    return value == null ? [] : [{ x: sensor.x, y: sensor.y, z: sensor.z, value }];
  });
}

function distinctZCount(points: VolumeFieldPoint[], height: number): number {
  const tolerance = Math.max(.05, height * .015);
  const levels: number[] = [];
  points.forEach((point) => {
    if (!levels.some((level) => Math.abs(level - point.z) <= tolerance)) levels.push(point.z);
  });
  return levels.length;
}

function verticalSupport(points: VolumeFieldPoint[], height: number): { anchorZSpan: number; supported: boolean } {
  if (points.length < 3) return { anchorZSpan: 0, supported: false };
  const levels = points.map((point) => point.z);
  const anchorZSpan = Math.max(...levels) - Math.min(...levels);
  return { anchorZSpan, supported: anchorZSpan >= Math.max(.5, height * .22) };
}

function pointConfidence(point: Point3D, anchors: VolumeFieldPoint[], bounds: VolumeBounds): number {
  if (!anchors.length) return 0;
  const nearest = Math.min(...anchors.map((anchor) => normalizedDistance(point, anchor, bounds)));
  return Math.max(0, Math.min(1, 1 - (nearest - .035) / .48));
}

export function interpolateVolume(
  sensors: Sensor[],
  samples: Record<string, MeasurementSample>,
  definition: MeasurementDefinition,
  requestedBounds: VolumeBounds,
  freshness: SpatialFreshnessOptions,
  resolutionColumns = 10,
): SpatialVolume {
  const bounds = safeBounds(requestedBounds);
  const height = bounds.maxZ - bounds.minZ;
  const anchors = volumePoints(sensors, samples, definition, freshness);
  const domain = measurementDomain(definition, anchors.map((point) => point.value));
  const support = verticalSupport(anchors, height);
  if (!definition.spatialInterpolation || !domain) {
    return {
      ...bounds, cells: [], min: definition.displayMin ?? 0, max: definition.displayMax ?? 1,
      columns: 0, rows: 0, layers: 0, sampleCount: anchors.length,
      distinctZCount: distinctZCount(anchors, height), anchorZSpan: support.anchorZSpan,
      verticalSupport: support.supported, anchors,
    };
  }

  const columns = Math.max(4, Math.min(14, Math.round(resolutionColumns)));
  const rows = Math.max(4, Math.min(12, Math.round(columns * bounds.depth / bounds.width)));
  const layers = Math.max(4, Math.min(9, Math.round(columns * .62)));
  const cellWidth = bounds.width / columns;
  const cellDepth = bounds.depth / rows;
  const cellHeight = height / layers;
  const minimumDistanceSquared = .055 ** 2;
  const cells: VolumeCell[] = [];

  for (let layer = 0; layer < layers; layer += 1) {
    for (let row = 0; row < rows; row += 1) {
      for (let column = 0; column < columns; column += 1) {
        const x = (column + .5) * cellWidth;
        const y = (row + .5) * cellDepth;
        const z = bounds.minZ + (layer + .5) * cellHeight;
        let weighted = 0;
        let totalWeight = 0;
        anchors.forEach((anchor) => {
          const normalizedDistanceSquared = Math.max(minimumDistanceSquared,
            ((anchor.x - x) / bounds.width) ** 2
            + ((anchor.y - y) / bounds.depth) ** 2
            + ((anchor.z - z) / height) ** 2);
          const weight = 1 / normalizedDistanceSquared;
          weighted += anchor.value * weight;
          totalWeight += weight;
        });
        const value = totalWeight ? weighted / totalWeight : domain.min;
        const confidence = pointConfidence({ x, y, z }, anchors, bounds);
        cells.push({
          x, y, z, width: cellWidth, depth: cellDepth, height: cellHeight, value,
          color: measurementColor(value, domain.min, domain.max, definition),
          confidence,
        });
      }
    }
  }

  return {
    ...bounds, cells, min: domain.min, max: domain.max, columns, rows, layers,
    sampleCount: anchors.length, distinctZCount: distinctZCount(anchors, height),
    anchorZSpan: support.anchorZSpan, verticalSupport: support.supported, anchors,
  };
}

function normalizedDistance(a: Point3D, b: Point3D, bounds: VolumeBounds): number {
  return Math.hypot(
    (a.x - b.x) / bounds.width,
    (a.y - b.y) / bounds.depth,
    (a.z - b.z) / (bounds.maxZ - bounds.minZ),
  );
}

export function createVolumeClouds(
  volume: SpatialVolume,
  definition: MeasurementDefinition,
  maximumBlobs = 22,
  colorDomain: { min: number; max: number } = volume,
): VolumeCloudBlob[] {
  if (!definition.spatialInterpolation || !volume.cells.length || maximumBlobs < 1) return [];
  const height = volume.maxZ - volume.minZ;
  if (volume.sampleCount <= 2) {
    const anchorMin = Math.min(...volume.anchors.map((anchor) => anchor.value));
    const anchorMax = Math.max(...volume.anchors.map((anchor) => anchor.value));
    return volume.anchors.map((anchor, index) => ({
      id: `anchor-${index}`,
      x: anchor.x, y: anchor.y, z: anchor.z,
      radiusX: Math.max(volume.width * .095, volume.cells[0]!.width * 1.8),
      radiusY: Math.max(volume.depth * .095, volume.cells[0]!.depth * 1.8),
      radiusZ: Math.max(height * .095, volume.cells[0]!.height * 1.6),
      value: anchor.value,
      color: measurementColor(anchor.value, colorDomain.min, colorDomain.max, definition),
      opacity: .38,
      level: anchorLevel(anchor.value, anchorMin, anchorMax),
    }));
  }

  const actualMin = Math.min(...volume.cells.map((cell) => cell.value));
  const actualMax = Math.max(...volume.cells.map((cell) => cell.value));
  const actualRange = actualMax - actualMin;
  const supportedCells = volume.cells.filter((cell) => cell.confidence >= .22);
  if (!supportedCells.length) return [];
  const orderedHigh = [...supportedCells].sort((a, b) => b.value - a.value);
  const orderedLow = [...supportedCells].sort((a, b) => a.value - b.value);
  const candidates: VolumeCell[] = [];
  for (let index = 0; index < supportedCells.length; index += 1) {
    if (orderedHigh[index]) candidates.push(orderedHigh[index]!);
    if (orderedLow[index]) candidates.push(orderedLow[index]!);
  }
  const selected: VolumeCell[] = [];
  const minimumSeparation = .2;
  candidates.forEach((candidate) => {
    if (selected.length >= maximumBlobs) return;
    if (selected.some((item) => normalizedDistance(item, candidate, volume) < minimumSeparation)) return;
    selected.push(candidate);
  });
  if (selected.length < Math.min(8, maximumBlobs)) {
    supportedCells.forEach((candidate) => {
      if (selected.length >= maximumBlobs) return;
      if (selected.some((item) => normalizedDistance(item, candidate, volume) < minimumSeparation * .62)) return;
      selected.push(candidate);
    });
  }

  return selected.map((cell, index) => {
    const normalized = actualRange > Number.EPSILON ? (cell.value - actualMin) / actualRange : .5;
    const prominence = Math.abs(normalized - .5) * 2;
    const radiusFactor = .92 + prominence * .28;
    return {
      id: `volume-${index}-${Math.round(cell.x)}-${Math.round(cell.y)}-${cell.z.toFixed(2)}`,
      x: cell.x, y: cell.y, z: cell.z,
      radiusX: Math.max(volume.width * .075, cell.width * 1.55) * radiusFactor,
      radiusY: Math.max(volume.depth * .075, cell.depth * 1.55) * radiusFactor,
      radiusZ: Math.max(height * .075, cell.height * 1.45) * radiusFactor,
      value: cell.value,
      color: measurementColor(cell.value, colorDomain.min, colorDomain.max, definition),
      opacity: (.19 + prominence * .13) * (.62 + cell.confidence * .38),
      level: normalizedLevel(normalized),
    };
  });
}

function cellAt(volume: SpatialVolume, column: number, row: number, layer: number): VolumeCell {
  return volume.cells[layer * volume.rows * volume.columns + row * volume.columns + column]!;
}

function sampleVolume(volume: SpatialVolume, x: number, y: number, z: number): number {
  if (!volume.cells.length) return volume.min;
  const gx = x / volume.width * volume.columns - .5;
  const gy = y / volume.depth * volume.rows - .5;
  const gz = (z - volume.minZ) / (volume.maxZ - volume.minZ) * volume.layers - .5;
  const x0 = Math.max(0, Math.min(volume.columns - 1, Math.floor(gx)));
  const y0 = Math.max(0, Math.min(volume.rows - 1, Math.floor(gy)));
  const z0 = Math.max(0, Math.min(volume.layers - 1, Math.floor(gz)));
  const x1 = Math.min(volume.columns - 1, x0 + 1);
  const y1 = Math.min(volume.rows - 1, y0 + 1);
  const z1 = Math.min(volume.layers - 1, z0 + 1);
  const tx = Math.max(0, Math.min(1, gx - x0));
  const ty = Math.max(0, Math.min(1, gy - y0));
  const tz = Math.max(0, Math.min(1, gz - z0));
  const plane = (layer: number) => {
    const top = cellAt(volume, x0, y0, layer).value * (1 - tx) + cellAt(volume, x1, y0, layer).value * tx;
    const bottom = cellAt(volume, x0, y1, layer).value * (1 - tx) + cellAt(volume, x1, y1, layer).value * tx;
    return top * (1 - ty) + bottom * ty;
  };
  return plane(z0) * (1 - tz) + plane(z1) * tz;
}

function estimateVolumeFlowAt(
  volume: SpatialVolume,
  column: number,
  row: number,
  layer: number,
  pathLength: number,
  minimumDifference: number,
): VolumeFlowEstimate | null {
  const current = cellAt(volume, column, row, layer);
  const gradientX = (cellAt(volume, column + 1, row, layer).value
    - cellAt(volume, column - 1, row, layer).value) * volume.columns / 2;
  const gradientY = (cellAt(volume, column, row + 1, layer).value
    - cellAt(volume, column, row - 1, layer).value) * volume.rows / 2;
  const gradientZ = volume.verticalSupport
    ? (cellAt(volume, column, row, layer + 1).value
      - cellAt(volume, column, row, layer - 1).value) * volume.layers / 2
    : 0;
  const strength = Math.hypot(gradientX, gradientY, gradientZ);
  if (strength <= Number.EPSILON || current.confidence < .3) return null;

  const height = volume.maxZ - volume.minZ;
  const directionX = -gradientX / strength;
  const directionY = -gradientY / strength;
  const directionZ = -gradientZ / strength;
  const toX = Math.max(0, Math.min(volume.width, current.x + directionX * pathLength * volume.width));
  const toY = Math.max(0, Math.min(volume.depth, current.y + directionY * pathLength * volume.depth));
  const toZ = Math.max(volume.minZ, Math.min(volume.maxZ, current.z + directionZ * pathLength * height));
  if (pointConfidence({ x: toX, y: toY, z: toZ }, volume.anchors, volume) < .22) return null;
  const toValue = sampleVolume(volume, toX, toY, toZ);
  const difference = current.value - toValue;
  if (difference < minimumDifference) return null;

  return {
    id: `${column}-${row}-${layer}`,
    from: { x: current.x, y: current.y, z: current.z, value: current.value },
    to: { x: toX, y: toY, z: toZ, value: toValue },
    difference,
    strength,
    hasVerticalComponent: Math.abs(toZ - current.z) > height * .025,
  };
}

export function estimateVolumeFlows(
  volume: SpatialVolume,
  definition: MeasurementDefinition,
  maximumVectors = 10,
): VolumeFlowEstimate[] {
  if (!definition.spatialInterpolation || volume.sampleCount < 3 || !volume.cells.length
    || volume.columns < 3 || volume.rows < 3 || volume.layers < 3 || maximumVectors < 1) return [];
  const pathLength = .24;
  const minimumDifference = Math.max(10 ** -definition.precision * .2, definition.interpolationDelta * .16);
  const candidates: VolumeFlowEstimate[] = [];

  for (let layer = 1; layer < volume.layers - 1; layer += 1) {
    for (let row = 1; row < volume.rows - 1; row += 1) {
      for (let column = 1; column < volume.columns - 1; column += 1) {
        const candidate = estimateVolumeFlowAt(
          volume,
          column,
          row,
          layer,
          pathLength,
          minimumDifference,
        );
        if (candidate) candidates.push(candidate);
      }
    }
  }

  candidates.sort((a, b) => b.strength - a.strength || b.difference - a.difference);
  const chosen: VolumeFlowEstimate[] = [];
  for (const candidate of candidates) {
    if (chosen.length >= maximumVectors) break;
    if (chosen.some((item) => normalizedDistance(item.from, candidate.from, volume) < .24)) continue;
    chosen.push(candidate);
  }
  return chosen;
}

export function projectPoint3D(
  point: Point3D,
  requestedBounds: VolumeBounds,
  camera: CameraOrbit,
  viewport: ProjectionViewport,
): ProjectedPoint3D {
  const bounds = safeBounds(requestedBounds);
  const padding = Math.max(0, viewport.padding ?? 54);
  const planSize = Math.max(bounds.width, bounds.depth);
  const nx = (point.x - bounds.width / 2) / (planSize / 2);
  const ny = (point.y - bounds.depth / 2) / (planSize / 2);
  const nz = (point.z - (bounds.minZ + bounds.maxZ) / 2) / ((bounds.maxZ - bounds.minZ) / 2) * .82;
  const cosYaw = Math.cos(camera.yaw);
  const sinYaw = Math.sin(camera.yaw);
  const cosPitch = Math.cos(camera.pitch);
  const sinPitch = Math.sin(camera.pitch);
  const horizontal = cosYaw * nx - sinYaw * ny;
  const forward = sinYaw * nx + cosYaw * ny;
  const vertical = sinPitch * forward - cosPitch * nz;
  const depth = cosPitch * forward + sinPitch * nz;
  const availableWidth = Math.max(1, viewport.width - padding * 2);
  const availableHeight = Math.max(1, viewport.height - padding * 2);
  const scale = Math.min(availableWidth / 2.25, availableHeight / 2.25) * Math.max(.35, camera.zoom);
  return {
    x: viewport.width / 2 + horizontal * scale,
    y: viewport.height / 2 + vertical * scale,
    depth,
  };
}

export function clampCameraOrbit(camera: CameraOrbit): CameraOrbit {
  return {
    yaw: Math.atan2(Math.sin(camera.yaw), Math.cos(camera.yaw)),
    // A complete orbit needs both hemispheres: +PI/2 is directly above the
    // building and -PI/2 is directly below it. This projection does not use a
    // look-at up vector, so the poles are stable and do not need an epsilon.
    pitch: Math.max(-Math.PI / 2, Math.min(Math.PI / 2, camera.pitch)),
    zoom: Math.max(.55, Math.min(1.75, camera.zoom)),
  };
}
