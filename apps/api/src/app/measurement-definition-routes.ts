import {
  HttpError,
  measurementId,
  parseMeasurementDefinition,
} from "./support/index.js";
import type { ApiRouteRegistrationContext } from "./route-registration-context.js";

export type MeasurementDefinitionRouteContext = Pick<
  ApiRouteRegistrationContext,
  "app" | "v2Prefix" | "database"
>;

export function registerMeasurementDefinitionRoutes(context: MeasurementDefinitionRouteContext): void {
  context.app.get(`${context.v2Prefix}/measurement-definitions`, (request, response) => {
    const includeDisabled = request.query.includeDisabled !== "false";
    response.json({ definitions: context.database.listMeasurementDefinitions(includeDisabled) });
  });
  context.app.post(`${context.v2Prefix}/measurement-definitions`, (request, response) => {
    const definition = context.database.createMeasurementDefinition(parseMeasurementDefinition(request.body));
    response.status(201).json({ definition });
  });
  context.app.patch(`${context.v2Prefix}/measurement-definitions/:id`, (request, response) => {
    const id = measurementId(request.params.id, "id");
    const current = context.database.getMeasurementDefinition(id);
    if (!current) throw new HttpError(404, "NOT_FOUND", "Measurement definition not found");
    const definition = context.database.updateMeasurementDefinition(id, parseMeasurementDefinition(request.body, current));
    response.json({ definition });
  });
  context.app.delete(`${context.v2Prefix}/measurement-definitions/:id`, (request, response) => {
    const definition = context.database.disableMeasurementDefinition(measurementId(request.params.id, "id"));
    if (!definition) throw new HttpError(404, "NOT_FOUND", "Measurement definition not found");
    response.json({ definition });
  });
}
