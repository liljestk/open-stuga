import type { MeasurementDefinition, MeasurementSample, Sensor } from "@climate-twin/contracts";
import { measurementColor, measurementDomain, measurementValue } from "./measurements";
import { isSpatialSampleFresh, type SpatialFreshnessOptions } from "./spatialFreshness";

export const MAX_SPATIAL_FIELD_CELLS = 1200;
const MAX_GRID_AXIS_CELLS = 80;
const MIN_CONFIDENT_CLOUD_COVERAGE = .16;
const MIN_CONFIDENT_FLOW_COVERAGE = .22;

export interface HeatCell {
  x: number;
  y: number;
  width: number;
  height: number;
  value: number;
  color: string;
  /** Confidence is derived from proximity to a reporting sensor, not model certainty. */
  confidence: number;
  nearestAnchorDistance: number;
}

export interface SpatialField {
  cells: HeatCell[];
  min: number;
  max: number;
  width: number;
  height: number;
  columns: number;
  rows: number;
  sampleCount: number;
  anchors: FieldPoint[];
  coverageRadius: number;
}

export interface CloudLobe {
  id: string;
  x: number;
  y: number;
  rx: number;
  ry: number;
  value: number;
  color: string;
  opacity: number;
  level: "high" | "low" | "level";
}

export interface FieldFlowEstimate {
  id: string;
  from: { x: number; y: number; value: number };
  to: { x: number; y: number; value: number };
  difference: number;
  strength: number;
}

export interface FieldPoint { x: number; y: number; value: number }

export type SpatialFieldOptions = Partial<SpatialFreshnessOptions>;

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

function reportingPoints(
  sensors: Sensor[],
  samples: Record<string, MeasurementSample>,
  definition: MeasurementDefinition,
  freshness?: SpatialFieldOptions,
): FieldPoint[] {
  return sensors.flatMap((sensor) => {
    if (!sensor.enabled) return [];
    const sample = samples[sensor.id];
    const value = measurementValue(sample, definition.id);
    const hasFreshnessWindow = freshness?.referenceTimeMs != null && freshness.maxSampleAgeMs != null;
    const fresh = hasFreshnessWindow
      ? isSpatialSampleFresh(sample, {
        referenceTimeMs: freshness.referenceTimeMs!,
        maxSampleAgeMs: freshness.maxSampleAgeMs!,
        ...(freshness.futureToleranceMs == null ? {} : { futureToleranceMs: freshness.futureToleranceMs }),
      })
      : sample?.quality !== "stale";
    return fresh && value != null ? [{ x: sensor.x, y: sensor.y, value }] : [];
  });
}

function gridDimensions(width: number, height: number, resolutionColumns: number): { columns: number; rows: number } {
  let columns = clamp(Math.round(resolutionColumns), 4, MAX_GRID_AXIS_CELLS);
  const boundedAspect = clamp(height / Math.max(width, Number.EPSILON), 1 / 12, 12);
  let rows = clamp(Math.round(columns * boundedAspect), 4, MAX_GRID_AXIS_CELLS);
  if (columns * rows > MAX_SPATIAL_FIELD_CELLS) {
    const scale = Math.sqrt(MAX_SPATIAL_FIELD_CELLS / (columns * rows));
    columns = Math.max(4, Math.floor(columns * scale));
    rows = Math.max(4, Math.floor(rows * scale));
  }
  while (columns * rows > MAX_SPATIAL_FIELD_CELLS) {
    if (rows >= columns && rows > 4) rows -= 1;
    else if (columns > 4) columns -= 1;
    else break;
  }
  return { columns, rows };
}

export function heatColor(value: number, min: number, max: number, definition: MeasurementDefinition): string {
  return measurementColor(value, min, max, definition);
}

