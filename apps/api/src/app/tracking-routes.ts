import { registerTrackingRoutes } from "../tracking/routes.js";
import type { AuthenticatedTrackingObserver } from "../tracking/store.js";
import { LocalVisibility } from "./support/index.js";
import type { LocalRequestPrincipal } from "./support/index.js";
import type { ApiRouteRegistrationContext } from "./route-registration-context.js";

/** Member location sharing, equipment loans and the tracking stream, under the API's principals and grants. */
export function registerTrackingApiRoutes(context: ApiRouteRegistrationContext): void {
  registerTrackingRoutes(context.app, {
    service: context.tracking,
    prefix: context.prefix,
    principal: (response) => {
      const principal = response.locals.localPrincipal as LocalRequestPrincipal | undefined;
      return principal
        ? {
            userId: principal.userId,
            label: principal.email || "Property member",
            role: principal.role,
          }
        : null;
    },
    machineObserver: (response) => (
      response.locals.trackingObserver as AuthenticatedTrackingObserver | undefined
    ) ?? null,
    authorizeProperty: (response, propertyId) => {
      const principal = response.locals.localPrincipal as LocalRequestPrincipal | undefined;
      return principal ? new LocalVisibility(context.database, principal).hasProperty(propertyId) : false;
    },
    authorizeEquipment: (response, equipmentId) => {
      const principal = response.locals.localPrincipal as LocalRequestPrincipal | undefined;
      const equipment = context.database.getAreaEquipment(equipmentId);
      return Boolean(
        principal
        && equipment
        && new LocalVisibility(context.database, principal).equipment(equipment),
      );
    },
    assertPropertyWriteAllowed: (propertyId) => context.stuguby.assertPropertyWriteAllowed(propertyId),
    streamAuthorizationFingerprint: context.streamAuthorizationFingerprint,
    validateStream: (_request, response) => !context.rejectEventStreamDuringShutdown(response),
    acquireStream: (_request, response) => context.acquireEventStream(response),
    registerStream: context.registerEventStream,
  });
}
