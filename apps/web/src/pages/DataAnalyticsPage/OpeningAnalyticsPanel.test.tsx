import axe from "axe-core";
import { act, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type {
  DoorPlanElement,
  OpeningActivityResponse,
  OpeningStateObservation,
} from "@climate-twin/contracts";
import { api } from "../../api";
import { queryClient } from "../../data/queryClient";
import { createDemoState } from "../../domain";
import { I18nProvider } from "../../i18n";
import { OpeningAnalyticsPanel } from "./OpeningAnalyticsPanel";

const clock = vi.hoisted(() => ({ now: Date.now() }));

vi.mock("../../useNow", () => ({
  useNow: () => clock.now,
}));

afterEach(() => {
  queryClient.clear();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("OpeningAnalyticsPanel", () => {
  beforeEach(() => {
    clock.now = Date.now();
    localStorage.setItem("climate-twin-locale", "en");
  });

  it("shows contact-state history, current state, and period insights", async () => {
    const state = createDemoState();
    const baseHouse = state.houses[0]!;
    const firstFloor = baseHouse.floors[0]!;
    const door: DoorPlanElement = {
      id: "front-door",
      kind: "door",
      wallId: firstFloor.walls[0]!.id,
      position: { x: 100, y: 45 },
      rotationDegrees: 0,
      variant: "exterior",
      state: "closed",
      label: "Front door",
      stateBinding: { provider: "tapo", externalId: "t110-entry", staleAfterSeconds: 900 },
    };
    const house = {
      ...baseHouse,
      timezone: "UTC",
      floors: baseHouse.floors.map((floor, index) => (
        index === 0 ? { ...floor, planElements: [...(floor.planElements ?? []), door] } : floor
      )),
    };
    const now = Date.now();
    const observations: OpeningStateObservation[] = [
      {
        id: "closed",
        houseId: house.id,
        floorId: firstFloor.id,
        elementId: door.id,
        state: "closed",
        source: "tapo",
        observedAt: new Date(now - 2 * 3_600_000).toISOString(),
        externalId: "t110-entry",
      },
      {
        id: "open",
        houseId: house.id,
        floorId: firstFloor.id,
        elementId: door.id,
        state: "open",
        source: "tapo",
        observedAt: new Date(now - 5 * 60_000).toISOString(),
        externalId: "t110-entry",
      },
    ];
    const openingActivity = vi.spyOn(api, "openingActivity").mockResolvedValue({
      apiVersion: "1.0",
      requestId: "opening-test",
      houseId: house.id,
      dataMode: "demo",
      range: {
        start: new Date(now - 24 * 3_600_000).toISOString(),
        end: new Date(now).toISOString(),
      },
      generatedAt: new Date(now).toISOString(),
      complete: true,
      truncated: false,
      archiveState: "not-configured",
      warnings: [],
      provenance: {
        algorithmKey: "opening-activity",
        algorithmVersion: "opening-activity-v2.0.0",
        evaluatedAt: new Date(now).toISOString(),
        sourceIds: ["tapo"],
        archiveState: "not-configured",
      },
      series: [{
        target: {
          key: `${firstFloor.id}:${door.id}`,
          floorId: firstFloor.id,
          floorName: firstFloor.name,
          elementId: door.id,
          kind: "door",
          label: "Front door",
          ordinal: 1,
        },
        segments: [
          {
            state: "closed",
            startedAt: observations[0]!.observedAt,
            endedAt: observations[1]!.observedAt,
          },
          {
            state: "open",
            startedAt: observations[1]!.observedAt,
            endedAt: new Date(now).toISOString(),
          },
        ],
        records: observations.map((observation, index) => ({
          id: observation.id,
          observedAt: observation.observedAt,
          state: observation.state,
          source: observation.source,
          transition: index === 0 ? "initial" : "opened",
        })),
        observationCount: 2,
        openedCount: 1,
        closedCount: 0,
        confirmedOpenMs: 5 * 60_000,
        longestOpenMs: 5 * 60_000,
        currentState: "open",
        currentSince: observations[1]!.observedAt,
        lastObservedAt: observations[1]!.observedAt,
      }],
    } satisfies OpeningActivityResponse);
    const onRange = vi.fn();
    const user = userEvent.setup();
    const view = render(<I18nProvider><OpeningAnalyticsPanel
      house={house}
      dataMode="demo"
      range="24h"
      refreshRevision={0}
      onRange={onRange}
    /></I18nProvider>);
    const { container } = view;

    expect(await screen.findByRole("heading", { name: "Door & window activity" })).not.toBeNull();
    await waitFor(() => expect(screen.getByText("Front door is open now.")).not.toBeNull());
    expect(screen.getByText("1 / 1")).not.toBeNull();
    expect(screen.getByText("Front door was opened once in this period.")).not.toBeNull();
    expect(container.querySelector(".opening-timeline-segment.open")).not.toBeNull();
    expect(screen.getByText("Open", { selector: ".opening-current-state" })).not.toBeNull();

    expect(screen.queryByRole("region", { name: "Door and window state history" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Download activity as CSV" })).toBeNull();
    const historyDetails = screen.getByText("Show state history (2 records)").closest("details")!;
    expect(historyDetails.open).toBe(false);
    await user.click(screen.getByText("Show state history (2 records)"));
    expect(historyDetails.open).toBe(true);
    const table = screen.getByRole("region", { name: "Door and window state history" });
    expect(within(table).getAllByText("Front door")).toHaveLength(2);
    expect(within(table).getAllByText("Tapo")).toHaveLength(2);
    const createObjectURL = vi.fn(() => "blob:opening-activity");
    const revokeObjectURL = vi.fn();
    class TestUrl extends URL {}
    Object.assign(TestUrl, { createObjectURL, revokeObjectURL });
    vi.stubGlobal("URL", TestUrl);
    const download = vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(() => undefined);
    expect(createObjectURL).not.toHaveBeenCalled();
    await user.click(screen.getByRole("button", { name: "Download activity as CSV" }));
    expect(createObjectURL).toHaveBeenCalledOnce();
    expect(download).toHaveBeenCalledOnce();
    await waitFor(() => expect(revokeObjectURL).toHaveBeenCalledWith("blob:opening-activity"));

    openingActivity.mockRejectedValueOnce(new Error("Opening refresh unavailable"));
    view.rerender(<I18nProvider><OpeningAnalyticsPanel
      house={house}
      dataMode="demo"
      range="24h"
      refreshRevision={1}
      onRange={onRange}
    /></I18nProvider>);
    expect(await screen.findByText("Door and window activity is stale.")).not.toBeNull();
    expect(screen.getByText(/Showing activity last received/)).not.toBeNull();
    expect(screen.getByText("Opening refresh unavailable")).not.toBeNull();
    expect(screen.queryByText("Front door is open now.")).toBeNull();
    expect(screen.getByText("Open now").closest("div")?.querySelector("strong")?.textContent).toBe("—");
    expect(screen.getByText("Last received state")).not.toBeNull();

    await user.click(screen.getByRole("button", { name: "7 days" }));
    expect(onRange).toHaveBeenCalledWith("7d");
    expect(api.openingActivity).toHaveBeenCalledWith(
      expect.objectContaining({
        houseId: house.id,
        dataMode: "demo",
        range: expect.objectContaining({
          start: expect.any(String),
          end: expect.any(String),
        }),
      }),
      expect.any(AbortSignal),
    );

    const panel = screen.getByRole("heading", { name: "Door & window activity" }).closest("section")!;
    const accessibility = await axe.run(panel, {
      rules: { "color-contrast": { enabled: false } },
    });
    expect(accessibility.violations).toEqual([]);
  });

  it("explains when a linked contact has not reported yet", async () => {
    const state = createDemoState();
    const baseHouse = state.houses[0]!;
    const floor = baseHouse.floors[0]!;
    const door: DoorPlanElement = {
      id: "side-door",
      kind: "door",
      wallId: floor.walls[0]!.id,
      position: { x: 120, y: 45 },
      rotationDegrees: 0,
      label: "Side door",
      stateBinding: { provider: "tapo", externalId: "t110-side" },
    };
    const house = {
      ...baseHouse,
      floors: baseHouse.floors.map((candidate, index) => (
        index === 0 ? { ...candidate, planElements: [...(candidate.planElements ?? []), door] } : candidate
      )),
    };
    const now = Date.now();
    vi.spyOn(api, "openingActivity").mockResolvedValue({
      apiVersion: "1.0",
      requestId: "opening-empty",
      houseId: house.id,
      dataMode: "demo",
      range: {
        start: new Date(now - 24 * 3_600_000).toISOString(),
        end: new Date(now).toISOString(),
      },
      generatedAt: new Date(now).toISOString(),
      complete: true,
      truncated: false,
      archiveState: "not-configured",
      warnings: [],
      provenance: {
        algorithmKey: "opening-activity",
        algorithmVersion: "opening-activity-v2.0.0",
        evaluatedAt: new Date(now).toISOString(),
        sourceIds: [],
        archiveState: "not-configured",
      },
      series: [{
        target: {
          key: `${floor.id}:${door.id}`,
          floorId: floor.id,
          floorName: floor.name,
          elementId: door.id,
          kind: "door",
          label: "Side door",
          ordinal: 1,
        },
        segments: [],
        records: [],
        observationCount: 0,
        openedCount: 0,
        closedCount: 0,
        confirmedOpenMs: 0,
        longestOpenMs: 0,
        currentState: "unknown",
        currentSince: null,
        lastObservedAt: null,
      }],
    } satisfies OpeningActivityResponse);

    render(<I18nProvider><OpeningAnalyticsPanel
      house={house}
      dataMode="demo"
      range="24h"
      refreshRevision={0}
      onRange={vi.fn()}
    /></I18nProvider>);

    expect(await screen.findByText("Waiting for the first contact update")).not.toBeNull();
    expect(screen.getByText(/after its sensor reports an open or closed state/)).not.toBeNull();
  });

  it("keeps the same request while a minute tick crosses a pending request and its failure", async () => {
    const state = createDemoState();
    const baseHouse = state.houses[0]!;
    const floor = baseHouse.floors[0]!;
    const door: DoorPlanElement = {
      id: "slow-door",
      kind: "door",
      wallId: floor.walls[0]!.id,
      position: { x: 130, y: 45 },
      rotationDegrees: 0,
      label: "Slow door",
      stateBinding: { provider: "tapo", externalId: "t110-slow" },
    };
    const house = {
      ...baseHouse,
      floors: baseHouse.floors.map((candidate, index) => (
        index === 0 ? { ...candidate, planElements: [...(candidate.planElements ?? []), door] } : candidate
      )),
    };
    let rejectRequest!: (error: Error) => void;
    const pending = new Promise<OpeningActivityResponse>((_resolve, reject) => { rejectRequest = reject; });
    const openingActivity = vi.spyOn(api, "openingActivity").mockReturnValue(pending);
    const panel = () => <I18nProvider><OpeningAnalyticsPanel
      house={house}
      dataMode="real"
      range="24h"
      refreshRevision={41}
      onRange={vi.fn()}
    /></I18nProvider>;
    const view = render(panel());

    await waitFor(() => expect(openingActivity).toHaveBeenCalledOnce());
    clock.now += 60_000;
    view.rerender(panel());
    expect(openingActivity).toHaveBeenCalledOnce();

    await act(async () => rejectRequest(new Error("The API request timed out")));
    await waitFor(() => expect(screen.getByText("The API request timed out")).not.toBeNull());
    clock.now += 60_000;
    view.rerender(panel());
    expect(openingActivity).toHaveBeenCalledOnce();
  });

  it("advances the request window on the next minute only after success", async () => {
    const state = createDemoState();
    const baseHouse = state.houses[0]!;
    const floor = baseHouse.floors[0]!;
    const door: DoorPlanElement = {
      id: "fresh-door",
      kind: "door",
      wallId: floor.walls[0]!.id,
      position: { x: 140, y: 45 },
      rotationDegrees: 0,
      label: "Fresh door",
      stateBinding: { provider: "tapo", externalId: "t110-fresh" },
    };
    const house = {
      ...baseHouse,
      floors: baseHouse.floors.map((candidate, index) => (
        index === 0 ? { ...candidate, planElements: [...(candidate.planElements ?? []), door] } : candidate
      )),
    };
    const openingActivity = vi.spyOn(api, "openingActivity").mockImplementation(async (request) => ({
      apiVersion: "1.0",
      requestId: request.requestId,
      houseId: house.id,
      dataMode: "live",
      range: request.range,
      generatedAt: request.range.end,
      complete: true,
      truncated: false,
      archiveState: "not-configured",
      warnings: [],
      provenance: {
        algorithmKey: "opening-activity",
        algorithmVersion: "opening-activity-v2.0.0",
        evaluatedAt: request.range.end,
        sourceIds: [],
        archiveState: "not-configured",
      },
      series: [],
    }));
    const panel = () => <I18nProvider><OpeningAnalyticsPanel
      house={house}
      dataMode="real"
      range="24h"
      refreshRevision={42}
      onRange={vi.fn()}
    /></I18nProvider>;
    const view = render(panel());

    await waitFor(() => expect(openingActivity).toHaveBeenCalledOnce());
    clock.now += 60_000;
    view.rerender(panel());
    await waitFor(() => expect(openingActivity).toHaveBeenCalledTimes(2));
    expect(openingActivity.mock.calls[1]?.[0].range.end).toBe(new Date(clock.now).toISOString());
  });
});
