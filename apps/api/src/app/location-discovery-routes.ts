import { HttpError } from "../http-error.js";
import { optionalQueryNumber } from "./support/query-fields.js";
import { requireNonGuest } from "./support/local-sessions.js";
import { recordFailureCause } from "../system-error-log.js";
import type { ApiRouteRegistrationContext } from "./route-registration-context.js";

export type LocationDiscoveryRouteContext = Pick<
  ApiRouteRegistrationContext,
  "app" | "prefix" | "locationDiscovery" | "systemErrorLog"
>;

export function registerLocationDiscoveryRoutes(context: LocationDiscoveryRouteContext): void {
  context.app.get(`${context.prefix}/locations/search`, requireNonGuest, async (request, response) => {
    const query = typeof request.query.q === "string" ? request.query.q.trim() : "";
    if (query.length < 2 || query.length > 120) {
      throw new HttpError(400, "INVALID_LOCATION_QUERY", "q must contain between 2 and 120 characters");
    }
    const language = typeof request.query.language === "string" ? request.query.language : "en";
    try {
      response.json({ results: await context.locationDiscovery.search(query, language) });
    } catch (error) {
      recordFailureCause(context.systemErrorLog, "location-discovery", error);
      throw new HttpError(503, "LOCATION_DISCOVERY_UNAVAILABLE", "Location search is temporarily unavailable");
    }
  });
  context.app.get(`${context.prefix}/locations/defaults`, requireNonGuest, async (request, response) => {
    const latitude = optionalQueryNumber(request.query.latitude, "latitude");
    const longitude = optionalQueryNumber(request.query.longitude, "longitude");
    if (latitude === null || longitude === null) {
      throw new HttpError(400, "INVALID_FIELD", "latitude and longitude are required");
    }
    try {
      response.json(await context.locationDiscovery.defaultsForCoordinates(latitude, longitude));
    } catch (error) {
      if (error instanceof HttpError) throw error;
      recordFailureCause(context.systemErrorLog, "location-discovery", error);
      throw new HttpError(503, "LOCATION_DISCOVERY_UNAVAILABLE", "Timezone discovery is temporarily unavailable");
    }
  });
}
