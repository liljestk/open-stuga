import { withResponseSignal } from "./response-signal.js";
import type {
  ActionPlaybookInput,
} from "@climate-twin/contracts";
import { type AppConfig } from "../config.js";
import { apnsConfigured } from "../apns.js";
import { HttpError, UUID_PATTERN, bodyObject, boundedQueryInteger, enumValue, measurementId, optionalBoolean, optionalResourceQuery, parseActionPlaybookInput, parseActionRunStart, requestPrincipal, requireNonGuest, requireWorkspaceAdmin, requiredString, safeInteger } from "./support/index.js";
import { configureApiPart18 } from "./part-18.js";


type NormalizedApiConfig = { [Key in keyof AppConfig]-?: Exclude<AppConfig[Key], undefined> };

export function configureApiPart19(context: ReturnType<typeof configureApiPart18>) {
  const config = context.config as NormalizedApiConfig;
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
      if (!context.database.retryNotificationDelivery(request.params.id as string)) {
        throw new HttpError(409, "NOT_RETRYABLE", "Notification delivery is not dead-lettered or abandoned");
      }
      context.notificationOutbox.wake();
      const delivery = context.database.listNotificationDeliveries(500)
        .find((candidate) => candidate.id === request.params.id);
      response.json({ delivery: delivery ? { ...delivery, canRetry: false } : delivery });
    });
  context.app.get(`${context.prefix}/action-playbooks`, requireNonGuest, (request, response) => {
      const metric = typeof request.query.metric === "string" ? measurementId(request.query.metric) : undefined;
      response.json({ playbooks: context.database.listActionPlaybooks(metric, request.query.enabled === "true") });
    });
  context.app.post(`${context.prefix}/action-playbooks`, (request, response) => {
      response.status(201).json({ playbook: context.database.saveActionPlaybook(parseActionPlaybookInput(request.body) as ActionPlaybookInput) });
    });
  context.app.patch(`${context.prefix}/action-playbooks/:id`, (request, response) => {
      const playbook = context.database.updateActionPlaybook(
        request.params.id as string,
        parseActionPlaybookInput(request.body, true) as Partial<ActionPlaybookInput>,
      );
      if (!playbook) throw new HttpError(404, "NOT_FOUND", "Action playbook not found");
      response.json({ playbook });
    });
  context.app.get(`${context.prefix}/alerts/:id/action-playbooks`, (request, response) => {
      const event = context.database.getAlertEvent(request.params.id as string);
      if (!event || !context.visibility(response).sensor(event.sensorId)) {
        throw new HttpError(404, "NOT_FOUND", "Alert event not found");
      }
      response.json({ playbooks: context.database.listActionPlaybooks(event.metric, true) });
    });
  context.app.get(`${context.prefix}/action-runs`, (request, response) => {
      const access = context.visibility(response);
      const houseId = optionalResourceQuery(request.query.houseId, "houseId");
      if (houseId) {
        const house = context.database.getHouse(houseId);
        if (!house || !access.house(houseId)) throw new HttpError(404, "NOT_FOUND", "House not found");
      }
      response.json({ runs: context.database.listActionRuns({
        ...(houseId ? { houseId } : {}),
        ...(typeof request.query.sensorId === "string" ? { sensorId: request.query.sensorId } : {}),
        ...(typeof request.query.alertEventId === "string" ? { alertEventId: request.query.alertEventId } : {}),
        activeOnly: request.query.active === "true",
        limit: boundedQueryInteger(request.query.limit, "limit", 1, 500) ?? 500,
      }).filter((run) => access.sensor(run.sensorId)) });
    });
  context.app.post(`${context.prefix}/action-runs`, (request, response) => {
      const run = context.database.startActionRun(parseActionRunStart(request.body));
      context.bus.publish({ type: "mutation", data: { method: "POST", resource: `/action-runs/${run.id}`, occurredAt: run.createdAt } });
      response.status(201).json({ run });
    });
  context.app.post(`${context.prefix}/action-runs/:id/complete`, (request, response) => {
      const run = context.database.completeActionRun(request.params.id as string);
      if (!run) throw new HttpError(404, "NOT_FOUND", "Action run not found");
      context.bus.publish({ type: "mutation", data: { method: "PATCH", resource: `/action-runs/${run.id}`, occurredAt: run.updatedAt } });
      response.json({ run });
    });
  context.app.post(`${context.prefix}/action-runs/:id/cancel`, (request, response) => {
      const body = request.body === undefined ? {} : bodyObject(request.body);
      const note = body.note === undefined || body.note === null ? null : requiredString(body, "note");
      const run = context.database.cancelActionRun(request.params.id as string, note);
      if (!run) throw new HttpError(404, "NOT_FOUND", "Action run not found");
      context.bus.publish({ type: "mutation", data: { method: "PATCH", resource: `/action-runs/${run.id}`, occurredAt: run.updatedAt } });
      response.json({ run });
    });
  context.app.get(`${context.prefix}/data-export/preview`, requireWorkspaceAdmin, async (request, response) => {
      const privacyLevel = enumValue(request.query.privacyLevel ?? "operations", ["structure", "operations", "full"] as const, "privacyLevel");
      const includeTelemetry = request.query.includeTelemetry === "true";
      const preview = await withResponseSignal(response, signal => context.dataOperations.preview(privacyLevel, includeTelemetry, signal));
      response.json({ preview });
    });
  const extended = Object.assign(context, {  });
  return extended;
}
