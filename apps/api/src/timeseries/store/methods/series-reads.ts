import { qualifiedName } from "../../schema.js";
import type { ElectricityPriceHistoryQuery, ElectricityPriceRecord, HeatPumpStateHistoryQuery, HeatPumpStateRecord, LegacyReadingHistoryQuery, LegacyReadingRecord, OpeningStateHistoryQuery, OpeningStateRecord, OpeningStateSnapshotQuery, OutdoorTemperatureHistoryQuery, OutdoorTemperatureRecord } from "../../types.js";
import { ElectricityPriceRow, HeatPumpStateRow, LatestLegacyReadingFilter, LegacyReadingRow, OpeningStateRow, OutdoorTemperatureRow, SqlValue } from "../support/row-types.js";
import { MAX_HISTORY_LIMIT } from "../support/store-limits.js";
import { electricityPriceFromRow, heatPumpStateFromRow, legacyReadingFromRow, openingStateFromRow, outdoorTemperatureFromRow } from "../support/row-mappers.js";
import { positiveInteger } from "../support/query-values.js";
import { registerTimeseriesStoreMethods, type TimeseriesStoreInternals } from "../core.js";

declare module "../core.js" {
  interface TimeseriesStoreInternals {
    latestLegacyReadings(filter?: LatestLegacyReadingFilter): Promise<LegacyReadingRecord[]>;
    legacyReadingHistory(query: LegacyReadingHistoryQuery): Promise<LegacyReadingRecord[]>;
    outdoorTemperatureHistory(query: OutdoorTemperatureHistoryQuery): Promise<OutdoorTemperatureRecord[]>;
    electricityPriceHistory(query: ElectricityPriceHistoryQuery): Promise<ElectricityPriceRecord[]>;
    openingStateHistory(query: OpeningStateHistoryQuery): Promise<OpeningStateRecord[]>;
    openingStateSnapshot(query: OpeningStateSnapshotQuery): Promise<OpeningStateRecord[]>;
    heatPumpStateHistory(query: HeatPumpStateHistoryQuery): Promise<HeatPumpStateRecord[]>;
  }

  interface TimeseriesStoreCore {
    latestLegacyReadings(filter?: LatestLegacyReadingFilter): Promise<LegacyReadingRecord[]>;
    legacyReadingHistory(query: LegacyReadingHistoryQuery): Promise<LegacyReadingRecord[]>;
    outdoorTemperatureHistory(query: OutdoorTemperatureHistoryQuery): Promise<OutdoorTemperatureRecord[]>;
    electricityPriceHistory(query: ElectricityPriceHistoryQuery): Promise<ElectricityPriceRecord[]>;
    openingStateHistory(query: OpeningStateHistoryQuery): Promise<OpeningStateRecord[]>;
    openingStateSnapshot(query: OpeningStateSnapshotQuery): Promise<OpeningStateRecord[]>;
    heatPumpStateHistory(query: HeatPumpStateHistoryQuery): Promise<HeatPumpStateRecord[]>;
  }
}

