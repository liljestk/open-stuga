import { useMemo } from "react";
import type { OutdoorBoundaryContext } from "../outdoor/context";
import { createOutdoorWindFlowGeometry } from "../outdoor/windFlow";
import "./OutdoorWindFlow2D.css";

export interface OutdoorWindFlow2DProps {
  context: OutdoorBoundaryContext;
  width: number;
  height: number;
  shellOffset: number;
  windLabel: string | null;
  animationsEnabled: boolean;
  extrasVisible: boolean;
  reducedMotion: boolean;
}

export function OutdoorWindFlow2D({
  context,
  width,
  height,
  shellOffset,
  windLabel,
  animationsEnabled,
  extrasVisible,
  reducedMotion,
}: OutdoorWindFlow2DProps) {
  const geometry = useMemo(
    () => createOutdoorWindFlowGeometry(context, width, height, shellOffset),
    [
      context.conditions.windSpeedMps,
      context.planWindFromDegrees,
      context.stale,
      height,
      shellOffset,
      width,
    ],
  );
  if (!geometry) return null;
  const animate = animationsEnabled && !reducedMotion && geometry.motionSupported;
  const routes = [...geometry.incomingPaths, ...geometry.bypassPaths];

  return (
    <g
      className={`outdoor-wind-visualization ${animate ? "animated" : "static"} ${context.stale ? "stale" : ""}`}
      data-wind-speed-mps={context.conditions.windSpeedMps}
      data-motion-supported={geometry.motionSupported}
      aria-hidden="true"
    >
      <path
        d={geometry.windwardPath}
        className="outdoor-shell-windward-edge"
        data-windward-edge={context.windwardEdge ?? undefined}
        data-source-edge={geometry.sourceEdge}
        data-wind-from-degrees={context.windFromDegrees ?? undefined}
        data-plan-wind-from-degrees={context.planWindFromDegrees ?? undefined}
      />
      <circle cx={geometry.source.x} cy={geometry.source.y} r="5.5" className="outdoor-wind-contact-dot" />
      {animate && (
        <g className="outdoor-wind-motion">
          {routes.map((path, routeIndex) => (
            <g key={`${routeIndex}-${path}`} className={routeIndex < geometry.incomingPaths.length ? "incoming" : "bypass"}>
              <path d={path} className="outdoor-wind-route" />
              {Array.from({ length: geometry.particleCount }, (_, particleIndex) => (
                <rect
                  key={particleIndex}
                  x="-9"
                  y="-1.7"
                  width="18"
                  height="3.4"
                  rx="1.7"
                  className="outdoor-wind-streak"
                >
                  <animateMotion
                    begin={`${((routeIndex * .19) + particleIndex * geometry.durationSeconds / geometry.particleCount).toFixed(2)}s`}
                    dur={`${geometry.durationSeconds}s`}
                    repeatCount="indefinite"
                    rotate="auto"
                    path={path}
                  />
                </rect>
              ))}
            </g>
          ))}
        </g>
      )}
      {extrasVisible && windLabel && (
        <g
          className="outdoor-wind-label"
          transform={`translate(${geometry.source.x.toFixed(2)} ${geometry.source.y.toFixed(2)}) rotate(${geometry.labelRotation})`}
        >
          <rect x="-112" y="-19" width="224" height="38" rx="19" />
          <circle cx="-91" cy="0" r="5" />
          <text x="10" y="1" textAnchor="middle" dominantBaseline="middle">{windLabel}</text>
        </g>
      )}
    </g>
  );
}
