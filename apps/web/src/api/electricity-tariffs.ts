import type {
  ElectricityInvoice,
  ElectricityInvoiceInput,
  ElectricityInvoiceReconciliation,
  ElectricityTariffVersion,
  PropertyElectricityTariff,
} from "@climate-twin/contracts";
import { request } from "./support/index";

export interface PropertyElectricityTariffResponse {
  tariff: PropertyElectricityTariff;
  timeZone: string;
}

const electricityPath = (propertyId: string) => `/properties/${encodeURIComponent(propertyId)}/electricity`;

export const electricityTariffApi = {
  propertyElectricityTariff: (propertyId: string, signal?: AbortSignal) => request<PropertyElectricityTariffResponse>(
    `${electricityPath(propertyId)}/tariff`,
    signal ? { signal } : undefined,
  ),
  savePropertyElectricityTariff: (propertyId: string, versions: ElectricityTariffVersion[], revision: number) => (
    request<PropertyElectricityTariffResponse>(`${electricityPath(propertyId)}/tariff`, {
      method: "PUT",
      body: JSON.stringify({ versions, revision }),
    })
  ),
  electricityInvoices: async (propertyId: string, signal?: AbortSignal): Promise<ElectricityInvoice[]> => (
    await request<{ invoices: ElectricityInvoice[] }>(`${electricityPath(propertyId)}/invoices`, signal ? { signal } : undefined)
  ).invoices,
  createElectricityInvoice: async (propertyId: string, input: ElectricityInvoiceInput): Promise<ElectricityInvoice> => (
    await request<{ invoice: ElectricityInvoice }>(`${electricityPath(propertyId)}/invoices`, {
      method: "POST",
      body: JSON.stringify(input),
    })
  ).invoice,
  deleteElectricityInvoice: (propertyId: string, invoiceId: string) => request<{ deleted: true; invoiceId: string }>(
    `${electricityPath(propertyId)}/invoices/${encodeURIComponent(invoiceId)}`,
    { method: "DELETE" },
  ),
  reconcileElectricityInvoice: async (
    propertyId: string,
    invoiceId: string,
    signal?: AbortSignal,
  ): Promise<ElectricityInvoiceReconciliation> => (
    await request<{ reconciliation: ElectricityInvoiceReconciliation }>(
      `${electricityPath(propertyId)}/invoices/${encodeURIComponent(invoiceId)}/reconciliation`,
      signal ? { signal } : undefined,
    )
  ).reconciliation,
};
