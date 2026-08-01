import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { api } from "../api";
import { clearBugReportDiagnosticsForTests } from "../bugReportDiagnostics";
import { I18nProvider } from "../i18n";
import { BugReportDialog } from "./BugReportDialog";

afterEach(() => {
  vi.restoreAllMocks();
  clearBugReportDiagnosticsForTests();
  window.history.replaceState({}, "", "/");
});

describe("BugReportDialog", () => {
  it("asks one required question and submits reviewed diagnostics with explicit contact consent", async () => {
    window.history.replaceState({}, "", "/properties/property-main/homes/home-main/integrations");
    const reportBug = vi.spyOn(api, "reportBug").mockResolvedValue({
      reportId: "6ba7b810-9dad-41d1-80b4-00c04fd430c8",
      submittedAt: new Date().toISOString(),
    });
    render(<I18nProvider><BugReportDialog page="integrations" principalEmail="owner@example.test" /></I18nProvider>);

    fireEvent.click(screen.getByRole("button", { name: "Report a bug" }));
    fireEvent.change(screen.getByLabelText("What went wrong?"), { target: { value: "The integration card stays blank." } });
    fireEvent.click(screen.getByText("You may contact me at owner@example.test"));
    fireEvent.click(screen.getByRole("button", { name: "Send report" }));

    await waitFor(() => expect(reportBug).toHaveBeenCalledOnce());
    expect(reportBug.mock.calls[0]![0]).toMatchObject({
      description: "The integration card stays blank.",
      contactEmail: "owner@example.test",
      diagnostics: {
        page: "integrations",
        route: "/properties/:propertyId/homes/:homeId/integrations",
      },
    });
    expect(await screen.findByText("Report sent")).toBeTruthy();
    expect(screen.getByText("6ba7b810-9dad-41d1-80b4-00c04fd430c8")).toBeTruthy();
  });
});
