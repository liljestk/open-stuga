import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { BugReportRelaySettings } from "@climate-twin/contracts";
import { afterEach, describe, expect, it, vi } from "vitest";
import { api, ApiRequestError } from "../api";
import { ConfirmationProvider } from "../components/ConfirmationProvider";
import { I18nProvider } from "../i18n";
import { BugReportRelayPanel } from "./BugReportRelayPanel";

const RELAY_TOKEN = "t".repeat(40);

function settings(overrides: Partial<BugReportRelaySettings> = {}): BugReportRelaySettings {
  return { configured: false, url: null, source: null, updatedAt: null, editable: true, ...overrides };
}

function renderPanel() {
  return render(<I18nProvider><ConfirmationProvider><BugReportRelayPanel /></ConfirmationProvider></I18nProvider>);
}

afterEach(() => {
  vi.restoreAllMocks();
  localStorage.clear();
});

describe("BugReportRelayPanel", () => {
  it("saves a relay so bug reporting stops failing as unconfigured", async () => {
    vi.spyOn(api, "bugReportRelay").mockResolvedValue(settings());
    const configure = vi.spyOn(api, "configureBugReportRelay").mockResolvedValue(settings({
      configured: true,
      url: "https://relay.example.test/reports",
      source: "protected-file",
      updatedAt: "2026-08-05T09:00:00.000Z",
    }));
    renderPanel();

    expect(await screen.findByText("Not configured")).toBeTruthy();
    await userEvent.type(screen.getByLabelText(/Relay address/), "https://relay.example.test/reports");
    await userEvent.type(screen.getByLabelText(/^Shared token/), RELAY_TOKEN);
    await userEvent.click(screen.getByRole("button", { name: "Enable reporting" }));

    await waitFor(() => expect(configure).toHaveBeenCalledWith({
      url: "https://relay.example.test/reports",
      token: RELAY_TOKEN,
    }));
    expect(await screen.findByText("Reporting enabled")).toBeTruthy();
    expect(await screen.findByText("Bug reporting is enabled.")).toBeTruthy();
    expect(screen.queryByLabelText(/^Shared token/)).toBeNull();
  });

  it("keeps an environment-owned relay read-only", async () => {
    vi.spyOn(api, "bugReportRelay").mockResolvedValue(settings({
      configured: true,
      url: "https://relay.example.test/reports",
      source: "environment",
      editable: false,
    }));
    renderPanel();

    expect(await screen.findByText(/Deployment environment variables own this relay/)).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Replace credentials" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Remove relay" })).toBeNull();
  });

  it("stays hidden for accounts that cannot administer the workspace", async () => {
    vi.spyOn(api, "bugReportRelay").mockRejectedValue(new ApiRequestError(403, "FORBIDDEN", "Workspace administration required"));
    const { container } = renderPanel();

    await waitFor(() => expect(container.querySelector(".bug-report-relay-panel")).toBeNull());
  });
});
