import type { CloudflareSetupStatusResponse } from "@climate-twin/contracts";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { api } from "../../api";
import { I18nProvider } from "../../i18n";
import { StugubyPage } from "../StugubyPage";
import { detail, identity, mockLoadedStugubys, summary } from "../StugubyPageTestSupport";

afterEach(() => vi.restoreAllMocks());

/** A coordinator provisioned through the UI before 0.58.0, as `deployment.json` reports it. */
function provisionedCoordinatorStatus(): CloudflareSetupStatusResponse {
  return {
    canConfigure: true,
    localConfigureUrl: "http://127.0.0.1:8080/stugbys",
    capability: { available: true, agentLastSeenAt: "2026-11-01T08:00:00.000Z", reason: "ready" },
    configuration: {
      configured: true,
      mode: "stuguby-coordinator",
      hostname: "stugu.example.test",
      suggestedZone: "example.test",
      accountIdKnown: true,
      zoneIdKnown: true,
      oauthClientConfigured: true,
      runtimeTokenAvailable: true,
      ownerEmail: "owner@example.test",
    },
    operation: {
      id: "5d0e8c1a-6f4b-4b7e-9a2d-3c1f0e9b8a76",
      mode: "stuguby-coordinator",
      hostname: "stugu.example.test",
      phase: "complete",
      requestedAt: "2026-07-25T08:00:00.000Z",
      completedAt: "2026-07-25T08:04:00.000Z",
      detail: "Secure connection verified at https://stugu.example.test",
    },
  };
}

function mockProvisionedCoordinator(): void {
  const stuguby = summary("stuguby-a", "Family Stuguby");
  mockLoadedStugubys([stuguby], { [stuguby.id]: detail(stuguby) });
  vi.mocked(api.stugubys).mockResolvedValue({
    identity,
    publicOrigin: "https://stugu.example.test",
    publicOriginConfigurable: false,
    stugubys: [stuguby],
  });
}

describe("CloudflareConnectionCard", () => {
  it("lets a provisioned coordinator rerun the Cloudflare setup without new tokens", async () => {
    const user = userEvent.setup();
    mockProvisionedCoordinator();
    const status = vi.spyOn(api, "cloudflareSetupStatus").mockResolvedValue(provisionedCoordinatorStatus());
    const start = vi.spyOn(api, "startCloudflareSetup").mockResolvedValue({
      operation: {
        id: "b7c1d2e3-f4a5-4b6c-8d7e-9f0a1b2c3d4e",
        mode: "stuguby-coordinator",
        hostname: "stugu.example.test",
        phase: "awaiting-approval",
        requestedAt: "2026-11-01T08:00:00.000Z",
        completedAt: null,
        detail: null,
      },
      authorizationUrl: "https://dash.cloudflare.com/oauth2/auth?client_id=legacy-oauth-client",
    });
    const replace = vi.fn();
    vi.spyOn(window, "open").mockReturnValue({ opener: window, location: { replace }, close: vi.fn() } as unknown as Window);

    render(<I18nProvider><StugubyPage houses={[]} /></I18nProvider>);
    await user.click(await screen.findByText("Cloudflare connection"));
    expect(screen.getByText("Remote access and sharing at https://stugu.example.test")).toBeTruthy();
    expect(status).not.toHaveBeenCalled();
    await user.click(screen.getByRole("button", { name: "Run Cloudflare setup again" }));

    const begin = await screen.findByRole("button", { name: "Continue with Cloudflare" });
    expect(screen.queryByLabelText(/^One-time OAuth client token/)).toBeNull();
    expect(screen.queryByLabelText(/^Runtime Access group token/)).toBeNull();
    expect(screen.queryByText(/Secure sharing was verified/)).toBeNull();
    await user.click(begin);

    await waitFor(() => expect(start).toHaveBeenCalledWith({
      mode: "stuguby-coordinator",
      hostname: "stugu.example.test",
      zone: "example.test",
      ownerEmail: "owner@example.test",
      accountId: null,
      zoneId: null,
      oauthClientToken: null,
      runtimeToken: null,
    }));
    expect(replace).toHaveBeenCalledWith("https://dash.cloudflare.com/oauth2/auth?client_id=legacy-oauth-client");

    await user.click(screen.getByRole("button", { name: "Cancel" }));
    expect(screen.getByRole("button", { name: "Run Cloudflare setup again" })).toBeTruthy();
  });

  it("stays away from origins the deployment does not pin", async () => {
    const stuguby = summary("stuguby-a", "Family Stuguby");
    mockLoadedStugubys([stuguby], { [stuguby.id]: detail(stuguby) });
    vi.mocked(api.stugubys).mockResolvedValue({
      identity,
      publicOrigin: "https://stugu.example.test",
      publicOriginConfigurable: true,
      stugubys: [stuguby],
    });

    render(<I18nProvider><StugubyPage houses={[]} /></I18nProvider>);
    expect(await screen.findByText("Family Stuguby", { selector: "strong" })).toBeTruthy();
    expect(screen.queryByText("Cloudflare connection")).toBeNull();
  });
});
