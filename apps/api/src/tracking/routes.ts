import type { Application } from "express";
import type { TrackingRouteOptions } from "./route-support.js";
import { registerTrackingCoreRoutes } from "./routes-core.js";
import { registerTrackingLiveRoutes } from "./routes-live.js";

export type { TrackingRoutePrincipal, TrackingRouteOptions } from "./route-support.js";

export function registerTrackingRoutes(app: Application, options: TrackingRouteOptions): void {
  registerTrackingCoreRoutes(app, options);
  registerTrackingLiveRoutes(app, options);
}
