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

function appSource(context: ExportDestinationRouteContext, userId: string, provider: CloudExportProvider) {
  return context.exportDestinations.status(userId).accounts.find((account) => account.provider === provider)?.appSource ?? null;
}

/**
 * Where the signed-in Owner/Admin's scheduled exports go: the shared NAS or a cloud drive of their own. Every
 * route answers with that person's status; only the provider apps under `/{provider}/app` are installation-wide.
 */
export function registerExportDestinationRoutes(context: ExportDestinationRouteContext): void {
  const base = `${context.prefix}/system/export-destinations`;

  context.app.get(base, requireWorkspaceAdmin, (_request, response) => {
    response.setHeader("cache-control", "no-store");
    response.json(context.exportDestinations.status(requestPrincipal(response).userId));
  });

  context.app.put(base, requireWorkspaceAdmin, (request, response) => {
    requireJsonContentType(request);
    const principal = requestPrincipal(response);
    const status = context.exportDestinations.select(principal.userId, bodyObject(request.body));
    context.recordSecurityAudit(principal, {
      eventType: "system.storage.change.requested",
      subjectType: "system-storage",
      subjectId: "export-destination",
      details: { exportDestination: status.selected },
    });
    response.setHeader("cache-control", "no-store");
    response.json(status);
  });

  context.app.delete(`${base}/connection`, requireWorkspaceAdmin, (_request, response) => {
    const { userId } = requestPrincipal(response);
    context.exportDestinations.cancelConnection(userId);
    response.setHeader("cache-control", "no-store");
    response.json(context.exportDestinations.status(userId));
  });

  context.app.post(`${base}/:provider/connect`, requireWorkspaceAdmin, async (request, response) => {
    const provider = providerParameter(request.params.provider);
    const principal = requestPrincipal(response);
    // Google Drive finishes in the background, so the audit runs when the account is actually saved.
    const status = await context.exportDestinations.connect(principal.userId, provider, () => context.recordSecurityAudit(principal, {
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
    const status = await context.exportDestinations.submitCode(requestPrincipal(response).userId, provider, bodyObject(request.body));
    response.setHeader("cache-control", "no-store");
    response.json(status);
  });

  // The provider app an Owner/Admin registered, audited apart from the accounts that later sign in through it.
  context.app.put(`${base}/:provider/app`, requireWorkspaceAdmin, (request, response) => {
    requireJsonContentType(request);
    const provider = providerParameter(request.params.provider);
    const principal = requestPrincipal(response);
    const replacing = appSource(context, principal.userId, provider) === "protected-file";
    context.exportDestinations.saveApp(provider, bodyObject(request.body));
    context.recordSecurityAudit(principal, {
      eventType: replacing ? "integration.credentials.rotated" : "integration.credentials.configured",
      subjectType: "integration",
      subjectId: `${provider}-app`,
      details: { integration: provider },
    });
    response.setHeader("cache-control", "no-store");
    response.json(context.exportDestinations.status(principal.userId));
  });

  context.app.delete(`${base}/:provider/app`, requireWorkspaceAdmin, (request, response) => {
    const provider = providerParameter(request.params.provider);
    const principal = requestPrincipal(response);
    const removing = appSource(context, principal.userId, provider) === "protected-file";
    context.exportDestinations.removeApp(provider);
    if (removing) {
      context.recordSecurityAudit(principal, {
        eventType: "integration.credentials.revoked",
        subjectType: "integration",
        subjectId: `${provider}-app`,
        details: { integration: provider },
      });
    }
    response.setHeader("cache-control", "no-store");
    response.json(context.exportDestinations.status(principal.userId));
  });

  context.app.delete(`${base}/:provider`, requireWorkspaceAdmin, async (request, response) => {
    const provider = providerParameter(request.params.provider);
    const principal = requestPrincipal(response);
    const status = await context.exportDestinations.disconnect(principal.userId, provider);
    context.recordSecurityAudit(principal, {
      eventType: "integration.credentials.revoked",
      subjectType: "integration",
      subjectId: provider,
      details: { integration: provider },
    });
    response.setHeader("cache-control", "no-store");
    response.json(status);
  });
}
