import { randomUUID } from "node:crypto";
import {
  BugReportValidationError,
  normalizeBugReportInput,
  normalizeBugReportRelayInput,
  type BugReportReceipt,
  type BugReportRelayPayload,
  type BugReportRelaySettings,
} from "@climate-twin/contracts";
import { updateIntegrationSecrets } from "../integration-secrets.js";
import { SYSTEM_VERSION } from "../version.js";
import {
  HttpError,
  bodyObject,
  requestPrincipal,
  requireJsonContentType,
  requireWorkspaceAdmin,
} from "./support/index.js";
import type { ApiRouteRegistrationContext } from "./route-registration-context.js";

const REPORT_WINDOW_MS = 60_000;
const REPORTS_PER_WINDOW = 3;
const RELAY_TIMEOUT_MS = 10_000;

export type BugReportRouteContext = Pick<
  ApiRouteRegistrationContext,
  "app" | "prefix" | "config" | "options" | "recordSecurityAudit"
>;

function relaySettings(context: BugReportRouteContext): BugReportRelaySettings {
  const source = context.config.bugReportRelaySource ?? null;
  return {
    configured: Boolean(context.config.bugReportRelayUrl && context.config.bugReportRelayToken),
    url: context.config.bugReportRelayUrl ?? null,
    source,
    updatedAt: context.config.bugReportRelayUpdatedAt ?? null,
    editable: source !== "environment",
  };
}

export function registerBugReportRoutes(context: BugReportRouteContext): void {
  const recentSubmissions = new Map<string, number[]>();

  context.app.get(`${context.prefix}/bug-reports/relay`, requireWorkspaceAdmin, (_request, response) => {
    response.setHeader("cache-control", "no-store");
    response.json(relaySettings(context));
  });

  context.app.put(`${context.prefix}/bug-reports/relay`, requireWorkspaceAdmin, (request, response, next) => {
    try {
      requireJsonContentType(request);
      if (context.config.bugReportRelaySource === "environment") {
        throw new HttpError(409, "BUG_REPORT_RELAY_ENVIRONMENT_OWNED", "The bug report relay is configured by deployment environment variables");
      }
      const body = bodyObject(request.body);
      let relay;
      try {
        relay = normalizeBugReportRelayInput({ url: body.url, token: body.token });
      } catch (error) {
        if (error instanceof BugReportValidationError) {
          throw new HttpError(400, "INVALID_BUG_REPORT_RELAY", error.message);
        }
        throw error;
      }
      const rotating = Boolean(context.config.bugReportRelayToken);
      const updatedAt = new Date().toISOString();
      updateIntegrationSecrets(context.config.integrationSecretsFile, { bugReportRelay: { ...relay, updatedAt } });
      context.config.bugReportRelayUrl = relay.url;
      context.config.bugReportRelayToken = relay.token;
      context.config.bugReportRelaySource = "protected-file";
      context.config.bugReportRelayUpdatedAt = updatedAt;
      context.recordSecurityAudit(requestPrincipal(response), {
        eventType: rotating ? "integration.credentials.rotated" : "integration.credentials.configured",
        subjectType: "integration",
        subjectId: "bug-report-relay",
        details: { integration: "bug-report-relay", url: relay.url },
      });
      response.setHeader("cache-control", "no-store");
      response.json(relaySettings(context));
    } catch (error) {
      next(error);
    }
  });

  context.app.delete(`${context.prefix}/bug-reports/relay`, requireWorkspaceAdmin, (_request, response, next) => {
    try {
      if (context.config.bugReportRelaySource === "environment") {
        throw new HttpError(409, "BUG_REPORT_RELAY_ENVIRONMENT_OWNED", "The bug report relay is configured by deployment environment variables");
      }
      updateIntegrationSecrets(context.config.integrationSecretsFile, { bugReportRelay: null });
      context.config.bugReportRelayUrl = null;
      context.config.bugReportRelayToken = null;
      context.config.bugReportRelaySource = null;
      context.config.bugReportRelayUpdatedAt = null;
      context.recordSecurityAudit(requestPrincipal(response), {
        eventType: "integration.credentials.revoked",
        subjectType: "integration",
        subjectId: "bug-report-relay",
        details: { integration: "bug-report-relay" },
      });
      response.setHeader("cache-control", "no-store");
      response.json(relaySettings(context));
    } catch (error) {
      next(error);
    }
  });

  context.app.post(`${context.prefix}/bug-reports`, async (request, response, next) => {
    try {
      requireJsonContentType(request);
      const principal = requestPrincipal(response);
      let input;
      try {
        input = normalizeBugReportInput(request.body);
      } catch (error) {
        if (error instanceof BugReportValidationError) {
          throw new HttpError(400, "INVALID_BUG_REPORT", error.message);
        }
        throw error;
      }

      if (input.contactEmail && input.contactEmail !== principal.email.trim().toLowerCase()) {
        throw new HttpError(403, "BUG_REPORT_CONTACT_FORBIDDEN", "Contact consent may only use the signed-in account email");
      }
      const relayUrl = context.config.bugReportRelayUrl;
      const relayToken = context.config.bugReportRelayToken;
      if (!relayUrl || !relayToken) {
        throw new HttpError(503, "BUG_REPORTING_UNAVAILABLE", "Bug reporting is not configured");
      }

      const now = Date.now();
      const cutoff = now - REPORT_WINDOW_MS;
      const attempts = (recentSubmissions.get(principal.userId) ?? []).filter((at) => at > cutoff);
      if (attempts.length >= REPORTS_PER_WINDOW) {
        response.setHeader("retry-after", String(Math.max(1, Math.ceil((attempts[0]! + REPORT_WINDOW_MS - now) / 1_000))));
        throw new HttpError(429, "BUG_REPORT_RATE_LIMITED", "Please wait before sending another bug report");
      }
      attempts.push(now);
      recentSubmissions.set(principal.userId, attempts);

      const submittedAt = new Date(now).toISOString();
      const reportId = randomUUID();
      const payload: BugReportRelayPayload = {
        ...input,
        reportId,
        submittedAt,
        serverVersion: SYSTEM_VERSION,
      };
      let relayResponse: Response;
      try {
        relayResponse = await (context.options.bugReportFetcher ?? fetch)(relayUrl, {
          method: "POST",
          redirect: "error",
          signal: AbortSignal.timeout(RELAY_TIMEOUT_MS),
          headers: {
            accept: "application/json",
            authorization: `Bearer ${relayToken}`,
            "content-type": "application/json",
          },
          body: JSON.stringify(payload),
        });
      } catch {
        throw new HttpError(502, "BUG_REPORT_RELAY_FAILED", "The bug report could not be delivered");
      }
      if (!relayResponse.ok) {
        throw new HttpError(502, "BUG_REPORT_RELAY_FAILED", "The bug report could not be delivered");
      }
      const receipt: BugReportReceipt = { reportId, submittedAt };
      response.setHeader("cache-control", "no-store");
      response.status(201).json(receipt);
    } catch (error) {
      next(error);
    }
  });
}
