import { useId, type CSSProperties } from "react";
import type { Floor, House, UnitSystem } from "@climate-twin/contracts";
import { useI18n } from "../i18n";
import {
  formatOutdoorInfluenceValue,
  type OutdoorInfluenceEdge,
  type OutdoorInfluenceEstimate,
} from "../outdoor/influence";
import type { PlanEdge } from "../outdoor/context";
import type { Point3D, ProjectedPoint3D } from "../spatial/volume";

function influenceLabel(
  estimate: OutdoorInfluenceEstimate,
  units: UnitSystem,
  locale: string,
  t: ReturnType<typeof useI18n>["t"],
): string {
  if (estimate.availability !== "ready"
    || estimate.outdoorValue === null || estimate.indoorValue === null || estimate.difference === null) {
    return t("spatial.outdoorInfluence.needsData");
  }
  const direction = t(`spatial.outdoorInfluence.direction.${estimate.direction}`);
  return [
    t("spatial.outdoorInfluence.estimateReady", { direction }),
    t("spatial.outdoorInfluence.evidence", {
      outside: formatOutdoorInfluenceValue(estimate.metric, estimate.outdoorValue, units, locale),
      inside: formatOutdoorInfluenceValue(estimate.metric, estimate.indoorValue, units, locale),
      difference: formatOutdoorInfluenceValue(estimate.metric, estimate.difference, units, locale, true),
      sensors: estimate.sensorCount,
    }),
    t("spatial.outdoorInfluence.disclaimer"),
  ].join(". ");
}

function influenceStyle(estimate: OutdoorInfluenceEstimate, edge?: OutdoorInfluenceEdge): CSSProperties {
  return {
    "--outdoor-influence-strength": estimate.strength.toFixed(3),
    "--outdoor-influence-opacity": (.1 + estimate.strength * .3).toFixed(3),
    ...(edge ? {
      "--outdoor-influence-edge-strength": edge.strength.toFixed(3),
      "--outdoor-influence-edge-opacity": (.16 + edge.strength * .72).toFixed(3),
      "--outdoor-influence-face-fill-opacity": (.035 + edge.strength * .13).toFixed(3),
      "--outdoor-influence-face-opacity": (.25 + edge.strength * .6).toFixed(3),
    } : {}),
  } as CSSProperties;
}

function planArrow(edge: PlanEdge, width: number, height: number, depth: number) {
  const inset = Math.max(10, Math.min(width, height) * .018);
  if (edge === "top") return { x1: width / 2, y1: inset, x2: width / 2, y2: depth };
  if (edge === "right") return { x1: width - inset, y1: height / 2, x2: width - depth, y2: height / 2 };
  if (edge === "bottom") return { x1: width / 2, y1: height - inset, x2: width / 2, y2: height - depth };
  return { x1: inset, y1: height / 2, x2: depth, y2: height / 2 };
}

export function OutdoorInfluenceOverlay2D({
  floor,
  estimate,
  scale,
  units,
}: {
  floor: Floor;
  estimate: OutdoorInfluenceEstimate;
  scale: number;
  units: UnitSystem;
}) {
  const { locale, t } = useI18n();
  const markerId = `outdoor-influence-${useId().replace(/:/g, "")}`;
  if (estimate.availability !== "ready") return null;
  const width = floor.width * scale;
  const height = floor.height * scale;
  const depth = Math.min(width, height) * (.11 + estimate.strength * .12);
  const label = influenceLabel(estimate, units, locale, t);
  return <g
    className="outdoor-influence-layer outdoor-influence-plan"
    data-direction={estimate.direction}
    data-metric={estimate.metric}
    data-support={estimate.support}
    style={influenceStyle(estimate)}
    role="img"
    aria-label={label}
  >
    <title>{label}</title>
    <defs>
      <marker id={markerId} markerWidth="8" markerHeight="8" refX="7" refY="4" orient="auto" markerUnits="userSpaceOnUse">
        <path d="M0 0L8 4L0 8Z" className="outdoor-influence-arrow-head" />
      </marker>
    </defs>
    <rect x="9" y="9" width={Math.max(0, width - 18)} height={Math.max(0, height - 18)} rx="15" className="outdoor-influence-perimeter" />
    {estimate.edges.map((edge) => <line
      key={edge.edge}
      {...planArrow(edge.edge, width, height, depth)}
      className="outdoor-influence-arrow"
      data-edge={edge.edge}
      data-windward={edge.windward || undefined}
      style={influenceStyle(estimate, edge)}
      markerEnd={`url(#${markerId})`}
      aria-hidden="true"
    />)}
  </g>;
}

