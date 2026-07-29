import axe from "axe-core";
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type {
  DoorPlanElement,
  OpeningActivityResponse,
  OpeningStateObservation,
} from "@climate-twin/contracts";
import { api } from "../api";
import { createDemoState } from "../domain";
import { I18nProvider } from "../i18n";
import { OpeningAnalyticsPanel } from "./OpeningAnalyticsPanel";

afterEach(() => vi.restoreAllMocks());

describe("OpeningAnalyticsPanel", () => {
  beforeEach(() => localStorage.setItem("climate-twin-locale", "en"));

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
    vi.spyOn(api, "openingActivity").mockResolvedValue({
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
    const { container } = render(<I18nProvider><OpeningAnalyticsPanel
      house={house}
      dataMode="demo"
      range="24h"
      refreshRevision={0}
      onRange={onRange}
    /></I18nProvider>);

    expect(await screen.findByRole("heading", { name: "Door & window activity" })).not.toBeNull();
    await waitFor(() => expect(screen.getByText("Front door is open now.")).not.toBeNull());
    expect(screen.getByText("1 / 1")).not.toBeNull();
    expect(screen.getByText("Front door was opened once in this period.")).not.toBeNull();
    expect(container.querySelector(".opening-timeline-segment.open")).not.toBeNull();
    expect(screen.getByText("Open", { selector: ".opening-current-state" })).not.toBeNull();

    await user.click(screen.getByText("Show state history (2 records)"));
    const table = screen.getByRole("region", { name: "Door and window state history" });
    expect(within(table).getAllByText("Front door")).toHaveLength(2);
    expect(within(table).getAllByText("Tapo")).toHaveLength(2);
    expect(screen.getByRole("link", { name: "Download activity as CSV" }).getAttribute("download"))
      .toBe("stugu-opening-activity-24h.csv");

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
});
