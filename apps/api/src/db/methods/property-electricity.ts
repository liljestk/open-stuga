import type { PropertyElectricityConfig, PropertyElectricityConfigInput, PropertyElectricityPricePoint } from "@climate-twin/contracts";
import { ElectricityPricePointRow, PropertyElectricityConfigRow, EnergyCostAggregateRow } from "../support/row-types.js";
import { ClimateDataValidationError } from "../support/validation-errors.js";
import { electricityConfigFromRow } from "../support/row-mappers.js";
import { registerDatabaseMethods } from "../core.js";
import { projectedElectricityConfig, versionsWithLegacyContract } from "../../electricity/legacy-contract.js";
import { withTariffPrice } from "../../electricity/tariff-cost.js";
import type { EnergyCostAggregateQuery, EnergyCostAggregateRecord, PowerCostAggregateQuery } from "../../timeseries/types.js";
import { SQLITE_EFFECTIVE_PRICE_END, sqlitePriceOverlapSql } from "../support/electricity-price-overlap.js";
import { localPowerCostAggregate } from "../local-power-cost.js";
import { HourlyUsageAccumulator } from "../../electricity/hourly-usage.js";

function sqliteHourlyUsage(usageJson: string | null | undefined, pricedJson: string | null | undefined) {
  const hours = new HourlyUsageAccumulator();
  const rows = (json: string | null | undefined): unknown[][] => {
    const parsed = json ? JSON.parse(json) as unknown : [];
    return Array.isArray(parsed) ? parsed.filter(Array.isArray) : [];
  };
  for (const [startAt, endAt, kwh] of rows(usageJson)) {
    hours.addUsage(Date.parse(String(startAt)), Date.parse(String(endAt)), Number(kwh));
  }
  for (const [startAt, endAt, kwh, rawCents] of rows(pricedJson)) {
    hours.addSpotPriced(Date.parse(String(startAt)), Date.parse(String(endAt)), Number(kwh), Number(rawCents));
  }
  return hours.toArray();
}

declare module "../core.js" {
  interface DatabaseInternals {
    getPropertyElectricityConfig(propertyId: string): PropertyElectricityConfig | null;
    listPropertyElectricityConfigs(): PropertyElectricityConfig[];
    updatePropertyElectricityConfig(propertyId: string, input: PropertyElectricityConfigInput): PropertyElectricityConfig | null;
    storePropertyElectricityPrices(propertyId: string, prices: Array<{
            startAt: string;
            endAt: string;
            rawPriceCentsPerKwh: number;
        }>, fetchedAt: string): void;
    setPropertyElectricityFetchError(propertyId: string, message: string): void;
    listPropertyElectricityPrices(propertyId: string, from: string, to: string): PropertyElectricityPricePoint[];
    getCurrentPropertyElectricityPrice(propertyId: string, at?: string): PropertyElectricityPricePoint | null;
    energyCostAggregate(query: EnergyCostAggregateQuery): EnergyCostAggregateRecord;
    powerCostAggregate(query: PowerCostAggregateQuery): EnergyCostAggregateRecord;
  }

  interface ClimateDatabaseCore {
    getPropertyElectricityConfig(propertyId: string): PropertyElectricityConfig | null;
    listPropertyElectricityConfigs(): PropertyElectricityConfig[];
    updatePropertyElectricityConfig(propertyId: string, input: PropertyElectricityConfigInput): PropertyElectricityConfig | null;
    storePropertyElectricityPrices(propertyId: string, prices: Array<{
            startAt: string;
            endAt: string;
            rawPriceCentsPerKwh: number;
        }>, fetchedAt: string): void;
    setPropertyElectricityFetchError(propertyId: string, message: string): void;
    listPropertyElectricityPrices(propertyId: string, from: string, to: string): PropertyElectricityPricePoint[];
    getCurrentPropertyElectricityPrice(propertyId: string, at?: string): PropertyElectricityPricePoint | null;
    energyCostAggregate(query: EnergyCostAggregateQuery): EnergyCostAggregateRecord;
    powerCostAggregate(query: PowerCostAggregateQuery): EnergyCostAggregateRecord;
  }
}

