import type { ElectricityInvoiceInput, ElectricityTariffVersion } from "@climate-twin/contracts";
import { invoiceRange, reconcileInvoice } from "../electricity/invoice-reconciliation.js";
import {
  HttpError,
  bodyObject,
  rejectUnknownFields,
  requestPrincipal,
} from "./support/index.js";
import type { ElectricityRouteContext } from "./electricity-routes.js";

const INVOICE_FIELDS = new Set([
  "houseId", "periodStart", "periodEnd", "totalEur", "consumptionKwh",
  "energyEur", "networkEur", "taxEur", "feesEur", "note",
]);

function optionalNumber(body: Record<string, unknown>, key: string): number | null {
  const value = body[key];
  if (value === undefined || value === null) return null;
  if (typeof value !== "number" || !Number.isFinite(value)) throw new HttpError(400, "INVALID_FIELD", `${key} must be a finite number or null`);
  return value;
}

function stringField(body: Record<string, unknown>, key: string): string {
  const value = body[key];
  if (typeof value !== "string") throw new HttpError(400, "INVALID_FIELD", `${key} must be a string`);
  return value;
}

/** Dated tariff versions, manually entered invoices, and their reconciliation against calculated costs. */
export function registerElectricityTariffRoutes(
  context: ElectricityRouteContext,
  access: {
    visibleProperty: (propertyId: string, response: Parameters<ElectricityRouteContext["visibility"]>[0]) => unknown;
    houseSensorIds: (houseId: string, response: Parameters<ElectricityRouteContext["visibility"]>[0]) => string[];
    invalidateSummaries: () => void;
  },
): void {
  const nonGuest = (response: Parameters<ElectricityRouteContext["visibility"]>[0]) => {
    if (requestPrincipal(response).role === "guest") {
      throw new HttpError(403, "GUEST_READ_ONLY", "Guest accounts cannot access electricity invoices");
    }
  };

  context.app.get(`${context.prefix}/properties/:id/electricity/tariff`, (request, response) => {
    const propertyId = request.params.id as string;
    access.visibleProperty(propertyId, response);
    const tariff = context.database.getPropertyElectricityTariff(propertyId);
    if (!tariff) throw new HttpError(404, "NOT_FOUND", "Property electricity tariff not found");
    response.json({ tariff, timeZone: context.database.propertyElectricityTimeZone(propertyId) });
  });

  context.app.put(`${context.prefix}/properties/:id/electricity/tariff`, (request, response) => {
    const propertyId = request.params.id as string;
    access.visibleProperty(propertyId, response);
    const body = bodyObject(request.body);
    rejectUnknownFields(body, new Set(["versions", "revision"]), "Electricity tariff");
    const revision = body.revision === undefined ? undefined : body.revision;
    if (revision !== undefined && (typeof revision !== "number" || !Number.isInteger(revision) || revision < 0)) {
      throw new HttpError(400, "INVALID_FIELD", "revision must be a non-negative integer");
    }
    const tariff = context.database.savePropertyElectricityTariff(
      propertyId,
      body.versions as ElectricityTariffVersion[],
      revision,
    );
    if (!tariff) throw new HttpError(404, "NOT_FOUND", "Property not found");
    access.invalidateSummaries();
    response.json({ tariff, timeZone: context.database.propertyElectricityTimeZone(propertyId) });
  });

  context.app.get(`${context.prefix}/properties/:id/electricity/invoices`, (request, response) => {
    const propertyId = request.params.id as string;
    access.visibleProperty(propertyId, response);
    nonGuest(response);
    const visibility = context.visibility(response);
    const invoices = context.database.listElectricityInvoices(propertyId)
      .filter((invoice) => visibility.house(invoice.houseId));
    response.json({ invoices });
  });

  context.app.post(`${context.prefix}/properties/:id/electricity/invoices`, (request, response) => {
    const propertyId = request.params.id as string;
    access.visibleProperty(propertyId, response);
    const body = bodyObject(request.body);
    rejectUnknownFields(body, INVOICE_FIELDS, "Electricity invoice");
    const houseId = stringField(body, "houseId");
    if (!context.visibility(response).house(houseId)) throw new HttpError(404, "NOT_FOUND", "House not found");
    const note = body.note === undefined || body.note === null ? null : stringField(body, "note");
    const input: ElectricityInvoiceInput = {
      houseId,
      periodStart: stringField(body, "periodStart"),
      periodEnd: stringField(body, "periodEnd"),
      totalEur: optionalNumber(body, "totalEur") ?? Number.NaN,
      consumptionKwh: optionalNumber(body, "consumptionKwh"),
      energyEur: optionalNumber(body, "energyEur"),
      networkEur: optionalNumber(body, "networkEur"),
      taxEur: optionalNumber(body, "taxEur"),
      feesEur: optionalNumber(body, "feesEur"),
      note,
    };
    const invoice = context.database.createElectricityInvoice(propertyId, input);
    if (!invoice) throw new HttpError(404, "NOT_FOUND", "Property not found");
    response.status(201).json({ invoice });
  });

  context.app.delete(`${context.prefix}/properties/:id/electricity/invoices/:invoiceId`, (request, response) => {
    const propertyId = request.params.id as string;
    access.visibleProperty(propertyId, response);
    const invoice = context.database.getElectricityInvoice(propertyId, request.params.invoiceId as string);
    if (!invoice || !context.visibility(response).house(invoice.houseId)) {
      throw new HttpError(404, "NOT_FOUND", "Invoice not found");
    }
    context.database.deleteElectricityInvoice(propertyId, invoice.id);
    response.json({ deleted: true, invoiceId: invoice.id });
  });

  context.app.get(`${context.prefix}/properties/:id/electricity/invoices/:invoiceId/reconciliation`, async (request, response) => {
    const propertyId = request.params.id as string;
    access.visibleProperty(propertyId, response);
    nonGuest(response);
    const invoice = context.database.getElectricityInvoice(propertyId, request.params.invoiceId as string);
    if (!invoice || !context.visibility(response).house(invoice.houseId)) {
      throw new HttpError(404, "NOT_FOUND", "Invoice not found");
    }
    const house = context.database.getHouse(invoice.houseId);
    const range = house ? invoiceRange(invoice, house.timezone) : null;
    if (!house || !range) throw new HttpError(409, "INVOICE_PERIOD_UNAVAILABLE", "The invoice period cannot be resolved for its Home");
    const abortController = new AbortController();
    const abortOnClose = () => abortController.abort();
    response.once("close", abortOnClose);
    try {
      const summary = await context.analyticsWorkLimiter.run(
        "energy-summary",
        () => context.energyCost.summarize({
          houseId: house.id,
          // The invoice belongs to this Property's contract and price feed.
          propertyId,
          sensorIds: access.houseSensorIds(house.id, response),
          ...range,
          signal: abortController.signal,
        }),
        abortController.signal,
      );
      response.setHeader("cache-control", "private, no-store");
      response.json({ reconciliation: reconcileInvoice(invoice, summary) });
    } finally {
      response.off("close", abortOnClose);
    }
  });
}
