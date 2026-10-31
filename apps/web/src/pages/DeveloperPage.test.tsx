import { act, fireEvent, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ConfirmationProvider } from "../components/ConfirmationProvider";
import { I18nProvider } from "../i18n";
import { api } from "../api";
import { browserFacingApiBase, DeveloperPage } from "./DeveloperPage";
import { setupDoctorRemediationHref } from "./SetupOperationsPanel";

const originalClipboard = navigator.clipboard;

afterEach(() => {
  vi.useRealTimers();
  Object.defineProperty(navigator, "clipboard", { configurable: true, value: originalClipboard });
  localStorage.removeItem("climate-twin-locale");
  document.documentElement.lang = "en";
  vi.restoreAllMocks();
});

describe("DeveloperPage", () => {
  it("advertises the API listener rather than the Vite development proxy", () => {
    expect(browserFacingApiBase("/api/v1", "http://localhost:5173")).toBe("http://localhost:8787/api/v1");
    expect(browserFacingApiBase("/api/v2", "http://192.0.2.10:5173")).toBe("http://192.0.2.10:8787/api/v2");
    expect(browserFacingApiBase("/api/v1", "https://stugu.example.test")).toBe("https://stugu.example.test/api/v1");
  });

  it("routes actionable doctor findings to their remediation workspace", () => {
    expect(setupDoctorRemediationHref("sensor-coverage")).toBe("/sensors");
    expect(setupDoctorRemediationHref("sensor-bindings")).toBe("/setup/operations");
    expect(setupDoctorRemediationHref("integration")).toBe("/setup/connections");
    expect(setupDoctorRemediationHref("notification-route")).toBe("/setup/automations");
    expect(setupDoctorRemediationHref("webhook-signing")).toBeNull();
  });

  it("documents and copies the local integrations", async () => {
    const user = userEvent.setup();
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, "clipboard", { configurable: true, value: { writeText } });
    localStorage.setItem("climate-twin-locale", "en");
    render(<I18nProvider><DeveloperPage /></I18nProvider>);

    expect(screen.getByRole("heading", { name: "Local v1 + v2 HTTP API" })).toBeTruthy();
    expect(screen.getByRole("heading", { name: "Local MCP server" })).toBeTruthy();
    expect(screen.getByText("Local integration contracts")).toBeTruthy();
    expect(screen.getByText("Use Stugu locally through the versioned HTTP API and trusted stdio MCP server.")).toBeTruthy();
    expect(screen.getByText(/trusted, read-only stdio/i)).toBeTruthy();

    const baseUrl = screen.getByRole("textbox", { name: "Local v1 base URL" }) as HTMLInputElement;
    expect(baseUrl.value).toBe(window.location.origin + "/api/v1");

    await user.click(screen.getByRole("button", { name: "Copy: Local v1 base URL" }));

    expect(writeText).toHaveBeenCalledWith(expect.stringMatching(/\/api\/v1$/));
    expect(screen.getByText("Copied").getAttribute("role")).toBe("status");
  });

  it("keeps workspace system operations out of non-admin developer access", () => {
    vi.spyOn(api, "localMcpRuntimeStatus").mockResolvedValue({
      state: "stopped", endpointPath: "/api/v1/mcp", pid: null, startedAt: null,
      toolCount: null, serverVersion: null, errorCode: null, accessTokenIssued: false,
    });
    vi.spyOn(api, "assistantConnections").mockResolvedValue([]);
    localStorage.setItem("climate-twin-locale", "en");
    const view = render(<I18nProvider><DeveloperPage /></I18nProvider>);

    expect(screen.getByRole("heading", { name: "Local v1 + v2 HTTP API" })).toBeTruthy();
    expect(screen.queryByText("Export, backup, and restore confidence")).toBeNull();

    view.rerender(<I18nProvider><DeveloperPage canManageSystem /></I18nProvider>);
    expect(screen.getByText("Export, backup, and restore confidence")).toBeTruthy();
  });

  it("starts a protected network MCP endpoint and shows its one-time connection details", async () => {
    const user = userEvent.setup();
    const stopped = {
      state: "stopped" as const, endpointPath: "/api/v1/mcp" as const, pid: null, startedAt: null,
      toolCount: null, serverVersion: null, errorCode: null, accessTokenIssued: false,
    };
    const running = {
      state: "running" as const, endpointPath: "/api/v1/mcp" as const, pid: 4321,
      startedAt: "2026-08-02T12:00:00.000Z", toolCount: 61, serverVersion: "0.30.0", errorCode: null, accessTokenIssued: true,
    };
    vi.spyOn(api, "assistantConnections").mockResolvedValue([]);
    vi.spyOn(api, "localMcpRuntimeStatus").mockResolvedValue(stopped);
    const start = vi.spyOn(api, "startLocalMcpRuntime").mockResolvedValue({
      ...running,
      accessToken: "stugu_mcp_test-token-shown-once",
    });
    const stop = vi.spyOn(api, "stopLocalMcpRuntime").mockResolvedValue(stopped);
    localStorage.setItem("climate-twin-locale", "en");
    render(<I18nProvider><DeveloperPage canManageSystem /></I18nProvider>);

    await user.click(await screen.findByRole("button", { name: "Start MCP server" }));

    expect(start).toHaveBeenCalledOnce();
    expect(await screen.findByText("Network MCP is running")).toBeTruthy();
    expect((screen.getByRole("textbox", { name: "Streamable HTTP address" }) as HTMLInputElement).value)
      .toBe(`${window.location.origin}/api/v1/mcp`);
    expect((screen.getByLabelText("One-time access token") as HTMLInputElement).value)
      .toBe("stugu_mcp_test-token-shown-once");
    expect(screen.getByText(/will not show it again/i)).toBeTruthy();

    await user.click(screen.getByRole("button", { name: "Stop MCP server" }));
    expect(stop).toHaveBeenCalledOnce();
    expect(await screen.findByText("Network MCP is stopped")).toBeTruthy();
    expect(screen.queryByLabelText("One-time access token")).toBeNull();
  });

  it("offers a replacement token when assistants started the server without one", async () => {
    const user = userEvent.setup();
    const runningForAssistants = {
      state: "running" as const, endpointPath: "/api/v1/mcp" as const, pid: 4321,
      startedAt: "2026-08-02T12:00:00.000Z", toolCount: 61, serverVersion: "0.30.0", errorCode: null, accessTokenIssued: false,
    };
    vi.spyOn(api, "localMcpRuntimeStatus").mockResolvedValue(runningForAssistants);
    vi.spyOn(api, "assistantConnections").mockResolvedValue([]);
    const start = vi.spyOn(api, "startLocalMcpRuntime").mockResolvedValue({
      ...runningForAssistants, accessTokenIssued: true, accessToken: "stugu_mcp_replacement",
    });
    localStorage.setItem("climate-twin-locale", "en");
    render(<I18nProvider><DeveloperPage canManageSystem /></I18nProvider>);

    expect(await screen.findByText(/No access token is active/u)).toBeTruthy();
    await user.click(screen.getByRole("button", { name: "Create access token" }));
    expect(start).toHaveBeenCalledOnce();
    expect((await screen.findByLabelText("One-time access token") as HTMLInputElement).value).toBe("stugu_mcp_replacement");
  });

  it("explains how to connect Claude and ChatGPT and disconnects an approved assistant", async () => {
    const user = userEvent.setup();
    vi.spyOn(api, "localMcpRuntimeStatus").mockResolvedValue({
      state: "stopped", endpointPath: "/api/v1/mcp", pid: null, startedAt: null,
      toolCount: null, serverVersion: null, errorCode: null, accessTokenIssued: false,
    });
    vi.spyOn(api, "assistantConnections").mockResolvedValue([{
      id: "grant-1", assistant: "claude", clientName: "Claude", approvedBy: "owner@example.test",
      createdAt: "2026-10-29T08:00:00.000Z", lastUsedAt: null,
    }]);
    const revoke = vi.spyOn(api, "revokeAssistantConnection").mockResolvedValue([]);
    localStorage.setItem("climate-twin-locale", "en");
    render(<I18nProvider><ConfirmationProvider><DeveloperPage canManageSystem /></ConfirmationProvider></I18nProvider>);

    expect(screen.getByRole("heading", { name: "Claude and ChatGPT" })).toBeTruthy();
    expect((screen.getByRole("textbox", { name: "Connector URL" }) as HTMLInputElement).value).toBe(`${window.location.origin}/api/v1/mcp`);
    expect(screen.getByText(/need Stugu's public HTTPS address/u)).toBeTruthy();
    expect(await screen.findByText(/^Approved by owner@example.test on .*2026$/u)).toBeTruthy();
    expect(screen.getByText("Not used yet")).toBeTruthy();

    await user.click(screen.getByRole("button", { name: "Disconnect" }));
    const dialog = await screen.findByRole("dialog");
    await user.click(within(dialog).getByRole("button", { name: "Disconnect" }));
    expect(revoke).toHaveBeenCalledWith("grant-1");
    expect(await screen.findByText("No assistant is connected yet.")).toBeTruthy();
  });

  it("announces when copying is unavailable in a non-secure local context", async () => {
    const user = userEvent.setup();
    Object.defineProperty(navigator, "clipboard", { configurable: true, value: undefined });
    localStorage.setItem("climate-twin-locale", "en");
    render(<I18nProvider><DeveloperPage /></I18nProvider>);

    await user.click(screen.getByRole("button", { name: "Copy: Trusted stdio command" }));

    expect(screen.getByText("Copy failed. Select the value and copy it manually.").getAttribute("role")).toBe("status");
    const value = screen.getByRole("textbox", { name: "Trusted stdio command" }) as HTMLInputElement;
    await user.click(value);
    expect(value.selectionStart).toBe(0);
    expect(value.selectionEnd).toBe(value.value.length);
  });

  it("announces when a browser leaves the clipboard request pending", async () => {
    vi.useFakeTimers();
    const writeText = vi.fn(() => new Promise<void>(() => undefined));
    Object.defineProperty(navigator, "clipboard", { configurable: true, value: { writeText } });
    localStorage.setItem("climate-twin-locale", "en");
    render(<I18nProvider><DeveloperPage /></I18nProvider>);

    fireEvent.click(screen.getByRole("button", { name: "Copy: Local v1 base URL" }));
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1500);
    });

    expect(screen.getByText("Copy failed. Select the value and copy it manually.").getAttribute("role")).toBe("status");
  });

  it("explains the local integrations in Finnish", async () => {
    localStorage.setItem("climate-twin-locale", "fi");
    render(<I18nProvider><DeveloperPage /></I18nProvider>);

    expect(await screen.findByRole("heading", { name: "Paikallinen v1 + v2 HTTP-rajapinta" })).toBeTruthy();
    expect(screen.getByRole("heading", { name: "Paikallinen MCP-palvelin" })).toBeTruthy();
    expect(screen.getByText("Paikalliset integraatiorajapinnat")).toBeTruthy();
    expect(screen.getByText("Käytä Stugua paikallisesti versioidun HTTP-rajapinnan ja luotetun stdio-MCP-palvelimen kautta.")).toBeTruthy();
  });
});
