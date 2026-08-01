import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import axe from "axe-core";
import { afterEach, describe, expect, it, vi } from "vitest";
import { api, type CloudflareSetupStatus } from "../api";
import { I18nProvider } from "../i18n";
import { CloudflareSetupPanel } from "./CloudflareSetupPanel";

afterEach(() => vi.restoreAllMocks());

function setupStatus(overrides: Partial<CloudflareSetupStatus["configuration"]> = {}): CloudflareSetupStatus {
  return {
    canConfigure: true,
    localConfigureUrl: "http://127.0.0.1:8080/stugbys",
    capability: {
      available: true,
      agentLastSeenAt: "2026-07-24T08:00:00.000Z",
      reason: "ready",
    },
    configuration: {
      configured: true,
      mode: "remote-ui",
      hostname: "stugu.example.com",
      suggestedZone: "example.com",
      accountIdKnown: true,
      zoneIdKnown: true,
      oauthClientConfigured: false,
      runtimeTokenAvailable: true,
      ownerEmail: "owner@example.com",
      ...overrides,
    },
    operation: null,
  };
}

describe("CloudflareSetupPanel", () => {
  it("upgrades an existing installation through one-time UI approval", async () => {
    const user = userEvent.setup();
    vi.spyOn(api, "cloudflareSetupStatus").mockResolvedValue(setupStatus());
    const start = vi.spyOn(api, "startCloudflareSetup").mockResolvedValue({
      operation: {
        id: "2fc58aab-24fb-4aa3-894a-2a0811497d76",
        mode: "stuguby-coordinator",
        hostname: "stugu.example.com",
        phase: "awaiting-approval",
        requestedAt: "2026-07-24T08:00:00.000Z",
        completedAt: null,
        detail: null,
      },
      authorizationUrl: "https://dash.cloudflare.com/oauth2/auth?client_id=client-id",
    });
    const replace = vi.fn();
    vi.spyOn(window, "open").mockReturnValue({
      opener: window,
      location: { replace },
      close: vi.fn(),
    } as unknown as Window);

    render(<I18nProvider><CloudflareSetupPanel suggestedOrigin="https://stugu.example.com" onComplete={vi.fn()} /></I18nProvider>);

    const token = await screen.findByLabelText(/^One-time OAuth client token/);
    expect(screen.queryByLabelText(/^Runtime Access group token/)).toBeNull();
    await user.type(token, "oauth-client-write-token-that-is-long-enough");
    await user.click(screen.getByRole("button", { name: "Continue with Cloudflare" }));

    await waitFor(() => expect(start).toHaveBeenCalledWith({
      mode: "stuguby-coordinator",
      hostname: "stugu.example.com",
      zone: "example.com",
      ownerEmail: "owner@example.com",
      accountId: null,
      zoneId: null,
      oauthClientToken: "oauth-client-write-token-that-is-long-enough",
      runtimeToken: null,
    }));
    expect(replace).toHaveBeenCalledWith("https://dash.cloudflare.com/oauth2/auth?client_id=client-id");
    expect(await screen.findByText("Waiting for approval in Cloudflare")).toBeTruthy();
    await user.click(screen.getByRole("button", { name: "Reopen Cloudflare approval" }));
    await waitFor(() => expect(replace).toHaveBeenCalledTimes(2));
  });

  it("asks a new installation for the narrow retained runtime token", async () => {
    vi.spyOn(api, "cloudflareSetupStatus").mockResolvedValue(setupStatus({
      configured: false,
      mode: null,
      runtimeTokenAvailable: false,
    }));

    render(<I18nProvider><CloudflareSetupPanel suggestedOrigin="https://stugu.example.com" onComplete={vi.fn()} /></I18nProvider>);

    expect(await screen.findByLabelText(/^One-time OAuth client token/)).toBeTruthy();
    expect(screen.getByLabelText(/^Runtime Access group token/)).toBeTruthy();
    expect(screen.getByText(/Secret values stay in memory/)).toBeTruthy();
    expect(screen.queryByText("Optional Cloudflare account and zone IDs")).toBeNull();
  });

  it("names the optional ID disclosure by its contents", async () => {
    vi.spyOn(api, "cloudflareSetupStatus").mockResolvedValue(setupStatus({
      accountIdKnown: false,
      zoneIdKnown: false,
    }));

    render(<I18nProvider><CloudflareSetupPanel suggestedOrigin="https://stugu.example.com" onComplete={vi.fn()} /></I18nProvider>);

    expect(await screen.findByText("Optional Cloudflare account and zone IDs")).toBeTruthy();
  });

  it("shows and hides the one-time token instructions", async () => {
    const user = userEvent.setup();
    vi.spyOn(api, "cloudflareSetupStatus").mockResolvedValue(setupStatus());

    render(<I18nProvider><CloudflareSetupPanel suggestedOrigin="https://stugu.example.com" onComplete={vi.fn()} /></I18nProvider>);

    const showHelp = await screen.findByRole("button", { name: "Show token instructions" });
    const helpId = showHelp.getAttribute("aria-controls");
    expect(showHelp.getAttribute("aria-expanded")).toBe("false");
    expect(helpId).toBeTruthy();
    expect(document.getElementById(helpId ?? "")?.hidden).toBe(true);
    expect(screen.queryByRole("link", { name: /Open Cloudflare/ })).toBeNull();

    await user.click(showHelp);

    const hideHelp = screen.getByRole("button", { name: "Hide token instructions" });
    expect(hideHelp.getAttribute("aria-expanded")).toBe("true");
    expect(document.getElementById(helpId ?? "")?.hidden).toBe(false);
    expect(screen.getByRole("link", { name: /Open Cloudflare/ }).getAttribute("href"))
      .toBe("https://dash.cloudflare.com/profile/api-tokens");
    expect(screen.getByText(/Under Permissions, select Account → OAuth Clients → Edit/)).toBeTruthy();
    expect(screen.getByText(/Under Account Resources, select Include/)).toBeTruthy();
    expect(screen.getByText("Leave Client IP Address Filtering and TTL empty.")).toBeTruthy();

    await user.click(hideHelp);

    expect(screen.getByRole("button", { name: "Show token instructions" }).getAttribute("aria-expanded")).toBe("false");
    expect(document.getElementById(helpId ?? "")?.hidden).toBe(true);
  });

  it("keeps the approval link available when popup navigation is blocked", async () => {
    const user = userEvent.setup();
    vi.spyOn(api, "cloudflareSetupStatus").mockResolvedValue(setupStatus());
    vi.spyOn(api, "startCloudflareSetup").mockResolvedValue({
      operation: {
        id: "2fc58aab-24fb-4aa3-894a-2a0811497d76",
        mode: "stuguby-coordinator",
        hostname: "stugu.example.com",
        phase: "awaiting-approval",
        requestedAt: "2026-07-24T08:00:00.000Z",
        completedAt: null,
        detail: null,
      },
      authorizationUrl: "https://dash.cloudflare.com/oauth2/auth?client_id=client-id",
    });
    const close = vi.fn();
    vi.spyOn(window, "open").mockReturnValue({
      opener: window,
      location: { replace: () => { throw new Error("blocked"); } },
      close,
    } as unknown as Window);

    render(<I18nProvider><CloudflareSetupPanel suggestedOrigin="https://stugu.example.com" onComplete={vi.fn()} /></I18nProvider>);
    await user.type(
      await screen.findByLabelText(/^One-time OAuth client token/),
      "oauth-client-write-token-that-is-long-enough",
    );
    await user.click(screen.getByRole("button", { name: "Continue with Cloudflare" }));

    const approval = await screen.findByRole("link", { name: /Open Cloudflare approval/ });
    expect(approval.getAttribute("href")).toBe("https://dash.cloudflare.com/oauth2/auth?client_id=client-id");
    expect(close).toHaveBeenCalledOnce();
  });

  it("refreshes a stale form when another setup is already active", async () => {
    const user = userEvent.setup();
    const active = setupStatus();
    active.operation = {
      id: "2fc58aab-24fb-4aa3-894a-2a0811497d76",
      mode: "stuguby-coordinator",
      hostname: "stugu.example.com",
      phase: "awaiting-approval",
      requestedAt: "2026-07-24T08:00:00.000Z",
      completedAt: null,
      detail: null,
    };
    vi.spyOn(api, "cloudflareSetupStatus")
      .mockResolvedValueOnce(setupStatus())
      .mockResolvedValue(active);
    vi.spyOn(api, "startCloudflareSetup").mockRejectedValue(new Error("Cloudflare setup is already in progress"));
    vi.spyOn(window, "open").mockReturnValue(null);

    render(<I18nProvider><CloudflareSetupPanel suggestedOrigin="https://stugu.example.com" onComplete={vi.fn()} /></I18nProvider>);
    await user.type(
      await screen.findByLabelText(/^One-time OAuth client token/),
      "oauth-client-write-token-that-is-long-enough",
    );
    await user.click(screen.getByRole("button", { name: "Continue with Cloudflare" }));

    expect(await screen.findByText("Waiting for approval in Cloudflare")).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Continue with Cloudflare" })).toBeNull();
  });

  it("has no automated accessibility violations in the credential form", async () => {
    vi.spyOn(api, "cloudflareSetupStatus").mockResolvedValue(setupStatus({
      configured: false,
      mode: null,
      runtimeTokenAvailable: false,
    }));
    const { container } = render(
      <I18nProvider><CloudflareSetupPanel suggestedOrigin="https://stugu.example.com" onComplete={vi.fn()} /></I18nProvider>,
    );
    await screen.findByRole("button", { name: "Continue with Cloudflare" });

    const result = await axe.run(container, {
      rules: { "color-contrast": { enabled: false } },
    });
    expect(result.violations).toEqual([]);
  });
});
