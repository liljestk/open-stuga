import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { AppSession, TenantMemberRole } from "@climate-twin/contracts";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { api, ApiRequestError } from "../api";
import { isAssistantConsentLocation } from "../assistantConnector";
import { I18nProvider } from "../i18n";
import { AssistantConsentPage } from "./AssistantConsentPage";

const QUERY = "response_type=code&client_id=client-1&redirect_uri=https%3A%2F%2Fclaude.ai%2Fapi%2Fmcp%2Fauth_callback&code_challenge=abc&code_challenge_method=S256&state=s";

function session(role: TenantMemberRole): AppSession {
  return {
    authenticated: true,
    principal: { type: "local", email: "owner@example.test" },
    tenant: { id: "local", name: "Local Stugu", role },
    availableTenants: [{ id: "local", name: "Local Stugu", role }],
    readOnly: role === "guest",
    grants: [],
    csrfToken: "csrf",
  };
}

function renderPage(leave = vi.fn()) {
  render(<I18nProvider><AssistantConsentPage query={QUERY} leave={leave} /></I18nProvider>);
  return leave;
}

beforeEach(() => localStorage.setItem("climate-twin-locale", "en"));

afterEach(() => {
  localStorage.removeItem("climate-twin-locale");
  vi.restoreAllMocks();
});

describe("assistant consent page", () => {
  it("is served at the OAuth authorization endpoint only", () => {
    expect(isAssistantConsentLocation({ pathname: "/connect/assistant" })).toBe(true);
    expect(isAssistantConsentLocation({ pathname: "/connect/assistant/" })).toBe(true);
    expect(isAssistantConsentLocation({ pathname: "/developer" })).toBe(false);
  });

  it("names the assistant from Stugu's check of the request and returns the approval to it", async () => {
    const user = userEvent.setup();
    vi.spyOn(api, "session").mockResolvedValue(session("owner"));
    const preview = vi.spyOn(api, "assistantAuthorizationPreview").mockResolvedValue({
      assistant: "claude", clientName: "Claude", redirectOrigin: "https://claude.ai", scope: "stugu.read",
    });
    const decide = vi.spyOn(api, "decideAssistantAuthorization").mockResolvedValue({
      redirectUrl: "https://claude.ai/api/mcp/auth_callback?code=c&state=s",
    });
    const leave = renderPage();

    expect(await screen.findByRole("heading", { name: "Claude wants to read your Stugu" })).toBeTruthy();
    expect(preview).toHaveBeenCalledWith(QUERY);
    expect(screen.getByText("https://claude.ai")).toBeTruthy();
    expect(screen.getByText("owner@example.test")).toBeTruthy();
    expect(screen.getByText(/Change anything, control equipment/u)).toBeTruthy();

    await user.click(screen.getByRole("button", { name: "Allow" }));
    expect(decide).toHaveBeenCalledWith({ query: QUERY, decision: "approve" });
    expect(leave).toHaveBeenCalledWith("https://claude.ai/api/mcp/auth_callback?code=c&state=s");
  });

  it("returns a declined request to the assistant", async () => {
    const user = userEvent.setup();
    vi.spyOn(api, "session").mockResolvedValue(session("admin"));
    vi.spyOn(api, "assistantAuthorizationPreview").mockResolvedValue({
      assistant: "chatgpt", clientName: null, redirectOrigin: "https://chatgpt.com", scope: "stugu.read",
    });
    const decide = vi.spyOn(api, "decideAssistantAuthorization").mockResolvedValue({
      redirectUrl: "https://chatgpt.com/connector_platform_oauth_redirect?error=access_denied&state=s",
    });
    const leave = renderPage();

    await user.click(await screen.findByRole("button", { name: "Don't allow" }));
    expect(decide).toHaveBeenCalledWith({ query: QUERY, decision: "deny" });
    expect(leave).toHaveBeenCalledWith(expect.stringContaining("error=access_denied"));
  });

  it("asks for sign-in first, and refuses accounts that cannot connect assistants", async () => {
    vi.spyOn(api, "session").mockRejectedValueOnce(new ApiRequestError(401, "UNAUTHORIZED", "Sign in"));
    const preview = vi.spyOn(api, "assistantAuthorizationPreview");
    const { unmount } = render(<I18nProvider><AssistantConsentPage query={QUERY} leave={vi.fn()} /></I18nProvider>);
    expect(await screen.findByLabelText(/email/iu)).toBeTruthy();
    expect(preview).not.toHaveBeenCalled();
    unmount();

    vi.spyOn(api, "session").mockResolvedValue(session("guest"));
    renderPage();
    expect(await screen.findByRole("heading", { name: "Ask an Owner or Admin" })).toBeTruthy();
    expect(preview).not.toHaveBeenCalled();
  });

  it("sends an unsupported request back to the assistant instead of offering approval", async () => {
    const user = userEvent.setup();
    vi.spyOn(api, "session").mockResolvedValue(session("owner"));
    vi.spyOn(api, "assistantAuthorizationPreview").mockRejectedValue(
      new ApiRequestError(400, "ASSISTANT_AUTHORIZATION_INVALID", "PKCE required"),
    );
    const decide = vi.spyOn(api, "decideAssistantAuthorization").mockResolvedValue({
      redirectUrl: "https://claude.ai/api/mcp/auth_callback?error=invalid_request&state=s",
    });
    const leave = renderPage();

    expect(await screen.findByRole("heading", { name: "This connection request can't be used" })).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Allow" })).toBeNull();
    await user.click(screen.getByRole("button", { name: "Return to the assistant" }));
    expect(decide).toHaveBeenCalledWith({ query: QUERY, decision: "deny" });
    expect(leave).toHaveBeenCalledWith(expect.stringContaining("error=invalid_request"));
  });

  it("does not offer a way back when Stugu cannot trust where the request came from", async () => {
    vi.spyOn(api, "session").mockResolvedValue(session("owner"));
    vi.spyOn(api, "assistantAuthorizationPreview").mockRejectedValue(
      new ApiRequestError(400, "ASSISTANT_CLIENT_UNKNOWN", "Unknown client"),
    );
    renderPage();
    expect(await screen.findByText(/does not recognise the assistant/u)).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Return to the assistant" })).toBeNull();
  });
});
