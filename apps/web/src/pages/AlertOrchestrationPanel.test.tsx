import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import type {
  ActionPlaybook,
  ActionRun,
  NotificationDeliveryStatus,
} from "@climate-twin/contracts";
import { api } from "../api";
import { createDemoState } from "../domain";
import { I18nProvider } from "../i18n";
import { ActionPlaybookLauncher, AlertOrchestrationPanel } from "./AlertOrchestrationPanel";

afterEach(() => vi.restoreAllMocks());

const retryableDelivery: NotificationDeliveryStatus = {
  id: "delivery-retryable",
  subjectKind: "alert",
  subjectId: "alert-1",
  stage: "initial",
  sequence: 0,
  channel: "telegram",
  destinationId: "redacted",
  attempts: 2,
  maxAttempts: 2,
  availableAt: "2026-08-01T09:00:00.000Z",
  createdAt: "2026-08-01T08:00:00.000Z",
  deliveredAt: null,
  deadLetteredAt: "2026-08-01T09:05:00.000Z",
  abandonedAt: null,
  lastError: "Telegram was unavailable",
  canRetry: true,
};

const playbook: ActionPlaybook = {
  id: "playbook-ventilate",
  name: "Ventilate the room",
  description: "Use a short ventilation cycle.",
  instructions: ["Open the window", "Wait ten minutes"],
  metric: "temperature",
  goal: "decrease",
  minimumImprovement: 1,
  targetValue: null,
  waitSeconds: 60,
  verificationWindowSeconds: 300,
  enabled: true,
  builtIn: true,
  createdAt: "2026-08-01T08:00:00.000Z",
  updatedAt: "2026-08-01T08:00:00.000Z",
};

function actionRun(status: ActionRun["status"]): ActionRun {
  return {
    id: "run-1",
    playbookId: playbook.id,
    alertEventId: "alert-1",
    maintenanceTaskId: null,
    sensorId: "sensor-1",
    metric: "temperature",
    status,
    startedAt: "2026-08-01T09:00:00.000Z",
    actionCompletedAt: status === "active" ? null : "2026-08-01T09:05:00.000Z",
    verifyAfter: status === "active" ? null : "2026-08-01T09:06:00.000Z",
    verificationDeadline: status === "active" ? null : "2026-08-01T09:11:00.000Z",
    baselineValue: 24,
    baselineTimestamp: "2026-08-01T09:00:00.000Z",
    resultValue: null,
    resultTimestamp: null,
    improvement: null,
    sampleCount: 0,
    operatorNote: null,
    verificationNote: null,
    createdAt: "2026-08-01T09:00:00.000Z",
    updatedAt: "2026-08-01T09:00:00.000Z",
  };
}

describe("AlertOrchestrationPanel", () => {
  it("retries only a delivery carrying the retry capability and reconciles the ledger", async () => {
    const user = userEvent.setup();
    const protectedDelivery: NotificationDeliveryStatus = {
      ...retryableDelivery,
      id: "delivery-protected",
      channel: "webhook",
      canRetry: false,
    };
    vi.spyOn(api, "notificationDeliveries")
      .mockResolvedValue([retryableDelivery, protectedDelivery]);
    vi.spyOn(api, "actionRuns").mockResolvedValue([]);
    const retryNotificationDelivery = vi.spyOn(api, "retryNotificationDelivery")
      .mockResolvedValue({
        ...retryableDelivery,
        attempts: 3,
        deadLetteredAt: null,
        lastError: null,
        canRetry: false,
      });

    render(<I18nProvider><AlertOrchestrationPanel /></I18nProvider>);
    await user.click(screen.getByText("Delivery and action evidence"));

    const retries = await screen.findAllByRole("button", { name: "Retry" });
    expect(retries).toHaveLength(1);
    await user.click(retries[0]!);
    await waitFor(() => expect(retryNotificationDelivery).toHaveBeenCalledWith(retryableDelivery.id));
    await waitFor(() => expect(screen.queryByRole("button", { name: "Retry" })).toBeNull());
    expect(screen.getByText(/Attempt 3, queued/)).toBeTruthy();
  });
});

describe("ActionPlaybookLauncher", () => {
  it("loads a playbook, starts its baseline, and completes the action for verification", async () => {
    const user = userEvent.setup();
    const alert = {
      ...createDemoState().alerts[0]!,
      id: "alert-1",
      sensorId: "sensor-1",
      metric: "temperature" as const,
    };
    vi.spyOn(api, "alertActionPlaybooks").mockResolvedValue([playbook]);
    vi.spyOn(api, "actionRuns").mockResolvedValue([]);
    const startActionRun = vi.spyOn(api, "startActionRun").mockResolvedValue(actionRun("active"));
    const completeActionRun = vi.spyOn(api, "completeActionRun").mockResolvedValue(actionRun("waiting"));

    render(<I18nProvider><ActionPlaybookLauncher alert={alert} /></I18nProvider>);
    const trigger = screen.getByRole("button", { name: "Action plan" });
    expect(trigger).not.toHaveAttribute("aria-controls");
    await user.click(trigger);
    expect(trigger).toHaveAttribute("aria-controls");
    expect(document.getElementById(trigger.getAttribute("aria-controls")!)).not.toBeNull();

    expect(await screen.findByText(playbook.name)).toBeTruthy();
    await user.click(screen.getByRole("button", { name: "Start with baseline" }));
    await waitFor(() => expect(startActionRun).toHaveBeenCalledWith({
      playbookId: playbook.id,
      sensorId: alert.sensorId,
      alertEventId: alert.id,
    }));

    await user.click(await screen.findByRole("button", {
      name: "Action completed — verify result",
    }));
    await waitFor(() => expect(completeActionRun).toHaveBeenCalledWith("run-1"));
    expect(await screen.findByText(/Waiting for fresh temperature evidence/)).toBeTruthy();
  });
});
