import { describe, expect, it } from "vitest";
import {
  electricityTariffProblem,
  legacyElectricityTariffVersion,
  type ElectricityTariffVersion,
} from "@climate-twin/contracts";
import {
  costBreakdown,
  effectivePriceAt,
  proratedMonthlyFeesEur,
  tariffCost,
  tariffVersionOn,
  withTariffPrice,
} from "../src/electricity/tariff-cost.js";
import { HourlyUsageAccumulator } from "../src/electricity/hourly-usage.js";
import {
  projectedElectricityConfig,
  versionsWithLegacyContract,
} from "../src/electricity/legacy-contract.js";
import type { HourlyEnergyUsage } from "../src/timeseries/types.js";

const HELSINKI = "Europe/Helsinki";
const HOUR = 3_600_000;

function version(overrides: Partial<ElectricityTariffVersion>): ElectricityTariffVersion {
  return {
    validFrom: "2000-01-01",
    energy: { kind: "spot", marginCentsPerKwh: 0 },
    network: null,
    electricityTaxCentsPerKwh: null,
    retailerMonthlyFeeEur: null,
    networkMonthlyFeeEur: null,
    ...overrides,
  };
}

function hour(iso: string, kwh: number, rawCents: number | null): HourlyEnergyUsage {
  return {
    hourStart: Date.parse(iso),
    kwh,
    spotPricedKwh: rawCents === null ? 0 : kwh,
    spotCostCents: rawCents === null ? 0 : kwh * rawCents,
  };
}

describe("tariff versions", () => {
  it("selects the version in force and lets the earliest one cover earlier dates", () => {
    const versions = [version({ validFrom: "2026-01-01" }), version({ validFrom: "2026-07-01" })];
    expect(tariffVersionOn(versions, "2025-12-31")).toBe(versions[0]);
    expect(tariffVersionOn(versions, "2026-06-30")).toBe(versions[0]);
    expect(tariffVersionOn(versions, "2026-07-01")).toBe(versions[1]);
    expect(tariffVersionOn([], "2026-07-01")).toBeNull();
  });

  it("validates versions before they can be stored", () => {
    expect(electricityTariffProblem([])).toMatch(/at least one/);
    expect(electricityTariffProblem([version({ validFrom: "2026-02-30" })])).toMatch(/validFrom/);
    expect(electricityTariffProblem([version({ validFrom: "2026-02-01" }), version({ validFrom: "2026-01-01" })]))
      .toMatch(/ascending/);
    expect(electricityTariffProblem([version({ network: { kind: "day_night", dayCentsPerKwh: 4 } as never })]))
      .toMatch(/nightCentsPerKwh/);
    expect(electricityTariffProblem([{ ...version({}), surprise: 1 }])).toMatch(/surprise/);
    expect(electricityTariffProblem([{ validFrom: "2026-01-01", energy: null }])).toBeNull();
    expect(electricityTariffProblem([version({ energy: { kind: "fixed", schedule: { kind: "flat", centsPerKwh: 9 } } })]))
      .toBeNull();
  });

  it("maps a pre-0.43 fixed contract to a missing energy price instead of spot plus margin", () => {
    expect(legacyElectricityTariffVersion({ contractType: "fixed", marginCentsPerKwh: 0.5, monthlyFeeEur: 3 }))
      .toMatchObject({ energy: null, retailerMonthlyFeeEur: 3 });
    expect(legacyElectricityTariffVersion({ contractType: "other", marginCentsPerKwh: 0.5, monthlyFeeEur: null }))
      .toMatchObject({ energy: { kind: "spot", marginCentsPerKwh: 0.5 } });
  });
});

