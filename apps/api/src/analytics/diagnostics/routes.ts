import { roleCanAccessNonGuestConfiguration } from "@climate-twin/contracts";
import { withResponseSignal } from "../../app/response-signal.js";
import type express from "express";
import type { ClimateDatabase } from "../../db.js";
import type { EnergySummaryCache } from "../../electricity/summary-cache.js";
import type { EnergyProjectionCache } from "../../electricity/projection-cache.js";
import { HttpError } from "../../http-error.js";
import { requestPrincipal } from "../../app/support/local-sessions.js";
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
    if (!roleCanAccessNonGuestConfiguration(requestPrincipal(response).role)) {
      throw new HttpError(403, "GUEST_READ_ONLY", "Guest accounts cannot read analytics diagnostics");
    }
    const sensors = context.database.listSensors(house.id).filter((sensor) => sensor.enabled && access.sensor(sensor.id));
    const diagnostics = await withResponseSignal(response, (signal) => service.diagnose(house, sensors, signal));
    response.setHeader("cache-control", "private, no-store");
    response.json({ diagnostics });
  });
}