registerDatabaseMethods({
  getPropertyElectricityConfig(propertyId: string): PropertyElectricityConfig | null {
      const row = this.db.prepare("SELECT * FROM property_electricity_configs WHERE property_id = ?")
        .get(propertyId) as unknown as PropertyElectricityConfigRow | undefined;
      return row
        ? projectedElectricityConfig(electricityConfigFromRow(row), this.getPropertyElectricityTariff(propertyId))
        : null;
    },
  listPropertyElectricityConfigs(): PropertyElectricityConfig[] {
      const rows = this.db.prepare("SELECT * FROM property_electricity_configs ORDER BY property_id")
        .all() as unknown as PropertyElectricityConfigRow[];
      return rows.map((row) => projectedElectricityConfig(
        electricityConfigFromRow(row),
        this.getPropertyElectricityTariff(row.property_id),
      ));
    },
  updatePropertyElectricityConfig(propertyId: string, input: PropertyElectricityConfigInput): PropertyElectricityConfig | null {
      if (!this.getProperty(propertyId)) return null;
      if (!["porssisahko", "custom"].includes(input.provider)) {
        throw new ClimateDataValidationError(400, "INVALID_ELECTRICITY_PROVIDER", "Unsupported electricity price provider");
      }
      let endpoint: URL;
      try { endpoint = new URL(input.endpointUrl); } catch {
        throw new ClimateDataValidationError(400, "INVALID_ELECTRICITY_ENDPOINT", "Electricity price endpoint must be a valid URL");
      }
      if (endpoint.protocol !== "https:" || endpoint.username || endpoint.password) {
        throw new ClimateDataValidationError(400, "INVALID_ELECTRICITY_ENDPOINT", "Electricity price endpoint must use HTTPS without embedded credentials");
      }
      const stored = this.getPropertyElectricityConfig(propertyId);
      const margin = input.marginCentsPerKwh ?? stored?.marginCentsPerKwh ?? 0;
      const contractType = input.contractType ?? stored?.contractType ?? "spot";
      const monthlyFee = input.monthlyFeeEur === undefined ? stored?.monthlyFeeEur ?? null : input.monthlyFeeEur;
      if (!Number.isFinite(margin) || margin < -100 || margin > 100) {
        throw new ClimateDataValidationError(400, "INVALID_ELECTRICITY_MARGIN", "Electricity margin must be between -100 and 100 cents/kWh");
      }
      if (!["spot", "fixed", "other"].includes(contractType)) {
        throw new ClimateDataValidationError(400, "INVALID_CONTRACT_TYPE", "Unsupported electricity contract type");
      }
      if (input.monthlyFeeEur !== undefined && input.monthlyFeeEur !== null
        && (!Number.isFinite(input.monthlyFeeEur) || input.monthlyFeeEur < 0 || input.monthlyFeeEur > 100_000)) {
        throw new ClimateDataValidationError(400, "INVALID_MONTHLY_FEE", "Monthly fee must be between 0 and 100000 euros");
      }
      const timestamp = new Date().toISOString();
      const text = (value: string | null | undefined, label: string): string | null => (
        this.propertyOptionalText(value ?? null, label, 200)
      );
      this.db.prepare(`INSERT INTO property_electricity_configs
        (property_id, provider, endpoint_url, enabled, margin_cents_per_kwh, contract_type,
         contract_name, retailer, monthly_fee_eur, last_fetched_at, last_error, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, NULL, ?)
        ON CONFLICT(property_id) DO UPDATE SET provider = excluded.provider, endpoint_url = excluded.endpoint_url,
          enabled = excluded.enabled, margin_cents_per_kwh = excluded.margin_cents_per_kwh,
          contract_type = excluded.contract_type, contract_name = excluded.contract_name,
          retailer = excluded.retailer, monthly_fee_eur = excluded.monthly_fee_eur,
          last_error = NULL, updated_at = excluded.updated_at`)
        .run(propertyId, input.provider, endpoint.toString(), input.enabled ? 1 : 0, margin,
          contractType, text(input.contractName, "Contract name"), text(input.retailer, "Retailer"),
          monthlyFee, timestamp);
      this.db.prepare(`UPDATE electricity_price_points SET margin_cents_per_kwh = ?
        WHERE property_id = ? AND end_at > ?`).run(margin, propertyId, timestamp);
      // A saved tariff is authoritative; legacy fields sent by older clients
      // update only the version in force today.
      const tariff = this.getPropertyElectricityTariff(propertyId);
      const contractSent = input.marginCentsPerKwh !== undefined || input.contractType !== undefined
        || input.monthlyFeeEur !== undefined;
      if (tariff && tariff.revision > 0 && contractSent) {
        const versions = versionsWithLegacyContract(tariff, { contractType, marginCentsPerKwh: margin, monthlyFeeEur: monthlyFee });
        if (versions) this.savePropertyElectricityTariff(propertyId, versions);
      }
      return this.getPropertyElectricityConfig(propertyId);
    },
  storePropertyElectricityPrices(
      propertyId: string,
      prices: Array<{ startAt: string; endAt: string; rawPriceCentsPerKwh: number }>,
      fetchedAt: string,
    ): void {
      const margin = this.getPropertyElectricityConfig(propertyId)?.marginCentsPerKwh ?? 0;
      this.immediateTransaction(() => {
        const statement = this.db.prepare(`INSERT INTO electricity_price_points
          (property_id, start_at, end_at, raw_price_cents_per_kwh, margin_cents_per_kwh, fetched_at) VALUES (?, ?, ?, ?, ?, ?)
          ON CONFLICT(property_id, start_at) DO UPDATE SET end_at = excluded.end_at,
            raw_price_cents_per_kwh = excluded.raw_price_cents_per_kwh,
            margin_cents_per_kwh = CASE
              WHEN electricity_price_points.end_at <= excluded.fetched_at THEN electricity_price_points.margin_cents_per_kwh
              ELSE excluded.margin_cents_per_kwh
            END,
            fetched_at = excluded.fetched_at`);
        for (const price of prices) {
          statement.run(propertyId, price.startAt, price.endAt, price.rawPriceCentsPerKwh, margin, fetchedAt);
        }
        const overlap = this.db.prepare(`SELECT earlier.start_at, later.start_at AS overlapping_start
          FROM electricity_price_points AS earlier
          JOIN electricity_price_points AS later
            ON later.property_id = earlier.property_id
            AND later.start_at > earlier.start_at
            AND later.start_at < earlier.end_at
          WHERE earlier.property_id = ? LIMIT 1`).get(propertyId) as {
          start_at: string;
          overlapping_start: string;
        } | undefined;
        if (overlap) {
          throw new ClimateDataValidationError(
            422,
            "OVERLAPPING_ELECTRICITY_PRICES",
            `Electricity price intervals ${overlap.start_at} and ${overlap.overlapping_start} overlap`,
          );
        }
        this.db.prepare(`UPDATE property_electricity_configs
          SET last_fetched_at = ?, last_error = NULL, updated_at = ? WHERE property_id = ?`)
          .run(fetchedAt, fetchedAt, propertyId);
      });
    },
  setPropertyElectricityFetchError(propertyId: string, message: string): void {
      this.db.prepare("UPDATE property_electricity_configs SET last_error = ?, updated_at = ? WHERE property_id = ?")
        .run(message.slice(0, 1_000), new Date().toISOString(), propertyId);
    },
  listPropertyElectricityPrices(propertyId: string, from: string, to: string): PropertyElectricityPricePoint[] {
      const tariff = this.getPropertyElectricityTariff(propertyId);
      if (!tariff) return [];
      const timeZone = this.propertyElectricityTimeZone(propertyId);
      const rows = this.db.prepare(`SELECT * FROM electricity_price_points
        WHERE property_id = ? AND end_at >= ? AND start_at <= ? ORDER BY start_at`)
        .all(propertyId, from, to) as unknown as ElectricityPricePointRow[];
      return rows.map((row) => withTariffPrice({
        propertyId: row.property_id,
        startAt: row.start_at,
        endAt: row.end_at,
        rawPriceCentsPerKwh: row.raw_price_cents_per_kwh,
        effectivePriceCentsPerKwh: row.raw_price_cents_per_kwh,
        effectivePriceEurPerKwh: row.raw_price_cents_per_kwh / 100,
        fetchedAt: row.fetched_at,
      }, tariff.versions, timeZone));
    },
  getCurrentPropertyElectricityPrice(propertyId: string, at = new Date().toISOString()): PropertyElectricityPricePoint | null {
      return this.listPropertyElectricityPrices(propertyId, at, at)[0] ?? null;
    },
  /**
     * Prices every cumulative-meter delta by the exact price intervals it overlaps.
     * A delta spanning several price intervals is distributed by overlap duration;
     * counter resets contribute the new post-reset counter value.
     */
  energyCostAggregate(query: EnergyCostAggregateQuery): EnergyCostAggregateRecord {
      const row = this.db.prepare(`WITH boundary_sample AS (
          SELECT id, timestamp, value FROM measurement_samples INDEXED BY idx_measurement_samples_sensor_metric_time
          WHERE sensor_id = ? AND metric = 'energy' AND quality <> 'stale' AND timestamp < ?
            AND (? = 0 OR source NOT IN ('mock', 'replay'))
          ORDER BY timestamp DESC, id DESC LIMIT 1
        ), window_samples AS (
          SELECT id, timestamp, value FROM measurement_samples INDEXED BY idx_measurement_samples_sensor_metric_time
          WHERE sensor_id = ? AND metric = 'energy' AND quality <> 'stale'
            AND timestamp >= ? AND timestamp <= ?
            AND (? = 0 OR source NOT IN ('mock', 'replay'))
        ), deduplicated AS (
          SELECT timestamp, value FROM (
            SELECT id, timestamp, value,
              ROW_NUMBER() OVER (PARTITION BY timestamp ORDER BY id DESC) AS sample_rank
            FROM (SELECT * FROM boundary_sample UNION ALL SELECT * FROM window_samples)
          ) WHERE sample_rank = 1
        ), ordered AS (
          SELECT timestamp AS current_at, value AS current_value,
            LAG(timestamp) OVER (ORDER BY timestamp) AS previous_at,
            LAG(value) OVER (ORDER BY timestamp) AS previous_value
          FROM deduplicated
        ), deltas AS (
          SELECT previous_at, current_at,
            CASE WHEN previous_at < ? THEN ? ELSE previous_at END AS window_start,
            CASE WHEN current_value >= previous_value THEN current_value - previous_value
              ELSE MAX(0, current_value) END AS base_delta_kwh,
            (julianday(current_at) - julianday(previous_at)) * 86400000.0 AS full_duration_ms
          FROM ordered
          WHERE previous_at IS NOT NULL AND current_at > ?
            AND current_value >= 0 AND previous_value >= 0
            AND julianday(current_at) > julianday(previous_at)
        ), normalized AS (
          SELECT *,
            base_delta_kwh * ((julianday(current_at) - julianday(window_start)) * 86400000.0)
              / full_duration_ms AS window_delta_kwh,
            (julianday(current_at) - julianday(window_start)) * 86400000.0 AS window_duration_ms
          FROM deltas
        ), priced AS (
          SELECT normalized.*,
            price.raw_price_cents_per_kwh,
            MAX(normalized.window_start, price.start_at) AS overlap_start,
            MIN(normalized.current_at, ${SQLITE_EFFECTIVE_PRICE_END}) AS overlap_end,
            (julianday(MIN(normalized.current_at, ${SQLITE_EFFECTIVE_PRICE_END}))
              - julianday(MAX(normalized.window_start, price.start_at))) * 86400000.0 AS overlap_ms
          ${sqlitePriceOverlapSql("energy")}
        ), allocations AS (
          SELECT overlap_ms, overlap_start, overlap_end,
            base_delta_kwh * overlap_ms / full_duration_ms AS allocated_kwh,
            raw_price_cents_per_kwh
          FROM priced WHERE overlap_ms > 0
        )
        SELECT
          (SELECT COUNT(*) FROM normalized) AS delta_count,
          (SELECT COALESCE(SUM(window_delta_kwh), 0) FROM normalized) AS consumption_kwh,
          (SELECT COALESCE(SUM(allocated_kwh), 0) FROM allocations) AS priced_consumption_kwh,
          (SELECT COALESCE(SUM(allocated_kwh * raw_price_cents_per_kwh / 100.0), 0) FROM allocations) AS cost_eur,
          (SELECT COALESCE(SUM(window_duration_ms), 0) FROM normalized) AS total_duration_ms,
          (SELECT COALESCE(SUM(overlap_ms), 0) FROM allocations) AS priced_duration_ms,
          (SELECT COALESCE(MAX(full_duration_ms), 0) FROM normalized) AS maximum_interval_duration_ms,
          (SELECT MIN(window_start) FROM normalized) AS coverage_from,
          (SELECT MAX(current_at) FROM normalized) AS coverage_until,
          (SELECT json_group_array(json_array(window_start, current_at, window_delta_kwh)) FROM normalized) AS usage_json,
          (SELECT json_group_array(json_array(overlap_start, overlap_end, allocated_kwh, raw_price_cents_per_kwh))
            FROM allocations) AS priced_json`)
        .get(query.sensorId, query.from, query.excludeSynthetic ? 1 : 0,
          query.sensorId, query.from, query.to, query.excludeSynthetic ? 1 : 0,
          query.from, query.from, query.from, query.propertyId, query.propertyId) as unknown as EnergyCostAggregateRow;
      return {
        deltaCount: Number(row.delta_count ?? 0),
        consumptionKwh: Number(row.consumption_kwh ?? 0),
        pricedConsumptionKwh: Number(row.priced_consumption_kwh ?? 0),
        spotCostEur: Number(row.cost_eur ?? 0),
        hourly: sqliteHourlyUsage(row.usage_json, row.priced_json),
        totalDurationMs: Number(row.total_duration_ms ?? 0),
        pricedDurationMs: Number(row.priced_duration_ms ?? 0),
        maximumIntervalDurationMs: Number(row.maximum_interval_duration_ms ?? 0),
        coverageFrom: row.coverage_from,
        coverageUntil: row.coverage_until,
      };
    },
  /**
   * Integrates non-stale power samples as a step function. Each reading is
   * held for at most 15 minutes so a disconnected source cannot manufacture
   * consumption across a long telemetry gap.
   */
  powerCostAggregate(query: PowerCostAggregateQuery): EnergyCostAggregateRecord {
      return localPowerCostAggregate(this, query);
    },
});
