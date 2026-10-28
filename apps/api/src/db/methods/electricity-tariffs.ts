import { randomUUID } from "node:crypto";
import {
  electricityTariffProblem,
  isLocalDateKey,
  legacyElectricityTariffVersion,
  normalizedElectricityTariffVersion,
  type ElectricityInvoice,
  type ElectricityInvoiceInput,
  type ElectricityTariffVersion,
  type PropertyElectricityTariff,
} from "@climate-twin/contracts";
import { registerDatabaseMethods } from "../core.js";
import { ClimateDataValidationError } from "../support/03-sensor-data-gap-row-to-canonical-json-value.js";

interface TariffRow {
  property_id: string;
  versions_json: string;
  revision: number;
  updated_at: string;
}

interface LegacyContractRow {
  margin_cents_per_kwh: number;
  contract_type: "spot" | "fixed" | "other";
  monthly_fee_eur: number | null;
  updated_at: string;
}

interface InvoiceRow {
  id: string;
  property_id: string;
  house_id: string;
  period_start: string;
  period_end: string;
  total_eur: number;
  consumption_kwh: number | null;
  energy_eur: number | null;
  network_eur: number | null;
  tax_eur: number | null;
  fees_eur: number | null;
  note: string | null;
  created_at: string;
}

const MAX_INVOICES_PER_PROPERTY = 500;
const MAX_INVOICE_DAYS = 366;
const MAX_INVOICE_EUR = 1_000_000;

function invoiceFromRow(row: InvoiceRow): ElectricityInvoice {
  return {
    id: row.id,
    propertyId: row.property_id,
    houseId: row.house_id,
    periodStart: row.period_start,
    periodEnd: row.period_end,
    totalEur: row.total_eur,
    consumptionKwh: row.consumption_kwh,
    energyEur: row.energy_eur,
    networkEur: row.network_eur,
    taxEur: row.tax_eur,
    feesEur: row.fees_eur,
    note: row.note,
    createdAt: row.created_at,
  };
}

function invoiceAmount(value: number | null | undefined, field: string): number | null {
  if (value === null || value === undefined) return null;
  if (typeof value !== "number" || !Number.isFinite(value) || Math.abs(value) > MAX_INVOICE_EUR) {
    throw new ClimateDataValidationError(400, "INVALID_INVOICE", `${field} must be a finite amount`);
  }
  return value;
}

function tariffFromRow(row: TariffRow): PropertyElectricityTariff {
  return {
    propertyId: row.property_id,
    versions: (JSON.parse(row.versions_json) as ElectricityTariffVersion[]).map(normalizedElectricityTariffVersion),
    revision: row.revision,
    updatedAt: row.updated_at,
  };
}

