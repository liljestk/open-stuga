import { useId, type CSSProperties } from "react";
import type { Floor, House } from "@climate-twin/contracts";
import type { SensorCoverageAssessment } from "../experimentalSpatialLayers";
import type { Point3D, ProjectedPoint3D } from "../spatialVolume";
import { useI18n } from "../i18n";

interface SensorCoverage2DProps {
  floor: Floor;
  assessment: SensorCoverageAssessment;
  scale: number;
}

interface SensorCoverage3DProps {
  house: House;
  assessment: SensorCoverageAssessment;
  project: (point: Point3D) => ProjectedPoint3D;
}

function supportStyle(support: number): CSSProperties {
  return { "--coverage-support": String(Math.max(.18, Math.min(1, support))) } as CSSProperties;
}

export function ExperimentalSensorCoverage2D({ floor, assessment, scale }: SensorCoverage2DProps) {
  const { t } = useI18n();
  const gradientId = `coverage-2d-${useId().replaceAll(":", "")}`;
  const regions = assessment.regions.filter((region) => region.floorId === floor.id);
  const recommendations = assessment.recommendations.filter((recommendation) => recommendation.floorId === floor.id);
  if (!regions.length && !recommendations.length) return null;
  const label = t("spatial.coverage.aria2d", {
    sensors: regions.length,
    suggestions: recommendations.length,
  });
  return <g className="experimental-coverage-layer experimental-coverage-layer-2d" role="img" aria-label={label}>
    <title>{label}</title>
    <defs>
      <radialGradient id={gradientId}>
        <stop offset="0" className="coverage-gradient-core" />
        <stop offset="58%" className="coverage-gradient-mid" />
        <stop offset="100%" className="coverage-gradient-edge" />
      </radialGradient>
    </defs>
    <g className="coverage-regions" aria-hidden="true">{regions.map((region) => <ellipse
      key={region.id}
      cx={region.x * scale}
      cy={region.y * scale}
      rx={region.radiusX * scale}
      ry={region.radiusY * scale}
      fill={`url(#${gradientId})`}
      style={supportStyle(region.support)}
      data-paired-humidity={region.pairedHumidity || undefined}
    />)}</g>
    <g className="coverage-recommendations">{recommendations.map((recommendation) => {
      const target = recommendation.roomName ?? recommendation.floorName;
      const recommendationLabel = recommendation.reason === "refresh-sensor"
        ? t("spatial.coverage.refreshMarker", { target })
        : t("spatial.coverage.addMarker", { target });
      return <g
        key={recommendation.id}
        transform={`translate(${recommendation.x * scale} ${recommendation.y * scale})`}
        className={`coverage-recommendation ${recommendation.reason}`}
        role="img"
        aria-label={recommendationLabel}
      >
        <title>{recommendationLabel}</title>
        <circle r="18" />
        <path d="M-7 0H7M0-7V7" />
      </g>;
    })}</g>
  </g>;
}

function projectedRadius(
  center: Point3D,
  radiusX: number,
  radiusY: number,
  radiusZ: number,
  project: (point: Point3D) => ProjectedPoint3D,
): { center: ProjectedPoint3D; rx: number; ry: number; angle: number } {
  const projectedCenter = project(center);
  const x = project({ ...center, x: center.x + radiusX });
  const y = project({ ...center, y: center.y + radiusY });
  const z = project({ ...center, z: center.z + radiusZ });
  const vectors = [x, y, z].map((point) => ({ x: point.x - projectedCenter.x, y: point.y - projectedCenter.y }));
  const xx = vectors.reduce((sum, vector) => sum + vector.x * vector.x, 0);
  const yy = vectors.reduce((sum, vector) => sum + vector.y * vector.y, 0);
  const xy = vectors.reduce((sum, vector) => sum + vector.x * vector.y, 0);
  const trace = xx + yy;
  const discriminant = Math.sqrt(Math.max(0, (xx - yy) ** 2 + 4 * xy ** 2));
  return {
    center: projectedCenter,
    rx: Math.max(12, Math.sqrt(Math.max(1, (trace + discriminant) / 2))),
    ry: Math.max(8, Math.sqrt(Math.max(1, (trace - discriminant) / 2))),
    angle: Math.atan2(2 * xy, xx - yy) * 90 / Math.PI,
  };
}

export function ExperimentalSensorCoverage3D({ house, assessment, project }: SensorCoverage3DProps) {
  const { t } = useI18n();
  const gradientId = `coverage-3d-${useId().replaceAll(":", "")}`;
  if (!assessment.regions.length && !assessment.recommendations.length) return null;
  const label = t("spatial.coverage.aria3d", {
    sensors: assessment.regions.length,
    suggestions: assessment.recommendations.length,
  });
  return <g className="experimental-coverage-layer experimental-coverage-layer-3d" role="img" aria-label={label}>
    <title>{label}</title>
    <defs>
      <radialGradient id={gradientId}>
        <stop offset="0" className="coverage-gradient-core" />
        <stop offset="58%" className="coverage-gradient-mid" />
        <stop offset="100%" className="coverage-gradient-edge" />
      </radialGradient>
    </defs>
    <g className="coverage-regions" aria-hidden="true">{assessment.regions.map((region) => {
      const projected = projectedRadius(region, region.radiusX, region.radiusY, region.radiusZ, project);
      return <ellipse
        key={region.id}
        cx={projected.center.x}
        cy={projected.center.y}
        rx={projected.rx}
        ry={projected.ry}
        transform={`rotate(${projected.angle.toFixed(1)} ${projected.center.x.toFixed(1)} ${projected.center.y.toFixed(1)})`}
        fill={`url(#${gradientId})`}
        style={supportStyle(region.support)}
        data-floor-id={region.floorId}
        data-paired-humidity={region.pairedHumidity || undefined}
      />;
    })}</g>
    <g className="coverage-recommendations">{assessment.recommendations.map((recommendation) => {
      if (!house.floors.some((floor) => floor.id === recommendation.floorId)) return null;
      const projected = project(recommendation);
      const target = recommendation.roomName ?? recommendation.floorName;
      const recommendationLabel = recommendation.reason === "refresh-sensor"
        ? t("spatial.coverage.refreshMarker", { target })
        : t("spatial.coverage.addMarker", { target });
      return <g
        key={recommendation.id}
        transform={`translate(${projected.x} ${projected.y})`}
        className={`coverage-recommendation ${recommendation.reason}`}
        role="img"
        aria-label={recommendationLabel}
        data-floor-id={recommendation.floorId}
      >
        <title>{recommendationLabel}</title>
        <circle r="14" />
        <path d="M-6 0H6M0-6V6" />
        <line x1="0" y1="14" x2="0" y2="27" />
      </g>;
    })}</g>
  </g>;
}
