import type { StaticParameter } from "@climate-twin/contracts";
import { HttpError, bodyObject, enumValue, optionalString, requiredString } from "./support/index.js";
import type { ApiRouteRegistrationContext } from "./route-registration-context.js";

/** Static house parameters (also served under the older /parameters path). */
export function registerStaticParameterRoutes(context: ApiRouteRegistrationContext): void {
  context.app.get(`${context.prefix}/parameters`, (request, response) => {
      const access = context.visibility(response);
      response.json({ parameters: context.database.listParameters(typeof request.query.houseId === "string" ? request.query.houseId : undefined)
        .filter((parameter) => access.house(parameter.houseId)) });
    });
  context.app.post(`${context.prefix}/parameters`, (request, response) => {
      const body = bodyObject(request.body);
      if (!["string", "number", "boolean"].includes(typeof body.value)) throw new HttpError(400, "INVALID_FIELD", "value must be a string, number, or boolean");
      const houseId = requiredString(body, "houseId");
      context.stuguby.assertHouseLocalAuthority(houseId);
      const parameter = context.database.saveParameter({
        ...(typeof body.id === "string" ? { id: body.id } : {}),
        houseId,
        scopeType: enumValue(body.scopeType, ["house", "floor", "room", "sensor"] as const, "scopeType"),
        scopeId: requiredString(body, "scopeId"), key: requiredString(body, "key"),
        value: body.value as StaticParameter["value"], unit: body.unit === null ? null : optionalString(body, "unit") ?? null,
        label: requiredString(body, "label"),
      });
      response.status(200).json({ parameter });
    });
  context.app.get(`${context.prefix}/static-parameters`, (request, response) => {
      const access = context.visibility(response);
      response.json({ parameters: context.database.listParameters(typeof request.query.houseId === "string" ? request.query.houseId : undefined)
        .filter((parameter) => access.house(parameter.houseId)) });
    });
  context.app.post(`${context.prefix}/static-parameters`, (request, response) => {
      const body = bodyObject(request.body);
      if (!["string", "number", "boolean"].includes(typeof body.value)) throw new HttpError(400, "INVALID_FIELD", "value must be a string, number, or boolean");
      const houseId = requiredString(body, "houseId");
      context.stuguby.assertHouseLocalAuthority(houseId);
      const parameter = context.database.saveParameter({
        houseId, scopeType: enumValue(body.scopeType, ["house", "floor", "room", "sensor"] as const, "scopeType"),
        scopeId: requiredString(body, "scopeId"), key: requiredString(body, "key"), value: body.value as StaticParameter["value"],
        unit: body.unit === null ? null : optionalString(body, "unit") ?? null, label: requiredString(body, "label"),
      });
      response.status(201).json(parameter);
    });
  context.app.delete(`${context.prefix}/parameters/:id`, (request, response) => {
      const id = request.params.id as string;
      const current = context.database.listParameters().find((parameter) => parameter.id === id);
      if (current) context.stuguby.assertHouseLocalAuthority(current.houseId);
      if (!context.database.deleteParameter(id)) throw new HttpError(404, "NOT_FOUND", "Static parameter not found");
      response.status(204).end();
    });
}
