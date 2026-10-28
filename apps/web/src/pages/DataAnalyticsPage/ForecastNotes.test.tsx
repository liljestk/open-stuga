import { describe, expect, it } from "vitest";
import { render, screen } from "@testing-library/react";
import type { MeasurementForecastEvaluation, Sensor } from "@climate-twin/contracts";
import { I18nProvider } from "../../i18n";
import { ForecastNotes } from "./ForecastNotes";

function evaluation(sensorId: string, overrides: Partial<MeasurementForecastEvaluation>): MeasurementForecastEvaluation {
  return {
    algorithmVersion: "measurement-forecast/v2", sensorId, metric: "temperature", status: "ready", model: "thermal-relaxation",
    computedAt: "2026-10-25T12:00:00.000Z", historyFrom: null, historyTo: null, origins: 80, outdoorDriver: "weather-forecast",
    horizons: [], skill6h: 0.42, skill24h: 0.3, coverage90: 0.89, ...overrides,
  };
}

describe("ForecastNotes", () => {
  it("explains shown, withheld and pending forecasts per sensor", () => {
    const sensors = [
      { id: "living", name: "Living room" },
      { id: "sauna", name: "Sauna" },
      { id: "new", name: "New sensor" },
      { id: "quiet", name: "Quiet sensor" },
    ] as Sensor[];
    render(<I18nProvider><ForecastNotes sensors={sensors} evaluations={{
      living: evaluation("living", {}),
      sauna: evaluation("sauna", { status: "no-skill", skill6h: -0.1 }),
      new: evaluation("new", { status: "insufficient-history", model: null, skill6h: null }),
    }} /></I18nProvider>);
    const list = screen.getByRole("list", { name: "Forecast quality" });
    expect(list.textContent).toContain("Living room: the forecast beat \"no change\" by 42% at 6 hours");
    expect(list.textContent).toContain("held 89% of the time");
    expect(list.textContent).toContain("Sauna: no forecast shown");
    expect(list.textContent).toContain("New sensor: no forecast yet");
    expect(list.textContent).not.toContain("Quiet sensor");
  });

  it("renders nothing without evaluations", () => {
    const { container } = render(<I18nProvider><ForecastNotes sensors={[]} evaluations={{}} /></I18nProvider>);
    expect(container.textContent).toBe("");
  });
});
