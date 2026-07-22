import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { api } from "../api";
import { createDemoState } from "../domain";
import { I18nProvider } from "../i18n";
import { AlertsPage, countActionableAlertGroups } from "./AlertsPage";

afterEach(() => vi.restoreAllMocks());

describe("AlertsPage monitoring coverage", () => {
  it("does not present missing sensor data as an all-clear", () => {
    const state = createDemoState();
    render(
      <I18nProvider>
        <AlertsPage
          state={{
            ...state,
            alerts: [],
            latestMeasurements: {},
            measurementHistory: {},
            readings: {},
            history: {},
          }}
          units="metric"
          onCreateRule={vi.fn().mockResolvedValue(undefined)}
          onUpdateRule={vi.fn()}
          onAcknowledge={vi.fn().mockResolvedValue(undefined)}
        />
      </I18nProvider>,
    );

    expect(screen.getByRole("heading", { name: "Monitoring status unknown or incomplete" })).toBeTruthy();
    expect(screen.getByText("No threshold alerts")).toBeTruthy();
    expect(screen.getByText(/condition cannot be confirmed/i)).toBeTruthy();
    expect(screen.queryByText(/within their rules/i)).toBeNull();
  });

  it("puts unresolved work first and keeps monitoring and rule administration disclosed", () => {
    const state = createDemoState();
    const { container } = render(
      <I18nProvider><AlertsPage state={state} units="metric" onCreateRule={vi.fn()} onUpdateRule={vi.fn()} onAcknowledge={vi.fn()} /></I18nProvider>,
    );

    const pageHeader = screen.getByRole("heading", { level: 1, name: "Alerts" }).closest("header")!;
    const actionPanel = screen.getByRole("heading", { name: "Needs attention" }).closest("section")!;
    expect(pageHeader.nextElementSibling).toBe(actionPanel);
    expect(container.querySelector(".alerts-rule-admin")?.hasAttribute("open")).toBe(false);
    expect(container.querySelector(".alerts-monitoring-summary.confirmed")?.hasAttribute("open")).toBe(false);
  });

  it("offers inspection as the primary action while acknowledgement stays secondary", async () => {
    const user = userEvent.setup();
    const state = createDemoState();
    const onInspectAlert = vi.fn();
    render(
      <I18nProvider><AlertsPage state={state} units="metric" onCreateRule={vi.fn()} onUpdateRule={vi.fn()} onAcknowledge={vi.fn()} onInspectAlert={onInspectAlert} /></I18nProvider>,
    );

    const inspect = screen.getByRole("button", { name: "Inspect" });
    const acknowledge = screen.getByRole("button", { name: "Acknowledge" });
    expect(inspect.classList.contains("primary-button")).toBe(true);
    expect(acknowledge.classList.contains("secondary-button")).toBe(true);
    await user.click(inspect);
    expect(onInspectAlert).toHaveBeenCalledWith(state.alerts[0]);
  });

  it("focuses an opened action plan and returns focus when Escape closes it", async () => {
    const user = userEvent.setup();
    vi.spyOn(api, "alertActionPlaybooks").mockResolvedValue([]);
    vi.spyOn(api, "actionRuns").mockResolvedValue([]);
    const state = createDemoState();
    render(
      <I18nProvider><AlertsPage state={state} units="metric" onCreateRule={vi.fn()} onUpdateRule={vi.fn()} onAcknowledge={vi.fn()} /></I18nProvider>,
    );

    const trigger = screen.getByRole("button", { name: "Action plan" });
    await user.click(trigger);
    const plan = await screen.findByRole("region", { name: "Action plan" });
    await waitFor(() => expect(document.activeElement).toBe(plan));
    await user.keyboard("{Escape}");
    await waitFor(() => expect(screen.queryByRole("region", { name: "Action plan" })).toBeNull());
    await waitFor(() => expect(document.activeElement).toBe(trigger));
  });

  it("keeps Guest access observational and removes alert mutations", async () => {
    const user = userEvent.setup();
    const state = createDemoState();
    const onInspectAlert = vi.fn();
    const onAcknowledge = vi.fn();
    render(
      <I18nProvider><AlertsPage
        state={state}
        units="metric"
        readOnly
        onCreateRule={vi.fn()}
        onUpdateRule={vi.fn()}
        onAcknowledge={onAcknowledge}
        onInspectAlert={onInspectAlert}
        onIntegrationChange={vi.fn()}
      /></I18nProvider>,
    );

    expect(screen.queryByRole("button", { name: "Acknowledge" })).toBeNull();
    expect(screen.queryByText("Rules", { selector: ".alerts-rule-admin > summary strong" })).toBeNull();
    expect(screen.queryByRole("heading", { name: "Notification delivery" })).toBeNull();
    expect(screen.queryByText("Telegram alerts")).toBeNull();
    await user.click(screen.getByRole("button", { name: "Inspect" }));
    expect(onInspectAlert).toHaveBeenCalledWith(state.alerts[0]);
    expect(onAcknowledge).not.toHaveBeenCalled();
  });

  it("explains when a Guest has no shared alert inventory", () => {
    const state = createDemoState();
    render(
      <I18nProvider><AlertsPage
        state={{
          ...state,
          properties: [],
          houses: [],
          sensors: [],
          alerts: [],
          latestMeasurements: {},
          measurementHistory: {},
          readings: {},
          history: {},
        }}
        units="metric"
        readOnly
        onCreateRule={vi.fn()}
        onUpdateRule={vi.fn()}
        onAcknowledge={vi.fn()}
      /></I18nProvider>,
    );

    expect(screen.getByText("No property access")).toBeTruthy();
    expect(screen.getByText(/administrator has not shared a property, home, or area/i)).toBeTruthy();
    expect(screen.queryByText("Monitoring confirmed")).toBeNull();
  });

  it("exports the same actionable grouping count used by the page", () => {
    const state = createDemoState();
    const related = { ...state.alerts[0]!, id: "alert-related", threshold: 67, severity: "critical" as const };
    expect(countActionableAlertGroups([...state.alerts, related], state.alertRules)).toBe(1);
  });

  it("adds Telegram delivery to a new rule when the integration is ready", async () => {
    const user = userEvent.setup();
    const state = createDemoState();
    state.integration.telegram = { available: true, configured: true, connected: true, botUsername: "stuga_bot", chatLabel: "Home alerts", lastDeliveryAt: null, error: null };
    const onCreateRule = vi.fn().mockResolvedValue(undefined);
    render(
      <I18nProvider><AlertsPage state={state} units="metric" onCreateRule={onCreateRule} onUpdateRule={vi.fn()} onAcknowledge={vi.fn()} /></I18nProvider>,
    );

    await user.click(screen.getByText("Rules", { selector: ".alerts-rule-admin > summary strong" }));
    await user.click(screen.getByRole("button", { name: "New rule" }));
    await user.type(screen.getByLabelText("Rule name"), "Telegram humidity");
    const telegram = screen.getByLabelText("Notify in Telegram");
    expect((telegram as HTMLInputElement).disabled).toBe(false);
    await user.click(telegram);
    await user.click(screen.getByRole("button", { name: "Create rule" }));

    await waitFor(() => expect(onCreateRule).toHaveBeenCalledWith(expect.objectContaining({
      name: "Telegram humidity",
      telegramEnabled: true,
      webhookEnabled: true,
    })));
  });

  it("opens workspace Telegram setup when delivery is unavailable", async () => {
    const user = userEvent.setup();
    const state = createDemoState();
    state.integration.telegram = { available: true, configured: false, connected: false, botUsername: null, chatLabel: null, lastDeliveryAt: null, error: null };
    const onIntegrationChange = vi.fn();
    render(
      <I18nProvider><AlertsPage state={state} units="metric" onCreateRule={vi.fn()} onUpdateRule={vi.fn()} onAcknowledge={vi.fn()} onIntegrationChange={onIntegrationChange} /></I18nProvider>,
    );

    expect(screen.getByRole("heading", { name: "Notification delivery" })).toBeTruthy();
    const telegramSetup = screen.getByText("Telegram alerts").closest("details")!;
    expect(telegramSetup.open).toBe(false);
    await user.click(screen.getByText("Rules", { selector: ".alerts-rule-admin > summary strong" }));
    await user.click(screen.getByRole("button", { name: "New rule" }));
    expect((screen.getByLabelText("Notify in Telegram") as HTMLInputElement).disabled).toBe(true);
    await user.click(screen.getByRole("button", { name: "Set up Telegram" }));
    expect(telegramSetup.open).toBe(true);
  });

  it("offers workspace Telegram setup without requiring a Home", () => {
    const state = createDemoState();
    state.houses = [];
    state.sensors = [];
    state.latestMeasurements = {};
    state.measurementHistory = {};
    state.readings = {};
    state.history = {};
    render(
      <I18nProvider><AlertsPage state={state} units="metric" onCreateRule={vi.fn()} onUpdateRule={vi.fn()} onAcknowledge={vi.fn()} onIntegrationChange={vi.fn()} /></I18nProvider>,
    );

    expect(screen.getByRole("heading", { name: "Notification delivery" })).toBeTruthy();
    expect(screen.getByText("Telegram alerts")).toBeTruthy();
  });

  it("updates Telegram independently on an existing rule", async () => {
    const user = userEvent.setup();
    const state = createDemoState();
    state.integration.telegram = { available: true, configured: true, connected: true, botUsername: "stuga_bot", chatLabel: "Home alerts", lastDeliveryAt: null, error: null };
    const updatedRule = { ...state.alertRules[0]!, telegramEnabled: true };
    const onUpdateRule = vi.fn().mockResolvedValue(updatedRule);
    render(
      <I18nProvider><AlertsPage state={state} units="metric" onCreateRule={vi.fn()} onUpdateRule={onUpdateRule} onAcknowledge={vi.fn()} /></I18nProvider>,
    );

    await user.click(screen.getByText("Rules", { selector: ".alerts-rule-admin > summary strong" }));
    const telegram = screen.getByRole("button", { name: "Telegram" });
    expect(telegram.getAttribute("aria-pressed")).toBe("false");
    await user.click(telegram);
    await waitFor(() => expect(onUpdateRule).toHaveBeenCalledWith(state.alertRules[0]!.id, { telegramEnabled: true }));
  });
});
