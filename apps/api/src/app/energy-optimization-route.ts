import type { EnergyOptimizationReport } from "@climate-twin/contracts";
import { LruTtlCache } from "../cache.js";
import { HttpError } from "../http-error.js";
import { localAuthorizationFingerprint, requestPrincipal } from "./support/local-sessions.js";
import { safeInteger } from "./support/query-fields.js";
import { withResponseSignal } from "./response-signal.js";
import type { ApiRouteRegistrationContext } from "./route-registration-context.js";

type Context = ApiRouteRegistrationContext;
const REFRESH_MS = 30_000;
/** Changes to these resources can change a report; live readings and device states cannot. */
const RELEVANT_MUTATION = /^\/(?:properties|houses|sensors)(?:\/|$)/u;

/** Share one bounded calculation for repeated reads of the same authorized scope. */
export function registerEnergyOptimizationRoute(context: Context): () => void {
  const cache = new LruTtlCache<EnergyOptimizationReport>({
    maxEntries: 64, maxBytes: 2 * 1024 * 1024, defaultTtlMs: REFRESH_MS,
  });
  const removeStats = context.analyticsWorkLimiter.registerCache("energy-optimization", () => cache.stats());
  const removeWake = context.bus.subscribe(event => {
    if (event.type === "mutation" && RELEVANT_MUTATION.test(event.data.resource)) cache.clear();
  });
  context.app.get(`${context.prefix}/properties/:id/energy-optimization`, async (request, response) => {
    const propertyId = request.params.id as string;
    const property = context.database.getProperty(propertyId);
    if (!property || !context.visibility(response).hasProperty(propertyId)) {
      throw new HttpError(404, "NOT_FOUND", "Property not found");
    }
    const hours = safeInteger(request.query.windowHours, 2, 1, 12);
    const now = new Date();
    const key = JSON.stringify([propertyId, hours, Math.floor(now.getTime() / REFRESH_MS),
      localAuthorizationFingerprint(requestPrincipal(response)), property.updatedAt,
      context.database.getPropertyElectricityConfig(propertyId)]);
    const report = await withResponseSignal(response, signal => cache.getOrLoad(key, sharedSignal => (
      context.analyticsWorkLimiter.run("energy-optimization",
        () => context.energyOptimizer.report(propertyId, hours, now, sharedSignal), sharedSignal)
    ), { signal, serveStale: false }));
    response.json({ report });
  });
  return () => { removeWake(); removeStats(); cache.clear(); };
}
