import type express from "express";
import type { ClimateDatabase } from "../../db.js";
import type { EnergySummaryCache } from "../../energy-summary-cache.js";
import type { EnergyProjectionCache } from "../../electricity/projection-cache.js";
import { HttpError, requestPrincipal } from "../../app/support/index.js";
import { AnalyticsDiagnosticsService } from "./service.js";

export interface AnalyticsDiagnosticsRouteContext {
  app: express.Express;
  v2Prefix: string;
  database: ClimateDatabase;
  energySummaries: EnergySummaryCache;
  energyProjections: EnergyProjectionCache;
  visibility(response: express.Response): {
    house(houseId: string): boolean;
    sensor(sensorId: string): boolean;
  };
}

/** Appliance-collected evidence of how the analytics performed for a Home. Not for Guests: it includes bills. */
export function registerAnalyticsDiagnosticsRoutes(context: AnalyticsDiagnosticsRouteContext): void {
  const service = new AnalyticsDiagnosticsService(context.database, context.energySummaries, context.energyProjections);
  context.app.get(`${context.v2Prefix}/analytics/diagnostics`, async (request, response) => {
    const houseId = typeof request.query.houseId === "string" ? request.query.houseId.trim() : "";
    if (!houseId || houseId.length > 200) throw new HttpError(400, "INVALID_FIELD", "houseId is required");
    const house = context.database.getHouse(houseId);
    const access = context.visibility(response);
    if (!house || !access.house(house.id)) {
      throw new HttpError(404, "ANALYTICS_SCOPE_NOT_FOUND", "Analytics house scope was not found");
    }
    if (requestPrincipal(response).role === "guest") {
      throw new HttpError(403, "GUEST_READ_ONLY", "Guest accounts cannot read analytics diagnostics");
    }
    const sensors = context.database.listSensors(house.id).filter((sensor) => sensor.enabled && access.sensor(sensor.id));
    const abortController = new AbortController();
    const abortOnClose = () => abortController.abort();
    response.once("close", abortOnClose);
    try {
      const diagnostics = await service.diagnose(house, sensors, abortController.signal);
      response.setHeader("cache-control", "private, no-store");
      response.json({ diagnostics });
    } finally {
      response.off("close", abortOnClose);
    }
  });
}
