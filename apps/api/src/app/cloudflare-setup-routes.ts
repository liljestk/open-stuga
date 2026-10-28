import { reportBackgroundFailure } from "../system-error-log.js";
import type { CloudflareSetupStatusResponse } from "@climate-twin/contracts";
import type { CloudflareSetupStartInput } from "@climate-twin/contracts";
import {
  HttpError,
  bodyObject,
  cloudflareUiRedirectUri,
  localCloudflareUiRequestAllowed,
  requestPrincipal,
  requireJsonContentType,
  requireWorkspaceAdmin,
  requiredString,
} from "./support/index.js";
import type { ApiRouteRegistrationContext } from "./route-registration-context.js";


export type CloudflareSetupRouteContext = Pick<
  ApiRouteRegistrationContext,
  "app" | "prefix" | "config" | "cloudflareSetup" | "recordSecurityAudit" | "systemErrorLog"
>;

export function registerCloudflareSetupRoutes(context: CloudflareSetupRouteContext): void {
  const config = context.config;
  context.app.get(`${context.prefix}/cloudflare/setup`, requireWorkspaceAdmin, (request, response) => {
    const status = context.cloudflareSetup.status();
    const principal = requestPrincipal(response);
    response.setHeader("cache-control", "no-store");
    response.json({
      ...status,
      canConfigure: localCloudflareUiRequestAllowed(request, config),
      localConfigureUrl: `http://127.0.0.1:${config.cloudflareSetupLocalUiPort}/stugbys`,
      configuration: {
        ...status.configuration,
        ownerEmail: status.configuration.ownerEmail ?? principal.email,
      },
    } satisfies CloudflareSetupStatusResponse);
  });
  context.app.post(`${context.prefix}/cloudflare/setup/start`, requireWorkspaceAdmin, async (request, response) => {
    requireJsonContentType(request);
    const redirectUri = cloudflareUiRedirectUri(request, config);
    const body = bodyObject(request.body);
    const optionalText = (key: string): string | null => {
      const value = body[key];
      if (value === undefined || value === null || value === "") return null;
      if (typeof value !== "string") throw new HttpError(400, "INVALID_FIELD", `${key} must be a string`);
      return value;
    };
    const input: CloudflareSetupStartInput = {
      mode: requiredString(body, "mode") as CloudflareSetupStartInput["mode"],
      hostname: requiredString(body, "hostname"),
      zone: requiredString(body, "zone"),
      ownerEmail: requiredString(body, "ownerEmail"),
      accountId: optionalText("accountId"),
      zoneId: optionalText("zoneId"),
      oauthClientToken: optionalText("oauthClientToken"),
      runtimeToken: optionalText("runtimeToken"),
    };
    const result = await context.cloudflareSetup.start(input, redirectUri);
    const principal = requestPrincipal(response);
    try {
      context.recordSecurityAudit(principal, {
        eventType: "cloudflare.setup.started",
        subjectType: "cloudflare-connection",
        subjectId: result.operation.hostname,
        details: { mode: result.operation.mode, operationId: result.operation.id },
      });
    } catch {
      // Cloudflare has already accepted the external operation. Do not turn
      // that success into a retryable 500 and create a duplicate setup.
      reportBackgroundFailure(context.systemErrorLog, {
        source: "security-audit", code: "AUDIT_NOT_RECORDED",
        message: "Cloudflare setup started, but its local audit event could not be recorded",
      });
    }
    response.setHeader("cache-control", "no-store");
    response.status(202).json(result);
  });
}
