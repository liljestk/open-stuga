import { apnsConfigured } from "../apns.js";
import { HttpError, UUID_PATTERN, bodyObject, enumValue, optionalBoolean, requestPrincipal, requireWorkspaceAdmin, requiredString, safeInteger } from "./support/index.js";
import type { ApiRouteRegistrationContext } from "./route-registration-context.js";

/** iOS notification registrations and notification delivery history. */
export function registerNotificationRoutes(context: ApiRouteRegistrationContext): void {
  const config = context.config;
  context.app.get(`${context.prefix}/ios-notification-registrations/:id`, (request, response) => {
      const id = request.params.id as string;
      if (!UUID_PATTERN.test(id)) {
        throw new HttpError(400, "INVALID_IOS_REGISTRATION_ID", "Notification registration id must be a UUID");
      }
      const principal = requestPrincipal(response);
      response.setHeader("cache-control", "no-store");
      response.json({
        configured: apnsConfigured(config),
        registration: context.database.getIOSNotificationRegistration(principal.userId, id),
      });
    });
  context.app.put(`${context.prefix}/ios-notification-registrations/:id`, (request, response) => {
      const id = request.params.id as string;
      if (!UUID_PATTERN.test(id)) {
        throw new HttpError(400, "INVALID_IOS_REGISTRATION_ID", "Notification registration id must be a UUID");
      }
      const body = bodyObject(request.body);
      const deviceToken = requiredString(body, "deviceToken").toLowerCase();
      if (!/^[a-f0-9]{64,200}$/u.test(deviceToken) || deviceToken.length % 2 !== 0) {
        throw new HttpError(400, "INVALID_IOS_DEVICE_TOKEN", "deviceToken must be an APNs hexadecimal device token");
      }
      if (!Array.isArray(body.homeIds) || body.homeIds.length > 100) {
        throw new HttpError(400, "INVALID_FIELD", "homeIds must be an array of at most 100 Home ids");
      }
      const homeIds = [...new Set(body.homeIds.map((value) => {
        if (typeof value !== "string" || !value.trim() || value.length > 200) {
          throw new HttpError(400, "INVALID_FIELD", "Every homeIds value must be a non-empty string of at most 200 characters");
        }
        return value.trim();
      }))];
      const access = context.visibility(response);
      for (const homeId of homeIds) {
        if (!context.database.getHouse(homeId) || !access.house(homeId)) {
          throw new HttpError(404, "NOT_FOUND", "Home not found");
        }
      }
      const principal = requestPrincipal(response);
      if (principal.bootstrap) {
        throw new HttpError(409, "ACCOUNT_REQUIRED", "Create and sign in to a local account before enabling notifications");
      }
      const registration = context.database.saveIOSNotificationRegistration(principal.userId, id, {
        deviceToken,
        environment: enumValue(body.environment, ["sandbox", "production"] as const, "environment"),
        homeIds,
        minimumSeverity: enumValue(
          body.minimumSeverity ?? "warning",
          ["info", "warning", "critical"] as const,
          "minimumSeverity",
        ),
        includeDetails: optionalBoolean(body, "includeDetails") ?? false,
      });
      response.setHeader("cache-control", "no-store");
      response.json({ configured: apnsConfigured(config), registration });
    });
  context.app.delete(`${context.prefix}/ios-notification-registrations/:id`, (request, response) => {
      const id = request.params.id as string;
      if (!UUID_PATTERN.test(id)) {
        throw new HttpError(400, "INVALID_IOS_REGISTRATION_ID", "Notification registration id must be a UUID");
      }
      context.database.deleteIOSNotificationRegistration(requestPrincipal(response).userId, id);
      response.setHeader("cache-control", "no-store");
      response.status(204).end();
    });
  context.app.get(`${context.prefix}/notification-deliveries`, (request, response) => {
      const access = context.visibility(response);
      const principal = requestPrincipal(response);
      const canManageDeliveries = principal.role === "owner" || principal.role === "admin";
      const limit = safeInteger(request.query.limit, 200, 1, 500);
      const deliveries = context.database.listNotificationDeliveries(limit * 2).filter((delivery) => {
        if (delivery.subjectKind !== "alert") return !access.restricted;
        const event = context.database.getAlertEvent(delivery.subjectId);
        if (!event || !access.sensor(event.sensorId)) return false;
        if (!access.restricted) return true;
        return delivery.channel !== "apns"
          || context.database.getIOSNotificationRegistration(
            principal.userId,
            delivery.destinationId,
          ) !== null;
      }).slice(0, limit).map((delivery) => ({
        ...delivery,
        canRetry: canManageDeliveries
          && delivery.deliveredAt === null
          && (delivery.deadLetteredAt !== null || delivery.abandonedAt !== null),
      }));
      response.json({ deliveries });
    });
  context.app.post(`${context.prefix}/notification-deliveries/:id/retry`, requireWorkspaceAdmin, (request, response) => {
      const id = request.params.id as string;
      if (!context.database.retryNotificationDelivery(id)) {
        throw new HttpError(409, "NOT_RETRYABLE", "Notification delivery is not dead-lettered or abandoned");
      }
      context.notificationOutbox.wake();
      const delivery = context.database.getNotificationDelivery(id);
      if (!delivery) throw new HttpError(404, "NOT_FOUND", "Notification delivery not found");
      response.json({ delivery: { ...delivery, canRetry: false } });
    });
}
