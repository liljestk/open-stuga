import { requireWorkspaceAdmin } from "./support/index.js";
import type { ApiRouteRegistrationContext } from "./route-registration-context.js";

export type HostSystemRouteContext = Pick<
  ApiRouteRegistrationContext,
  "app" | "prefix" | "hostSystem" | "status" | "systemErrorLog"
>;

export function registerHostSystemRoutes(context: HostSystemRouteContext): void {
  context.app.get(`${context.prefix}/system/health`, requireWorkspaceAdmin, async (_request, response) => {
    response.setHeader("cache-control", "no-store");
    const health = await context.hostSystem.snapshot();
    const telegram = context.status.value.telegram;
    response.json({
      ...health,
      alertDelivery: {
        telegram: {
          configured: telegram?.configured ?? false,
          connected: telegram?.configured ? telegram.connected : null,
          lastDeliveryAt: telegram?.lastDeliveryAt ?? null,
          error: telegram?.error ?? null,
        },
      },
    });
  });
  context.app.get(`${context.prefix}/system/metrics`, (request, response, next) => {
    if (response.locals.hostMetricsAuthorized === true) {
      next();
      return;
    }
    requireWorkspaceAdmin(request, response, next);
  }, async (_request, response) => {
    response.setHeader("cache-control", "no-store");
    response.type("text/plain; version=0.0.4; charset=utf-8");
    response.send(await context.hostSystem.prometheusMetrics());
  });
  context.app.get(`${context.prefix}/system/error-logs`, requireWorkspaceAdmin, (_request, response) => {
    const date = new Date().toISOString().slice(0, 10);
    response.setHeader("cache-control", "no-store");
    response.setHeader("content-security-policy", "sandbox");
    response.setHeader("content-disposition", `attachment; filename="stugu-error-logs-${date}.ndjson"`);
    response.type("application/x-ndjson; charset=utf-8");
    response.send(context.systemErrorLog.exportNdjson());
  });
}
