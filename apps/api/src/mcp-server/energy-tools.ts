import { ClimateDatabase } from "../db.js";
import { publicElectricityConfiguration } from "../electricity/prices.js";
import { invoiceRange, reconcileInvoice } from "../electricity/invoice-reconciliation.js";
import { requireMcpHouse, requireMcpHouseSensor, validateMcpDateRange } from "./validation.js";
import type { McpRuntime } from "./runtime.js";
import { mcpDateTime, requiredToolString } from "./arguments.js";

export async function propertyElectricity(runtime: McpRuntime, args: Record<string, unknown>): Promise<object> {
  const { database, telemetryReader } = runtime;
  const propertyId = requiredToolString(args, "propertyId");
  if (!database.getProperty(propertyId)) throw new Error(`Unknown property: ${propertyId}`);
  const electricity = database.getPropertyElectricityConfig(propertyId);
  if (!electricity) throw new Error(`Property ${propertyId} does not have electricity configuration`);
  const to = mcpDateTime(args, "to", new Date(Date.now() + 48 * 3_600_000));
  const from = mcpDateTime(args, "from", new Date(Date.now() - 24 * 3_600_000));
  validateMcpDateRange(from, to);
  const prices = (await telemetryReader.electricityPriceHistory({
    propertyId,
    from,
    to,
    limit: 10_000,
  })).records;
  return {
    config: publicElectricityConfiguration(electricity, true),
    current: database.getCurrentPropertyElectricityPrice(propertyId),
    prices,
  };
}

export async function houseElectricityPrice(runtime: McpRuntime, args: Record<string, unknown>): Promise<object> {
  const { database, telemetryReader } = runtime;
  const house = requireMcpHouse(database, requiredToolString(args, "houseId"));
  const toHomePrice = (price: NonNullable<ReturnType<ClimateDatabase["getCurrentPropertyElectricityPrice"]>>) => ({
    startAt: price.startAt,
    endAt: price.endAt,
    effectivePriceCentsPerKwh: price.effectivePriceCentsPerKwh,
    effectivePriceEurPerKwh: price.effectivePriceEurPerKwh,
    fetchedAt: price.fetchedAt,
  });
  const propertyPrice = database.getCurrentPropertyElectricityPrice(house.propertyId);
  const current = propertyPrice ? toHomePrice(propertyPrice) : null;
  if (args.from === undefined && args.to === undefined) return { current };
  const to = mcpDateTime(args, "to", new Date(Date.now() + 48 * 3_600_000));
  const from = mcpDateTime(args, "from", new Date(Date.now() - 24 * 3_600_000));
  validateMcpDateRange(from, to);
  return {
    current,
    prices: (await telemetryReader.electricityPriceHistory({
      propertyId: house.propertyId,
      from,
      to,
      limit: 10_000,
    })).records.map(toHomePrice),
  };
}

export async function houseEnergyCost(runtime: McpRuntime, args: Record<string, unknown>): Promise<unknown> {
  const { database, energyCost } = runtime;
  const house = requireMcpHouse(database, requiredToolString(args, "houseId"));
  const sensor = requireMcpHouseSensor(database, house.id, requiredToolString(args, "sensorId"));
  const to = mcpDateTime(args, "to", new Date());
  const from = mcpDateTime(args, "from", new Date(Date.parse(to) - 30 * 86_400_000));
  const durationMs = Date.parse(to) - Date.parse(from);
  if (durationMs <= 0 || durationMs > 366 * 86_400_000) {
    throw new Error("Energy cost range must be greater than zero and at most 366 days");
  }
  return energyCost.calculate({
    houseId: house.id,
    propertyId: house.propertyId,
    sensorId: sensor.id,
    from,
    to,
  });
}

export async function houseEnergySummary(runtime: McpRuntime, args: Record<string, unknown>): Promise<unknown> {
  const { database, energyCost } = runtime;
  const house = requireMcpHouse(database, requiredToolString(args, "houseId"));
  const to = mcpDateTime(args, "to", new Date());
  const from = mcpDateTime(args, "from", new Date(Date.parse(to) - 30 * 86_400_000));
  const durationMs = Date.parse(to) - Date.parse(from);
  if (durationMs <= 0 || durationMs > 366 * 86_400_000) {
    throw new Error("Energy summary range must be greater than zero and at most 366 days");
  }
  return energyCost.summarize({
    houseId: house.id,
    propertyId: house.propertyId,
    sensorIds: database.listSensors(house.id).filter((sensor) => sensor.enabled).map((sensor) => sensor.id),
    from,
    to,
  });
}

