import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { AnalyticsDiagnostics } from "@climate-twin/contracts";
import { api } from "../../api";
import { queryClient } from "../../data/queryClient";
import { createDemoState } from "../../domain";
import { I18nProvider } from "../../i18n";
import { AnalyticsHealthPanel } from "./AnalyticsHealthPanel";

afterEach(() => {
  vi.restoreAllMocks();
  queryClient.clear();
});

describe("AnalyticsHealthPanel", () => {
  it("reads the appliance evidence only when opened and shows each target", async () => {
    const state = createDemoState();
    const house = state.houses[0]!;
    const diagnostics: AnalyticsDiagnostics = {
      houseId: house.id, generatedAt: "2026-10-26T12:00:00.000Z", windowDays: 30,
      latency: [
        { operation: "query-24h", requests: 120, p50Ms: 50, p95Ms: 250, targetP95Ms: 400, meetsTarget: true },
        { operation: "query-365d", requests: 0, p50Ms: null, p95Ms: null, targetP95Ms: 3_000, meetsTarget: null },
      ],
      forecasts: [{ metric: "temperature", sensors: 3, evaluations: 84, withheld: 2, medianSkill6h: 0.42, medianSkill24h: 0.18, medianCoverage90: 0.9, meetsTarget: true }],
      bills: { invoices: 2, reconciled: 2, outsideTolerance: 0, incomplete: 0, medianAbsoluteErrorPercent: 1.2, tolerancePercent: 2, meetsTarget: false },
      projection: { method: "weather-regression", origins: 20, meanAbsolutePercentError: 3.4, baselineMeanAbsolutePercentError: 7.9, skill: 0.57, meetsTarget: true },
      findings: { evaluatedThrough: "2026-10-25", seriesTested: 24, findings: 3, falseDiscoveryRate: 0.1 },
    };
    const read = vi.spyOn(api, "analyticsDiagnostics").mockResolvedValue(diagnostics);
    const user = userEvent.setup();

    render(<I18nProvider><AnalyticsHealthPanel house={house} definitions={state.measurementDefinitions} /></I18nProvider>);
    expect(read).not.toHaveBeenCalled();
    await user.click(screen.getByText("Analytics health on this appliance"));

    expect(await screen.findByText("120 requests, 95% answered within 250 ms (target 400 ms)")).toBeInTheDocument();
    expect(screen.getByText("No requests yet")).toBeInTheDocument();
    expect(screen.getByText(/Skill 0.42 at 6 hours and 0.18 at 24 hours; the 90% range held the outcome 90% of the time \(84 daily checks\)/)).toBeInTheDocument();
    expect(screen.getByText(/2 of 2 invoices within ±2% \(median difference 1.2%\)/)).toBeInTheDocument();
    expect(screen.getByText(/Missed by 3.4% on average over 20 past periods, against 7.9%/)).toBeInTheDocument();
    expect(screen.getByText(/3 findings from 24 series compared through 2026-10-25/)).toBeInTheDocument();
    // Two invoices are not yet the three the cost model needs.
    expect(screen.getAllByText("Off target")).toHaveLength(1);
    expect(screen.getAllByText("Collecting")).toHaveLength(1);
    expect(read).toHaveBeenCalledWith(house.id, expect.any(AbortSignal));
  });
});
