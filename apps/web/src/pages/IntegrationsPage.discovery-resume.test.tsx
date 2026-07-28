import { act, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { IntegrationDiscoveryJob } from "@climate-twin/contracts";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { api } from "../api";
import { connectedTpLink, deferred, house, renderPage } from "./IntegrationsPageTestSupport";

vi.mock("../components/HouseLocationMap", () => ({
  HouseLocationMap: () => <div>Map</div>,
}));

const job: IntegrationDiscoveryJob = {
  id: "72d642ee-a2f4-40cb-8d68-5fd663454912",
  houseId: house.id,
  status: "running",
  createdAt: "2026-07-28T10:00:00.000Z",
  updatedAt: "2026-07-28T10:00:00.000Z",
  expiresAt: "2026-07-28T10:10:00.000Z",
  result: null,
  error: null,
};
const storageKey = `stugu.integration-discovery.${house.id}`;
const result = { homeAssistant: [], tpLink: [], warnings: [] };

beforeEach(() => {
  localStorage.clear();
  window.history.replaceState(null, "", "/setup/overview");
});

afterEach(() => {
  localStorage.clear();
  vi.restoreAllMocks();
});

describe("integration discovery resume", () => {
  it("keeps the server job id when the page closes before discovery finishes", async () => {
    const pending = deferred<typeof result>();
    let subscriptionSignal: AbortSignal | undefined;
    vi.spyOn(api, "discoverIntegrations").mockImplementation(
      async (_houseId, _credentials, onStarted, signal) => {
        subscriptionSignal = signal;
        onStarted?.(job);
        return pending.promise;
      },
    );
    const rendered = renderPage();
    const user = userEvent.setup();

    await user.click(screen.getByRole("tab", { name: /Where readings come from/ }));
    await user.click(screen.getByRole("button", { name: "Find devices" }));
    await waitFor(() => expect(localStorage.getItem(storageKey)).toBe(job.id));

    rendered.unmount();
    expect(subscriptionSignal?.aborted).toBe(true);
    await act(async () => {
      pending.resolve(result);
      await pending.promise;
    });
    expect(localStorage.getItem(storageKey)).toBe(job.id);
  });

  it("keeps a completed server result available instead of starting another scan", async () => {
    localStorage.setItem(storageKey, job.id);
    const resume = vi.spyOn(api, "resumeIntegrationDiscovery").mockResolvedValue(result);
    const start = vi.spyOn(api, "discoverIntegrations");

    renderPage();

    await waitFor(() => expect(resume).toHaveBeenCalledWith(job.id, expect.any(AbortSignal)));
    await waitFor(() => expect(localStorage.getItem(storageKey)).toBe(job.id));
    expect(start).not.toHaveBeenCalled();
  });

  it("keeps the server job id through a temporary browser connection failure", async () => {
    vi.spyOn(api, "discoverIntegrations").mockImplementation(
      async (_houseId, _credentials, onStarted) => {
        onStarted?.(job);
        throw new Error("Browser went offline");
      },
    );
    vi.spyOn(api, "latestIntegrationDiscovery").mockRejectedValue(new Error("Still offline"));
    renderPage();
    const user = userEvent.setup();

    await user.click(screen.getByRole("tab", { name: /Where readings come from/ }));
    await user.click(screen.getByRole("button", { name: "Find devices" }));

    await waitFor(() => expect(localStorage.getItem(storageKey)).toBe(job.id));
  });

  it("restores the latest result and hides a source that was connected meanwhile", async () => {
    window.history.replaceState(null, "", "/setup/connections");
    const found = {
      homeAssistant: [],
      tpLink: [
        { host: "192.168.1.20", model: "P110", alias: "Desk plug", sourceType: "energy-device" as const },
        { host: "192.168.1.21", model: "P110", alias: "Heater plug", sourceType: "energy-device" as const },
      ],
      warnings: [],
    };
    const completedJob: IntegrationDiscoveryJob = {
      ...job,
      status: "completed",
      updatedAt: "2026-07-28T10:00:30.000Z",
      result: found,
    };
    vi.spyOn(api, "latestIntegrationDiscovery").mockResolvedValue(completedJob);
    const resume = vi.spyOn(api, "resumeIntegrationDiscovery").mockResolvedValue(found);
    const start = vi.spyOn(api, "discoverIntegrations");

    renderPage({
      integration: connectedTpLink({
        host: "192.168.1.20",
        connections: [{
          id: "desk-plug",
          houseId: house.id,
          configured: true,
          connected: true,
          lastPollAt: "2026-07-28T10:01:00.000Z",
          mappedDevices: 0,
          discoveredDevices: 1,
          hubModel: null,
          error: null,
          host: "192.168.1.20",
          sourceType: "energy-device",
          sourceModel: "P110",
          sourceAlias: "Desk plug",
        }],
      }),
    });

    await waitFor(() => expect(resume).toHaveBeenCalledWith(completedJob.id, expect.any(AbortSignal)));
    const foundDevices = await screen.findByRole("group", { name: "TP-Link devices found" });
    expect(within(foundDevices).getByRole("radio", { name: /Heater plug/ })).not.toBeNull();
    expect(within(foundDevices).queryByRole("radio", { name: /Desk plug/ })).toBeNull();
    expect(start).not.toHaveBeenCalled();
  });
});
