import { act, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { api } from "../api";
import { createDemoState } from "../domain";
import { renderPage } from "./SensorManagementPageTestSupport";
import { sensorUrlStateFromLocation, writeSensorUrlStateToLocation } from "./SensorManagementPage/urlState";

beforeEach(() => {
  window.history.replaceState(null, "", "/properties/property-main/homes/house-pine/sensors");
  vi.spyOn(api, "sensorMeasurementPage").mockResolvedValue({ samples: [], nextCursor: null });
});

afterEach(() => vi.restoreAllMocks());

describe("Sensor URL-backed urgency, detail, and range", () => {
  it("replaces filter and range churn while keeping detail selection navigable", async () => {
    const user = userEvent.setup();
    const pushState = vi.spyOn(window.history, "pushState");
    const replaceState = vi.spyOn(window.history, "replaceState");
    renderPage();
    pushState.mockClear();
    replaceState.mockClear();

    const status = screen.getByRole("combobox", { name: "Status" });
    await user.selectOptions(status, "waiting");
    await user.selectOptions(status, "live");
    await user.selectOptions(status, "all");
    expect(pushState).not.toHaveBeenCalled();
    expect(replaceState).toHaveBeenCalledTimes(3);

    await user.click(screen.getByRole("button", { name: "View data for Living room" }));
    expect(pushState).toHaveBeenCalledTimes(1);
    pushState.mockClear();
    replaceState.mockClear();
    const details = document.querySelector<HTMLElement>(".sensor-details-panel")!;
    await user.click(within(details).getByRole("button", { name: "6 hours" }));
    await user.click(within(details).getByRole("button", { name: "7 days" }));

    expect(pushState).not.toHaveBeenCalled();
    expect(replaceState).toHaveBeenCalledTimes(2);
    expect(new URLSearchParams(window.location.search).get("range")).toBe("7d");
  });

  it("restores sensor evidence and follows popstate while preserving unrelated params", async () => {
    const user = userEvent.setup();
    const state = createDemoState();
    const living = state.sensors.find((sensor) => sensor.id === "sensor-living")!;
    const kitchen = state.sensors.find((sensor) => sensor.id === "sensor-kitchen")!;
    window.history.replaceState(null, "", `?keep=yes&urgency=archived&detail=sensor%2F${living.id}&range=7d`);
    const rendered = renderPage({ state });

    await waitFor(() => expect(rendered.container.querySelector("#sensor-details-title")).toHaveTextContent(living.name));
    expect(screen.getByRole("combobox", { name: "Status" })).toHaveValue("archived");
    const details = rendered.container.querySelector<HTMLElement>(".sensor-details-panel")!;
    expect(within(details).getByRole("button", { name: "7 days" })).toHaveAttribute("aria-pressed", "true");
    expect(new URLSearchParams(window.location.search).get("keep")).toBe("yes");

    act(() => {
      window.history.pushState(null, "", `?keep=yes&urgency=live&detail=sensor%2F${kitchen.id}&range=6h`);
      window.dispatchEvent(new PopStateEvent("popstate"));
    });
    await waitFor(() => expect(rendered.container.querySelector("#sensor-details-title")).toHaveTextContent(kitchen.name));
    expect(screen.getByRole("combobox", { name: "Status" })).toHaveValue("live");
    expect(within(rendered.container.querySelector<HTMLElement>(".sensor-details-panel")!).getByRole("button", { name: "6 hours" })).toHaveAttribute("aria-pressed", "true");

    await user.click(screen.getByRole("button", { name: "Close" }));
    expect(new URLSearchParams(window.location.search).has("detail")).toBe(false);
    expect(new URLSearchParams(window.location.search).get("keep")).toBe("yes");
  });

  it("canonicalizes invalid/default values and round-trips contact identifiers", async () => {
    window.history.replaceState(null, "", "?keep=yes&urgency=urgent&detail=sensor%2Fmissing&range=1y");
    renderPage();
    await waitFor(() => expect(window.location.search).toBe("?keep=yes"));
    expect(screen.getByRole("combobox", { name: "Status" })).toHaveValue("all");

    writeSensorUrlStateToLocation({
      urgency: "waiting",
      detail: { kind: "contact", connectionId: "bridge/main", deviceId: "door:1" },
      range: "7d",
    }, "replace");
    expect(sensorUrlStateFromLocation()).toEqual({
      urgency: "waiting",
      detail: { kind: "contact", connectionId: "bridge/main", deviceId: "door:1" },
      range: "7d",
    });
    expect(new URLSearchParams(window.location.search).get("keep")).toBe("yes");
  });
});