function edgePoint(floor: Floor, edge: PlanEdge, progress: number, inset: number, z: number): Point3D {
  if (edge === "top") return { x: floor.width * progress, y: inset, z };
  if (edge === "right") return { x: floor.width - inset, y: floor.height * progress, z };
  if (edge === "bottom") return { x: floor.width * (1 - progress), y: floor.height - inset, z };
  return { x: inset, y: floor.height * (1 - progress), z };
}

function inwardPoint(floor: Floor, edge: PlanEdge, depth: number, z: number): Point3D {
  if (edge === "top") return { x: floor.width / 2, y: depth, z };
  if (edge === "right") return { x: floor.width - depth, y: floor.height / 2, z };
  if (edge === "bottom") return { x: floor.width / 2, y: floor.height - depth, z };
  return { x: depth, y: floor.height / 2, z };
}

function projectedPoints(points: readonly Point3D[], project: (point: Point3D) => ProjectedPoint3D): string {
  return points.map((point) => {
    const projected = project(point);
    return `${projected.x.toFixed(1)},${projected.y.toFixed(1)}`;
  }).join(" ");
}

export function OutdoorInfluenceOverlay3D({
  house,
  estimate,
  project,
  units,
}: {
  house: House;
  estimate: OutdoorInfluenceEstimate;
  project: (point: Point3D) => ProjectedPoint3D;
  units: UnitSystem;
}) {
  const { locale, t } = useI18n();
  const markerId = `building-outdoor-influence-${useId().replace(/:/g, "")}`;
  if (estimate.availability !== "ready") return null;
  const label = influenceLabel(estimate, units, locale, t);
  const visibleEdges = estimate.windwardEdge
    ? estimate.edges.filter((edge) => edge.edge === estimate.windwardEdge)
    : estimate.edges;
  return <g
    className="outdoor-influence-layer building-outdoor-influence"
    data-direction={estimate.direction}
    data-metric={estimate.metric}
    data-support={estimate.support}
    style={influenceStyle(estimate)}
    role="img"
    aria-label={label}
  >
    <title>{label}</title>
    <defs>
      <marker id={markerId} markerWidth="8" markerHeight="8" refX="7" refY="4" orient="auto" markerUnits="userSpaceOnUse">
        <path d="M0 0L8 4L0 8Z" className="outdoor-influence-arrow-head" />
      </marker>
    </defs>
    {house.floors.flatMap((floor) => {
      const scale = Math.min(floor.width, floor.height);
      const inset = Math.max(.05, scale * .012);
      const depth = scale * (.12 + estimate.strength * .1);
      const z = floor.elevation + .09;
      const wallHeight = Math.max(.8, floor.wallHeight ?? floor.ceilingHeight ?? 2.8);
      return visibleEdges.flatMap((edge) => {
        const source = project(edgePoint(floor, edge.edge, .5, inset, z));
        const target = project(inwardPoint(floor, edge.edge, depth, z));
        const face = edge.windward ? [
          edgePoint(floor, edge.edge, .22, inset, z),
          edgePoint(floor, edge.edge, .78, inset, z),
          edgePoint(floor, edge.edge, .78, inset, z + wallHeight * .82),
          edgePoint(floor, edge.edge, .22, inset, z + wallHeight * .82),
        ] : null;
        return <g key={`${floor.id}:${edge.edge}`} data-floor-id={floor.id} data-edge={edge.edge} style={influenceStyle(estimate, edge)} aria-hidden="true">
          {face && <polygon points={projectedPoints(face, project)} className="building-outdoor-influence-face" />}
          <line
            x1={source.x}
            y1={source.y}
            x2={target.x}
            y2={target.y}
            className="outdoor-influence-arrow building-outdoor-influence-arrow"
            markerEnd={`url(#${markerId})`}
          />
        </g>;
      });
    })}
  </g>;
}
