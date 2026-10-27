import type {
  ElectricityInvoice,
  ElectricityInvoiceInput,
  ElectricityTariffVersion,
  PropertyElectricityTariff,
} from "@climate-twin/contracts";
import "../core.js";

declare module "../core.js" {
  interface DatabaseInternals {
    /** The saved tariff, or the one implied by the pre-0.43 contract fields (revision 0). */
    getPropertyElectricityTariff(propertyId: string): PropertyElectricityTariff | null;
    savePropertyElectricityTariff(
      propertyId: string,
      versions: ElectricityTariffVersion[],
      expectedRevision?: number,
    ): PropertyElectricityTariff | null;
    /** Time zone for a Property's local tariff dates: its default (or first) Home's. */
    propertyElectricityTimeZone(propertyId: string): string;
    listElectricityInvoices(propertyId: string): ElectricityInvoice[];
    getElectricityInvoice(propertyId: string, invoiceId: string): ElectricityInvoice | null;
    createElectricityInvoice(propertyId: string, input: ElectricityInvoiceInput): ElectricityInvoice | null;
    deleteElectricityInvoice(propertyId: string, invoiceId: string): boolean;
  }

  interface ClimateDatabaseCore {
    /** The saved tariff, or the one implied by the pre-0.43 contract fields (revision 0). */
    getPropertyElectricityTariff(propertyId: string): PropertyElectricityTariff | null;
    savePropertyElectricityTariff(
      propertyId: string,
      versions: ElectricityTariffVersion[],
      expectedRevision?: number,
    ): PropertyElectricityTariff | null;
    /** Time zone for a Property's local tariff dates: its default (or first) Home's. */
    propertyElectricityTimeZone(propertyId: string): string;
    listElectricityInvoices(propertyId: string): ElectricityInvoice[];
    getElectricityInvoice(propertyId: string, invoiceId: string): ElectricityInvoice | null;
    createElectricityInvoice(propertyId: string, input: ElectricityInvoiceInput): ElectricityInvoice | null;
    deleteElectricityInvoice(propertyId: string, invoiceId: string): boolean;
  }
}
