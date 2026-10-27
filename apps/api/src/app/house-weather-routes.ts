import { outdoorLocationKey } from "../db.js";
import { WeatherRequestSupersededError, WeatherUnavailableError } from "../weather.js";
import { prefersFmi } from "../open-meteo.js";
import { WeatherEventSupersededError } from "../weather-events.js";
import { HttpError, dateValue, safeInteger } from "./support/index.js";
import type { ApiRouteRegistrationContext } from "./route-registration-context.js";

/** Current weather and outdoor temperature history for a house. */
export function registerHouseWeatherRoutes(context: ApiRouteRegistrationContext): void {
  context.app.get(`${context.prefix}/houses/:id/weather`, async (request, response) => {
      const house = context.database.getHouse(request.params.id as string);
      if (!house || !context.visibility(response).house(house.id)) throw new HttpError(404, "NOT_FOUND", "House not found");
      context.stuguby.assertHouseLocalAuthority(house.id);
      if (!house.location) {
        throw new HttpError(409, "HOUSE_LOCATION_REQUIRED", "Set the house location before requesting weather");
      }
      const hours = safeInteger(request.query.hours, 48, 1, 240);
      try {
        const result = await context.weather.get(house, hours);
        const current = context.database.getHouse(house.id);
        if (!current) throw new HttpError(404, "NOT_FOUND", "House not found");
        if (current.updatedAt !== house.updatedAt
          || outdoorLocationKey(current.location) !== outdoorLocationKey(result.location)) {
          throw new WeatherRequestSupersededError();
        }
        response.setHeader("cache-control", "private, no-store");
        response.json({ weather: result });
      } catch (error) {
        if (error instanceof WeatherRequestSupersededError || error instanceof WeatherEventSupersededError) {
          throw new HttpError(409, "WEATHER_REQUEST_SUPERSEDED", error.message);
        }
        if (error instanceof WeatherUnavailableError) {
          throw new HttpError(503, "WEATHER_UNAVAILABLE", error.message, {
            provider: house.location && !prefersFmi(house.location) ? "open-meteo" : "fmi",
            recovery: context.weather.recoveryStatus(house),
          });
        }
        throw error;
      }
    });
  context.app.get(`${context.v2Prefix}/houses/:id/outdoor-temperature/history`, async (request, response) => {
      const house = context.database.getHouse(request.params.id as string);
      if (!house || !context.visibility(response).house(house.id)) throw new HttpError(404, "NOT_FOUND", "House not found");
      context.stuguby.assertHouseLocalAuthority(house.id);
      const to = dateValue(request.query.to, new Date(), "to");
      const from = dateValue(request.query.from, new Date(Date.parse(to) - 24 * 3_600_000), "from");
      if (Date.parse(from) > Date.parse(to)) throw new HttpError(400, "INVALID_RANGE", "from must be before to");
      const limit = safeInteger(request.query.limit, 20_000, 1, 50_000);
      if (!house.location) {
        response.json({ samples: [], from, to, truncated: false });
        return;
      }
      const archived = (await context.telemetryReader.outdoorTemperatureHistory({
        houseId: house.id,
        locationKey: outdoorLocationKey(house.location),
        from,
        to,
        limit: limit + 1,
      })).records;
      const truncated = archived.length > limit;
      response.json({ samples: truncated ? archived.slice(-limit) : archived, from, to, truncated });
    });
}
