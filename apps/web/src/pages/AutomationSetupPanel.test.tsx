import { act, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { IntegrationStatus } from "@climate-twin/contracts";
import { afterEach, describe, expect, it, vi } from "vitest";
import { api } from "../api";
import { createDemoState } from "../domain";
import { I18nProvider } from "../i18n";
import { AutomationSetupPanel } from "./AutomationSetupPanel";
import { TelegramSetupPanel } from "./TelegramSetupPanel";

function integrationWith(overrides: Partial<IntegrationStatus>): IntegrationStatus {
  return { ...createDemoState().integration, ...overrides };
}

function renderPanel(integration: IntegrationStatus, onIntegrationChange = vi.fn()) {
  const state = createDemoState();
  const props: React.ComponentProps<typeof AutomationSetupPanel> = {
    integration,
    house: state.houses[0]!,
    houses: state.houses,
    onHouse: vi.fn(),
    onIntegrationChange,
  };
  const view = render(<I18nProvider><AutomationSetupPanel {...props} /></I18nProvider>);
  return { ...view, props };
}

function renderTelegram(integration: IntegrationStatus, onIntegrationChange = vi.fn()) {
  const props: React.ComponentProps<typeof TelegramSetupPanel> = { integration, onIntegrationChange };
  const view = render(<I18nProvider><TelegramSetupPanel {...props} /></I18nProvider>);
  return { ...view, props };
}

afterEach(() => {
  vi.restoreAllMocks();
  localStorage.clear();
});

describe("AutomationSetupPanel", () => {
  it("guides Telegram discovery, clears the token after saving, and reports a successful test", async () => {
    const user = userEvent.setup();
    const initial = integrationWith({
      telegram: { available: true, configured: false, connected: false, botUsername: null, chatLabel: null, lastDeliveryAt: null, error: null },
      appleNotes: { available: false, configured: false, grantCount: 0, lastSyncAt: null, error: null },
    });
    const saved = integrationWith({
      telegram: { available: true, configured: true, connected: false, botUsername: "stuga_house_bot", chatLabel: "Home alerts", lastDeliveryAt: null, error: null },
      appleNotes: initial.appleNotes!,
    });
    const testedStatus = integrationWith({
      telegram: { ...saved.telegram!, connected: true, lastDeliveryAt: "2026-07-15T10:00:00.000Z" },
      appleNotes: initial.appleNotes!,
    });
    const discover = vi.spyOn(api, "discoverTelegram").mockResolvedValue({
      botUsername: "stuga_house_bot",
      chats: [{ id: "99112233", label: "Home alerts", username: "home_owner", type: "private" }],
      message: "Found one private chat",
    });
    const configure = vi.spyOn(api, "configureTelegram").mockResolvedValue({ ok: true, configured: true, integration: saved });
    const test = vi.spyOn(api, "testTelegram").mockResolvedValue({ ok: true, message: "Delivered" });
    const refreshStatus = vi.spyOn(api, "integrations").mockResolvedValue(testedStatus);
    const onIntegrationChange = vi.fn();
    const view = renderTelegram(initial, onIntegrationChange);

    await user.click(screen.getByText("Telegram alerts").closest("summary")!);
    const token = screen.getByLabelText("Bot token") as HTMLInputElement;
    expect(token.type).toBe("password");
    await user.type(token, "123456:local-test-token");
    await user.click(screen.getByRole("button", { name: "Find private chats" }));
    expect((await screen.findByRole("radio", { name: /Home alerts/ }) as HTMLInputElement).checked).toBe(true);
    expect(discover).toHaveBeenCalledWith("123456:local-test-token", expect.any(AbortSignal));

    await user.click(screen.getByRole("button", { name: "Save Telegram setup" }));
    await waitFor(() => expect(configure).toHaveBeenCalledWith({ botToken: "123456:local-test-token", chatId: "99112233" }));
    expect(onIntegrationChange).toHaveBeenCalledWith(saved);
    expect(screen.queryByDisplayValue("123456:local-test-token")).toBeNull();
    expect(JSON.stringify({ ...localStorage })).not.toContain("local-test-token");

    view.rerender(<I18nProvider><TelegramSetupPanel {...view.props} integration={saved} /></I18nProvider>);
    await user.click(await screen.findByRole("button", { name: "Send test message" }));
    expect(test).toHaveBeenCalledOnce();
    expect(refreshStatus).toHaveBeenCalledOnce();
    expect(onIntegrationChange).toHaveBeenLastCalledWith(testedStatus);
    expect((await screen.findByRole("status")).textContent).toContain("The test message was delivered to Telegram.");
  });

  it("creates a one-time Notes grant and renders exact Shortcut endpoints without persisting the token", async () => {
    const user = userEvent.setup();
    const initial = integrationWith({
      telegram: { available: false, configured: false, connected: false, botUsername: null, chatLabel: null, lastDeliveryAt: null, error: null },
      appleNotes: { available: true, configured: false, grantCount: 0, lastSyncAt: null, error: null },
    });
    const configured = integrationWith({
      telegram: initial.telegram!,
      appleNotes: { available: true, configured: true, grantCount: 1, lastSyncAt: null, error: null },
    });
    vi.spyOn(api, "appleNotesSetup").mockResolvedValue({});
    vi.spyOn(api, "appleNotesGrants").mockResolvedValue([]);
    const createGrant = vi.spyOn(api, "createAppleNotesGrant").mockResolvedValue({
      id: "grant-1",
      deviceLabel: "Niklas iPhone",
      houseId: createDemoState().houses[0]!.id,
      createdAt: "2026-07-15T10:00:00.000Z",
      token: "notes-one-time-secret",
      integration: configured,
    });
    const onIntegrationChange = vi.fn();
    renderPanel(initial, onIntegrationChange);

    expect(screen.queryByText("Telegram alerts")).toBeNull();
    expect(screen.getByRole("heading", { name: "Apple Notes access" })).toBeTruthy();
    await user.click(screen.getByText("Apple Notes via Shortcuts").closest("summary")!);
    expect(await screen.findByText("A manual bridge, not live Notes sync")).not.toBeNull();
    const deviceName = screen.getByLabelText("Operator device label") as HTMLInputElement;
    expect(deviceName.maxLength).toBe(100);
    await user.type(deviceName, "Niklas iPhone");
    await user.click(screen.getByRole("button", { name: "Create Shortcut grant" }));

    await waitFor(() => expect(createGrant).toHaveBeenCalledWith({ houseId: createDemoState().houses[0]!.id, deviceLabel: "Niklas iPhone" }));
    const oneTimeToken = await screen.findByLabelText("One-time bearer token") as HTMLInputElement;
    expect(oneTimeToken.type).toBe("password");
    expect(oneTimeToken.value).toBe("notes-one-time-secret");
    expect((screen.getByLabelText("Maintenance snapshot URL") as HTMLInputElement).value).toMatch(/\/api\/v1\/integrations\/apple-notes\/snapshot\?houseId=/);
    expect((screen.getByLabelText("Maintenance capture URL") as HTMLInputElement).value).toMatch(/\/api\/v1\/integrations\/apple-notes\/capture$/);
    expect(screen.getByText(/will not be shown again/i)).not.toBeNull();
    expect(onIntegrationChange).toHaveBeenCalledWith(configured);
    expect(JSON.stringify({ ...localStorage })).not.toContain("notes-one-time-secret");
  });

  it("clears a pending one-time token and filters grants when the selected Home changes", async () => {
    const user = userEvent.setup();
    const state = createDemoState();
    const firstHouse = state.houses[0]!;
    const secondHouse = { ...firstHouse, id: "house-lake", name: "Lake home" };
    const integration = integrationWith({
      appleNotes: { available: true, configured: true, grantCount: 2, lastSyncAt: null, error: null },
    });
    vi.spyOn(api, "appleNotesSetup").mockResolvedValue({});
    vi.spyOn(api, "appleNotesGrants").mockResolvedValue([
      { id: "grant-a", houseId: firstHouse.id, deviceLabel: "Phone A", createdAt: "2026-07-15T10:00:00.000Z" },
      { id: "grant-b", houseId: secondHouse.id, deviceLabel: "Phone B", createdAt: "2026-07-15T11:00:00.000Z" },
    ]);
    let resolveGrant!: (grant: Awaited<ReturnType<typeof api.createAppleNotesGrant>>) => void;
    const createGrant = vi.spyOn(api, "createAppleNotesGrant").mockReturnValue(new Promise((resolve) => { resolveGrant = resolve; }));
    const onIntegrationChange = vi.fn();
    const props: React.ComponentProps<typeof AutomationSetupPanel> = {
      integration,
      house: firstHouse,
      houses: [firstHouse, secondHouse],
      onHouse: vi.fn(),
      onIntegrationChange,
    };
    const view = render(<I18nProvider><AutomationSetupPanel {...props} /></I18nProvider>);

    await user.click(screen.getByText("Apple Notes via Shortcuts").closest("summary")!);
    expect(await screen.findByText("Phone A")).toBeTruthy();
    expect(screen.queryByText("Phone B")).toBeNull();
    await user.type(screen.getByLabelText("Operator device label"), "Pending phone");
    await user.click(screen.getByRole("button", { name: "Create Shortcut grant" }));
    await waitFor(() => expect(createGrant).toHaveBeenCalledWith({ houseId: firstHouse.id, deviceLabel: "Pending phone" }));

    view.rerender(<I18nProvider><AutomationSetupPanel {...props} house={secondHouse} /></I18nProvider>);
    expect(await screen.findByText("Phone B")).toBeTruthy();
    expect(screen.queryByText("Phone A")).toBeNull();

    await act(async () => resolveGrant({
      id: "grant-late",
      houseId: firstHouse.id,
      deviceLabel: "Pending phone",
      createdAt: "2026-07-15T12:00:00.000Z",
      token: "late-one-time-secret",
      integration,
    }));
    await waitFor(() => expect(onIntegrationChange).toHaveBeenCalledWith(integration));
    expect(screen.queryByDisplayValue("late-one-time-secret")).toBeNull();
    expect(screen.queryByText("Pending phone")).toBeNull();
    expect(JSON.stringify({ ...localStorage })).not.toContain("late-one-time-secret");
  });
});
