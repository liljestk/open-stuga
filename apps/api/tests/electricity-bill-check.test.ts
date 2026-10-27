import { afterEach, describe, expect, it } from "vitest";
import request from "supertest";
import { DEFAULT_ELECTRICITY_PRICE_ENDPOINT, type ElectricityTariffVersion } from "@climate-twin/contracts";
import { createApi, type ApiRuntime } from "../src/app.js";
import { loadConfig } from "../src/config.js";

// Local 2025-10-25..27 in Helsinki: the 26th is 25 hours long (summer time ends).
const PERIOD_FROM = "2025-10-24T21:00:00.000Z";
const PERIOD_TO = "2025-10-27T22:00:00.000Z";
const QUARTER = 15 * 60_000;
const POWER_WATTS = 1_200;
const QUARTER_KWH = POWER_WATTS / 1_000 / 4;

const localHour = new Intl.DateTimeFormat("en-GB", { timeZone: "Europe/Helsinki", hour: "2-digit", hourCycle: "h23" });
const hourAt = (at: number) => Number(localHour.format(new Date(at)));
const daytime = (at: number) => hourAt(at) >= 7 && hourAt(at) < 22;
const rawPrice = (index: number) => 3 + (index % 8) * 1.5 + (index % 3 === 0 ? -1 : 0);

function quarters(): number[] {
  const result: number[] = [];
  for (let at = Date.parse(PERIOD_FROM); at < Date.parse(PERIOD_TO); at += QUARTER) result.push(at);
  return result;
}

function seed(runtime: ApiRuntime): void {
  runtime.database.storePropertyElectricityPrices("property-main", quarters().map((at, index) => ({
    startAt: new Date(at).toISOString(),
    endAt: new Date(at + QUARTER).toISOString(),
    rawPriceCentsPerKwh: rawPrice(index),
  })), "2025-10-24T12:00:00.000Z");
  const samples = [];
  for (let at = Date.parse(PERIOD_FROM); at <= Date.parse(PERIOD_TO); at += 5 * 60_000) {
    samples.push({
      sensorId: "sensor-01", metric: "power" as const, value: POWER_WATTS, canonicalUnit: "W",
      timestamp: new Date(at).toISOString(), source: "api" as const, quality: "good" as const,
    });
  }
  runtime.measurements.ingestBatch(samples);
}

function base(overrides: Partial<ElectricityTariffVersion>): ElectricityTariffVersion {
  return {
    validFrom: "2000-01-01", energy: null, network: null, electricityTaxCentsPerKwh: null,
    retailerMonthlyFeeEur: null, networkMonthlyFeeEur: null, ...overrides,
  };
}

/** The invoice a retailer and network operator would send, computed independently of the cost model. */
function expectedInvoice(energyCents: (at: number, index: number) => number, networkCents: (at: number) => number, taxCents: number, monthlyFees: number) {
  let energy = 0;
  let network = 0;
  quarters().forEach((at, index) => {
    energy += QUARTER_KWH * energyCents(at, index) / 100;
    network += QUARTER_KWH * networkCents(at) / 100;
  });
  const kwh = quarters().length * QUARTER_KWH;
  const tax = kwh * taxCents / 100;
  const fees = monthlyFees * 3 / 31;
  return { kwh, energy, network, tax, fees, total: energy + network + tax + fees };
}