export function interpolateHeat(
  sensors: Sensor[],
  samples: Record<string, MeasurementSample>,
  definition: MeasurementDefinition,
  width: number,
  height: number,
  resolutionColumns = 25,
  freshness?: SpatialFieldOptions,
): SpatialField {
  const points = reportingPoints(sensors, samples, definition, freshness);
  const domain = measurementDomain(definition, points.map((item) => item.value));
  const floorDiagonal = Math.hypot(width, height);
  const coverageRadius = Math.max(1, floorDiagonal * .3);
  if (!definition.spatialInterpolation || !domain) {
    return {
      cells: [], min: definition.displayMin ?? 0, max: definition.displayMax ?? 1, width, height, columns: 0, rows: 0,
      sampleCount: points.length, anchors: points, coverageRadius,
    };
  }
  const { min, max } = domain;
  const { columns, rows } = gridDimensions(width, height, resolutionColumns);
  const cellWidth = width / columns;
  const cellHeight = height / rows;
  const minimumDistanceSquared = (Math.max(width, height) / 30) ** 2;
  const cells: HeatCell[] = [];
  for (let row = 0; row < rows; row += 1) {
    for (let column = 0; column < columns; column += 1) {
      const x = column * cellWidth;
      const y = row * cellHeight;
      const centerX = x + cellWidth / 2;
      const centerY = y + cellHeight / 2;
      let weighted = 0;
      let totalWeight = 0;
      let nearestAnchorDistance = Number.POSITIVE_INFINITY;
      points.forEach((sample) => {
        const rawDistanceSquared = (sample.x - centerX) ** 2 + (sample.y - centerY) ** 2;
        nearestAnchorDistance = Math.min(nearestAnchorDistance, Math.sqrt(rawDistanceSquared));
        const distanceSquared = Math.max(minimumDistanceSquared, rawDistanceSquared);
        const weight = 1 / distanceSquared;
        weighted += sample.value * weight;
        totalWeight += weight;
      });
      const value = totalWeight ? weighted / totalWeight : min;
      const confidence = clamp(1 - nearestAnchorDistance / coverageRadius, 0, 1);
      cells.push({
        x, y, width: cellWidth, height: cellHeight, value,
        color: heatColor(value, min, max, definition), confidence, nearestAnchorDistance,
      });
    }
  }
  return { cells, min, max, width, height, columns, rows, sampleCount: points.length, anchors: points, coverageRadius };
}

export function createCloudLobes(
  field: SpatialField,
  definition: MeasurementDefinition,
  maximumLobes = 10,
  colorDomain: { min: number; max: number } = field,
): CloudLobe[] {
  if (!definition.spatialInterpolation || !field.cells.length || maximumLobes < 1) return [];
  if (field.sampleCount <= 2) {
    const anchorMin = Math.min(...field.anchors.map((anchor) => anchor.value));
    const anchorMax = Math.max(...field.anchors.map((anchor) => anchor.value));
    return field.anchors.map((anchor, index) => ({
      id: `anchor-${index}-${Math.round(anchor.x)}-${Math.round(anchor.y)}`,
      x: anchor.x,
      y: anchor.y,
      rx: Math.max(field.width * .11, field.cells[0]!.width * 2.4),
      ry: Math.max(field.height * .11, field.cells[0]!.height * 2.4),
      value: anchor.value,
      color: heatColor(anchor.value, colorDomain.min, colorDomain.max, definition),
      opacity: .34,
      level: anchorMax === anchorMin ? "level" : anchor.value === anchorMax ? "high" : "low",
    }));
  }
  const supportedCells = field.cells.filter((cell) => cell.confidence >= MIN_CONFIDENT_CLOUD_COVERAGE);
  if (!supportedCells.length) return [];
  const actualMin = Math.min(...supportedCells.map((cell) => cell.value));
  const actualMax = Math.max(...supportedCells.map((cell) => cell.value));
  const actualRange = actualMax - actualMin;
  const high = [...supportedCells].sort((a, b) => b.value - a.value || b.confidence - a.confidence);
  const low = [...supportedCells].sort((a, b) => a.value - b.value || b.confidence - a.confidence);
  const candidates: HeatCell[] = [];
  for (let index = 0; index < supportedCells.length; index += 1) {
    if (high[index]) candidates.push(high[index]!);
    if (low[index]) candidates.push(low[index]!);
  }
  const minimumDistance = Math.max(field.width, field.height) / Math.max(3.4, Math.sqrt(maximumLobes) * 1.65);
  const selected: HeatCell[] = [];
  const used = new Set<string>();
  const choose = (candidate: HeatCell, distance: number) => {
    const key = `${candidate.x}:${candidate.y}`;
    if (used.has(key) || selected.some((item) => Math.hypot(item.x - candidate.x, item.y - candidate.y) < distance)) return;
    used.add(key);
    selected.push(candidate);
  };
  candidates.forEach((candidate) => {
    if (selected.length < maximumLobes) choose(candidate, minimumDistance);
  });
  if (selected.length < Math.min(4, maximumLobes)) {
    supportedCells.forEach((candidate) => {
      if (selected.length < maximumLobes) choose(candidate, minimumDistance * .55);
    });
  }
  const baseRadiusX = Math.max(field.width / Math.max(4.8, Math.sqrt(maximumLobes) * 2), field.cells[0]!.width * 2.5);
  const baseRadiusY = Math.max(field.height / Math.max(4.8, Math.sqrt(maximumLobes) * 2), field.cells[0]!.height * 2.5);
  return selected.map((cell, index) => {
    const normalized = actualRange > Number.EPSILON ? (cell.value - actualMin) / actualRange : .5;
    const prominence = Math.abs(normalized - .5) * 2;
    const radiusFactor = .9 + prominence * .28;
    return {
      id: `${index}-${Math.round(cell.x)}-${Math.round(cell.y)}`,
      x: cell.x + cell.width / 2,
      y: cell.y + cell.height / 2,
      rx: baseRadiusX * radiusFactor,
      ry: baseRadiusY * radiusFactor,
      value: cell.value,
      color: heatColor(cell.value, colorDomain.min, colorDomain.max, definition),
      opacity: (.24 + prominence * .14) * (.55 + cell.confidence * .45),
      level: normalized > .58 ? "high" : normalized < .42 ? "low" : "level",
    };
  });
}

