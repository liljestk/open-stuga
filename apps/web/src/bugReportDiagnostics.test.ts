import { afterEach, describe, expect, it } from "vitest";
import {
  buildBugReportDiagnostics,
  clearBugReportDiagnosticsForTests,
  recordApiError,
  redactDiagnosticText,
  routeTemplate,
} from "./bugReportDiagnostics";

afterEach(() => {
  clearBugReportDiagnosticsForTests();
  window.history.replaceState({}, "", "/");
});

describe("bug report diagnostics", () => {
  it("templates route identities without collecting query values", () => {
    window.history.replaceState({}, "", "/properties/property-main/homes/home-main/setup/tp-link?token=private");
    expect(routeTemplate()).toBe("/properties/:propertyId/homes/:homeId/setup/tp-link");
  });

  it("redacts common identifiers and secrets from recent errors", () => {
    const message = "Failed https://example.test/path?token=secret for owner@example.test at 192.168.1.2 id 6ba7b810-9dad-41d1-80b4-00c04fd430c8";
    expect(redactDiagnosticText(message)).not.toMatch(/example\.test|owner@|192\.168|6ba7b810/iu);

    recordApiError(500, "UPSTREAM_FAILED", message);
    const diagnostics = buildBugReportDiagnostics("integrations", "en");
    expect(diagnostics.recentErrors).toHaveLength(1);
    expect(diagnostics.recentErrors[0]).toMatchObject({ source: "api", status: 500, code: "UPSTREAM_FAILED" });
    expect(diagnostics.recentErrors[0]!.message).toContain("[url]");
  });
});