describe("electricity bill check", () => {
  let runtime: ApiRuntime | null = null;
  afterEach(async () => {
    await runtime?.close();
    runtime = null;
  });

  const contracts = [
    {
      name: "spot with day/night transfer",
      version: base({
        energy: { kind: "spot", marginCentsPerKwh: 0.49 },
        network: { kind: "day_night", dayCentsPerKwh: 4.5, nightCentsPerKwh: 2.8 },
        electricityTaxCentsPerKwh: 2.82, retailerMonthlyFeeEur: 3.9, networkMonthlyFeeEur: 9.6,
      }),
      invoice: () => expectedInvoice((_, index) => rawPrice(index) + 0.49, (at) => daytime(at) ? 4.5 : 2.8, 2.82, 13.5),
    },
    {
      name: "fixed price with flat transfer",
      version: base({
        energy: { kind: "fixed", schedule: { kind: "flat", centsPerKwh: 11.5 } },
        network: { kind: "flat", centsPerKwh: 5 }, electricityTaxCentsPerKwh: 2.82, retailerMonthlyFeeEur: 4.5,
      }),
      invoice: () => expectedInvoice(() => 11.5, () => 5, 2.82, 4.5),
    },
    {
      name: "time-of-use energy with seasonal transfer",
      version: base({
        energy: { kind: "fixed", schedule: { kind: "day_night", dayCentsPerKwh: 13, nightCentsPerKwh: 9 } },
        network: { kind: "seasonal", winterDayCentsPerKwh: 6.1, otherCentsPerKwh: 3.2 },
        electricityTaxCentsPerKwh: 2.82, networkMonthlyFeeEur: 12.4,
      }),
      // October is outside the November–March winter season.
      invoice: () => expectedInvoice((at) => daytime(at) ? 13 : 9, () => 3.2, 2.82, 12.4),
    },
  ];

  it.each(contracts)("reconciles a $name invoice across the daylight-saving change", async (contract) => {
    runtime = createApi({ config: loadConfig({ NODE_ENV: "test", DATABASE_PATH: ":memory:" }), startBackground: false });
    seed(runtime);
    await request(runtime.app).put("/api/v1/properties/property-main/electricity/tariff")
      .send({ versions: [contract.version] }).expect(200);
    const expected = contract.invoice();
    // Invoices round each line; a 0.5% difference stays inside the 2% tolerance.
    const created = await request(runtime.app).post("/api/v1/properties/property-main/electricity/invoices").send({
      houseId: "house-main", periodStart: "2025-10-25", periodEnd: "2025-10-27",
      totalEur: Number((expected.total * 1.005).toFixed(2)), consumptionKwh: expected.kwh,
      energyEur: Number(expected.energy.toFixed(2)), networkEur: Number(expected.network.toFixed(2)),
      taxEur: Number(expected.tax.toFixed(2)), feesEur: Number(expected.fees.toFixed(2)),
    }).expect(201);

    const result = await request(runtime.app)
      .get(`/api/v1/properties/property-main/electricity/invoices/${created.body.invoice.id}/reconciliation`)
      .expect(200);
    const reconciliation = result.body.reconciliation;
    expect(reconciliation).toMatchObject({
      status: "reconciled", from: PERIOD_FROM, to: PERIOD_TO, tolerancePercent: 2,
    });
    expect(Math.abs(reconciliation.total.errorPercent)).toBeLessThanOrEqual(2);
    expect(reconciliation.consumption.calculatedKwh).toBeCloseTo(73 * POWER_WATTS / 1_000, 6);
    expect(reconciliation.breakdown.energyEur).toBeCloseTo(expected.energy, 6);
    expect(reconciliation.breakdown.networkEur).toBeCloseTo(expected.network, 6);
    expect(reconciliation.breakdown.taxEur).toBeCloseTo(expected.tax, 6);
    expect(reconciliation.breakdown.feesEur).toBeCloseTo(expected.fees, 6);
    // Each invoice line is rounded to cents, which alone moves the small fee line by about 1%.
    for (const component of ["energy", "network", "tax", "fees"] as const) {
      expect(Math.abs(reconciliation.components[component].errorPercent), component).toBeLessThanOrEqual(2);
    }
  });

  it("flags an invoice outside the tolerance and keeps both totals visible", async () => {
    runtime = createApi({ config: loadConfig({ NODE_ENV: "test", DATABASE_PATH: ":memory:" }), startBackground: false });
    seed(runtime);
    await request(runtime.app).put("/api/v1/properties/property-main/electricity/tariff")
      .send({ versions: [contracts[1]!.version] }).expect(200);
    const expected = contracts[1]!.invoice();
    const created = await request(runtime.app).post("/api/v1/properties/property-main/electricity/invoices").send({
      houseId: "house-main", periodStart: "2025-10-25", periodEnd: "2025-10-27", totalEur: expected.total * 1.05,
    }).expect(201);
    const result = await request(runtime.app)
      .get(`/api/v1/properties/property-main/electricity/invoices/${created.body.invoice.id}/reconciliation`)
      .expect(200);
    expect(result.body.reconciliation.status).toBe("outside_tolerance");
    expect(result.body.reconciliation.total.calculatedEur).toBeCloseTo(expected.total, 6);
    expect(result.body.reconciliation.total.errorPercent).toBeCloseTo(-4.76, 1);
    expect(result.body.reconciliation.components).toEqual({});
  });

  it("does not price a fixed contract at spot while its energy price is missing", async () => {
    runtime = createApi({ config: loadConfig({ NODE_ENV: "test", DATABASE_PATH: ":memory:" }), startBackground: false });
    seed(runtime);
    await request(runtime.app).put("/api/v1/properties/property-main/electricity/config").send({
      provider: "porssisahko", endpointUrl: DEFAULT_ELECTRICITY_PRICE_ENDPOINT, enabled: true,
      marginCentsPerKwh: 0.5, contractType: "fixed", contractName: null, retailer: null, monthlyFeeEur: 3.1,
    }).expect(200);
    const summary = await request(runtime.app).get("/api/v1/houses/house-main/energy-summary")
      .query({ from: PERIOD_FROM, to: PERIOD_TO }).expect(200);
    expect(summary.body.summary).toMatchObject({
      consumptionKwh: expect.closeTo(87.6, 6),
      costEur: null,
      totalCostEur: null,
      priceCoveragePercent: 0,
      costBreakdown: { energyPriceMissing: true, energyEur: null, feesEur: expect.closeTo(3.1 * 3 / 31, 9) },
    });
  });
});

