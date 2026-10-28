import { type HomeEnergyProjection, type PropertyElectricityConfigInput, expectShape, isHomeEnergyProjection, withSignal, type ElectricityInvoice, type ElectricityInvoiceInput, type ElectricityInvoiceReconciliation, type ElectricityTariffVersion, type PropertyElectricityTariff, ResponseShapeError, isElectricityInvoice, isElectricityInvoiceReconciliation, isPropertyElectricityTariff } from "@climate-twin/contracts";
import { request } from "./support/request";
import type { TimeRangeQuery } from "./support/response-types";
import { energyOptimizationReportShape, homeElectricityPricePointShape, homeEnergyCostShape, homeEnergySummaryShape, propertyElectricityConfigShape, propertyElectricityPricePointShape } from "./support/entity-shapes";
import { anyBody, string, literal, nullable, optional, arrayOf, fields } from "./support/response-shapes";

export interface PropertyElectricityTariffResponse {
  tariff: PropertyElectricityTariff;
  timeZone: string;
}

const electricityPath = (propertyId: string) => `/properties/${encodeURIComponent(propertyId)}/electricity`;

/** Every tariff response is checked against its documented shape before callers see it. */
function tariffResponse(body: unknown, endpoint: string): PropertyElectricityTariffResponse {
  const record = typeof body === "object" && body !== null ? body as Record<string, unknown> : {};
  if (typeof record.timeZone !== "string") throw new ResponseShapeError(endpoint);
  return { tariff: expectShape(record.tariff, isPropertyElectricityTariff, endpoint), timeZone: record.timeZone };
}

/** Property electricity contracts, tariffs and invoices, Home prices, costs, summaries, projections and the energy optimizer. */
export const electricityApi = {
  propertyElectricity: (propertyId: string, signal?: AbortSignal) => request(`/properties/${encodeURIComponent(propertyId)}/electricity`, fields({ config: propertyElectricityConfigShape, current: nullable(propertyElectricityPricePointShape), prices: arrayOf(propertyElectricityPricePointShape) }), withSignal(signal)),
  houseElectricityPrice: (houseId: string, { from, to, signal }: Partial<Omit<TimeRangeQuery, "limit">> = {}) => request(`/houses/${encodeURIComponent(houseId)}/electricity-price${from || to ? `?${new URLSearchParams({ ...(from ? { from } : {}), ...(to ? { to } : {}) })}` : ""}`, fields({ current: nullable(homeElectricityPricePointShape), prices: optional(arrayOf(homeElectricityPricePointShape)) }), withSignal(signal)),
  houseEnergyCost: async (houseId: string, { sensorId, from, to, signal }: Omit<TimeRangeQuery, "limit"> & { sensorId: string }) => (await request(`/houses/${encodeURIComponent(houseId)}/energy-cost?${new URLSearchParams({ sensorId, from, to })}`, fields({ cost: homeEnergyCostShape }), withSignal(signal))).cost,
  houseEnergySummary: async (houseId: string, { from, to, signal }: Omit<TimeRangeQuery, "limit">) => (await request(`/houses/${encodeURIComponent(houseId)}/energy-summary?${new URLSearchParams({ from, to })}`, fields({ summary: homeEnergySummaryShape }), withSignal(signal))).summary,
  houseEnergyProjection: async (houseId: string, signal?: AbortSignal): Promise<HomeEnergyProjection | null> => {
      const endpoint = "/houses/{id}/energy-projection";
      const body = await request(`/houses/${encodeURIComponent(houseId)}/energy-projection`, fields({ projection: optional(anyBody) }), withSignal(signal));
      return body.projection === null ? null : expectShape(body.projection, isHomeEnergyProjection, endpoint);
    },
  configurePropertyElectricity: (propertyId: string, configuration: PropertyElectricityConfigInput) => request(
      `/properties/${encodeURIComponent(propertyId)}/electricity/config`, fields({ config: propertyElectricityConfigShape }),
      { method: "PUT", body: JSON.stringify(configuration) },
    ),
  refreshPropertyElectricity: (propertyId: string) => request(`/properties/${encodeURIComponent(propertyId)}/electricity/refresh`, fields({ config: propertyElectricityConfigShape, current: nullable(propertyElectricityPricePointShape), prices: arrayOf(propertyElectricityPricePointShape) }), { method: "POST" }),
  energyOptimization: async (propertyId: string, windowHours = 2, signal?: AbortSignal) => (await request(`/properties/${encodeURIComponent(propertyId)}/energy-optimization?windowHours=${encodeURIComponent(windowHours)}`, fields({ report: energyOptimizationReportShape }), withSignal(signal))).report,
  propertyElectricityTariff: async (propertyId: string, signal?: AbortSignal) => tariffResponse(
    await request(`${electricityPath(propertyId)}/tariff`, anyBody, signal ? { signal } : undefined),
    "/properties/{id}/electricity/tariff",
  ),
  savePropertyElectricityTariff: async (propertyId: string, versions: ElectricityTariffVersion[], revision: number) => tariffResponse(
    await request(`${electricityPath(propertyId)}/tariff`, anyBody, {
      method: "PUT",
      body: JSON.stringify({ versions, revision }),
    }),
    "/properties/{id}/electricity/tariff",
  ),
  electricityInvoices: async (propertyId: string, signal?: AbortSignal): Promise<ElectricityInvoice[]> => {
    const endpoint = "/properties/{id}/electricity/invoices";
    const body = await request(`${electricityPath(propertyId)}/invoices`, fields({ invoices: optional(anyBody) }), signal ? { signal } : undefined);
    if (!Array.isArray(body.invoices)) throw new ResponseShapeError(endpoint);
    return body.invoices.map((invoice) => expectShape(invoice, isElectricityInvoice, endpoint));
  },
  createElectricityInvoice: async (propertyId: string, input: ElectricityInvoiceInput): Promise<ElectricityInvoice> => expectShape(
    (await request(`${electricityPath(propertyId)}/invoices`, fields({ invoice: optional(anyBody) }), {
      method: "POST",
      body: JSON.stringify(input),
    })).invoice,
    isElectricityInvoice,
    "/properties/{id}/electricity/invoices",
  ),
  deleteElectricityInvoice: (propertyId: string, invoiceId: string) => request(
    `${electricityPath(propertyId)}/invoices/${encodeURIComponent(invoiceId)}`, fields({ deleted: literal(true), invoiceId: string }),
    { method: "DELETE" },
  ),
  reconcileElectricityInvoice: async (
    propertyId: string,
    invoiceId: string,
    signal?: AbortSignal,
  ): Promise<ElectricityInvoiceReconciliation> => expectShape(
    (await request(
      `${electricityPath(propertyId)}/invoices/${encodeURIComponent(invoiceId)}/reconciliation`, fields({ reconciliation: optional(anyBody) }),
      signal ? { signal } : undefined,
    )).reconciliation,
    isElectricityInvoiceReconciliation,
    "/properties/{id}/electricity/invoices/{invoiceId}/reconciliation",
  ),
};
