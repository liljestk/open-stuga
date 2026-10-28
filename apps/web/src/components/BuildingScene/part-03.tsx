import { isAirflowPlanElement, type ConfiguredOpeningState, type Floor, type ManualObservation, type PlanElement } from "@climate-twin/contracts";
import {
  type Point3D,
  type ProjectedPoint3D,
} from "../../spatialVolume";
import {
  isWallOpening,
} from "../../planElementGeometry";
import { fireplaceChimneyDimensions, fireplaceChimneyTop, isRoofSpanningFireplace } from "../../architecturalGeometry";
import { effectiveOpeningState, openingStateCanChange, openingStateKey } from "../../openingState";
import { elementAxis, elementWorldGeometry, points } from "./sceneGeometry";
import { useBuildingScenePart02 } from "./part-02";
export function useBuildingScenePart03(context: ReturnType<typeof useBuildingScenePart02>) {
  const { house, editing, openingStateLabelsVisible, pendingOpeningStateKeys, onOpeningStateChange, t, houseOpeningStateObservations, selectedElementKey, effectiveReferenceTimeMs, project, activateFloor, selectArchitecturalElement } = context;
  const renderArchitecturalElement = (floor: Floor, element: PlanElement, index: number) => {
      const geometry = elementWorldGeometry(floor, element);
      const chimneyDimensions = isRoofSpanningFireplace(element) ? fireplaceChimneyDimensions(floor, element) : null;
      const chimneyGeometry = chimneyDimensions ? elementWorldGeometry(floor, element, {
        width: chimneyDimensions.width,
        depth: chimneyDimensions.depth,
        bottom: floor.elevation,
        height: Math.max(.05, fireplaceChimneyTop(house, floor, element) - floor.elevation),
      }) : null;
      const chimneyFront = chimneyGeometry?.front.map(project);
      const chimneyBack = chimneyGeometry?.back?.map(project);
      const chimneyLeft = chimneyGeometry?.left?.map(project);
      const chimneyRight = chimneyGeometry?.right?.map(project);
      const chimneyTop = chimneyGeometry?.top?.map(project);
      const front = geometry.front.map(project);
      const back = geometry.back?.map(project);
      const left = geometry.left?.map(project);
      const right = geometry.right?.map(project);
      const top = geometry.top?.map(project);
      const selected = selectedElementKey?.floorId === floor.id && selectedElementKey.elementId === element.id;
      const airflowElement = isAirflowPlanElement(element) ? element : null;
      const openingState = airflowElement
        ? effectiveOpeningState(house.id, floor.id, airflowElement, houseOpeningStateObservations, effectiveReferenceTimeMs)
        : null;
      const wallOpeningIsOpen = Boolean(openingState?.state === "open" && isWallOpening(element));
      const openingIsSliding = (element.kind === "door" || element.kind === "window") && element.variant === "sliding";
      const openingHasLeaf = wallOpeningIsOpen && !(element.kind === "door" && element.variant === "open-passage");
      const openingLeafWorld: Point3D[] | null = openingHasLeaf ? (() => {
        const axis = elementAxis(floor, element);
        const fraction = Math.min(1, Math.max(.2, openingState?.openFraction ?? 1));
        if (openingIsSliding) {
          const offset = geometry.width * fraction * .62;
          return geometry.front.map((point) => ({ ...point, x: point.x + axis.x * offset, y: point.y + axis.y * offset }));
        }
        let outward = { x: -axis.y, y: axis.x };
        const fromCentre = { x: element.position.x - floor.width / 2, y: element.position.y - floor.height / 2 };
        if (outward.x * fromCentre.x + outward.y * fromCentre.y < 0) outward = { x: -outward.x, y: -outward.y };
        const angle = Math.PI * (element.kind === "door" ? .46 : .34) * fraction;
        const direction = {
          x: axis.x * Math.cos(angle) + outward.x * Math.sin(angle),
          y: axis.y * Math.cos(angle) + outward.y * Math.sin(angle),
        };
        const bottomHinge = geometry.front[0]!;
        const topHinge = geometry.front[3]!;
        return [
          bottomHinge,
          { x: bottomHinge.x + direction.x * geometry.width, y: bottomHinge.y + direction.y * geometry.width, z: bottomHinge.z },
          { x: topHinge.x + direction.x * geometry.width, y: topHinge.y + direction.y * geometry.width, z: topHinge.z },
          topHinge,
        ];
      })() : null;
      const openingLeaf = openingLeafWorld?.map(project) ?? null;
      const openingMotionPath = openingLeafWorld && !openingIsSliding ? (() => {
        const axis = elementAxis(floor, element);
        let outward = { x: -axis.y, y: axis.x };
        const fromCentre = { x: element.position.x - floor.width / 2, y: element.position.y - floor.height / 2 };
        if (outward.x * fromCentre.x + outward.y * fromCentre.y < 0) outward = { x: -outward.x, y: -outward.y };
        const fraction = Math.min(1, Math.max(.2, openingState?.openFraction ?? 1));
        const angle = Math.PI * (element.kind === "door" ? .46 : .34) * fraction;
        const hinge = geometry.front[0]!;
        return Array.from({ length: 9 }, (_, step) => {
          const progress = angle * step / 8;
          return project({
            x: hinge.x + (axis.x * Math.cos(progress) + outward.x * Math.sin(progress)) * geometry.width,
            y: hinge.y + (axis.y * Math.cos(progress) + outward.y * Math.sin(progress)) * geometry.width,
            z: hinge.z + (element.kind === "window" ? geometry.height * .5 : .02),
          });
        });
      })() : null;
      const openingControlEnabled = Boolean(
        airflowElement && openingState && !editing && onOpeningStateChange && openingStateCanChange(airflowElement),
      );
      const openingPending = openingControlEnabled && pendingOpeningStateKeys.has(openingStateKey(floor.id, element.id));
      const nextOpeningState: ConfiguredOpeningState | null = openingState?.state === "open" ? "closed" : openingState ? "open" : null;
      const openingName = `${element.label ?? t(`planElement.${element.kind}`)} ${index + 1}`;
      const openingStateLabel = openingState ? t(`opening.state.${openingState.state}`) : null;
      const stateLabel = openingStateLabel ? ` ${t("opening.state")} ${openingStateLabel}.` : "";
      const geometryLabel = `${openingName}, ${floor.name}.${stateLabel} ${t("twin.elementWidth")} ${Number(geometry.width.toFixed(2))} ${t("twin.planUnit")}. ${t("twin.elementHeight")} ${geometry.height.toFixed(2)} m.`;
      const label = openingControlEnabled && openingState && nextOpeningState
        ? t("opening.toggleAria", {
          opening: `${openingName}, ${floor.name}`,
          state: t(`opening.state.${openingState.state}`),
          action: t(`opening.state.${nextOpeningState}`),
        })
        : geometryLabel;
      const verticalMidpoint = (a: ProjectedPoint3D, b: ProjectedPoint3D) => ({ x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 });
      const bottomMid = verticalMidpoint(front[0]!, front[1]!);
      const topMid = verticalMidpoint(front[3]!, front[2]!);
      const leftMid = verticalMidpoint(front[0]!, front[3]!);
      const rightMid = verticalMidpoint(front[1]!, front[2]!);
      const visibleFront = openingLeaf ?? front;
      const visibleBottomMid = verticalMidpoint(visibleFront[0]!, visibleFront[1]!);
      const visibleTopMid = verticalMidpoint(visibleFront[3]!, visibleFront[2]!);
      const visibleLeftMid = verticalMidpoint(visibleFront[0]!, visibleFront[3]!);
      const visibleRightMid = verticalMidpoint(visibleFront[1]!, visibleFront[2]!);
      const ventSlats = element.kind === "vent" ? (openingState?.state === "closed"
        ? [.16, .3, .44, .58, .72, .86]
        : [.2, .4, .6, .8]).map((progress) => {
          const tilt = openingState?.state === "open" ? .055 : 0;
          return {
            from: {
              x: front[0]!.x + (front[3]!.x - front[0]!.x) * (progress + tilt),
              y: front[0]!.y + (front[3]!.y - front[0]!.y) * (progress + tilt),
            },
            to: {
              x: front[1]!.x + (front[2]!.x - front[1]!.x) * (progress - tilt),
              y: front[1]!.y + (front[2]!.y - front[1]!.y) * (progress - tilt),
            },
          };
        }) : [];
      const stateBadgeWidth = openingStateLabel
        ? Math.min(104, Math.max(52, Array.from(openingStateLabel).length * 6.4 + 29))
        : 0;
      const openingVisualModel = !openingState
        ? undefined
        : element.kind === "vent"
          ? `louvers-${openingState.state}`
          : openingState.state === "closed"
            ? "closed"
            : openingIsSliding
              ? "sliding-open"
              : openingLeaf
                ? "swing-open"
                : "open-aperture";
      const frontXs = front.map((point) => point.x);
      const frontYs = front.map((point) => point.y);
      const hitPadding = 12;
      return (
        <g
          key={`${floor.id}:${element.id}`}
          className={`building-plan-element ${element.kind} ${openingState ? `opening-${openingState.state}` : ""} ${openingControlEnabled ? "opening-control" : ""} ${openingPending ? "pending" : ""} ${selected ? "selected" : ""} ${editing ? "editable" : ""}`}
          role={editing || openingControlEnabled ? "button" : "img"}
          tabIndex={editing || openingControlEnabled ? 0 : undefined}
          aria-label={label}
          aria-pressed={editing ? selected : openingControlEnabled ? openingState?.state === "open" : undefined}
          aria-busy={openingPending || undefined}
          data-element-id={element.id}
          data-floor-id={floor.id}
          data-kind={element.kind}
          data-width={geometry.width.toFixed(4)}
            data-height={geometry.height.toFixed(4)}
            data-bottom={geometry.bottom.toFixed(4)}
            data-depth={geometry.depth.toFixed(4)}
          data-opening-state={openingState?.state}
          data-opening-source={openingState?.source}
          data-opening-visual={openingVisualModel}
          onPointerDown={editing
            ? (event) => selectArchitecturalElement(event, floor.id, element.id)
            : openingControlEnabled
              ? (event) => { event.stopPropagation(); }
              : undefined}
          onClick={editing
            ? (event) => event.stopPropagation()
            : openingControlEnabled
              ? (event) => {
                event.preventDefault();
                event.stopPropagation();
                if (!openingPending && nextOpeningState) onOpeningStateChange?.(floor.id, element.id, nextOpeningState);
              }
              : (event) => {
                event.stopPropagation();
                activateFloor(floor.id);
              }}
          onKeyDown={editing
            ? (event) => selectArchitecturalElement(event, floor.id, element.id)
            : openingControlEnabled
              ? (event) => {
                if (event.key !== "Enter" && event.key !== " ") return;
                event.preventDefault();
                event.stopPropagation();
                if (!openingPending && nextOpeningState) onOpeningStateChange?.(floor.id, element.id, nextOpeningState);
              }
              : undefined}
        >
          <title>{label}</title>
          {(editing || openingControlEnabled) && <rect
            x={Math.min(...frontXs) - hitPadding}
            y={Math.min(...frontYs) - hitPadding}
            width={Math.max(...frontXs) - Math.min(...frontXs) + hitPadding * 2}
            height={Math.max(...frontYs) - Math.min(...frontYs) + hitPadding * 2}
            className="building-element-hit-target"
          />}
          {chimneyGeometry && <g className="building-chimney" data-vertical-extent="roof" data-bottom={chimneyGeometry.bottom.toFixed(4)} data-height={chimneyGeometry.height.toFixed(4)} data-width={chimneyGeometry.width.toFixed(4)} data-depth={chimneyGeometry.depth.toFixed(4)}>
            {chimneyBack && <polygon points={points(chimneyBack)} className="building-chimney-side" />}
            {chimneyLeft && <polygon points={points(chimneyLeft)} className="building-chimney-side" />}
            {chimneyRight && <polygon points={points(chimneyRight)} className="building-chimney-side" />}
            {chimneyTop && <polygon points={points(chimneyTop)} className="building-chimney-cap" />}
            {chimneyFront && <polygon points={points(chimneyFront)} className="building-chimney-front" />}
            {chimneyFront && [.12, .24, .36, .48, .6, .72, .84].map((progress) => {
              const from = { x: chimneyFront[0]!.x + (chimneyFront[3]!.x - chimneyFront[0]!.x) * progress, y: chimneyFront[0]!.y + (chimneyFront[3]!.y - chimneyFront[0]!.y) * progress };
              const to = { x: chimneyFront[1]!.x + (chimneyFront[2]!.x - chimneyFront[1]!.x) * progress, y: chimneyFront[1]!.y + (chimneyFront[2]!.y - chimneyFront[1]!.y) * progress };
              return <line key={progress} x1={from.x} y1={from.y} x2={to.x} y2={to.y} className="building-chimney-course" />;
            })}
          </g>}
          {back && <polygon points={points(back)} className="building-element-side building-element-back" />}
          {left && <polygon points={points(left)} className="building-element-side building-element-left" />}
          {right && <polygon points={points(right)} className="building-element-side building-element-right" />}
          {top && <polygon points={points(top)} className="building-element-side building-element-top" />}
          {wallOpeningIsOpen
            ? <polygon points={points(front)} className="building-opening-aperture" />
            : <polygon points={points(front)} className="building-element-front" />}
          {openingMotionPath && <polyline points={points(openingMotionPath)} className="building-opening-motion-path" />}
          {openingLeaf && <polygon points={points(openingLeaf)} className="building-element-front building-opening-leaf" />}
          {element.kind === "window" && <>
            <line x1={visibleBottomMid.x} y1={visibleBottomMid.y} x2={visibleTopMid.x} y2={visibleTopMid.y} className="building-window-frame" />
            <line x1={visibleLeftMid.x} y1={visibleLeftMid.y} x2={visibleRightMid.x} y2={visibleRightMid.y} className="building-window-frame" />
          </>}
          {element.kind === "door" && (!wallOpeningIsOpen || openingLeaf) && <circle cx={(visibleFront[0]!.x * .24 + visibleFront[1]!.x * .66 + visibleFront[2]!.x * .1)} cy={(visibleFront[0]!.y * .24 + visibleFront[1]!.y * .66 + visibleFront[2]!.y * .1)} r="3.2" className="building-door-handle" />}
          {element.kind === "vent" && <g className="building-vent-louvers" aria-hidden="true">
            {ventSlats.map((slat, slatIndex) => <line key={slatIndex} x1={slat.from.x} y1={slat.from.y} x2={slat.to.x} y2={slat.to.y} />)}
          </g>}
          {element.kind === "fireEscape" && (element.variant ?? "ladder") === "ladder" && <g className="building-fire-escape-detail">
            {[.14, .29, .44, .59, .74, .89].map((progress) => {
              const from = { x: front[0]!.x + (front[3]!.x - front[0]!.x) * progress, y: front[0]!.y + (front[3]!.y - front[0]!.y) * progress };
              const to = { x: front[1]!.x + (front[2]!.x - front[1]!.x) * progress, y: front[1]!.y + (front[2]!.y - front[1]!.y) * progress };
              return <line key={progress} x1={from.x} y1={from.y} x2={to.x} y2={to.y} />;
            })}
            <line x1={front[0]!.x} y1={front[0]!.y} x2={front[3]!.x} y2={front[3]!.y} />
            <line x1={front[1]!.x} y1={front[1]!.y} x2={front[2]!.x} y2={front[2]!.y} />
          </g>}
          {element.kind === "fireEscape" && element.variant === "stairs" && <g className="building-fire-escape-detail stairs">
            <line x1={front[0]!.x} y1={front[0]!.y} x2={front[2]!.x} y2={front[2]!.y} />
            {[.18, .36, .54, .72, .9].map((progress) => {
              const point = { x: front[0]!.x + (front[2]!.x - front[0]!.x) * progress, y: front[0]!.y + (front[2]!.y - front[0]!.y) * progress };
              const end = { x: front[1]!.x + (front[2]!.x - front[1]!.x) * progress, y: front[1]!.y + (front[2]!.y - front[1]!.y) * progress };
              return <line key={progress} x1={point.x} y1={point.y} x2={end.x} y2={end.y} />;
            })}
          </g>}
          {openingStateLabelsVisible && openingState && openingStateLabel && <g
            className="building-opening-state-badge"
            transform={`translate(${topMid.x.toFixed(1)} ${(topMid.y - 18).toFixed(1)})`}
            data-opening-state-label={openingState.state}
            aria-hidden="true"
          >
            <rect x={-stateBadgeWidth / 2} y="-11" width={stateBadgeWidth} height="22" rx="5" />
            {openingState.state === "open"
              ? <path d={`M${-stateBadgeWidth / 2 + 8} 4V-4H${-stateBadgeWidth / 2 + 17}V4M${-stateBadgeWidth / 2 + 8} -4L${-stateBadgeWidth / 2 + 13} -1V4`} className="building-opening-state-icon" />
              : <path d={`M${-stateBadgeWidth / 2 + 8} -4H${-stateBadgeWidth / 2 + 17}V4H${-stateBadgeWidth / 2 + 8}ZM${-stateBadgeWidth / 2 + 12.5} -4V4`} className="building-opening-state-icon" />}
            <text x={-stateBadgeWidth / 2 + 23} y=".5">{openingStateLabel}</text>
          </g>}
          {element.kind === "fireplace" && <path d={`M${bottomMid.x.toFixed(1)} ${bottomMid.y.toFixed(1)}Q${((leftMid.x + rightMid.x) / 2 - 7).toFixed(1)} ${((leftMid.y + rightMid.y) / 2 + 3).toFixed(1)} ${topMid.x.toFixed(1)} ${topMid.y.toFixed(1)}Q${((leftMid.x + rightMid.x) / 2 + 9).toFixed(1)} ${((leftMid.y + rightMid.y) / 2 + 5).toFixed(1)} ${bottomMid.x.toFixed(1)} ${bottomMid.y.toFixed(1)}Z`} className="building-fireplace-flame" />}
          {selected && <polygon points={points(front)} className="building-element-selection" />}
        </g>
      );
    };
  const observationName = (observation: ManualObservation) => t(`observations.${observation.kind === "note" ? "noteKind" : observation.kind}`);
  return Object.assign(context, { renderArchitecturalElement, observationName });
}
