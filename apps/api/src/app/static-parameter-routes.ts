import type { Request, Response } from "express";
import type { StaticParameter } from "@climate-twin/contracts";
import { HttpError, bodyObject, enumValue, optionalString, requiredString } from "./support/index.js";
import type { ApiRouteRegistrationContext } from "./route-registration-context.js";

/** Static house parameters (also served under the older /static-parameters path). */
export function registerStaticParameterRoutes(context: ApiRouteRegistrationContext): void {
  context.app.get(`${context.prefix}/parameters`, (request, response) => {
      response.json({ parameters: visibleParameters(context, request, response) });
    });
  context.app.post(`${context.prefix}/parameters`, (request, response) => {
      response.status(200).json({ parameter: saveParameter(context, bodyObject(request.body), { allowId: true }) });
    });
  // Compatibility path: the same list, and a create answered 201 with the bare parameter.
  context.app.get(`${context.prefix}/static-parameters`, (request, response) => {
      response.json({ parameters: visibleParameters(context, request, response) });
    });
  context.app.post(`${context.prefix}/static-parameters`, (request, response) => {
      response.status(201).json(saveParameter(context, bodyObject(request.body), { allowId: false }));
    });
  context.app.delete(`${context.prefix}/parameters/:id`, (request, response) => {
      const id = request.params.id as string;
      const current = context.database.listParameters().find((parameter) => parameter.id === id);
      if (current) context.stuguby.assertHouseLocalAuthority(current.houseId);
      if (!context.database.deleteParameter(id)) throw new HttpError(404, "NOT_FOUND", "Static parameter not found");
      response.status(204).end();
    });
}

/** Static parameters of the requested Home (or of every Home), limited to Homes the caller may see. */
function visibleParameters(context: ApiRouteRegistrationContext, request: Request, response: Response): StaticParameter[] {
  const access = context.visibility(response);
  return context.database.listParameters(typeof request.query.houseId === "string" ? request.query.houseId : undefined)
    .filter((parameter) => access.house(parameter.houseId));
}

/** Validates and saves a parameter; `allowId` lets the canonical path upsert an existing one. */
function saveParameter(context: ApiRouteRegistrationContext, body: Record<string, unknown>, options: { allowId: boolean }): StaticParameter {
  if (!["string", "number", "boolean"].includes(typeof body.value)) throw new HttpError(400, "INVALID_FIELD", "value must be a string, number, or boolean");
  const houseId = requiredString(body, "houseId");
  context.stuguby.assertHouseLocalAuthority(houseId);
  return context.database.saveParameter({
    ...(options.allowId && typeof body.id === "string" ? { id: body.id } : {}),
    houseId,
    scopeType: enumValue(body.scopeType, ["house", "floor", "room", "sensor"] as const, "scopeType"),
    scopeId: requiredString(body, "scopeId"), key: requiredString(body, "key"),
    value: body.value as StaticParameter["value"], unit: body.unit === null ? null : optionalString(body, "unit") ?? null,
    label: requiredString(body, "label"),
  });
}
