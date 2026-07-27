import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";

import userEvent from "@testing-library/user-event";

import type { House, IntegrationStatus, TpLinkDiscoveredDevice } from "@climate-twin/contracts";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { api } from "../api";

import { I18nProvider } from "../i18n";

import { IntegrationsPage } from "./IntegrationsPage";

import { connectedTpLink, deferred, discoveredChild, historyAutomation, house, integration, renderPage } from "./IntegrationsPageTestSupport";

vi.mock("../components/HouseLocationMap", () => ({
  HouseLocationMap: ({ onChange, onSelect, ariaLabel, selectedHouseId, items }: {
    onChange: (houseId: string, location: { latitude: number; longitude: number }) => void;
    onSelect: (houseId: string) => void;
    ariaLabel: string;
    selectedHouseId: string;
    items: Array<{ id: string }>;
  }) => (
    <>
      <button type="button" aria-label={ariaLabel} onClick={() => onChange(selectedHouseId, { latitude: 61.5, longitude: 25.25 })}>Map</button>
      <button type="button" onClick={() => {
        const other = items.find((item) => item.id !== selectedHouseId);
        if (other) onSelect(other.id);
      }}>Select another home from map</button>
    </>
  ),
}));

beforeEach(() => {
  window.history.replaceState(null, "", "/setup/overview");
  vi.spyOn(window, "confirm").mockReturnValue(true);
  vi.spyOn(api, "testTpLinkDraft").mockResolvedValue({ ok: true, message: "Connected" });
  vi.spyOn(api, "testHomeAssistantDraft").mockResolvedValue({ ok: true, message: "Connected" });
  vi.spyOn(api, "tpLinkHistoryExportJobs").mockResolvedValue({ enabled: false, automation: historyAutomation, jobs: [] });
  vi.spyOn(api, "tpLinkDevices").mockResolvedValue([]);
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("Setup workspace", () => {
  it("derives distinct completion states and presents one recommended action", async () => {
    const user = userEvent.setup();
    const onOpenSensors = vi.fn();
    const almostComplete: IntegrationStatus = {
      ...integration,
      tpLink: {
        ...integration.tpLink,
        configured: true,
        connected: true,
        discoveredDevices: 2,
        mappedDevices: 0,
      },
    };
    const rendered = renderPage({ integration: almostComplete, onOpenSensors });

    expect(screen.getByRole("progressbar", { name: "Setup progress" }).getAttribute("aria-valuenow")).toBe("3");
    expect(screen.getByRole("heading", { level: 2, name: "Map and place sensors" })).not.toBeNull();
    const checklist = screen.getByText("Review setup checklist").closest("details")!;
    expect(checklist.hasAttribute("open")).toBe(false);
    await user.click(screen.getByRole("button", { name: "Add sensor" }));
    expect(onOpenSensors).toHaveBeenCalledOnce();

    const complete = { ...almostComplete, tpLink: { ...almostComplete.tpLink, mappedDevices: 2 } };
    rendered.rerender(<I18nProvider><IntegrationsPage {...rendered.props} integration={complete} /></I18nProvider>);
    expect(screen.getByRole("heading", { name: "Setup complete" })).not.toBeNull();
    expect(screen.queryByRole("button", { name: "Add sensor" })).toBeNull();
    expect(screen.getByText("Sensor data is connected and mapped.")).not.toBeNull();
  });

  it("identifies invalid manual coordinates and timezone with actionable field feedback", async () => {
    const user = userEvent.setup();
    const onHouseUpdate = vi.fn().mockResolvedValue(undefined);
    renderPage({ onHouseUpdate });

    await user.click(screen.getByRole("tab", { name: /Weather/ }));
    await user.click(screen.getByText("Advanced weather location"));
    const latitude = screen.getByRole("spinbutton", { name: "Latitude" });
    const timezone = screen.getByRole("textbox", { name: "Timezone" });
    await user.clear(latitude);
    await user.type(latitude, "100");
    await user.clear(timezone);
    await user.type(timezone, "Invalid/Zone");
    await user.click(screen.getByRole("button", { name: "Save location" }));

    expect(latitude.getAttribute("aria-invalid")).toBe("true");
    expect(latitude.getAttribute("aria-describedby")).toBe("weather-coordinate-error");
    expect(timezone.getAttribute("aria-invalid")).toBe("true");
    expect(timezone.getAttribute("aria-describedby")).toBe("weather-timezone-error");
    expect(screen.getByText(/latitude from −90 to 90/)).not.toBeNull();
    expect(screen.getByText(/valid IANA timezone/)).not.toBeNull();
    expect(onHouseUpdate).not.toHaveBeenCalled();

    await user.clear(latitude);
    await user.type(latitude, "60.17");
    await user.clear(timezone);
    await user.type(timezone, "UTC");
    await user.click(screen.getByRole("button", { name: "Save location" }));
    await waitFor(() => expect(onHouseUpdate).toHaveBeenCalledWith(house.id, expect.objectContaining({ timezone: "UTC" })));
  });

  it("supports keyboard navigation between Setup tabs", async () => {
    const user = userEvent.setup();
    renderPage();
    const overview = screen.getByRole("tab", { name: /Overview/ });
    overview.focus();

    await user.keyboard("{ArrowRight}");
    await waitFor(() => expect(document.activeElement).toBe(screen.getByRole("tab", { name: /Layout & rooms/ })));
    expect(screen.getByRole("tab", { name: /Layout & rooms/ }).getAttribute("aria-selected")).toBe("true");
    await user.keyboard("{End}");
    await waitFor(() => expect(document.activeElement).toBe(screen.getByRole("tab", { name: /Automations/ })));
  });
});
