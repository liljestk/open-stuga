import { useEffect, useId, useMemo, useState, type KeyboardEvent, type MouseEvent } from "react";
import type { House, ManualObservation, MeasurementDefinition, MeasurementSample, Sensor, UnitSystem } from "@climate-twin/contracts";
import { useI18n, type TranslationKey } from "../i18n";
import { formatMeasurement, formatMeasurementDelta, measurementDomain, measurementGradient, measurementLabel, measurementValue, toDisplayValue } from "../measurements";
import { createCloudLobes, estimateFieldFlows, interpolateHeat, type CloudLobe } from "../spatialField";

interface BuildingSceneProps {
  house: House;
  sensors: Sensor[];
  samples: Record<string, MeasurementSample>;
  observations: ManualObservation[];
  definition: MeasurementDefinition;
  colorDomain?: { min: number; max: number } | null;
  units: UnitSystem;
  activeFloorId: string;
  selectedSensorId: string | null;
  onFloorSelect: (floorId: string) => void;
  onSensorSelect: (sensorId: string, floorId: string) => void;
}

interface ProjectedPoint { x: number; y: number }

const VIEW_WIDTH = 1100;
const VIEW_HEIGHT = 720;
const MIN_FLOOR_GAP_METRES = 2.8;

function points(points: ProjectedPoint[]): string {
  return points.map((point) => `${point.x.toFixed(1)},${point.y.toFixed(1)}`).join(" ");
}

function projectedCloud(lobe: CloudLobe, z: number, project: (x: number, y: number, z: number) => ProjectedPoint): string {
  return points(Array.from({ length: 28 }, (_, index) => {
    const angle = index / 28 * Math.PI * 2;
    return project(lobe.x + Math.cos(angle) * lobe.rx, lobe.y + Math.sin(angle) * lobe.ry, z);
  }));
}

function svgToken(value: string): string {
  return value.replace(/[^a-zA-Z0-9_-]/g, "-");
}

function relativeSensorHeight(sensor: Sensor, floorElevation: number): number {
  return sensor.z - floorElevation;
}

function visualLabel(value: string, maximumCharacters = 20): string {
  const characters = Array.from(value);
  return characters.length > maximumCharacters
    ? `${characters.slice(0, maximumCharacters - 1).join("")}…`
    : value;
}

