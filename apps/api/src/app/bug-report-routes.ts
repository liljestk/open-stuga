import { randomUUID } from "node:crypto";
import {
  BugReportValidationError,
  normalizeBugReportInput,
  type BugReportReceipt,
  type BugReportRelayPayload,
} from "@climate-twin/contracts";
import { SYSTEM_VERSION } from "../version.js";
import { HttpError, requestPrincipal, requireJsonContentType } from "./support/index.js";
import type { ApiRouteRegistrationContext } from "./route-registration-context.js";

const REPORT_WINDOW_MS = 60_000;
const REPORTS_PER_WINDOW = 3;
const RELAY_TIMEOUT_MS = 10_000;

export type BugReportRouteContext = Pick<ApiRouteRegistrationContext, "app" | "prefix" | "config" | "options">;

export function registerBugReportRoutes(context: BugReportRouteContext): void {
  const recentSubmissions = new Map<string, number[]>();

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
