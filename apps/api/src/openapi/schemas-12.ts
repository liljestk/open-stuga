const rate = { type: "number", minimum: 0, maximum: 1000 } as const;
const nullableAmount = { type: ["number", "null"] } as const;
const localDate = { type: "string", pattern: "^\\d{4}-\\d{2}-\\d{2}$" } as const;
const comparison = {
  type: "object", additionalProperties: false,
  required: ["invoicedEur", "calculatedEur", "errorPercent"],
  properties: { invoicedEur: { type: "number" }, calculatedEur: nullableAmount, errorPercent: nullableAmount },
} as const;

const nullableSkill = { type: ["number", "null"] } as const;

/** Dated electricity tariffs, cost breakdowns, invoice reconciliation, and forecast evaluations. */
export const schemasPart12 = {
  MeasurementForecastEvaluation: {
    type: "object", additionalProperties: false,
    required: ["algorithmVersion", "sensorId", "metric", "status", "model", "computedAt", "historyFrom", "historyTo", "origins", "outdoorDriver", "horizons", "skill6h", "skill24h", "coverage90"],
    properties: {
      algorithmVersion: { const: "measurement-forecast/v2" },
      sensorId: { type: "string" }, metric: { type: "string" },
      status: { enum: ["ready", "no-skill", "insufficient-history"] },
      model: { enum: ["thermal-relaxation", "daily-profile", null] },
      computedAt: { type: "string", format: "date-time" },
      historyFrom: { type: ["string", "null"], format: "date-time" }, historyTo: { type: ["string", "null"], format: "date-time" },
      origins: { type: "integer", minimum: 0 },
      outdoorDriver: { enum: ["weather-forecast", "held-observation", null], description: "Backtests use observed outdoor temperatures, so their skill assumes a good weather forecast." },
      horizons: { type: "array", items: {
        type: "object", additionalProperties: false,
        required: ["hours", "samples", "maeModel", "maePersistence", "maeSameTimeYesterday", "skillVsPersistence", "skillVsSameTimeYesterday", "intervalHalfWidth", "intervalCoverage"],
        properties: {
          hours: { type: "integer", minimum: 1 }, samples: { type: "integer", minimum: 0 },
          maeModel: { type: "number" }, maePersistence: { type: "number" }, maeSameTimeYesterday: nullableSkill,
          skillVsPersistence: nullableSkill, skillVsSameTimeYesterday: nullableSkill,
          intervalHalfWidth: { type: "number", minimum: 0 }, intervalCoverage: nullableSkill,
        },
      } },
      skill6h: nullableSkill, skill24h: nullableSkill, coverage90: nullableSkill,
    },
  },
  ElectricityRateSchedule: {
    description: "Rates in cents/kWh including VAT. Daytime is 07–22 local; seasonal winter daytime is November–March, Monday–Saturday 07–22.",
    oneOf: [
      { type: "object", additionalProperties: false, required: ["kind", "centsPerKwh"], properties: { kind: { const: "flat" }, centsPerKwh: rate } },
      { type: "object", additionalProperties: false, required: ["kind", "dayCentsPerKwh", "nightCentsPerKwh"], properties: { kind: { const: "day_night" }, dayCentsPerKwh: rate, nightCentsPerKwh: rate } },
      { type: "object", additionalProperties: false, required: ["kind", "winterDayCentsPerKwh", "otherCentsPerKwh"], properties: { kind: { const: "seasonal" }, winterDayCentsPerKwh: rate, otherCentsPerKwh: rate } },
    ],
  },
  ElectricityTariffVersion: {
    type: "object", additionalProperties: false,
    required: ["validFrom", "energy"],
    properties: {
      validFrom: { ...localDate, description: "First local date of this version; the earliest version also covers earlier dates." },
      energy: {
        description: "Spot (raw feed plus margin) or fixed schedule; null until a fixed contract's price is entered.",
        oneOf: [
          { type: "object", additionalProperties: false, required: ["kind", "marginCentsPerKwh"], properties: { kind: { const: "spot" }, marginCentsPerKwh: { type: "number", minimum: -1000, maximum: 1000 } } },
          { type: "object", additionalProperties: false, required: ["kind", "schedule"], properties: { kind: { const: "fixed" }, schedule: { $ref: "#/components/schemas/ElectricityRateSchedule" } } },
          { type: "null" },
        ],
      },
      network: { oneOf: [{ $ref: "#/components/schemas/ElectricityRateSchedule" }, { type: "null" }] },
      electricityTaxCentsPerKwh: { type: ["number", "null"], minimum: 0, maximum: 1000 },
      retailerMonthlyFeeEur: { type: ["number", "null"], minimum: 0, maximum: 10000 },
      networkMonthlyFeeEur: { type: ["number", "null"], minimum: 0, maximum: 10000 },
    },
  },
  PropertyElectricityTariff: {
    type: "object", additionalProperties: false,
    required: ["propertyId", "versions", "revision", "updatedAt"],
    properties: {
      propertyId: { type: "string" },
      versions: { type: "array", minItems: 1, maxItems: 120, items: { $ref: "#/components/schemas/ElectricityTariffVersion" } },
      revision: { type: "integer", minimum: 0, description: "0 for the tariff implied by the legacy contract fields." },
      updatedAt: { type: "string", format: "date-time" },
    },
  },
  ElectricityTariffInput: {
    type: "object", additionalProperties: false,
    required: ["versions"],
    properties: {
      versions: { type: "array", minItems: 1, maxItems: 120, items: { $ref: "#/components/schemas/ElectricityTariffVersion" } },
      revision: { type: "integer", minimum: 0, description: "Optional optimistic-concurrency check against the stored revision." },
    },
  },
  ElectricityPriceComponents: {
    type: "object", additionalProperties: false,
    required: ["energyCentsPerKwh", "networkCentsPerKwh", "taxCentsPerKwh"],
    properties: { energyCentsPerKwh: nullableAmount, networkCentsPerKwh: nullableAmount, taxCentsPerKwh: nullableAmount },
  },
  ElectricityCostBreakdown: {
    type: "object", additionalProperties: false,
    required: ["energyEur", "networkEur", "taxEur", "feesEur", "included", "energyPriceMissing"],
    properties: {
      energyEur: nullableAmount, networkEur: nullableAmount, taxEur: nullableAmount, feesEur: nullableAmount,
      included: { type: "array", items: { enum: ["energy", "network", "tax", "fees"] } },
      energyPriceMissing: { type: "boolean" },
    },
  },
  ElectricityInvoiceInput: {
    type: "object", additionalProperties: false,
    required: ["houseId", "periodStart", "periodEnd", "totalEur"],
    properties: {
      houseId: { type: "string" }, periodStart: localDate, periodEnd: localDate,
      totalEur: { type: "number", exclusiveMinimum: 0 }, consumptionKwh: { type: ["number", "null"], minimum: 0 },
      energyEur: nullableAmount, networkEur: nullableAmount, taxEur: nullableAmount, feesEur: nullableAmount,
      note: { type: ["string", "null"], maxLength: 500 },
    },
  },
  ElectricityInvoice: {
    type: "object", additionalProperties: false,
    required: ["id", "propertyId", "houseId", "periodStart", "periodEnd", "totalEur", "consumptionKwh", "energyEur", "networkEur", "taxEur", "feesEur", "note", "createdAt"],
    properties: {
      id: { type: "string" }, propertyId: { type: "string" }, houseId: { type: "string" },
      periodStart: localDate, periodEnd: localDate, totalEur: { type: "number" }, consumptionKwh: nullableAmount,
      energyEur: nullableAmount, networkEur: nullableAmount, taxEur: nullableAmount, feesEur: nullableAmount,
      note: { type: ["string", "null"] }, createdAt: { type: "string", format: "date-time" },
    },
  },
  ElectricityInvoiceReconciliation: {
    type: "object", additionalProperties: false,
    required: ["invoiceId", "status", "tolerancePercent", "from", "to", "consumption", "total", "components", "breakdown", "priceCoveragePercent", "calculatedAt"],
    properties: {
      invoiceId: { type: "string" },
      status: { enum: ["reconciled", "outside_tolerance", "incomplete"] },
      tolerancePercent: { type: "number" },
      from: { type: "string", format: "date-time" }, to: { type: "string", format: "date-time" },
      consumption: {
        oneOf: [{ type: "null" }, {
          type: "object", additionalProperties: false, required: ["invoicedKwh", "calculatedKwh", "errorPercent"],
          properties: { invoicedKwh: { type: "number" }, calculatedKwh: nullableAmount, errorPercent: nullableAmount },
        }],
      },
      total: comparison,
      components: {
        type: "object", additionalProperties: false,
        properties: { energy: comparison, network: comparison, tax: comparison, fees: comparison },
      },
      breakdown: { oneOf: [{ $ref: "#/components/schemas/ElectricityCostBreakdown" }, { type: "null" }] },
      priceCoveragePercent: nullableAmount,
      calculatedAt: { type: "string", format: "date-time" },
    },
  },
  HomeEnergyProjection: {
    type: "object", additionalProperties: false,
    required: [
      "houseId", "generatedAt", "algorithmVersion", "horizonStart", "horizonDays", "method", "next30DaysKwh", "lowKwh",
      "highKwh", "dailyKwh", "baseLoadKwhPerDay", "heatingSlopeKwhPerDegreeHour", "heatingBaseTemperatureC",
      "forecastDays", "observedDays", "confidence", "backtest", "estimatedCostEur", "lowCostEur", "highCostEur", "priceBasis",
    ],
    properties: {
      houseId: { type: "string" },
      generatedAt: { type: "string", format: "date-time" },
      algorithmVersion: { const: "energy-projection/v1" },
      horizonStart: { type: "string", format: "date-time" },
      horizonDays: { type: "integer", minimum: 1 },
      method: { enum: ["weather-regression", "recent-average"] },
      next30DaysKwh: { type: "number", minimum: 0 },
      lowKwh: { type: "number", minimum: 0 },
      highKwh: { type: "number", minimum: 0 },
      dailyKwh: { type: "number", minimum: 0 },
      baseLoadKwhPerDay: nullableAmount,
      heatingSlopeKwhPerDegreeHour: nullableAmount,
      heatingBaseTemperatureC: { type: "number" },
      forecastDays: { type: "integer", minimum: 0 },
      observedDays: { type: "integer", minimum: 0 },
      confidence: { enum: ["low", "medium", "high"] },
      backtest: {
        type: "object", additionalProperties: false,
        required: ["origins", "meanAbsolutePercentError", "baselineMeanAbsolutePercentError", "skill"],
        properties: {
          origins: { type: "integer", minimum: 0 },
          meanAbsolutePercentError: nullableAmount,
          baselineMeanAbsolutePercentError: nullableAmount,
          skill: nullableAmount,
        },
      },
      estimatedCostEur: nullableAmount,
      lowCostEur: nullableAmount,
      highCostEur: nullableAmount,
      priceBasis: { enum: ["historical", "unavailable"] },
    },
  },
  EnergyFlexibleLoad: {
    type: "object", additionalProperties: false,
    required: [
      "sensorId", "sensorName", "runsPerDay", "dailyKwh", "typicalRunMinutes", "paidCentsPerKwh",
      "cheapestWindow", "estimatedDailySavingsEur",
    ],
    properties: {
      sensorId: { type: "string" },
      sensorName: { type: "string" },
      runsPerDay: { type: "number", minimum: 0 },
      dailyKwh: { type: "number", minimum: 0 },
      typicalRunMinutes: { type: "number", minimum: 0 },
      paidCentsPerKwh: { type: "number" },
      cheapestWindow: {
        oneOf: [
          {
            type: "object", additionalProperties: false, required: ["startAt", "endAt", "averagePriceCentsPerKwh"],
            properties: {
              startAt: { type: "string", format: "date-time" },
              endAt: { type: "string", format: "date-time" },
              averagePriceCentsPerKwh: { type: "number" },
            },
          },
          { type: "null" },
        ],
      },
      estimatedDailySavingsEur: nullableAmount,
    },
  },
  AnalyticsDiagnostics: {
    type: "object", additionalProperties: false,
    required: ["houseId", "generatedAt", "windowDays", "latency", "forecasts", "bills", "projection", "findings"],
    properties: {
      houseId: { type: "string" },
      generatedAt: { type: "string", format: "date-time" },
      windowDays: { type: "integer", minimum: 1 },
      latency: {
        type: "array",
        items: {
          type: "object", additionalProperties: false,
          required: ["operation", "requests", "p50Ms", "p95Ms", "targetP95Ms", "meetsTarget"],
          properties: {
            operation: { enum: ["query-24h", "query-7d", "query-30d", "query-365d", "energy-summary-30d"] },
            requests: { type: "integer", minimum: 0 },
            p50Ms: nullableAmount,
            p95Ms: nullableAmount,
            targetP95Ms: { type: "number", minimum: 0 },
            meetsTarget: { type: ["boolean", "null"] },
          },
        },
      },
      forecasts: {
        type: "array",
        items: {
          type: "object", additionalProperties: false,
          required: ["metric", "sensors", "evaluations", "withheld", "medianSkill6h", "medianSkill24h", "medianCoverage90", "meetsTarget"],
          properties: {
            metric: { type: "string" },
            sensors: { type: "integer", minimum: 0 },
            evaluations: { type: "integer", minimum: 0 },
            withheld: { type: "integer", minimum: 0 },
            medianSkill6h: nullableAmount,
            medianSkill24h: nullableAmount,
            medianCoverage90: nullableAmount,
            meetsTarget: { type: ["boolean", "null"] },
          },
        },
      },
      bills: {
        type: "object", additionalProperties: false,
        required: ["invoices", "reconciled", "outsideTolerance", "incomplete", "medianAbsoluteErrorPercent", "tolerancePercent", "meetsTarget"],
        properties: {
          invoices: { type: "integer", minimum: 0 },
          reconciled: { type: "integer", minimum: 0 },
          outsideTolerance: { type: "integer", minimum: 0 },
          incomplete: { type: "integer", minimum: 0 },
          medianAbsoluteErrorPercent: nullableAmount,
          tolerancePercent: { type: "number", minimum: 0 },
          meetsTarget: { type: ["boolean", "null"] },
        },
      },
      projection: {
        oneOf: [
          {
            type: "object", additionalProperties: false,
            required: ["method", "origins", "meanAbsolutePercentError", "baselineMeanAbsolutePercentError", "skill", "meetsTarget"],
            properties: {
              method: { enum: ["weather-regression", "recent-average"] },
              origins: { type: "integer", minimum: 0 },
              meanAbsolutePercentError: nullableAmount,
              baselineMeanAbsolutePercentError: nullableAmount,
              skill: nullableAmount,
              meetsTarget: { type: ["boolean", "null"] },
            },
          },
          { type: "null" },
        ],
      },
      findings: {
        oneOf: [
          {
            type: "object", additionalProperties: false,
            required: ["evaluatedThrough", "seriesTested", "findings", "falseDiscoveryRate"],
            properties: {
              evaluatedThrough: localDate,
              seriesTested: { type: ["integer", "null"], minimum: 0 },
              findings: { type: "integer", minimum: 0 },
              falseDiscoveryRate: nullableAmount,
            },
          },
          { type: "null" },
        ],
      },
    },
  },
};