registerTimeseriesStoreMethods({
  async latestLegacyReadings(this: TimeseriesStoreInternals, filter: LatestLegacyReadingFilter = {}): Promise<LegacyReadingRecord[]> {
      if (filter.sensorIds?.length === 0) return [];
      const values: SqlValue[] = [];
      const where = filter.sensorIds
        ? (() => {
          values.push([...filter.sensorIds]);
          return "WHERE sensor_id = ANY($1::TEXT[])";
        })()
        : "";
      const result = await this.__query<LegacyReadingRow>(`SELECT DISTINCT ON (sensor_id)
          sensor_id, observed_at, temperature_c, relative_humidity_pct, battery_pct, source, quality, metadata
        FROM ${qualifiedName(this.schema, "legacy_readings")}
        ${where}
        ORDER BY sensor_id, observed_at DESC, ingested_at DESC, source DESC`, values, filter);
      return result.rows.map(legacyReadingFromRow);
    },
  async legacyReadingHistory(this: TimeseriesStoreInternals, query: LegacyReadingHistoryQuery): Promise<LegacyReadingRecord[]> {
      if (query.sensorIds.length === 0) return [];
      const limit = positiveInteger(query.limit, 20_000, MAX_HISTORY_LIMIT);
      const result = await this.__query<LegacyReadingRow>(`SELECT sensor_id, observed_at, temperature_c,
          relative_humidity_pct, battery_pct, source, quality, metadata
        FROM (
          SELECT sensor_id, observed_at, temperature_c, relative_humidity_pct, battery_pct,
            source, quality, metadata, ingested_at
          FROM ${qualifiedName(this.schema, "legacy_readings")}
          WHERE sensor_id = ANY($1::TEXT[]) AND observed_at >= $2::TIMESTAMPTZ AND observed_at <= $3::TIMESTAMPTZ
          ORDER BY observed_at DESC, ingested_at DESC, sensor_id, source DESC
          LIMIT $4
        ) recent
        ORDER BY observed_at ASC, sensor_id, source ASC`, [query.sensorIds, query.from, query.to, limit], query);
      return result.rows.map(legacyReadingFromRow);
    },
  async outdoorTemperatureHistory(this: TimeseriesStoreInternals, query: OutdoorTemperatureHistoryQuery): Promise<OutdoorTemperatureRecord[]> {
      const limit = positiveInteger(query.limit, 20_000, MAX_HISTORY_LIMIT);
      const result = await this.__query<OutdoorTemperatureRow>(`SELECT house_id, location_key, observed_at,
          temperature_c, source, fetched_at, station_id, station_name, metadata
        FROM (
          SELECT house_id, location_key, observed_at, temperature_c, source, fetched_at,
            station_id, station_name, metadata, ingested_at
          FROM ${qualifiedName(this.schema, "outdoor_temperature_samples")}
          WHERE house_id = $1 AND location_key = $2
            AND observed_at >= $3::TIMESTAMPTZ AND observed_at <= $4::TIMESTAMPTZ
          ORDER BY observed_at DESC, ingested_at DESC, source DESC
          LIMIT $5
        ) recent
        ORDER BY observed_at ASC, source ASC`, [query.houseId, query.locationKey, query.from, query.to, limit], query);
      return result.rows.map(outdoorTemperatureFromRow);
    },
  async electricityPriceHistory(this: TimeseriesStoreInternals, query: ElectricityPriceHistoryQuery): Promise<ElectricityPriceRecord[]> {
      const limit = positiveInteger(query.limit, 20_000, MAX_HISTORY_LIMIT);
      const result = await this.__query<ElectricityPriceRow>(`SELECT property_id, starts_at, ends_at,
          raw_price_cents_per_kwh, margin_cents_per_kwh, source, fetched_at, metadata
        FROM (
          SELECT property_id, starts_at, ends_at, raw_price_cents_per_kwh, margin_cents_per_kwh,
            source, fetched_at, metadata, ingested_at
          FROM ${qualifiedName(this.schema, "electricity_price_samples")}
          WHERE property_id = $1 AND starts_at < $3::TIMESTAMPTZ AND ends_at > $2::TIMESTAMPTZ
          ORDER BY starts_at DESC, ingested_at DESC, source DESC
          LIMIT $4
        ) recent
        ORDER BY starts_at ASC, source ASC`, [query.propertyId, query.from, query.to, limit], query);
      return result.rows.map(electricityPriceFromRow);
    },
  async openingStateHistory(this: TimeseriesStoreInternals, query: OpeningStateHistoryQuery): Promise<OpeningStateRecord[]> {
      const limit = positiveInteger(query.limit, 20_000, MAX_HISTORY_LIMIT);
      const result = await this.__query<OpeningStateRow>(`SELECT observation_id, house_id, floor_id, element_id,
          state, open_fraction, source, observed_at, valid_until, external_id, connection_id, recorded_at, metadata
        FROM (
          SELECT observation_id, house_id, floor_id, element_id, state, open_fraction, source, observed_at,
            valid_until, external_id, connection_id, recorded_at, metadata, ingested_at
          FROM ${qualifiedName(this.schema, "opening_state_samples")}
          WHERE house_id = $1 AND observed_at >= $2::TIMESTAMPTZ AND observed_at <= $3::TIMESTAMPTZ
          ORDER BY observed_at DESC, ingested_at DESC, observation_id DESC
          LIMIT $4
        ) recent
        ORDER BY observed_at ASC, observation_id ASC`, [query.houseId, query.from, query.to, limit], query);
      return result.rows.map(openingStateFromRow);
    },
  async openingStateSnapshot(this: TimeseriesStoreInternals, query: OpeningStateSnapshotQuery): Promise<OpeningStateRecord[]> {
      const limit = positiveInteger(query.limit, 10_000, MAX_HISTORY_LIMIT);
      const result = await this.__query<OpeningStateRow>(`SELECT observation_id, house_id, floor_id, element_id,
          state, open_fraction, source, observed_at, valid_until, external_id, connection_id, recorded_at, metadata
        FROM (
          SELECT DISTINCT ON (
              floor_id, element_id, source, COALESCE(external_id, ''), COALESCE(connection_id, '')
            )
            observation_id, house_id, floor_id, element_id, state, open_fraction, source, observed_at,
            valid_until, external_id, connection_id, recorded_at, metadata, ingested_at
          FROM ${qualifiedName(this.schema, "opening_state_samples")}
          WHERE house_id = $1 AND observed_at <= $2::TIMESTAMPTZ
            AND (valid_until IS NULL OR valid_until > $2::TIMESTAMPTZ)
          ORDER BY floor_id, element_id, source, COALESCE(external_id, ''), COALESCE(connection_id, ''),
            observed_at DESC, ingested_at DESC, observation_id DESC
        ) latest
        ORDER BY observed_at DESC, observation_id DESC
        LIMIT $3`, [query.houseId, query.at, limit], query);
      return result.rows.map(openingStateFromRow);
    },
  async heatPumpStateHistory(this: TimeseriesStoreInternals,
      query: HeatPumpStateHistoryQuery,
    ): Promise<HeatPumpStateRecord[]> {
      const limit = positiveInteger(query.limit, 20_000, MAX_HISTORY_LIMIT);
      const result = await this.__query<HeatPumpStateRow>(`SELECT connection_id, house_id, equipment_id,
          device_id, name, brand, model, transport, floor_id, room_id, x, y, z,
          observed_at, received_at, available, power, selected_mode,
          target_temperature_c, current_temperature_c, current_temperature_source,
          current_humidity_percent, target_humidity_percent, fan_speed,
          horizontal_swing, vertical_swing, fresh_air, anion, sleep, light, quiet, turbo, xfan,
          steady_heat, power_save, clean_filter, water_full, dehumidifier_mode, compressor_frequency_hz,
          diagnostics, activity, activity_evidence
        FROM (
          SELECT connection_id, house_id, equipment_id, device_id, name, brand, model, transport,
            floor_id, room_id, x, y, z, observed_at,
            received_at, available, power, selected_mode, target_temperature_c, current_temperature_c,
            current_temperature_source, current_humidity_percent, target_humidity_percent,
            fan_speed, horizontal_swing, vertical_swing, fresh_air, anion, sleep, light, quiet, turbo,
            xfan, steady_heat, power_save, clean_filter, water_full, dehumidifier_mode,
            compressor_frequency_hz, diagnostics, activity, activity_evidence, ingested_at
          FROM ${qualifiedName(this.schema, "heat_pump_state_samples")}
          WHERE connection_id = $1
            AND observed_at >= $2::TIMESTAMPTZ AND observed_at <= $3::TIMESTAMPTZ
          ORDER BY observed_at DESC, ingested_at DESC
          LIMIT $4
        ) recent
        ORDER BY observed_at ASC`, [query.connectionId, query.from, query.to, limit], query);
      return result.rows.map(heatPumpStateFromRow);
    },
});
