import type {
  Floor,
  HouseLocation,
  HouseMapPlacement,
} from "@climate-twin/contracts";
import {
  outdoorLocationKey,
} from "../db.js";
import {
  WeatherRequestSupersededError,
  WeatherUnavailableError,
} from "../weather.js";
import { prefersFmi } from "../open-meteo.js";
import {
  WeatherEventSupersededError,
} from "../weather-events.js";
import { HttpError, bodyObject, dateValue, houseLocationValue, houseMapPlacementValue, requiredNumber, requiredString, safeInteger } from "./support/index.js";
import { configureApiPart14 } from "./part-14.js";


export function configureApiPart15(context: ReturnType<typeof configureApiPart14>) {
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
  context.app.patch(`${context.prefix}/houses/:id`, async (request, response) => {
      const houseId = request.params.id as string;
      const previous = context.database.getHouse(houseId);
      context.stuguby.assertHouseWriteAllowed(houseId);
      const body = bodyObject(request.body);
      const patch: {
        name?: string;
        timezone?: string;
        propertyId?: string;
        orientationDegrees?: number | null;
        floors?: Floor[];
        location?: HouseLocation | null;
        mapPlacement?: HouseMapPlacement | null;
      } = {};
      if (body.name !== undefined) patch.name = requiredString(body, "name");
      if (body.timezone !== undefined) patch.timezone = requiredString(body, "timezone");
      if (body.propertyId !== undefined) patch.propertyId = requiredString(body, "propertyId");
      if (body.location !== undefined) patch.location = houseLocationValue(body.location, true);
      if (body.mapPlacement !== undefined) patch.mapPlacement = houseMapPlacementValue(body.mapPlacement, true);
      if (body.orientationDegrees !== undefined) {
        patch.orientationDegrees = body.orientationDegrees === null ? null : requiredNumber(body, "orientationDegrees");
      }
      if (body.floors !== undefined) {
        if (!Array.isArray(body.floors)) throw new HttpError(400, "INVALID_FIELD", "floors must be an array");
        patch.floors = body.floors as Floor[];
      }
      if (patch.propertyId !== undefined && patch.propertyId !== previous?.propertyId
        && previous?.stuguby?.ownership === "shared" && previous.stuguby.syncState !== "detached") {
        throw new HttpError(
          409,
          "STUGBY_HOME_PROPERTY_MANAGED",
          "A shared Home remains in its adopted Stuguby Property until permanent disconnect",
        );
      }
      if (patch.propertyId !== undefined && patch.propertyId !== previous?.propertyId && previous) {
        const sourceLink = context.database.getProperty(previous.propertyId)?.stuguby;
        const targetLink = context.database.getProperty(patch.propertyId)?.stuguby;
        if ((sourceLink && sourceLink.syncState !== "detached") || (targetLink && targetLink.syncState !== "detached")) {
          throw new HttpError(
            409,
            "STUGBY_PROPERTY_MIGRATION_REQUIRED",
            "Use the reviewed Stuguby Property migration to move a local Home into or out of an adopted Property",
          );
        }
      }
      if (patch.floors) context.stuguby.assertSharedHouseFloorPlanAssetsUnchanged(houseId, patch.floors);
      if (patch.location !== undefined) await context.requireArchivedBeforeCascade("house-location", houseId);
      const house = context.database.transaction(() => {
        const updated = context.database.updateHouse(houseId, patch);
        if (!updated) throw new HttpError(404, "NOT_FOUND", "House not found");
        context.stuguby.captureHomeMutation(updated.id);
        return updated;
      });
      if (patch.floors !== undefined) context.homeAssistant.refreshMappings();
      if (previous) {
        const observedAt = new Date().toISOString();
        if (previous.propertyId !== house.propertyId) {
          context.notifySpatial((runtime) => {
            runtime.scheduler.enqueueScope({ kind: "property", id: previous.propertyId }, observedAt, "ownership-changed", true);
            runtime.scheduler.wakeHouse(house.id, house.propertyId, observedAt, "ownership-changed");
          });
        } else if (patch.name !== undefined || patch.floors !== undefined || patch.location !== undefined
          || patch.mapPlacement !== undefined || patch.orientationDegrees !== undefined) {
          context.notifySpatial((runtime) => runtime.scheduler.wakeHouse(
            house.id,
            house.propertyId,
            observedAt,
            "property-context-changed",
          ));
        }
      }
      context.weather.invalidate(house.id);
      context.weatherEvents.invalidate(house.id);
      context.status.refreshWeatherConfiguration();
      if (patch.location !== undefined && context.options.startBackground) {
        // Configuration changes may request a coalesced background cycle, but
        // never make the foreground mutation wait for upstream weather.
        context.weatherMonitor.requestRun();
      }
      response.json({ house });
    });
  const extended = Object.assign(context, {  });
  return extended;
}