function requireMcpProperty(runtime: McpRuntime, args: Record<string, unknown>): string {
  const propertyId = requiredToolString(args, "propertyId");
  if (!runtime.database.getProperty(propertyId)) throw new Error(`Unknown property: ${propertyId}`);
  return propertyId;
}

function enabledHouseSensors(runtime: McpRuntime, houseId: string) {
  return runtime.database.listSensors(houseId).filter((sensor) => sensor.enabled);
}

export async function houseEnergyProjection(runtime: McpRuntime, args: Record<string, unknown>, signal?: AbortSignal): Promise<object> {
  const house = requireMcpHouse(runtime.database, requiredToolString(args, "houseId"));
  return { projection: await runtime.energyProjections.get(house, enabledHouseSensors(runtime, house.id), signal) };
}

export function propertyElectricityTariff(runtime: McpRuntime, args: Record<string, unknown>): object {
  const propertyId = requireMcpProperty(runtime, args);
  const tariff = runtime.database.getPropertyElectricityTariff(propertyId);
  if (!tariff) throw new Error(`Property ${propertyId} does not have an electricity tariff`);
  return { tariff, timeZone: runtime.database.propertyElectricityTimeZone(propertyId) };
}

export function electricityInvoices(runtime: McpRuntime, args: Record<string, unknown>): object {
  return { invoices: runtime.database.listElectricityInvoices(requireMcpProperty(runtime, args)) };
}

export async function electricityInvoiceReconciliation(
  runtime: McpRuntime,
  args: Record<string, unknown>,
  signal?: AbortSignal,
): Promise<object> {
  const { database, energySummaries } = runtime;
  const propertyId = requireMcpProperty(runtime, args);
  const invoiceId = requiredToolString(args, "invoiceId");
  const invoice = database.getElectricityInvoice(propertyId, invoiceId);
  if (!invoice) throw new Error(`Unknown invoice: ${invoiceId}`);
  const house = database.getHouse(invoice.houseId);
  const range = house ? invoiceRange(invoice, house.timezone) : null;
  if (!house || !range) throw new Error("The invoice period cannot be resolved for its Home");
  // The invoice belongs to this Property's contract and price feed.
  const { summary } = await energySummaries.get({
    houseId: house.id,
    propertyId,
    timeZone: house.timezone,
    sensors: enabledHouseSensors(runtime, house.id),
    ...range,
    ...(signal ? { signal } : {}),
  });
  return { reconciliation: reconcileInvoice(invoice, summary) };
}

const propertyIdSchema = { type: "string", minLength: 1, maxLength: 200 } as const;

export const electricityToolDefinitions = [
  {
    name: "get_house_energy_projection",
    description: "Project one Home's electricity use and cost over the next 30 days, with a low/high range and confidence, from its recent daily use, the stored weather forecast, and the Property tariff.",
    inputSchema: {
      type: "object",
      properties: { houseId: { type: "string", minLength: 1, maxLength: 200 } },
      required: ["houseId"],
      additionalProperties: false,
    },
  },
  {
    name: "get_property_electricity_tariff",
    description: "Get one Property's versioned electricity contract: energy pricing (spot or fixed), margins, network and tax components, and their validity dates.",
    inputSchema: {
      type: "object",
      properties: { propertyId: propertyIdSchema },
      required: ["propertyId"],
      additionalProperties: false,
    },
  },
  {
    name: "list_electricity_invoices",
    description: "List the electricity invoices recorded for one Property, with period, totals, consumption, and cost components.",
    inputSchema: {
      type: "object",
      properties: { propertyId: propertyIdSchema },
      required: ["propertyId"],
      additionalProperties: false,
    },
  },
  {
    name: "get_electricity_invoice_reconciliation",
    description: "Compare one recorded electricity invoice with the consumption and cost Stugu calculated for the same Home-local period.",
    inputSchema: {
      type: "object",
      properties: {
        propertyId: propertyIdSchema,
        invoiceId: { type: "string", minLength: 1, maxLength: 200 },
      },
      required: ["propertyId", "invoiceId"],
      additionalProperties: false,
    },
  },
] as const;
