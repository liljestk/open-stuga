import { render, screen } from "@testing-library/react";
import type { DurableDerivedAnalyticsResponse, DurableDerivedAnalyticsState } from "@climate-twin/contracts";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { I18nProvider } from "../i18n";
import { DerivedArtifactNotices } from "./DerivedArtifactNotices";

function durable(
  state: DurableDerivedAnalyticsState,
  withArtifact: boolean,
  errorCode = "ANALYSIS_FAILED",
): DurableDerivedAnalyticsResponse<unknown> {
  return {
    apiVersion: "1.0",
    kind: "thermal-isolation",
    houseId: "house-1",
    dataMode: "live",
    windowDays: 7,
    cutoff: "2026-08-08T09:00:00.000Z",
    state,
    stale: false,
    result: withArtifact ? {} : null,
    artifact: withArtifact ? {
      id: 1,
      generatedAt: "2026-08-08T08:00:00.000Z",
      cutoff: "2026-08-08T08:00:00.000Z",
      algorithmVersion: "1",
      evidenceVersion: "evidence-1",
    } : null,
    job: state === "failed" ? {
      requestedAt: "2026-08-08T08:30:00.000Z",
      startedAt: "2026-08-08T08:31:00.000Z",
      completedAt: "2026-08-08T08:32:00.000Z",
      nextAttemptAt: null,
      attemptCount: 1,
      errorCode,
      errorMessage: "Failed",
    } : null,
  };
}

describe("DerivedArtifactNotices", () => {
  beforeEach(() => {
    localStorage.setItem("climate-twin-locale", "en");
    vi.spyOn(Date, "now").mockReturnValue(Date.parse("2026-08-08T09:00:00.000Z"));
  });

  afterEach(() => vi.restoreAllMocks());

  it("distinguishes a failed first run from a failed refresh with last-good data", () => {
    const view = render(<I18nProvider><DerivedArtifactNotices
      status={durable("failed", false)}
      hasResult={false}
      canRefresh
    /></I18nProvider>);
    expect(screen.getByRole("status")).toHaveTextContent("failed before a result could be saved");
    expect(screen.queryByText(/last successful result/i)).toBeNull();

    view.rerender(<I18nProvider><DerivedArtifactNotices
      status={durable("failed", true)}
      hasResult
      canRefresh
    /></I18nProvider>);
    expect(screen.getByRole("status")).toHaveTextContent("last successful result is still available");
    expect(screen.getByText("1 hour ago")).toHaveAttribute("dateTime", "2026-08-08T08:00:00.000Z");
    expect(screen.getByText("1 hour ago").closest("small")).toHaveTextContent("Saved");
  });

  it("names the failure cause for recognized job error codes only", () => {
    const view = render(<I18nProvider><DerivedArtifactNotices
      status={durable("failed", true, "HVAC_EVIDENCE_INSUFFICIENT")}
      hasResult
      canRefresh
    /></I18nProvider>);
    expect(screen.getByText(/Verified heat-pump-off time was too scarce/)).toBeInTheDocument();

    view.rerender(<I18nProvider><DerivedArtifactNotices
      status={durable("failed", true, "THERMAL_SCOPE_TOO_LARGE")}
      hasResult
      canRefresh
    /></I18nProvider>);
    expect(screen.getByText(/supports up to 64 temperature sensors/)).toBeInTheDocument();

    view.rerender(<I18nProvider><DerivedArtifactNotices
      status={durable("failed", true, "HOME_PERFORMANCE_SCOPE_TOO_LARGE")}
      hasResult
      canRefresh
    /></I18nProvider>);
    expect(screen.getByText(/at most 80 enabled sensors/)).toBeInTheDocument();
    expect(screen.queryByText(/64/)).toBeNull();

    // Unknown codes, including Object.prototype member names a plain object
    // lookup would have matched, render no reason notice at all.
    for (const code of ["SOMETHING_UNEXPECTED", "constructor", "__proto__"]) {
      view.rerender(<I18nProvider><DerivedArtifactNotices
        status={durable("failed", true, code)}
        hasResult
        canRefresh
      /></I18nProvider>);
      expect(screen.getAllByRole("status")).toHaveLength(1);
      expect(screen.getByRole("status")).toHaveTextContent("last successful result is still available");
    }

    view.rerender(<I18nProvider><DerivedArtifactNotices
      status={durable("refreshing", true)}
      hasResult
      canRefresh
    /></I18nProvider>);
    expect(screen.queryByText(/Verified heat-pump-off time/)).toBeNull();
  });

  it("explains an idle artifact without polling or offering a guest-owned action", () => {
    render(<I18nProvider><DerivedArtifactNotices
      status={durable("idle", false)}
      hasResult={false}
      canRefresh={false}
    /></I18nProvider>);
    expect(screen.getByRole("status")).toHaveTextContent("No saved analysis is available yet");
    expect(screen.getByRole("status")).toHaveTextContent("A home owner can queue it");
  });
});