registerDatabaseMethods({
  getPropertyElectricityTariff(propertyId: string): PropertyElectricityTariff | null {
    const row = this.db.prepare("SELECT * FROM property_electricity_tariffs WHERE property_id = ?")
      .get(propertyId) as unknown as TariffRow | undefined;
    if (row) return tariffFromRow(row);
    const legacy = this.db.prepare(`SELECT margin_cents_per_kwh, contract_type, monthly_fee_eur, updated_at
      FROM property_electricity_configs WHERE property_id = ?`).get(propertyId) as unknown as LegacyContractRow | undefined;
    if (!legacy) return null;
    return {
      propertyId,
      versions: [legacyElectricityTariffVersion({
        contractType: legacy.contract_type,
        marginCentsPerKwh: legacy.margin_cents_per_kwh,
        monthlyFeeEur: legacy.monthly_fee_eur,
      })],
      revision: 0,
      updatedAt: legacy.updated_at,
    };
  },

  savePropertyElectricityTariff(
    propertyId: string,
    versions: unknown,
    expectedRevision?: number,
  ): PropertyElectricityTariff | null {
    if (!this.getProperty(propertyId)) return null;
    const problem = electricityTariffProblem(versions);
    if (problem) throw new ClimateDataValidationError(400, "INVALID_ELECTRICITY_TARIFF", problem);
    // electricityTariffProblem accepted every entry, so each has the version shape.
    const normalized = (versions as ElectricityTariffVersion[]).map(normalizedElectricityTariffVersion);
    return this.immediateTransaction(() => {
      const currentRevision = this.getPropertyElectricityTariff(propertyId)?.revision ?? 0;
      if (expectedRevision !== undefined && expectedRevision !== currentRevision) {
        throw new ClimateDataValidationError(409, "TARIFF_REVISION_CONFLICT", "The tariff changed since it was loaded");
      }
      const updatedAt = new Date().toISOString();
      this.db.prepare(`INSERT INTO property_electricity_tariffs (property_id, versions_json, revision, updated_at)
        VALUES (?, ?, ?, ?)
        ON CONFLICT(property_id) DO UPDATE SET versions_json = excluded.versions_json,
          revision = excluded.revision, updated_at = excluded.updated_at`)
        .run(propertyId, JSON.stringify(normalized), currentRevision + 1, updatedAt);
      return { propertyId, versions: normalized, revision: currentRevision + 1, updatedAt };
    });
  },

  propertyElectricityTimeZone(propertyId: string): string {
    const row = this.db.prepare(`SELECT house.timezone FROM houses AS house
      LEFT JOIN properties AS property ON property.default_house_id = house.id
      WHERE house.property_id = ?
      ORDER BY property.id IS NULL, house.created_at, house.id LIMIT 1`)
      .get(propertyId) as unknown as { timezone: string | null } | undefined;
    return row?.timezone || "UTC";
  },

  listElectricityInvoices(propertyId: string): ElectricityInvoice[] {
    const rows = this.db.prepare(`SELECT * FROM electricity_invoices WHERE property_id = ?
      ORDER BY period_start DESC, created_at DESC, id`).all(propertyId) as unknown as InvoiceRow[];
    return rows.map(invoiceFromRow);
  },

  getElectricityInvoice(propertyId: string, invoiceId: string): ElectricityInvoice | null {
    const row = this.db.prepare("SELECT * FROM electricity_invoices WHERE property_id = ? AND id = ?")
      .get(propertyId, invoiceId) as unknown as InvoiceRow | undefined;
    return row ? invoiceFromRow(row) : null;
  },

  createElectricityInvoice(propertyId: string, input: ElectricityInvoiceInput): ElectricityInvoice | null {
    if (!this.getProperty(propertyId)) return null;
    const house = this.getHouse(input.houseId);
    if (!house || house.propertyId !== propertyId) {
      throw new ClimateDataValidationError(400, "INVALID_INVOICE", "The invoice Home must belong to this Property");
    }
    if (!isLocalDateKey(input.periodStart) || !isLocalDateKey(input.periodEnd) || input.periodEnd < input.periodStart) {
      throw new ClimateDataValidationError(400, "INVALID_INVOICE", "The billing period needs valid start and end dates in order");
    }
    const days = (Date.parse(`${input.periodEnd}T00:00:00Z`) - Date.parse(`${input.periodStart}T00:00:00Z`)) / 86_400_000 + 1;
    if (days > MAX_INVOICE_DAYS) {
      throw new ClimateDataValidationError(400, "INVALID_INVOICE", `A billing period can be at most ${MAX_INVOICE_DAYS} days`);
    }
    const total = invoiceAmount(input.totalEur, "totalEur");
    if (total === null || total <= 0) throw new ClimateDataValidationError(400, "INVALID_INVOICE", "totalEur must be greater than zero");
    const consumption = invoiceAmount(input.consumptionKwh, "consumptionKwh");
    if (consumption !== null && consumption < 0) {
      throw new ClimateDataValidationError(400, "INVALID_INVOICE", "consumptionKwh cannot be negative");
    }
    const invoice: ElectricityInvoice = {
      id: randomUUID(),
      propertyId,
      houseId: house.id,
      periodStart: input.periodStart,
      periodEnd: input.periodEnd,
      totalEur: total,
      consumptionKwh: consumption,
      energyEur: invoiceAmount(input.energyEur, "energyEur"),
      networkEur: invoiceAmount(input.networkEur, "networkEur"),
      taxEur: invoiceAmount(input.taxEur, "taxEur"),
      feesEur: invoiceAmount(input.feesEur, "feesEur"),
      note: this.propertyOptionalText(input.note ?? null, "Invoice note", 500),
      createdAt: new Date().toISOString(),
    };
    return this.immediateTransaction(() => {
      const count = this.db.prepare("SELECT COUNT(*) AS count FROM electricity_invoices WHERE property_id = ?")
        .get(propertyId) as unknown as { count: number };
      if (Number(count.count) >= MAX_INVOICES_PER_PROPERTY) {
        throw new ClimateDataValidationError(409, "INVOICE_LIMIT", `A Property can keep at most ${MAX_INVOICES_PER_PROPERTY} invoices`);
      }
      this.db.prepare(`INSERT INTO electricity_invoices (id, property_id, house_id, period_start, period_end,
          total_eur, consumption_kwh, energy_eur, network_eur, tax_eur, fees_eur, note, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
        .run(invoice.id, propertyId, invoice.houseId, invoice.periodStart, invoice.periodEnd, invoice.totalEur,
          invoice.consumptionKwh, invoice.energyEur, invoice.networkEur, invoice.taxEur, invoice.feesEur,
          invoice.note, invoice.createdAt);
      return invoice;
    });
  },

  deleteElectricityInvoice(propertyId: string, invoiceId: string): boolean {
    const result = this.db.prepare("DELETE FROM electricity_invoices WHERE property_id = ? AND id = ?")
      .run(propertyId, invoiceId);
    return Number(result.changes) > 0;
  },
});