describe("electricity tariff routes", () => {
  let runtime: ApiRuntime | null = null;
  afterEach(async () => {
    await runtime?.close();
    runtime = null;
  });

  it("serves the legacy tariff, saves dated versions with revisions and refreshes cached summaries", async () => {
    runtime = createApi({ config: loadConfig({ NODE_ENV: "test", DATABASE_PATH: ":memory:" }), startBackground: false });
    seed(runtime);
    const legacy = await request(runtime.app).get("/api/v1/properties/property-main/electricity/tariff").expect(200);
    expect(legacy.body).toMatchObject({
      timeZone: "Europe/Helsinki",
      tariff: { revision: 0, versions: [{ validFrom: "2000-01-01", energy: { kind: "spot", marginCentsPerKwh: 0 } }] },
    });
    const summaryQuery = { from: PERIOD_FROM, to: PERIOD_TO };
    const before = await request(runtime.app).get("/api/v1/houses/house-main/energy-summary").query(summaryQuery).expect(200);

    await request(runtime.app).put("/api/v1/properties/property-main/electricity/tariff")
      .send({ versions: [base({ validFrom: "2026-13-01" })] }).expect(400);
    await request(runtime.app).put("/api/v1/properties/property-main/electricity/tariff")
      .send({ versions: [base({})], extra: true }).expect(400);
    const saved = await request(runtime.app).put("/api/v1/properties/property-main/electricity/tariff").send({
      revision: 0,
      versions: [base({ energy: { kind: "spot", marginCentsPerKwh: 0 } }), base({
        validFrom: "2025-10-26", energy: { kind: "spot", marginCentsPerKwh: 2 }, network: { kind: "flat", centsPerKwh: 1 },
      })],
    }).expect(200);
    expect(saved.body.tariff.revision).toBe(1);
    await request(runtime.app).put("/api/v1/properties/property-main/electricity/tariff")
      .send({ revision: 0, versions: [base({})] }).expect(409);

    const after = await request(runtime.app).get("/api/v1/houses/house-main/energy-summary").query(summaryQuery).expect(200);
    expect(after.headers["x-stugu-cache"]).toBe("miss");
    expect(after.body.summary.tariffRevision).toBe(1);
    // From local 26 October: 49 hours × 1.2 kWh × (2 + 1) c/kWh.
    expect(after.body.summary.costEur - before.body.summary.costEur).toBeCloseTo(49 * 1.2 * 3 / 100, 6);
    expect(after.body.summary.costBreakdown.included).toEqual(["energy", "network"]);

    // Older clients that still send the legacy fields update only the version in force today.
    await request(runtime.app).put("/api/v1/properties/property-main/electricity/config").send({
      provider: "porssisahko", endpointUrl: DEFAULT_ELECTRICITY_PRICE_ENDPOINT, enabled: true,
      marginCentsPerKwh: 0.7, contractType: "spot",
    }).expect(200);
    const updated = await request(runtime.app).get("/api/v1/properties/property-main/electricity/tariff").expect(200);
    expect(updated.body.tariff.revision).toBe(2);
    expect(updated.body.tariff.versions[0].energy).toEqual({ kind: "spot", marginCentsPerKwh: 0 });
    expect(updated.body.tariff.versions[1]).toMatchObject({ energy: { kind: "spot", marginCentsPerKwh: 0.7 }, network: { kind: "flat", centsPerKwh: 1 } });
    // Saving only the source details leaves the tariff alone.
    await request(runtime.app).put("/api/v1/properties/property-main/electricity/config").send({
      provider: "porssisahko", endpointUrl: DEFAULT_ELECTRICITY_PRICE_ENDPOINT, enabled: true, retailer: "Example Energy",
    }).expect(200);
    expect((await request(runtime.app).get("/api/v1/properties/property-main/electricity/tariff")).body.tariff.revision).toBe(2);
  });

  it("validates, lists and deletes invoices", async () => {
    runtime = createApi({ config: loadConfig({ NODE_ENV: "test", DATABASE_PATH: ":memory:" }), startBackground: false });
    const invoices = "/api/v1/properties/property-main/electricity/invoices";
    await request(runtime.app).post(invoices).send({ houseId: "house-main", periodStart: "2026-10-26", periodEnd: "2026-10-24", totalEur: 10 }).expect(400);
    await request(runtime.app).post(invoices).send({ houseId: "house-main", periodStart: "2025-01-01", periodEnd: "2026-10-24", totalEur: 10 }).expect(400);
    await request(runtime.app).post(invoices).send({ houseId: "house-main", periodStart: "2026-10-01", periodEnd: "2026-10-31", totalEur: 0 }).expect(400);
    await request(runtime.app).post(invoices).send({ houseId: "house-missing", periodStart: "2026-10-01", periodEnd: "2026-10-31", totalEur: 10 }).expect(404);
    await request(runtime.app).post(invoices).send({ houseId: "house-main", periodStart: "2026-10-01", periodEnd: "2026-10-31", totalEur: 10, unknown: 1 }).expect(400);
    const first = await request(runtime.app).post(invoices).send({ houseId: "house-main", periodStart: "2026-09-01", periodEnd: "2026-09-30", totalEur: 41.2, note: "September" }).expect(201);
    const second = await request(runtime.app).post(invoices).send({ houseId: "house-main", periodStart: "2026-10-01", periodEnd: "2026-10-31", totalEur: 52.75 }).expect(201);
    const listed = await request(runtime.app).get(invoices).expect(200);
    expect(listed.body.invoices.map((invoice: { id: string }) => invoice.id)).toEqual([second.body.invoice.id, first.body.invoice.id]);
    expect(listed.body.invoices[1]).toMatchObject({ note: "September", consumptionKwh: null, energyEur: null });
    await request(runtime.app).delete(`${invoices}/${first.body.invoice.id}`).expect(200, { deleted: true, invoiceId: first.body.invoice.id });
    await request(runtime.app).delete(`${invoices}/${first.body.invoice.id}`).expect(404);
    expect((await request(runtime.app).get(invoices)).body.invoices).toHaveLength(1);
  });
});
