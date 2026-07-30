import { requireWorkspaceAdmin } from "./support/index.js";
import type { ApiRouteRegistrationContext } from "./route-registration-context.js";

export type HostSystemRouteContext = Pick<
  ApiRouteRegistrationContext,
  "app" | "prefix" | "hostSystem"
>;

export function registerHostSystemRoutes(context: HostSystemRouteContext): void {
  context.app.get(`${context.prefix}/system/health`, requireWorkspaceAdmin, async (_request, response, next) => {
    try {
      response.setHeader("cache-control", "no-store");
      response.json(await context.hostSystem.snapshot());
    } catch (error) {
      next(error);
    }
  });
  context.app.get(`${context.prefix}/system/metrics`, (request, response, next) => {
    if (response.locals.hostMetricsAuthorized === true) {
      next();
      return;
    }
    requireWorkspaceAdmin(request, response, next);
  }, async (_request, response, next) => {
    try {
      response.setHeader("cache-control", "no-store");
      response.type("text/plain; version=0.0.4; charset=utf-8");
      response.send(await context.hostSystem.prometheusMetrics());
    } catch (error) {
      next(error);
    }
  });
}
