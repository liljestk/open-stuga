import { HttpError, safeInteger } from "./support/index.js";
import type { ApiRouteRegistrationContext } from "./route-registration-context.js";

/** Aggregate integration status and recorded sensor data gaps. */
export function registerIntegrationStatusRoutes(context: ApiRouteRegistrationContext): void {
  context.app.get(`${context.prefix}/integrations/status`, (request, response) => {
      context.dataMode.synchronize();
      const houseId = typeof request.query.houseId === "string" ? request.query.houseId.trim() : undefined;
      if (houseId && !context.database.getHouse(houseId)) throw new HttpError(404, "NOT_FOUND", "House not found");
      response.json(context.integrationStatusForHouse(houseId));
    });
  context.app.get(`${context.prefix}/integrations/sensor-data-gaps`, (request, response) => {
      const houseId = typeof request.query.houseId === "string" ? request.query.houseId.trim() : undefined;
      const sensorId = typeof request.query.sensorId === "string" ? request.query.sensorId.trim() : undefined;
      const access = context.visibility(response);
      if (houseId && (!context.database.getHouse(houseId) || !access.house(houseId))) {
        throw new HttpError(404, "NOT_FOUND", "House not found");
      }
      const limit = safeInteger(request.query.limit, 100, 1, 1_000);
      const visibleHouseIds = houseId
        ? [houseId]
        : access.restricted
          ? context.database.listHouses().filter((house) => access.house(house.id)).map((house) => house.id)
          : null;
      const gaps = (visibleHouseIds === null
        ? context.database.listSensorDataGaps(sensorId, limit)
        : visibleHouseIds
          .flatMap((visibleHouseId) => context.database.listHouseSensorDataGaps(visibleHouseId, sensorId, limit))
          .sort((left, right) => right.startedAt.localeCompare(left.startedAt) || right.id - left.id)
          .slice(0, limit))
        .filter((gap) => {
          const sensor = context.database.getSensor(gap.sensorId);
          return Boolean(sensor && access.sensor(gap.sensorId));
        });
      response.json({ gaps });
    });
}
