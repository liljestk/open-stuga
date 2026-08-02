import {
  SystemStorageError,
} from "../system-storage.js";
import {
  HttpError,
  bodyObject,
  requestPrincipal,
  requireWorkspaceAdmin,
} from "./support/index.js";
import type { ApiRouteRegistrationContext } from "./route-registration-context.js";

export type SystemStorageRouteContext = Pick<
  ApiRouteRegistrationContext,
  "app" | "prefix" | "systemStorage" | "recordSecurityAudit"
>;

export function registerSystemStorageRoutes(context: SystemStorageRouteContext): void {
  context.app.get(`${context.prefix}/system/storage`, requireWorkspaceAdmin, (_request, response) => {
    response.setHeader("cache-control", "no-store");
    response.json(context.systemStorage.status());
  });

  context.app.put(`${context.prefix}/system/storage`, requireWorkspaceAdmin, (request, response, next) => {
    try {
      const status = context.systemStorage.queue(bodyObject(request.body));
      const principal = requestPrincipal(response);
      context.recordSecurityAudit(principal, {
        eventType: "system.storage.change.requested",
        subjectType: "system-storage",
        subjectId: status.operation?.id ?? "unchanged",
        details: {
          timeseriesKind: status.operation?.target.timeseries.kind ?? status.settings.timeseries.kind,
          backupKind: status.operation?.target.backups.kind ?? status.settings.backups.kind,
        },
      });
      response.setHeader("cache-control", "no-store");
      response.status(status.operation?.phase === "queued" ? 202 : 200).json(status);
    } catch (error) {
      if (error instanceof SystemStorageError) {
        next(new HttpError(error.status, error.code, error.message));
        return;
      }
      next(error instanceof TypeError
        ? new HttpError(400, "INVALID_STORAGE_SETTINGS", error.message)
        : error);
    }
  });
}
