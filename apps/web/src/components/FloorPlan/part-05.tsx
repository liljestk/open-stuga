import { type CSSProperties } from "react";
import { type TranslationKey } from "../../i18n";
import { cardinalDirection, normalizeDegrees } from "../../outdoorContext";
import {
  formatOutdoorHumidity,
  formatOutdoorTemperature,
  formatOutdoorWindSpeed,
} from "../OutdoorConditionsBadge";
import {
  defaultPlanElementWidth,
  editablePlanElementWidthBounds,
  isWallAttachedPlanElement,
  planElementHeightBounds,
} from "../../planElementGeometry";
import { useFloorPlanPart04 } from "./part-04";
export function useFloorPlanPart05(context: ReturnType<typeof useFloorPlanPart04>) {
  const { floor, definition, units, outdoor, spatialLayerSnapshots, experimentalSensorCoverage, experimentalOutdoorInfluence, locale, t, wallStart, roomStart, selectedWallId, planElementKind, placementError, undoMessage, snapEnabled, keyboardPoint, renderScale, metresPerPlanUnit, renderWidth, renderHeight, clouds, drawingWall, drawingRoom, placingElement, selectedRoom, selectedPlanElement, resolveElementPlacement, outdoorContext, airflow, airflowPaths, activeGradientFlows } = context;
  const hasOutdoorWindCue = outdoorContext?.planWindFromDegrees != null && outdoorContext.windFromDegrees != null;
  const hasMapInformation = clouds.length > 0 || airflowPaths.length > 0 || activeGradientFlows.length > 0
      || hasOutdoorWindCue || Boolean(experimentalSensorCoverage) || Boolean(experimentalOutdoorInfluence) || spatialLayerSnapshots.length > 0;
  const airflowSupport = airflow
      ? t(`spatial.airflow.support.${airflow.evidence.support}` as TranslationKey)
      : t("spatial.airflow.support.low");
  const airflowDriver = airflow?.evidence.windDriven
      ? t("spatial.airflow.driverBuoyancyWind")
      : t("spatial.airflow.driverBuoyancy");
  const airflowDescription = airflow ? t("spatial.airflow.description", {
      temperature: airflow.evidence.temperatureSensors,
      humidity: airflow.evidence.humiditySensors,
      tracer: airflow.evidence.tracerSensors,
      driver: airflowDriver,
    }) : "";
  const airflowAria = airflow ? t("spatial.airflow.aria", {
      support: airflowSupport,
      temperature: airflow.evidence.temperatureSensors,
      humidity: airflow.evidence.humiditySensors,
      tracer: airflow.evidence.tracerSensors,
    }) : "";
  const outdoorTemperature = outdoorContext
      ? formatOutdoorTemperature(outdoorContext.conditions.temperatureC, units, locale)
      : null;
  const outdoorHumidity = outdoorContext
      ? formatOutdoorHumidity(outdoorContext.conditions.relativeHumidityPercent, locale)
      : null;
  const outdoorTemperatureColor = outdoor?.conditionColors?.temperature;
  const outdoorHumidityColor = outdoor?.conditionColors?.humidity;
  const activeOutdoorColor = definition.id === "temperature"
      ? outdoorTemperatureColor
      : definition.id === "humidity"
        ? outdoorHumidityColor
        : undefined;
  const activeOutdoorStyle = activeOutdoorColor
      ? ({ "--outdoor-active-color": activeOutdoorColor } as CSSProperties)
      : undefined;
  const outdoorTemperatureStyle = outdoorTemperatureColor
      ? ({ "--outdoor-condition-color": outdoorTemperatureColor } as CSSProperties)
      : undefined;
  const outdoorHumidityStyle = outdoorHumidityColor
      ? ({ "--outdoor-condition-color": outdoorHumidityColor } as CSSProperties)
      : undefined;
  const outdoorWindSpeed = outdoorContext
      ? formatOutdoorWindSpeed(outdoorContext.conditions.windSpeedMps, units, locale)
      : null;
  const outdoorWindDirection = outdoorContext?.windFromCardinal && outdoorContext.windFromDegrees !== null
      ? `${t(`outdoor.cardinal.${outdoorContext.windFromCardinal}` as TranslationKey)} ${Math.round(outdoorContext.windFromDegrees)}°`
      : null;
  const outdoorWindwardSide = outdoorContext?.windwardEdge
      ? t(`outdoor.edge.${outdoorContext.windwardEdge}` as TranslationKey)
      : null;
  const outdoorShellLabel = [
      t("outdoor.shellLabel"),
      outdoorTemperature && t("outdoor.temperatureAria", { value: outdoorTemperature }),
      outdoorHumidity && t("outdoor.humidityAria", { value: outdoorHumidity }),
      outdoorWindSpeed && t("outdoor.windSpeedAria", { value: outdoorWindSpeed }),
      outdoorWindDirection && t("outdoor.windFromAria", { value: outdoorWindDirection }),
      outdoorWindwardSide && t("outdoor.windwardAria", { edge: outdoorWindwardSide }),
    ].filter(Boolean).join(". ");
  const edgeLabels = outdoor?.orientationDegrees === undefined ? [] : ([
      { edge: "top", x: renderWidth / 2, y: -28, bearing: outdoor.orientationDegrees },
      { edge: "right", x: renderWidth + 34, y: renderHeight / 2, bearing: outdoor.orientationDegrees + 90 },
      { edge: "bottom", x: renderWidth / 2, y: renderHeight + 36, bearing: outdoor.orientationDegrees + 180 },
      { edge: "left", x: -34, y: renderHeight / 2, bearing: outdoor.orientationDegrees + 270 },
    ] as const).map((item) => {
      const bearing = normalizeDegrees(item.bearing);
      return { ...item, bearing, cardinal: cardinalDirection(bearing) };
    });
  const elementPreviewPlacement = placingElement
      ? resolveElementPlacement(planElementKind, keyboardPoint, defaultPlanElementWidth(floor, planElementKind)).placement
      : null;
  const selectedElementWidthBounds = selectedPlanElement ? editablePlanElementWidthBounds(floor, selectedPlanElement) : null;
  const selectedElementHeightBounds = selectedPlanElement ? planElementHeightBounds(floor, selectedPlanElement.kind) : null;
  const selectedElementRotation = selectedPlanElement ? Math.round(normalizeDegrees(selectedPlanElement.rotationDegrees)) % 360 : 0;
  const selectedElementHasCardinalRotation = [0, 90, 180, 270].includes(selectedElementRotation);
  const wallPreview = wallStart ? (() => {
      const coordinates = {
        x1: wallStart.x * renderScale,
        y1: wallStart.y * renderScale,
        x2: keyboardPoint.x * renderScale,
        y2: keyboardPoint.y * renderScale,
      };
      const planLength = Math.hypot(keyboardPoint.x - wallStart.x, keyboardPoint.y - wallStart.y);
      const physicalLength = metresPerPlanUnit === null ? null : planLength * metresPerPlanUnit;
      const dimensionLabel = physicalLength === null
        ? t("twin.wallLengthPlanUnits", { length: new Intl.NumberFormat(locale, { maximumFractionDigits: 2 }).format(planLength) })
        : t("twin.wallLengthMetres", { length: new Intl.NumberFormat(locale, { maximumFractionDigits: 2 }).format(physicalLength) });
      const midpoint = { x: (coordinates.x1 + coordinates.x2) / 2, y: (coordinates.y1 + coordinates.y2) / 2 };
      const angle = Math.atan2(coordinates.y2 - coordinates.y1, coordinates.x2 - coordinates.x1) * 180 / Math.PI;
      const readableAngle = angle > 90 || angle < -90 ? angle + 180 : angle;
      return { coordinates, dimensionLabel, midpoint, physicalLength, readableAngle, start: wallStart };
    })() : null;
  const editorHint = placementError ?? undoMessage
      ?? (selectedWallId
        ? t("twin.wallSelected")
        : selectedRoom
          ? t("twin.roomSelected")
          : selectedPlanElement
            ? t(isWallAttachedPlanElement(selectedPlanElement) ? "twin.elementSelected" : "twin.fixtureSelected", {
              element: t(`planElement.${selectedPlanElement.kind}` as TranslationKey),
              degrees: selectedElementRotation,
            })
            : drawingWall
              ? wallStart ? t("twin.wallEnd") : t("twin.wallStart")
              : drawingRoom
                ? roomStart ? t("twin.roomEnd") : t("twin.roomStart")
                : placingElement
                  ? t(planElementKind === "door" || planElementKind === "window" || planElementKind === "fireEscape" ? "twin.openingPlacement" : "twin.elementPlacement", { element: t(`planElement.${planElementKind}` as TranslationKey) })
                  : `${t("twin.dragHint")} ${snapEnabled ? t("twin.snapOnHint") : t("twin.snapOffHint")}`);
  return Object.assign(context, { hasOutdoorWindCue, hasMapInformation, airflowSupport, airflowDriver, airflowDescription, airflowAria, outdoorTemperature, outdoorHumidity, outdoorTemperatureColor, outdoorHumidityColor, activeOutdoorColor, activeOutdoorStyle, outdoorTemperatureStyle, outdoorHumidityStyle, outdoorWindSpeed, outdoorWindDirection, outdoorWindwardSide, outdoorShellLabel, edgeLabels, elementPreviewPlacement, selectedElementWidthBounds, selectedElementHeightBounds, selectedElementRotation, selectedElementHasCardinalRotation, wallPreview, editorHint });
}
