import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { createDemoState } from "../../domain";
import { I18nProvider } from "../../i18n";
import { monitoringDetail, monitoringSummary } from "../../monitoringTestSupport";
import { HomePulsePanel } from "./HomePulsePanel";

describe("learned changes in Home Pulse", () => {
  it.each(["steady", "critical", "incomplete"] as const)("shows a review action without claiming calm or lowering %s priority", status => {
    const state = createDemoState();
    const house = state.houses[0]!;
    const sensors = state.sensors.filter(s => s.houseId === house.id).slice(0, 1);
    const view = render(<I18nProvider><HomePulsePanel house={house} sensors={sensors} latestMeasurements={{}}
      measurementHistory={{}} alerts={[]} alertRules={[]} weather={null} referenceTime={Date.now()} onOpenTarget={vi.fn()}
      learnedChangeCount={1} learningIncomplete={status === "incomplete"} monitoring={monitoringDetail(monitoringSummary({ houseId: house.id, pulseStatus: status === "incomplete" ? "steady" : status,
        status: "monitoring-ok", coverage: { enabledSensors: 1, freshSensors: 1 } }), [])} /></I18nProvider>);
    expect(screen.queryByText("No action is being suggested right now.")).not.toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Review learned changes (1)" })).toHaveAttribute("href",
      `/properties/${house.propertyId}/homes/${house.id}/analytics?learning=1`);
    expect(view.container.querySelector(`.home-pulse.${status === "steady" ? "watch" : status === "incomplete" ? "unknown" : "critical"}`)).not.toBeNull();
  });
});