describe("rate schedules in local time", () => {
  const dayNight = version({
    energy: { kind: "fixed", schedule: { kind: "day_night", dayCentsPerKwh: 12, nightCentsPerKwh: 8 } },
    network: { kind: "seasonal", winterDayCentsPerKwh: 5, otherCentsPerKwh: 2 },
    electricityTaxCentsPerKwh: 2.79,
  });

  it("switches day and night at 07 and 22 local across the October change", () => {
    // 2026-10-25: Helsinki leaves summer time at 04:00 local (01:00 UTC).
    const at = (iso: string) => effectivePriceAt(0, { timestamp: Date.parse(iso), versions: [dayNight], timeZone: HELSINKI });
    expect(at("2026-10-24T03:59:00Z").energyCentsPerKwh).toBe(8); // 06:59 EEST
    expect(at("2026-10-24T04:00:00Z").energyCentsPerKwh).toBe(12); // 07:00 EEST
    expect(at("2026-10-25T04:00:00Z").energyCentsPerKwh).toBe(8); // 06:00 EET
    expect(at("2026-10-25T05:00:00Z").energyCentsPerKwh).toBe(12); // 07:00 EET
    expect(at("2026-10-25T19:59:00Z").energyCentsPerKwh).toBe(12); // 21:59 EET
    expect(at("2026-10-25T20:00:00Z").energyCentsPerKwh).toBe(8); // 22:00 EET
  });

  it("charges the seasonal winter rate only on November–March Monday–Saturday daytime", () => {
    const network = (iso: string) => effectivePriceAt(0, { timestamp: Date.parse(iso), versions: [dayNight], timeZone: HELSINKI }).networkCentsPerKwh;
    expect(network("2026-10-30T10:00:00Z")).toBe(2); // Friday in October
    expect(network("2026-11-02T10:00:00Z")).toBe(5); // Monday in November, 12:00 EET
    expect(network("2026-11-07T10:00:00Z")).toBe(5); // Saturday
    expect(network("2026-11-08T10:00:00Z")).toBe(2); // Sunday
    expect(network("2026-11-02T21:00:00Z")).toBe(2); // 23:00 EET
    expect(network("2027-03-31T10:00:00Z")).toBe(5);
    expect(network("2027-04-01T09:00:00Z")).toBe(2);
  });

  it("derives effective prices from the raw price and every variable component", () => {
    const spot = version({ energy: { kind: "spot", marginCentsPerKwh: 0.6 }, network: { kind: "flat", centsPerKwh: 3 }, electricityTaxCentsPerKwh: 2.79 });
    const point = withTariffPrice({
      startAt: "2026-07-01T10:00:00.000Z", rawPriceCentsPerKwh: 4,
      effectivePriceCentsPerKwh: 99, effectivePriceEurPerKwh: 0.99,
    }, [spot], HELSINKI);
    expect(point.effectivePriceCentsPerKwh).toBeCloseTo(10.39, 12);
    expect(point.effectivePriceEurPerKwh).toBeCloseTo(0.1039, 12);
    expect(point.components).toEqual({ energyCentsPerKwh: 4.6, networkCentsPerKwh: 3, taxCentsPerKwh: 2.79 });
    const missing = effectivePriceAt(4, { timestamp: Date.parse("2026-07-01T10:00:00Z"), versions: [version({ energy: null })], timeZone: HELSINKI });
    expect(missing).toEqual({ energyCentsPerKwh: null, networkCentsPerKwh: null, taxCentsPerKwh: null, totalCentsPerKwh: 4 });
  });
});

describe("tariff cost", () => {
  it("prices spot hours by their raw cost plus margin and only on spot-priced kWh", () => {
    const tariff = [version({ energy: { kind: "spot", marginCentsPerKwh: 1 }, network: { kind: "flat", centsPerKwh: 3 }, electricityTaxCentsPerKwh: 2 })];
    const result = tariffCost([
      hour("2026-07-01T10:00:00Z", 2, 10),
      hour("2026-07-01T11:00:00Z", 1, null),
    ], tariff, HELSINKI);
    expect(result.consumptionKwh).toBe(3);
    expect(result.pricedConsumptionKwh).toBe(2);
    expect(result.energyEur).toBeCloseTo(0.22, 12);
    expect(result.networkEur).toBeCloseTo(0.06, 12);
    expect(result.taxEur).toBeCloseTo(0.04, 12);
    expect(result.energyPriceMissing).toBe(false);
  });

  it("prices fixed and time-of-use hours without spot prices and follows version changes", () => {
    const tariff = [
      version({ validFrom: "2000-01-01", energy: { kind: "fixed", schedule: { kind: "flat", centsPerKwh: 10 } } }),
      version({ validFrom: "2026-07-02", energy: { kind: "fixed", schedule: { kind: "day_night", dayCentsPerKwh: 15, nightCentsPerKwh: 5 } } }),
    ];
    const result = tariffCost([
      hour("2026-07-01T10:00:00Z", 1, null), // 13:00 on the 1st: flat 10
      hour("2026-07-02T10:00:00Z", 1, 99), // 13:00 on the 2nd: day 15, the spot price is irrelevant
      hour("2026-07-02T20:00:00Z", 1, null), // 23:00 on the 2nd: night 5
    ], tariff, HELSINKI);
    expect(result.pricedConsumptionKwh).toBe(3);
    expect(result.energyEur).toBeCloseTo(0.3, 12);
    expect(result.networkEur).toBeNull();
    expect(result.taxEur).toBeNull();
  });

  it("reports a missing energy price instead of pricing a fixed contract at spot", () => {
    const result = tariffCost([hour("2026-07-01T10:00:00Z", 2, 10)], [version({ energy: null })], HELSINKI);
    expect(result).toMatchObject({ consumptionKwh: 2, pricedConsumptionKwh: 0, energyEur: 0, energyPriceMissing: true });
  });

  it("lists only configured components and keeps their order", () => {
    expect(costBreakdown({ energyEur: 1, networkEur: null, taxEur: 0.5, feesEur: 2, energyPriceMissing: false }).included)
      .toEqual(["energy", "tax", "fees"]);
  });
});

