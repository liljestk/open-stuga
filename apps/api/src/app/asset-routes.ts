import { HttpError, SAFE_ASSET_MIME_TYPES, bodyObject, enumValue, requiredString } from "./support/index.js";
import type { ApiRouteRegistrationContext } from "./route-registration-context.js";

/** Uploaded assets. */
export function registerAssetRoutes(context: ApiRouteRegistrationContext): void {
  context.app.get(`${context.prefix}/assets`, (request, response) => {
      const access = context.visibility(response);
      response.json({ assets: context.database.listAssets(typeof request.query.houseId === "string" ? request.query.houseId : undefined)
        .filter((asset) => access.house(asset.houseId)) });
    });
  context.app.post(`${context.prefix}/assets`, (request, response) => {
      const body = bodyObject(request.body);
      const houseId = requiredString(body, "houseId");
      context.stuguby.assertHouseLocalAuthority(houseId);
      const mimeType = requiredString(body, "mimeType").toLowerCase();
      if (!SAFE_ASSET_MIME_TYPES.has(mimeType)) {
        throw new HttpError(415, "UNSUPPORTED_ASSET_TYPE", "Assets must be PNG, JPEG, WebP, glTF, or GLB");
      }
      const encoded = requiredString(body, "data").replace(/^data:[^;]+;base64,/, "");
      const data = Buffer.from(encoded, "base64");
      if (data.length === 0) throw new HttpError(400, "INVALID_ASSET", "data must contain valid base64 bytes");
      if (data.length > 10 * 1024 * 1024) throw new HttpError(413, "ASSET_TOO_LARGE", "Decoded assets are limited to 10 MiB");
      const asset = context.database.createAsset({
        houseId, name: requiredString(body, "name"), mimeType,
        kind: enumValue(body.kind, ["floor-plan", "model-3d", "other"] as const, "kind"), data,
      });
      response.status(201).json({ asset, url: `${context.prefix}/assets/${asset.id}` });
    });
  context.app.get(`${context.prefix}/assets/:id`, (request, response) => {
      const asset = context.database.getAsset(request.params.id as string);
      if (!asset || !context.visibility(response).house(asset.houseId)) throw new HttpError(404, "NOT_FOUND", "Asset not found");
      response.setHeader("content-type", asset.mimeType);
      response.setHeader("content-length", String(asset.size));
      response.setHeader("content-security-policy", "sandbox; default-src 'none'");
      const disposition = asset.mimeType.startsWith("image/") ? "inline" : "attachment";
      response.setHeader("content-disposition", `${disposition}; filename="${asset.name.replace(/["\r\n]/g, "_")}"`);
      response.send(Buffer.from(asset.data));
    });
  context.app.delete(`${context.prefix}/assets/:id`, (request, response) => {
      const id = request.params.id as string;
      const current = context.database.getAsset(id);
      if (current) context.stuguby.assertHouseLocalAuthority(current.houseId);
      if (!context.database.deleteAsset(id)) throw new HttpError(404, "NOT_FOUND", "Asset not found");
      response.status(204).end();
    });
}
