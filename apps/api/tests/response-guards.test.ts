import { describe, expect, it } from "vitest";
import {
  ResponseShapeError,
  expectShape,
  isAnalyticsDiagnostics,
  isElectricityInvoice,
  isElectricityInvoiceReconciliation,
  isHomeEnergyProjection,
  isMeasurementForecastEvaluation,
  isMeasurementForecastPoints,
  isPropertyElectricityTariff,
} from "@climate-twin/contracts";

describe("response guards", () => {
  it("accept the documented shapes and reject anything else", () => {
    const projection = {
      houseId: "home", method: "weather-regression", next30DaysKwh: 420, lowKwh: 390, highKwh: 455, dailyKwh: 14,
      estimatedCostEur: null, confidence: "high", backtest: { origins: 20 },
    };
    expect(isHomeEnergyProjection(projection)).toBe(true);
    expect(isHomeEnergyProjection({ ...projection, method: "linear" })).toBe(false);
    expect(isHomeEnergyProjection({ projection })).toBe(false);

    const diagnostics = {
      houseId: "home", windowDays: 30, latency: [{ operation: "query-24h", requests: 3 }],
      forecasts: [{ metric: "temperature" }], bills: { invoices: 0 }, projection: null, findings: null,
    };
    expect(isAnalyticsDiagnostics(diagnostics)).toBe(true);
    expect(isAnalyticsDiagnostics({ ...diagnostics, latency: [{ operation: "query-24h" }] })).toBe(false);

    expect(isMeasurementForecastEvaluation({ sensorId: "s", metric: "temperature", status: "ready", horizons: [], skill6h: 0.4, skill24h: null, coverage90: 0.9 })).toBe(true);
    expect(isMeasurementForecastEvaluation({ sensorId: "s", metric: "temperature", status: "maybe", horizons: [] })).toBe(false);
    expect(isMeasurementForecastPoints([{ timestamp: "2026-10-26T00:00:00Z", value: 21 }])).toBe(true);
    expect(isMeasurementForecastPoints([{ timestamp: "2026-10-26T00:00:00Z", value: "21" }])).toBe(false);

    expect(isPropertyElectricityTariff({ propertyId: "p", revision: 2, versions: [] })).toBe(true);
    expect(isPropertyElectricityTariff({ propertyId: "p", versions: [] })).toBe(false);
    expect(isElectricityInvoice({ id: "i", houseId: "h", periodStart: "2026-09-01", periodEnd: "2026-09-30", totalEur: 50 })).toBe(true);
    expect(isElectricityInvoice({ id: "i", houseId: "h", periodStart: "2026-09-01", periodEnd: "2026-09-30" })).toBe(false);
    expect(isElectricityInvoiceReconciliation({ invoiceId: "i", status: "reconciled", total: { invoicedEur: 50 } })).toBe(true);
    expect(isElectricityInvoiceReconciliation({ invoiceId: "i", status: "fine", total: { invoicedEur: 50 } })).toBe(false);
  });

  it("returns the typed value or throws a shape error naming the endpoint", () => {
    expect(expectShape([], isMeasurementForecastPoints, "/measurements/forecast")).toEqual([]);
    expect(() => expectShape({}, isMeasurementForecastPoints, "/measurements/forecast"))
      .toThrow(new ResponseShapeError("/measurements/forecast"));
  });
});
