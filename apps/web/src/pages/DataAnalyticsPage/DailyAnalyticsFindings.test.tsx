import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { DailyAnalyticsFindingsResponse } from "@climate-twin/contracts";
import { api } from "../../api";
import { createDemoState } from "../../domain";
import { I18nProvider } from "../../i18n";
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

  it("explains a weather-adjusted, coverage-scaled comparison and how clear it is", async () => {
    const state = createDemoState();
    const house = { ...state.houses[0]!, timezone: "UTC" };
    const period = (year: number, value: number, extra: object = {}) => ({
      key: `${year}-01`, year, start: `${year}-01-01T00:00:00.000Z`, end: `${year}-01-22T00:00:00.000Z`,
      value, sampleCount: 500, coverage: 0.9, ...extra,
    });
    const response: DailyAnalyticsFindingsResponse = {
      status: { state: "ready", lastAttemptAt: "2026-01-22T01:00:00.000Z", lastError: null },
      snapshot: {
        apiVersion: "1.0", houseId: house.id, dataMode: "demo", periodKind: "month-to-date",
        evaluatedThrough: "2026-01-21", algorithmVersion: "calendar-peer-findings-v4.0.0",
        generatedAt: "2026-01-22T01:00:00.000Z", warnings: [], seriesTested: 24, falseDiscoveryRate: 0.1,
        findings: [{
          id: "heater-finding", category: "electricity", subjectId: "heater", subjectLabel: "Heater meter",
          metric: "energy", unit: "kWh", statistic: "sum", direction: "higher", strength: "notable",
          current: period(2026, 400, { unscaledValue: 360 }),
          baseline: [period(2025, 250), period(2024, 260), period(2023, 240)],
          baselineMedian: 300, absoluteDifference: 100, percentDifference: 33.333,
          zScore: 4.2, qValue: 0.0031, spreadBasis: "between-years",
          weatherAdjustment: {
            driver: "heating-degree-hours", baseTemperatureC: 17, slope: 0.02,
            currentDriver: 420, baselineDriverMedian: 300, unadjustedBaselineMedian: 250,
          },
        }],
      },
    };
    vi.spyOn(api, "analyticsFindings").mockResolvedValue(response);
    const user = userEvent.setup();

    render(<I18nProvider><DailyAnalyticsFindings
      house={house}
      definitions={state.measurementDefinitions}
      units="metric"
    /></I18nProvider>);

    expect(await screen.findByText(/24 series compared/)).not.toBeNull();
    const article = screen.getByRole("heading", { level: 3, name: "Heater meter" }).closest("article")!;
    await user.click(within(article).getByText("Show evidence (4 periods)"));
    expect(within(article).getByText(/Baseline moved to this period's weather: 420 heating degree-hours a day below 17 °C, against 300/)).not.toBeNull();
    expect(within(article).getByText(/4\.2 times the usual variation \(between earlier years\); p adjusted for multiple comparisons = 0\.0031/)).not.toBeNull();
    expect(within(article).getByText(/scaled up from/)).not.toBeNull();
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

  it("keeps the shown state while its 15 s poll is in flight", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    try {
      const state = createDemoState();
      let resolveNext!: () => void;
      const request = vi.spyOn(api, "analyticsFindings")
        .mockResolvedValueOnce({ snapshot: null, status: { state: "pending", lastAttemptAt: null, lastError: null } })
        .mockImplementation(() => new Promise((resolve) => {
          resolveNext = () => resolve({ snapshot: null, status: { state: "pending", lastAttemptAt: null, lastError: null } });
        }));

      render(<I18nProvider><DailyAnalyticsFindings
        house={state.houses[0]!}
        definitions={state.measurementDefinitions}
        units="metric"
      /></I18nProvider>);

      expect(await screen.findByText("The first daily comparison is being prepared")).not.toBeNull();
      await vi.advanceTimersByTimeAsync(15_100);
      await waitFor(() => expect(request).toHaveBeenCalledTimes(2));
      expect(screen.getByText("The first daily comparison is being prepared")).not.toBeNull();
      resolveNext();
    } finally {
      vi.useRealTimers();
    }
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

  it("withholds a stale algorithm snapshot while the server recomputes it", async () => {
    const state = createDemoState();
    const house = { ...state.houses[0]!, timezone: "UTC" };
    vi.spyOn(api, "analyticsFindings").mockResolvedValue({
      status: {
        state: "stale-algorithm",
        lastAttemptAt: "2026-07-22T01:00:00.000Z",
        lastError: null,
        expectedAlgorithmVersion: "calendar-peer-findings-v3.0.0",
        actualAlgorithmVersion: "calendar-peer-findings-v1.0.0",
      },
      snapshot: {
        apiVersion: "1.0",
        houseId: house.id,
        dataMode: "demo",
        periodKind: "month-to-date",
        evaluatedThrough: "2026-07-21",
        algorithmVersion: "calendar-peer-findings-v1.0.0",
        generatedAt: "2026-07-22T01:00:00.000Z",
        warnings: [],
        findings: [],
      },
    });

    render(<I18nProvider><DailyAnalyticsFindings
      house={house}
      definitions={state.measurementDefinitions}
      units="metric"
    /></I18nProvider>);

    expect(await screen.findByText("Daily comparisons are being updated")).not.toBeNull();
    expect(screen.queryByText("Compared through July 21, 2026")).toBeNull();
  });
});