describe("monthly fees", () => {
  const fees = [version({ retailerMonthlyFeeEur: 3.1, networkMonthlyFeeEur: 6.2 })];

  it("pro-rates by local calendar day and month length", () => {
    // All of July 2026 in Helsinki: one month of both fees.
    const july = proratedMonthlyFeesEur({ fromMs: Date.parse("2026-06-30T21:00:00Z"), toMs: Date.parse("2026-07-31T21:00:00Z"), versions: fees, timeZone: HELSINKI });
    expect(july).toBeCloseTo(9.3, 9);
    // One day of a 31-day month.
    const day = proratedMonthlyFeesEur({ fromMs: Date.parse("2026-07-14T21:00:00Z"), toMs: Date.parse("2026-07-15T21:00:00Z"), versions: fees, timeZone: HELSINKI });
    expect(day).toBeCloseTo(9.3 / 31, 9);
    // Half of a day.
    const half = proratedMonthlyFeesEur({ fromMs: Date.parse("2026-07-14T21:00:00Z"), toMs: Date.parse("2026-07-15T09:00:00Z"), versions: fees, timeZone: HELSINKI });
    expect(half).toBeCloseTo(9.3 / 31 / 2, 9);
  });

  it("counts the 25-hour October day as one day", () => {
    const longDay = proratedMonthlyFeesEur({ fromMs: Date.parse("2026-10-24T21:00:00Z"), toMs: Date.parse("2026-10-25T22:00:00Z"), versions: fees, timeZone: HELSINKI });
    expect(longDay).toBeCloseTo(9.3 / 31, 9);
  });

  it("follows fee changes between versions and is null without fees", () => {
    const changing = [version({ retailerMonthlyFeeEur: 3 }), version({ validFrom: "2026-07-16", retailerMonthlyFeeEur: 6 })];
    const value = proratedMonthlyFeesEur({ fromMs: Date.parse("2026-07-14T21:00:00Z"), toMs: Date.parse("2026-07-16T21:00:00Z"), versions: changing, timeZone: HELSINKI });
    expect(value).toBeCloseTo(3 / 31 + 6 / 31, 9);
    expect(proratedMonthlyFeesEur({ fromMs: 0, toMs: HOUR, versions: [version({})], timeZone: HELSINKI })).toBeNull();
    expect(proratedMonthlyFeesEur({ fromMs: HOUR, toMs: 0, versions: fees, timeZone: HELSINKI })).toBeNull();
  });
});

describe("hourly usage", () => {
  it("spreads usage and spot-priced usage across UTC hours", () => {
    const hours = new HourlyUsageAccumulator();
    hours.addUsage(Date.parse("2026-07-01T10:30:00Z"), Date.parse("2026-07-01T11:30:00Z"), 2);
    hours.addSpotPriced(Date.parse("2026-07-01T10:30:00Z"), Date.parse("2026-07-01T11:00:00Z"), 1, 10);
    expect(hours.toArray()).toEqual([
      { hourStart: Date.parse("2026-07-01T10:00:00Z"), kwh: 1, spotPricedKwh: 1, spotCostCents: 10 },
      { hourStart: Date.parse("2026-07-01T11:00:00Z"), kwh: 1, spotPricedKwh: 0, spotCostCents: 0 },
    ]);
  });
});

describe("legacy contract fields", () => {
  const config = {
    propertyId: "property-main", provider: "porssisahko" as const, endpointUrl: "https://example.test/prices.json",
    enabled: true, marginCentsPerKwh: 0.4, contractType: "spot" as const, contractName: null, retailer: null,
    monthlyFeeEur: null, lastFetchedAt: null, lastError: null, updatedAt: "2026-07-01T00:00:00.000Z",
  };
  const tariff = {
    propertyId: "property-main", revision: 3, updatedAt: "2026-07-01T00:00:00.000Z",
    versions: [
      version({ energy: { kind: "spot", marginCentsPerKwh: 0.4 } }),
      version({ validFrom: "2026-07-01", energy: { kind: "fixed", schedule: { kind: "flat", centsPerKwh: 9 } }, retailerMonthlyFeeEur: 4 }),
    ],
  };

  it("shows the version in force today through the old fields", () => {
    expect(projectedElectricityConfig(config, tariff, "2026-07-10")).toMatchObject({ contractType: "fixed", monthlyFeeEur: 4 });
    expect(projectedElectricityConfig(config, tariff, "2026-06-10")).toMatchObject({ contractType: "spot", marginCentsPerKwh: 0.4 });
    expect(projectedElectricityConfig(config, { ...tariff, revision: 0 }, "2026-07-10")).toBe(config);
  });

  it("updates only today's version, and nothing when the projection is resent", () => {
    expect(versionsWithLegacyContract(tariff, { contractType: "fixed", marginCentsPerKwh: 0.4, monthlyFeeEur: 4 }, "2026-07-10"))
      .toBeNull();
    const changed = versionsWithLegacyContract(tariff, { contractType: "spot", marginCentsPerKwh: 0.7, monthlyFeeEur: 4 }, "2026-07-10");
    expect(changed?.[0]).toBe(tariff.versions[0]);
    expect(changed?.[1]).toMatchObject({ validFrom: "2026-07-01", energy: { kind: "spot", marginCentsPerKwh: 0.7 } });
  });
});
