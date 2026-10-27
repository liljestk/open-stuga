import { registerSpatialLayerRoutes } from "../spatial-layers/index.js";
import { requestPrincipal } from "./support/index.js";
import type { ApiRouteRegistrationContext } from "./route-registration-context.js";

/** Spatial-layer reads, writes and the layer event stream, under the API's grants and Stuguby authority. */
export function registerSpatialLayerApiRoutes(context: ApiRouteRegistrationContext): void {
  registerSpatialLayerRoutes(context.app, {
    runtime: context.spatialLayers,
    prefix: context.prefix,
    authorizeScope: (request, response, scope) => {
      const access = request.path === `${context.prefix}/layers/events`
        ? context.currentStreamVisibility(request, response)
        : context.visibility(response);
      if (!access) return false;
      // A property aggregate may contain several houses, so a guest needs the
      // property-level grant. House-specific grants remain usable through the
      // corresponding house layer endpoint.
      return scope.kind === "house" ? access.house(scope.id) : access.hasProperty(scope.id);
    },
    authorizeMutation: (_request, response, scope) => {
      if (requestPrincipal(response).role === "guest") return false;
      try {
        if (scope.kind === "house") {
          context.stuguby.assertHouseWriteAllowed(scope.id);
          context.stuguby.assertHouseLocalAuthority(scope.id);
        } else {
          context.stuguby.assertPropertyWriteAllowed(scope.id);
        }
        return true;
      } catch {
        return false;
      }
    },
    auditActor: (_request, response) => requestPrincipal(response).userId,
    streamAuthorizationFingerprint: context.streamAuthorizationFingerprint,
    validateStream: (_request, response) => !context.rejectEventStreamDuringShutdown(response),
    acquireStream: (_request, response) => context.acquireEventStream(response),
  });
}
