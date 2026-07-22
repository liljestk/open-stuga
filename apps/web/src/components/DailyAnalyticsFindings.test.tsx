import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { DailyAnalyticsFindingsResponse } from "@climate-twin/contracts";
import { api } from "../api";
import { createDemoState } from "../domain";
import { I18nProvider } from "../i18n";
import { DailyAnalyticsFindings } from "./DailyAnalyticsFindings";

afterEach(() => vi.restoreAllMocks());

describe("DailyAnalyticsFindings", () => {
  it("explains an opening comparison and exposes its peer-period evidence", async () => {
    const state = createDemoState();
    const house = { ...state.houses[0]!, timezone: "UTC" };
    const response: DailyAnalyticsFindingsResponse = {
      status: { state: "ready", lastAttemptAt: "2026-07-22T01:00:00.000Z", lastError: null },
      snapshot: {
        apiVersion: "1.0", houseId: house.id, dataMode: "demo", periodKind: "month-to-date",
        evaluatedThrough: "2026-07-21", algorithmVersion: "calendar-peer-findings-v1.0.0",
        generatedAt: "2026-07-22T01:00:00.000Z", warnings: [],
        findings: [{
          id: "front-door-finding", category: "opening", subjectId: "floor:front-door", subjectLabel: "Front door",
          metric: "opening_events", unit: "opens", statistic: "open-count", direction: "higher", strength: "strong",
          current: { key: "2026-07", year: 2026, start: "2026-07-01T00:00:00.000Z", end: "2026-07-22T00:00:00.000Z", value: 13, sampleCount: 40, coverage: null },
          baseline: [{ key: "2025-07", year: 2025, start: "2025-07-01T00:00:00.000Z", end: "2025-07-22T00:00:00.000Z", value: 3, sampleCount: 10, coverage: null }],
          baselineMedian: 3, absoluteDifference: 10, percentDifference: 333.333,
        }],
      },
    };
    const opening = response.snapshot!.findings[0]!;
    response.snapshot!.findings.push(...["Kitchen window", "Patio door", "Office window", "Side door"].map((subjectLabel, index) => ({
      ...opening,
      id: `extra-opening-${index}`,
      subjectId: `extra-opening-${index}`,
      subjectLabel,
      strength: "notable" as const,
    })));
    vi.spyOn(api, "analyticsFindings").mockResolvedValue(response);
    const user = userEvent.setup();

    render(<I18nProvider><DailyAnalyticsFindings
      house={house}
      definitions={state.measurementDefinitions}
      units="metric"
    /></I18nProvider>);

    expect(await screen.findByText(/Front door opened 10 more times this July/)).not.toBeNull();
    const frontDoorHeading = screen.getByRole("heading", { level: 3, name: "Front door" });
    expect(frontDoorHeading).not.toBeNull();
    expect(screen.getByText("Strong")).not.toBeNull();
    expect(within(screen.getByRole("region", { name: "Notable changes" })).queryByRole("button", { name: "Refresh" })).toBeNull();
    await user.click(within(frontDoorHeading.closest("article")!).getByText("Show evidence (2 periods)"));
    expect(screen.getByRole("table", { name: "Calendar-period evidence for Front door" })).not.toBeNull();
    const evidenceRegion = screen.getByRole("region", { name: "Calendar-period evidence for Front door" });
    expect(evidenceRegion.getAttribute("tabindex")).toBe("0");
    expect(within(evidenceRegion).getByText("Current (2026)")).not.toBeNull();
    expect(within(evidenceRegion).getByText("2025")).not.toBeNull();
    const moreFindings = screen.getByText("Show 1 more findings").closest("details")!;
    expect(moreFindings.hasAttribute("open")).toBe(false);
    await user.click(screen.getByText("Show 1 more findings"));
    expect(moreFindings.hasAttribute("open")).toBe(true);
    expect(screen.getByRole("heading", { level: 3, name: "Side door" })).not.toBeNull();
    await waitFor(() => expect(api.analyticsFindings).toHaveBeenCalledWith(house.id, expect.any(AbortSignal)));
  });

  it("shows a non-alarming first-run state", async () => {
    const state = createDemoState();
    vi.spyOn(api, "analyticsFindings").mockResolvedValue({
      snapshot: null,
      status: { state: "pending", lastAttemptAt: null, lastError: null },
    });

    render(<I18nProvider><DailyAnalyticsFindings
      house={state.houses[0]!}
      definitions={state.measurementDefinitions}
      units="metric"
    /></I18nProvider>);

    const pendingText = await screen.findByText("The first daily comparison is being prepared");
    expect(pendingText.closest('[role="status"]')).not.toBeNull();
  });

  it("renders a property-local date without shifting it across the date line", async () => {
    const state = createDemoState();
    const house = { ...state.houses[0]!, timezone: "Pacific/Kiritimati" };
    vi.spyOn(api, "analyticsFindings").mockResolvedValue({
      status: { state: "ready", lastAttemptAt: "2026-07-22T01:00:00.000Z", lastError: null },
      snapshot: {
        apiVersion: "1.0", houseId: house.id, dataMode: "demo", periodKind: "month-to-date",
        evaluatedThrough: "2026-07-21", algorithmVersion: "calendar-peer-findings-v1.0.0",
        generatedAt: "2026-07-22T01:00:00.000Z", warnings: [], findings: [],
      },
    });

    render(<I18nProvider><DailyAnalyticsFindings
      house={house}
      definitions={state.measurementDefinitions}
      units="metric"
    /></I18nProvider>);

    expect(await screen.findByText("Compared through July 21, 2026")).not.toBeNull();
    expect(screen.queryByText("Compared through July 22, 2026")).toBeNull();
  });
});
