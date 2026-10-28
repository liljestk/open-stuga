import { type HomeElectricityPricePoint, type HomeEnergyCost, type HomeEnergyProjection, type HomeEnergySummary, type PropertyElectricityConfig, type PropertyElectricityConfigInput, type PropertyElectricityPricePoint, expectShape, isHomeEnergyProjection, withSignal, type EnergyOptimizationReport, type ElectricityInvoice, type ElectricityInvoiceInput, type ElectricityInvoiceReconciliation, type ElectricityTariffVersion, type PropertyElectricityTariff, ResponseShapeError, isElectricityInvoice, isElectricityInvoiceReconciliation, isPropertyElectricityTariff } from "@climate-twin/contracts";
import { request } from "./support/request";

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
  propertyElectricity: (propertyId: string, signal?: AbortSignal) => request<{
      config: PropertyElectricityConfig;
      current: PropertyElectricityPricePoint | null;
      prices: PropertyElectricityPricePoint[];
    }>(`/properties/${encodeURIComponent(propertyId)}/electricity`, withSignal(signal)),
  houseElectricityPrice: (houseId: string, from?: string, to?: string, signal?: AbortSignal) => request<{
      current: HomeElectricityPricePoint | null;
      prices?: HomeElectricityPricePoint[];
    }>(`/houses/${encodeURIComponent(houseId)}/electricity-price${from || to ? `?${new URLSearchParams({ ...(from ? { from } : {}), ...(to ? { to } : {}) })}` : ""}`, withSignal(signal)),
  houseEnergyCost: async (houseId: string, sensorId: string, from: string, to: string, signal?: AbortSignal) => (await request<{ cost: HomeEnergyCost }>(`/houses/${encodeURIComponent(houseId)}/energy-cost?${new URLSearchParams({ sensorId, from, to })}`, withSignal(signal))).cost,
  houseEnergySummary: async (houseId: string, from: string, to: string, signal?: AbortSignal) => (await request<{ summary: HomeEnergySummary }>(`/houses/${encodeURIComponent(houseId)}/energy-summary?${new URLSearchParams({ from, to })}`, withSignal(signal))).summary,
  houseEnergyProjection: async (houseId: string, signal?: AbortSignal): Promise<HomeEnergyProjection | null> => {
      const endpoint = "/houses/{id}/energy-projection";
      const body = await request<{ projection?: unknown }>(`/houses/${encodeURIComponent(houseId)}/energy-projection`, withSignal(signal));
      return body.projection === null ? null : expectShape(body.projection, isHomeEnergyProjection, endpoint);
    },
  configurePropertyElectricity: (propertyId: string, configuration: PropertyElectricityConfigInput) => request<{ config: PropertyElectricityConfig }>(
      `/properties/${encodeURIComponent(propertyId)}/electricity/config`,
      { method: "PUT", body: JSON.stringify(configuration) },
    ),
  refreshPropertyElectricity: (propertyId: string) => request<{
      config: PropertyElectricityConfig;
      current: PropertyElectricityPricePoint | null;
      prices: PropertyElectricityPricePoint[];
    }>(`/properties/${encodeURIComponent(propertyId)}/electricity/refresh`, { method: "POST" }),
  energyOptimization: async (propertyId: string, windowHours = 2, signal?: AbortSignal) => (await request<{ report: EnergyOptimizationReport }>(`/properties/${encodeURIComponent(propertyId)}/energy-optimization?windowHours=${encodeURIComponent(windowHours)}`, withSignal(signal))).report,
  propertyElectricityTariff: async (propertyId: string, signal?: AbortSignal) => tariffResponse(
    await request<unknown>(`${electricityPath(propertyId)}/tariff`, signal ? { signal } : undefined),
    "/properties/{id}/electricity/tariff",
  ),
  savePropertyElectricityTariff: async (propertyId: string, versions: ElectricityTariffVersion[], revision: number) => tariffResponse(
    await request<unknown>(`${electricityPath(propertyId)}/tariff`, {
      method: "PUT",
      body: JSON.stringify({ versions, revision }),
    }),
    "/properties/{id}/electricity/tariff",
  ),
  electricityInvoices: async (propertyId: string, signal?: AbortSignal): Promise<ElectricityInvoice[]> => {
    const endpoint = "/properties/{id}/electricity/invoices";
    const body = await request<{ invoices?: unknown }>(`${electricityPath(propertyId)}/invoices`, signal ? { signal } : undefined);
    if (!Array.isArray(body.invoices)) throw new ResponseShapeError(endpoint);
    return body.invoices.map((invoice) => expectShape(invoice, isElectricityInvoice, endpoint));
  },
  createElectricityInvoice: async (propertyId: string, input: ElectricityInvoiceInput): Promise<ElectricityInvoice> => expectShape(
    (await request<{ invoice?: unknown }>(`${electricityPath(propertyId)}/invoices`, {
      method: "POST",
      body: JSON.stringify(input),
    })).invoice,
    isElectricityInvoice,
    "/properties/{id}/electricity/invoices",
  ),
  deleteElectricityInvoice: (propertyId: string, invoiceId: string) => request<{ deleted: true; invoiceId: string }>(
    `${electricityPath(propertyId)}/invoices/${encodeURIComponent(invoiceId)}`,
    { method: "DELETE" },
  ),
  reconcileElectricityInvoice: async (
    propertyId: string,
    invoiceId: string,
    signal?: AbortSignal,
  ): Promise<ElectricityInvoiceReconciliation> => expectShape(
    (await request<{ reconciliation?: unknown }>(
      `${electricityPath(propertyId)}/invoices/${encodeURIComponent(invoiceId)}/reconciliation`,
      signal ? { signal } : undefined,
    )).reconciliation,
    isElectricityInvoiceReconciliation,
    "/properties/{id}/electricity/invoices/{invoiceId}/reconciliation",
  ),
};