export function BuildingScene({
  house, sensors, samples, observations, definition, colorDomain, units, activeFloorId, selectedSensorId,
  onFloorSelect, onSensorSelect,
}: BuildingSceneProps) {
  const { locale, t } = useI18n();
  const metricLabel = measurementLabel(definition, locale);
  const markerId = `building-flow-${useId().replace(/:/g, "")}`;
  const [explode, setExplode] = useState(1.15);
  const [reducedMotion, setReducedMotion] = useState(false);
  useEffect(() => {
    if (typeof window.matchMedia !== "function") return;
    const query = window.matchMedia("(prefers-reduced-motion: reduce)");
    const update = () => setReducedMotion(query.matches);
    update();
    query.addEventListener?.("change", update);
    return () => query.removeEventListener?.("change", update);
  }, []);
  const rawFloors = [...house.floors].sort((a, b) => a.elevation - b.elevation);
  let previousElevation = Number.NEGATIVE_INFINITY;
  const floorModels = rawFloors.map((floor, index) => {
    const requested = floor.elevation;
    const baseElevation = index === 0 ? requested : Math.max(requested, previousElevation + MIN_FLOOR_GAP_METRES);
    previousElevation = baseElevation;
    const floorSensors = sensors.filter((sensor) => sensor.floorId === floor.id && sensor.enabled);
    const values = floorSensors.flatMap((sensor) => {
      const sample = samples[sensor.id];
      const value = measurementValue(sample, definition.id);
      return sample?.quality !== "stale" && value != null ? [value] : [];
    });
    const average = values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : null;
    return { floor, baseElevation, floorSensors, average, sampleCount: values.length };
  });

  const usableSamples = Object.fromEntries(Object.entries(samples).filter(([, sample]) => sample.quality !== "stale"));
  const allValues = sensors.filter((sensor) => sensor.enabled).flatMap((sensor) => {
    const value = measurementValue(usableSamples[sensor.id], definition.id);
    return value == null ? [] : [value];
  });
  const heatDomain = colorDomain ?? measurementDomain(definition, allValues);
  const heatMin = heatDomain?.min ?? definition.displayMin ?? 0;
  const heatMax = heatDomain?.max ?? definition.displayMax ?? 1;
  const maxWidth = Math.max(1, ...house.floors.map((floor) => floor.width));
  const maxDepth = Math.max(1, ...house.floors.map((floor) => floor.height));
  const planeScale = 600 / Math.max(maxWidth + maxDepth, 1);
  const depthScale = planeScale * .45;
  const maxAbsoluteZ = Math.max(1, ...floorModels.flatMap((model) => [
    model.baseElevation * explode,
    ...model.floorSensors.map((sensor) => model.baseElevation * explode + Math.max(0, relativeSensorHeight(sensor, model.floor.elevation))),
  ]));
  const minAbsoluteZ = Math.min(0, ...floorModels.map((model) => model.baseElevation * explode));
  const verticalScale = Math.min(70, 310 / Math.max(maxAbsoluteZ - minAbsoluteZ, 1));
  const originX = 45 + maxDepth * planeScale;
  const originY = 56 + (maxAbsoluteZ - minAbsoluteZ) * verticalScale;
  const project = (x: number, y: number, z: number): ProjectedPoint => ({
    x: originX + (x - y) * planeScale,
    y: originY + (x + y) * depthScale - (z - minAbsoluteZ) * verticalScale,
  });

  const floorVisuals = useMemo(() => Object.fromEntries(floorModels.map(({ floor, floorSensors }) => {
    const field = interpolateHeat(floorSensors, usableSamples, definition, floor.width, floor.height, 16);
    return [floor.id, {
      clouds: createCloudLobes(field, definition, 8, { min: heatMin, max: heatMax }),
      flows: estimateFieldFlows(field, definition, 4),
    }];
  })), [house.floors, sensors, samples, definition, heatMin, heatMax]);

  const activateFloor = (floorId: string) => onFloorSelect(floorId);
  const floorKeyDown = (event: KeyboardEvent<SVGGElement>, floorId: string) => {
    if (event.key !== "Enter" && event.key !== " ") return;
    event.preventDefault();
    activateFloor(floorId);
  };
  const selectSensor = (event: MouseEvent<SVGGElement> | KeyboardEvent<SVGGElement>, sensor: Sensor) => {
    event.stopPropagation();
    if ("key" in event && event.key !== "Enter" && event.key !== " ") return;
    event.preventDefault();
    onFloorSelect(sensor.floorId);
    onSensorSelect(sensor.id, sensor.floorId);
  };

  const observationName = (observation: ManualObservation) => t(`observations.${observation.kind === "note" ? "noteKind" : observation.kind}` as TranslationKey);
  const renderedSensors = sensors.filter((sensor) => sensor.enabled).flatMap((sensor) => {
    const model = floorModels.find((item) => item.floor.id === sensor.floorId);
    if (!model) return [];
    const height = relativeSensorHeight(sensor, model.floor.elevation);
    const floorZ = model.baseElevation * explode;
    const position = project(sensor.x, sensor.y, floorZ + Math.max(height, .25));
    const anchor = project(sensor.x, sensor.y, floorZ + .08);
    return [{ sensor, model, height, position, anchor }];
  }).sort((a, b) => a.position.y - b.position.y || a.position.x - b.position.x);

  return (
    <div className="building-scene">
      <div className="building-scene-controls">
        <div><span className="eyebrow">{t("building.title")}</span><strong>{house.name}</strong></div>
        <label>
          <span>{t("building.spacing")}</span>
          <input type="range" min="0.85" max="1.7" step="0.05" value={explode} onChange={(event) => setExplode(Number(event.target.value))} />
        </label>
      </div>
      <div className="building-viewport">
      <svg className="building-svg" viewBox={`0 0 ${VIEW_WIDTH} ${VIEW_HEIGHT}`} role="group" aria-label={t("building.aria", { house: house.name, floors: house.floors.length, sensors: sensors.filter((sensor) => sensor.enabled).length, metric: metricLabel })}>
        <desc>{allValues.length
          ? t("twin.estimatedFieldDescription", { metric: metricLabel })
          : definition.spatialInterpolation
            ? t("twin.estimateUnavailable", { metric: metricLabel })
            : t("building.noSpatial", { metric: metricLabel })}</desc>
        <defs>
          <marker id={markerId} markerWidth="10" markerHeight="10" refX="9" refY="5" orient="auto"><path d="M0 0L10 5L0 10Z" className="vertical-arrow-head" /></marker>
          <filter id={`${markerId}-shadow`} x="-80%" y="-80%" width="260%" height="260%"><feDropShadow dx="0" dy="4" stdDeviation="5" floodOpacity=".24" /></filter>
          <filter id={`${markerId}-cloud-soften`} x="-25%" y="-25%" width="150%" height="150%"><feGaussianBlur stdDeviation="6" /></filter>
        </defs>

        <g className="building-floors">
          {floorModels.map(({ floor, baseElevation, floorSensors, average }, floorIndex) => {
            const z = baseElevation * explode;
            const surface = [project(0, 0, z), project(floor.width, 0, z), project(floor.width, floor.height, z), project(0, floor.height, z)];
            const slabBottom = [project(0, 0, z - .16), project(floor.width, 0, z - .16), project(floor.width, floor.height, z - .16), project(0, floor.height, z - .16)];
            const active = floor.id === activeFloorId;
            const labelPoint = surface[1]!;
            const averageLabel = average == null ? t("common.noData") : formatMeasurement(average, definition, units);
            const visual = floorVisuals[floor.id] ?? { clouds: [], flows: [] };
            const floorToken = `${floorIndex}-${svgToken(floor.id)}`;
            return (
              <g
                key={floor.id} className={`building-floor ${active ? "active" : ""}`} role="button" tabIndex={0}
                aria-pressed={active} aria-label={t("building.floorAria", { floor: floor.name, height: floor.elevation.toFixed(1), sensors: floorSensors.length, metric: metricLabel, value: averageLabel })}
                onClick={() => activateFloor(floor.id)} onKeyDown={(event) => floorKeyDown(event, floor.id)}
              >
                <polygon points={points([surface[1]!, surface[2]!, slabBottom[2]!, slabBottom[1]!])} className="floor-slab-side" />
                <polygon points={points([surface[2]!, surface[3]!, slabBottom[3]!, slabBottom[2]!])} className="floor-slab-front" />
                <polygon points={points(surface)} className="floor-surface" />
                <defs>{visual.clouds.map((cloud) => (
                  <radialGradient key={`${cloud.id}-gradient`} id={`${markerId}-${floorToken}-${cloud.id}`}>
                    <stop offset="0" stopColor={cloud.color} stopOpacity={Math.min(.82, cloud.opacity + .34)} />
                    <stop offset="54%" stopColor={cloud.color} stopOpacity={cloud.opacity} />
                    <stop offset="100%" stopColor={cloud.color} stopOpacity="0" />
                  </radialGradient>
                ))}</defs>
                <g className="building-clouds" filter={`url(#${markerId}-cloud-soften)`} aria-hidden="true">
                  {visual.clouds.map((cloud) => (
                    <polygon key={cloud.id} points={projectedCloud(cloud, z + .025, project)} fill={`url(#${markerId}-${floorToken}-${cloud.id})`} className={`building-cloud-lobe ${cloud.level}`} />
                  ))}
                </g>
                <g className="building-walls" aria-hidden="true">
                  {floor.walls.map((wall) => {
                    const from = project(wall.from.x, wall.from.y, z + .06);
                    const to = project(wall.to.x, wall.to.y, z + .06);
                    return <line key={wall.id} x1={from.x} y1={from.y} x2={to.x} y2={to.y} />;
                  })}
                </g>
                <g className="building-floor-label" aria-hidden="true" transform={`translate(${labelPoint.x + 14} ${labelPoint.y - 15})`}>
                  <rect width="176" height="43" rx="9" />
                  <text x="11" y="17">{visualLabel(floor.name, 22)}</text>
                  <text x="11" y="33" className="sub-label">{t("building.floorSummary", { height: floor.elevation.toFixed(1), value: averageLabel })}</text>
                </g>
              </g>
            );
          })}
        </g>

        <g className="building-floor-flows" aria-label={t("twin.flow")}>
          {floorModels.flatMap(({ floor, baseElevation }) => {
            const visual = floorVisuals[floor.id] ?? { clouds: [], flows: [] };
            const z = baseElevation * explode + .1;
            return visual.flows.map((flow, index) => {
              const from = project(flow.from.x, flow.from.y, z);
              const to = project(flow.to.x, flow.to.y, z);
              const distance = Math.max(1, Math.hypot(to.x - from.x, to.y - from.y));
              const bend = Math.min(24, distance * .12) * (index % 2 ? 1 : -1);
              const curveX = (from.x + to.x) / 2 - (to.y - from.y) / distance * bend;
              const curveY = (from.y + to.y) / 2 + (to.x - from.x) / distance * bend;
              const path = `M${from.x} ${from.y} Q${curveX} ${curveY} ${to.x} ${to.y}`;
              const label = t("twin.gradientAria", {
                from: formatMeasurement(flow.from.value, definition, units),
                to: formatMeasurement(flow.to.value, definition, units),
                difference: formatMeasurementDelta(flow.difference, definition, units),
              });
              return (
                <g key={`${floor.id}-${flow.id}`} role="img" aria-label={label}>
                  <title>{label}</title>
                  <path d={path} className="building-flow-path" markerEnd={`url(#${markerId})`} />
                  {!reducedMotion && <circle r="4.5" className="building-flow-particle"><animateMotion dur={`${2.9 + index * .35}s`} repeatCount="indefinite" path={path} /></circle>}
                </g>
              );
            });
          })}
        </g>

        <g className="building-observations">
          {observations.filter((observation) => observation.x != null && observation.y != null).map((observation) => {
            const model = floorModels.find((item) => item.floor.id === observation.floorId);
            if (!model) return null;
            const position = project(observation.x!, observation.y!, model.baseElevation * explode + .18);
            const label = t("building.observationAria", {
              kind: observationName(observation), severity: t(`alerts.${observation.severity}`), floor: model.floor.name, note: observation.note,
            });
            return (
              <g key={observation.id} transform={`translate(${position.x} ${position.y})`} className={`building-observation ${observation.severity}`} role="img" aria-label={label}>
                <title>{label}</title><path d="M0-15C-8-15-14-9-14-1C-14 9 0 19 0 19S14 9 14-1C14-9 8-15 0-15Z" /><text textAnchor="middle" y="3">!</text>
              </g>
            );
          })}
        </g>

        <g className="building-sensors">
          {renderedSensors.map(({ sensor, model, height, position, anchor }) => {
            const rawSample = samples[sensor.id];
            const sample = rawSample?.quality === "stale" ? undefined : rawSample;
            const sampleValue = measurementValue(sample, definition.id);
            const value = sampleValue == null ? t("common.noData") : formatMeasurement(sampleValue, definition, units);
            const selected = sensor.id === selectedSensorId;
            const status = rawSample?.quality === "stale"
              ? t("building.statusStale")
              : rawSample?.quality === "estimated"
                ? t("building.statusEstimated")
                : rawSample
                  ? t("building.statusCurrent")
                  : t("common.noData");
            const label = t("building.sensorAria", { sensor: sensor.name, floor: model.floor.name, height: height.toFixed(1), metric: metricLabel, value, status });
            return (
              <g
                key={sensor.id} transform={`translate(${position.x} ${position.y})`} className={`building-sensor ${selected ? "selected" : ""} ${rawSample?.quality === "stale" ? "stale" : ""}`}
                role="button" tabIndex={0} aria-pressed={selected} aria-label={label}
                onClick={(event) => selectSensor(event, sensor)} onKeyDown={(event) => selectSensor(event, sensor)}
              >
                <title>{label}</title>
                <line x1="0" y1="0" x2={anchor.x - position.x} y2={anchor.y - position.y} className="sensor-tether" aria-hidden="true" />
                <circle r="34" className="building-sensor-hit" aria-hidden="true" />
                <circle r="19" className="building-sensor-ring" />
                <circle r="14" className="building-sensor-core" filter={`url(#${markerId}-shadow)`} />
                <text textAnchor="middle" y="4" className="building-sensor-value">{sampleValue == null ? "—" : toDisplayValue(sampleValue, definition, units).toFixed(definition.precision)}</text>
                <text x="22" y="-2" className="building-sensor-name">{visualLabel(sensor.name)}</text>
              </g>
            );
          })}
        </g>

        <g className="vertical-gradients">
          {definition.spatialInterpolation && floorModels.slice(0, -1).map((lower, index) => {
            const upper = floorModels[index + 1]!;
            if (lower.average == null || upper.average == null || lower.sampleCount === 0 || upper.sampleCount === 0) return null;
            const difference = upper.average - lower.average;
            const stable = Math.abs(difference) < definition.interpolationDelta;
            if (stable) return null;
            const lowerY = project(lower.floor.width / 2, lower.floor.height / 2, lower.baseElevation * explode).y;
            const upperY = project(upper.floor.width / 2, upper.floor.height / 2, upper.baseElevation * explode).y;
            const fromY = difference < 0 ? lowerY : upperY;
            const toY = difference < 0 ? upperY : lowerY;
            const delta = formatMeasurementDelta(difference, definition, units);
            const label = difference < 0
              ? t("building.flowUp", { from: lower.floor.name, to: upper.floor.name, value: delta })
              : t("building.flowDown", { from: upper.floor.name, to: lower.floor.name, value: delta });
            const x = 888;
            const midY = (fromY + toY) / 2;
            return (
              <g key={`${lower.floor.id}-${upper.floor.id}`} className="vertical-gradient" role="img" aria-label={label}>
                <title>{label}</title>
                <line x1={x} x2={x} y1={fromY} y2={toY} markerEnd={`url(#${markerId})`} />
                {!reducedMotion && <circle r="5" className="vertical-flow-particle"><animateMotion dur="2.4s" repeatCount="indefinite" path={`M${x} ${fromY}L${x} ${toY}`} /></circle>}
                <rect x={x + 15} y={midY - 18} width="180" height="36" rx="8" />
                <text x={x + 25} y={midY - 3}>{t("building.verticalFlow")}</text>
                <text x={x + 25} y={midY + 11} className="sub-label">{label}</text>
              </g>
            );
          })}
        </g>
      </svg>
      </div>
      <div className="building-legend">
        <span>{!definition.spatialInterpolation
          ? t("building.noSpatial", { metric: metricLabel })
          : allValues.length > 0
            ? <><i className="heat-gradient" style={{ background: measurementGradient(definition) }} aria-hidden="true" />{t("twin.estimatedField", { metric: metricLabel })}: {formatMeasurement(heatMin, definition, units)} – {formatMeasurement(heatMax, definition, units)}</>
            : t("common.noData")}</span>
        {definition.spatialInterpolation && allValues.length > 1 && <span><i className="vertical-key" aria-hidden="true">↕</i>{t("building.verticalFlow")}</span>}
      </div>
      <p className="building-help">{t("building.help")}</p>
    </div>
  );
}
