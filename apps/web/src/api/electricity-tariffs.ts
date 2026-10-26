import type {
  ElectricityInvoice,
  ElectricityInvoiceInput,
  ElectricityInvoiceReconciliation,
  ElectricityTariffVersion,
  PropertyElectricityTariff,
} from "@climate-twin/contracts";
import {
  ResponseShapeError,
  expectShape,
  isElectricityInvoice,
  isElectricityInvoiceReconciliation,
  isPropertyElectricityTariff,
} from "@climate-twin/contracts";
import { request } from "./support/index";

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

export const electricityTariffApi = {
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
