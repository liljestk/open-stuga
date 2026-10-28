import {
  HttpError,
  bodyObject,
  requireWorkspaceAdmin,
} from "./support/index.js";
import type { ApiRouteRegistrationContext } from "./route-registration-context.js";

export type ScheduledDataExportRouteContext = Pick<
  ApiRouteRegistrationContext,
  "app" | "prefix" | "database" | "scheduledDataExports" | "visibility"
>;

function visibleHome(context: ScheduledDataExportRouteContext, response: Parameters<ScheduledDataExportRouteContext["visibility"]>[0], houseId: string): void {
  if (!context.database.getHouse(houseId) || !context.visibility(response).house(houseId)) {
    throw new HttpError(404, "NOT_FOUND", "Home not found");
  }
}

function scheduleForHome(context: ScheduledDataExportRouteContext, houseId: string, id: string): void {
  const schedule = context.scheduledDataExports.get(id);
  if (!schedule || schedule.houseId !== houseId) throw new HttpError(404, "NOT_FOUND", "Scheduled export not found");
}

export function registerScheduledDataExportRoutes(context: ScheduledDataExportRouteContext): void {
  const base = `${context.prefix}/houses/:houseId/scheduled-data-exports`;

  context.app.get(base, requireWorkspaceAdmin, (request, response) => {
    const houseId = request.params.houseId as string;
    visibleHome(context, response, houseId);
    response.setHeader("cache-control", "no-store");
    response.json({ exports: context.scheduledDataExports.list(houseId) });
  });

  context.app.post(base, requireWorkspaceAdmin, (request, response) => {
    const houseId = request.params.houseId as string;
    visibleHome(context, response, houseId);
    response.status(201).json({ export: context.scheduledDataExports.create(houseId, bodyObject(request.body)) });
  });

  context.app.put(`${base}/:id`, requireWorkspaceAdmin, (request, response) => {
    const houseId = request.params.houseId as string;
    const id = request.params.id as string;
    visibleHome(context, response, houseId);
    scheduleForHome(context, houseId, id);
    response.json({ export: context.scheduledDataExports.update(id, bodyObject(request.body)) });
  });

  context.app.delete(`${base}/:id`, requireWorkspaceAdmin, (request, response) => {
    const houseId = request.params.houseId as string;
    const id = request.params.id as string;
    visibleHome(context, response, houseId);
    scheduleForHome(context, houseId, id);
    context.scheduledDataExports.delete(id);
    response.status(204).end();
  });

  context.app.post(`${base}/:id/run`, requireWorkspaceAdmin, async (request, response) => {
    const houseId = request.params.houseId as string;
    const id = request.params.id as string;
    visibleHome(context, response, houseId);
    scheduleForHome(context, houseId, id);
    response.status(202).json({ export: await context.scheduledDataExports.runNow(id) });
  });
}
