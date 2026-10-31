import { CLOUD_EXPORT_PROVIDERS, isOneOf, type CloudExportProvider } from "@climate-twin/contracts";
import { HttpError } from "../http-error.js";
import { bodyObject } from "../request-fields.js";
import { requestPrincipal, requireWorkspaceAdmin } from "./support/local-sessions.js";
import { requireJsonContentType } from "./support/request-classification.js";
import type { ApiRouteRegistrationContext } from "./route-registration-context.js";

export type ExportDestinationRouteContext = Pick<
  ApiRouteRegistrationContext,
  "app" | "prefix" | "exportDestinations" | "recordSecurityAudit"
>;

function providerParameter(value: unknown): CloudExportProvider {
  if (!isOneOf(value, CLOUD_EXPORT_PROVIDERS)) throw new HttpError(404, "CLOUD_EXPORT_PROVIDER_NOT_FOUND", "Unknown cloud export provider");
  return value;
}

/** Installation-wide export destination: the NAS or one connected cloud drive. Owner/Admin only. */
export function registerExportDestinationRoutes(context: ExportDestinationRouteContext): void {
  const base = `${context.prefix}/system/export-destinations`;

  context.app.get(base, requireWorkspaceAdmin, (_request, response) => {
    response.setHeader("cache-control", "no-store");
    response.json(context.exportDestinations.status());
  });

  context.app.put(base, requireWorkspaceAdmin, (request, response) => {
    requireJsonContentType(request);
    const status = context.exportDestinations.select(bodyObject(request.body));
    context.recordSecurityAudit(requestPrincipal(response), {
      eventType: "system.storage.change.requested",
      subjectType: "system-storage",
      subjectId: "export-destination",
      details: { exportDestination: status.selected },
    });
    response.setHeader("cache-control", "no-store");
    response.json(status);
  });

  context.app.delete(`${base}/connection`, requireWorkspaceAdmin, (_request, response) => {
    context.exportDestinations.cancelConnection();
    response.setHeader("cache-control", "no-store");
    response.json(context.exportDestinations.status());
  });

  context.app.post(`${base}/:provider/connect`, requireWorkspaceAdmin, async (request, response) => {
    const provider = providerParameter(request.params.provider);
    const principal = requestPrincipal(response);
    // Google Drive finishes in the background, so the audit runs when the account is actually saved.
    const status = await context.exportDestinations.connect(provider, () => context.recordSecurityAudit(principal, {
      eventType: "integration.credentials.configured",
      subjectType: "integration",
      subjectId: provider,
      details: { integration: provider },
    }));
    response.setHeader("cache-control", "no-store");
    response.json(status);
  });

  context.app.post(`${base}/:provider/code`, requireWorkspaceAdmin, async (request, response) => {
    requireJsonContentType(request);
    const provider = providerParameter(request.params.provider);
    const status = await context.exportDestinations.submitCode(provider, bodyObject(request.body));
    response.setHeader("cache-control", "no-store");
    response.json(status);
  });

  context.app.delete(`${base}/:provider`, requireWorkspaceAdmin, async (request, response) => {
    const provider = providerParameter(request.params.provider);
    const status = await context.exportDestinations.disconnect(provider);
    context.recordSecurityAudit(requestPrincipal(response), {
      eventType: "integration.credentials.revoked",
      subjectType: "integration",
      subjectId: provider,
      details: { integration: provider },
    });
    response.setHeader("cache-control", "no-store");
    response.json(status);
  });
}