function sampleField(field: SpatialField, x: number, y: number): { value: number; confidence: number } {
  if (!field.cells.length || !field.columns || !field.rows) return { value: field.min, confidence: 0 };
  const cellWidth = field.width / field.columns;
  const cellHeight = field.height / field.rows;
  const gridX = x / cellWidth - .5;
  const gridY = y / cellHeight - .5;
  const x0 = Math.max(0, Math.min(field.columns - 1, Math.floor(gridX)));
  const y0 = Math.max(0, Math.min(field.rows - 1, Math.floor(gridY)));
  const x1 = Math.min(field.columns - 1, x0 + 1);
  const y1 = Math.min(field.rows - 1, y0 + 1);
  const tx = Math.max(0, Math.min(1, gridX - x0));
  const ty = Math.max(0, Math.min(1, gridY - y0));
  const bilinear = (property: "value" | "confidence") => {
    const value = (column: number, row: number) => field.cells[row * field.columns + column]![property];
    const top = value(x0, y0) * (1 - tx) + value(x1, y0) * tx;
    const bottom = value(x0, y1) * (1 - tx) + value(x1, y1) * tx;
    return top * (1 - ty) + bottom * ty;
  };
  return { value: bilinear("value"), confidence: bilinear("confidence") };
}

export function estimateFieldFlows(
  field: SpatialField,
  definition: MeasurementDefinition,
  maximumPaths = 7,
): FieldFlowEstimate[] {
  if (!definition.spatialInterpolation || field.sampleCount < 2 || !field.cells.length || field.columns < 3 || field.rows < 3 || maximumPaths < 1) return [];
  const cellWidth = field.width / field.columns;
  const cellHeight = field.height / field.rows;
  const pathLength = Math.max(Math.min(field.width, field.height) * .2, Math.max(cellWidth, cellHeight) * 2.8);
  const minimumDifference = Math.max(10 ** -definition.precision * .2, definition.interpolationDelta * .18);
  const cell = (column: number, row: number) => field.cells[row * field.columns + column]!;
  const candidates: FieldFlowEstimate[] = [];
  for (let row = 1; row < field.rows - 1; row += 1) {
    for (let column = 1; column < field.columns - 1; column += 1) {
      const current = cell(column, row);
      if (current.confidence < MIN_CONFIDENT_FLOW_COVERAGE
        || cell(column + 1, row).confidence < MIN_CONFIDENT_CLOUD_COVERAGE
        || cell(column - 1, row).confidence < MIN_CONFIDENT_CLOUD_COVERAGE
        || cell(column, row + 1).confidence < MIN_CONFIDENT_CLOUD_COVERAGE
        || cell(column, row - 1).confidence < MIN_CONFIDENT_CLOUD_COVERAGE) continue;
      const gradientX = (cell(column + 1, row).value - cell(column - 1, row).value) / (2 * cellWidth);
      const gradientY = (cell(column, row + 1).value - cell(column, row - 1).value) / (2 * cellHeight);
      const strength = Math.hypot(gradientX, gradientY);
      if (strength <= Number.EPSILON) continue;
      const from = { x: current.x + current.width / 2, y: current.y + current.height / 2, value: current.value };
      const toX = Math.max(0, Math.min(field.width, from.x - gradientX / strength * pathLength));
      const toY = Math.max(0, Math.min(field.height, from.y - gradientY / strength * pathLength));
      const destination = sampleField(field, toX, toY);
      if (destination.confidence < MIN_CONFIDENT_CLOUD_COVERAGE) continue;
      const difference = from.value - destination.value;
      if (difference < minimumDifference) continue;
      candidates.push({
        id: `${column}-${row}`,
        from,
        to: { x: toX, y: toY, value: destination.value },
        difference,
        strength,
      });
    }
  }
  candidates.sort((a, b) => b.strength - a.strength || b.difference - a.difference);
  const minimumSeparation = Math.max(field.width, field.height) / Math.max(4.5, Math.sqrt(maximumPaths) * 1.7);
  const chosen: FieldFlowEstimate[] = [];
  for (const candidate of candidates) {
    if (chosen.length >= maximumPaths) break;
    if (chosen.some((item) => Math.hypot(item.from.x - candidate.from.x, item.from.y - candidate.from.y) < minimumSeparation)) continue;
    chosen.push(candidate);
  }
  return chosen;
}
