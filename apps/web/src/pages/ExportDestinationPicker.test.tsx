import { act, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { CloudExportAccount, ExportDestinationStatus } from "@climate-twin/contracts";
import { api } from "../api";
import { confirmAction } from "../components/ConfirmationProvider";
import { I18nProvider } from "../i18n";
import { ExportDestinationPicker } from "./ExportDestinationPicker";

vi.mock("../components/ConfirmationProvider", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../components/ConfirmationProvider")>();
  return { ...actual, confirmAction: vi.fn().mockResolvedValue(true) };
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

function account(provider: CloudExportAccount["provider"], overrides: Partial<CloudExportAccount> = {}): CloudExportAccount {
  return { provider, available: true, connected: false, accountLabel: null, connectedAt: null, ...overrides };
}

function status(overrides: Partial<ExportDestinationStatus> = {}): ExportDestinationStatus {
  return {
    selected: "nas",
    ready: true,
    nasConnected: true,
    accounts: [account("dropbox"), account("google-drive")],
    connection: null,
    ...overrides,
  };
}

function renderPicker() {
  return render(<I18nProvider><ExportDestinationPicker nasConnected /></I18nProvider>);
}

describe("ExportDestinationPicker", () => {
  it("offers NAS, Dropbox and Google Drive, with iCloud marked as coming later", async () => {
    vi.spyOn(api, "exportDestinations").mockResolvedValue(status({
      accounts: [account("dropbox"), account("google-drive", { available: false })],
    }));

    renderPicker();

    expect(await screen.findByRole("radio", { name: /^NAS/u })).toBeChecked();
    expect(screen.getByRole("radio", { name: /^Dropbox/u })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Connect Dropbox" })).toBeEnabled();
    expect(screen.queryByRole("button", { name: "Connect Google Drive" })).not.toBeInTheDocument();
    expect(screen.getByText("Not enabled on this installation yet")).toBeVisible();
    expect(screen.getByRole("radio", { name: /^iCloud Drive/u })).toBeDisabled();
    expect(screen.getByText("Coming later")).toBeVisible();
  });

  it("connects Dropbox by opening it in a new tab and pasting the code back", async () => {
    const pending = status({
      connection: {
        id: "11111111-1111-4111-8111-111111111111",
        provider: "dropbox",
        method: "paste-code",
        url: "https://www.dropbox.com/oauth2/authorize?client_id=app",
        userCode: null,
        expiresAt: "2026-10-31T12:10:00.000Z",
        error: null,
      },
    });
    vi.spyOn(api, "exportDestinations").mockResolvedValue(status());
    const connect = vi.spyOn(api, "connectExportDestination").mockResolvedValue(pending);
    const submit = vi.spyOn(api, "submitExportDestinationCode").mockResolvedValue(status({
      selected: "dropbox",
      accounts: [account("dropbox", { connected: true, accountLabel: "owner@example.test" }), account("google-drive")],
    }));
    const user = userEvent.setup();

    renderPicker();
    await user.click(await screen.findByRole("button", { name: "Connect Dropbox" }));

    expect(connect).toHaveBeenCalledWith("dropbox");
    const open = await screen.findByRole("link", { name: "Open Dropbox" });
    expect(open).toHaveAttribute("href", "https://www.dropbox.com/oauth2/authorize?client_id=app");
    expect(open).toHaveAttribute("target", "_blank");
    expect(open).toHaveAttribute("rel", "noopener noreferrer");
    const finish = screen.getByRole("button", { name: "Finish connecting" });
    expect(finish).toBeDisabled();
    await user.type(screen.getByRole("textbox", { name: "Paste the code Dropbox shows" }), "  pasted-code-123 ");
    await user.click(finish);

    expect(submit).toHaveBeenCalledWith("dropbox", "11111111-1111-4111-8111-111111111111", "pasted-code-123");
    expect(await screen.findByRole("radio", { name: /^Dropbox/u })).toBeChecked();
    expect(screen.getByText("Connected as owner@example.test")).toBeVisible();
    expect(screen.getByText(/Dropbox › Apps/u)).toBeVisible();
  });

  it("shows the Google Drive code and keeps checking until the account approves", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const waiting = status({
      connection: {
        id: "22222222-2222-4222-8222-222222222222",
        provider: "google-drive",
        method: "enter-code",
        url: "https://www.google.com/device",
        userCode: "ABCD-EFGH",
        expiresAt: "2026-10-31T12:30:00.000Z",
        error: null,
      },
    });
    const connected = status({
      selected: "google-drive",
      accounts: [account("dropbox"), account("google-drive", { connected: true, accountLabel: "owner@gmail.example" })],
    });
    const load = vi.spyOn(api, "exportDestinations").mockResolvedValueOnce(waiting).mockResolvedValue(connected);

    renderPicker();

    expect(await screen.findByText("ABCD-EFGH")).toBeVisible();
    expect(screen.getByText("On any phone or computer, open www.google.com/device.")).toBeVisible();
    expect(screen.getByRole("link", { name: "Open www.google.com/device" })).toHaveAttribute("href", "https://www.google.com/device");
    expect(screen.getByRole("status")).toHaveTextContent("Waiting for Google Drive");
    await act(async () => { await vi.advanceTimersByTimeAsync(3_000); });

    await waitFor(() => expect(load).toHaveBeenCalledTimes(2));
    expect(await screen.findByText("Connected as owner@gmail.example")).toBeVisible();
    expect(screen.queryByText("ABCD-EFGH")).not.toBeInTheDocument();
  });

  it("confirms before disconnecting a cloud drive", async () => {
    vi.mocked(confirmAction).mockResolvedValue(true);
    vi.spyOn(api, "exportDestinations").mockResolvedValue(status({
      selected: "dropbox",
      accounts: [account("dropbox", { connected: true }), account("google-drive")],
    }));
    const disconnect = vi.spyOn(api, "disconnectExportDestination").mockResolvedValue(status());
    const user = userEvent.setup();

    renderPicker();
    await user.click(await screen.findByRole("button", { name: "Disconnect Dropbox" }));

    expect(confirmAction).toHaveBeenCalledWith(expect.stringContaining("Disconnect Dropbox?"), "Disconnect", true);
    expect(disconnect).toHaveBeenCalledWith("dropbox");
    expect(await screen.findByRole("radio", { name: /^NAS/u })).toBeChecked();
  });

  it("switches between connected destinations", async () => {
    vi.spyOn(api, "exportDestinations").mockResolvedValue(status({
      accounts: [account("dropbox", { connected: true }), account("google-drive")],
    }));
    const select = vi.spyOn(api, "selectExportDestination").mockResolvedValue(status({
      selected: "dropbox",
      accounts: [account("dropbox", { connected: true }), account("google-drive")],
    }));
    const user = userEvent.setup();

    renderPicker();
    await user.click(await screen.findByRole("radio", { name: /^Dropbox/u }));

    expect(select).toHaveBeenCalledWith("dropbox");
    await waitFor(() => expect(screen.getByRole("radio", { name: /^Dropbox/u })).toBeChecked());
  });
});
