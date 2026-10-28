import type { ElectricityPriceRecord, HeatPumpStateRecord, LegacyReadingRecord, MeasurementBucketRecord, MeasurementSampleRecord, OpeningStateRecord, OutdoorTemperatureRecord } from "../../types.js";
import type { ElectricityPriceRow, HeatPumpStateRow, LegacyReadingRow, MeasurementBucketRow, MeasurementRow, OpeningStateRow, OutdoorTemperatureRow } from "./row-types.js";
import { timestamp } from "./query-values.js";

export function measurementFromRow(row: MeasurementRow): MeasurementSampleRecord {
  return {
    sensorId: row.sensor_id,
    metric: row.metric,
    value: Number(row.value),
    canonicalUnit: row.canonical_unit,
    timestamp: timestamp(row.observed_at),
    source: row.source,
    quality: row.quality,
    metadata: row.metadata,
  };
}

export function legacyReadingFromRow(row: LegacyReadingRow): LegacyReadingRecord {
  return {
    sensorId: row.sensor_id,
    timestamp: timestamp(row.observed_at),
    temperature: Number(row.temperature_c),
    humidity: Number(row.relative_humidity_pct),
    battery: row.battery_pct === null ? null : Number(row.battery_pct),
    source: row.source,
    quality: row.quality,
    metadata: row.metadata,
  };
}

export function outdoorTemperatureFromRow(row: OutdoorTemperatureRow): OutdoorTemperatureRecord {
  return {
    houseId: row.house_id,
    locationKey: row.location_key,
    timestamp: timestamp(row.observed_at),
    temperatureC: Number(row.temperature_c),
    source: row.source,
    fetchedAt: timestamp(row.fetched_at),
    stationId: row.station_id,
    stationName: row.station_name,
    metadata: row.metadata,
  };
}

export function electricityPriceFromRow(row: ElectricityPriceRow): ElectricityPriceRecord {
  return {
    propertyId: row.property_id,
    startAt: timestamp(row.starts_at),
    endAt: timestamp(row.ends_at),
    rawPriceCentsPerKwh: Number(row.raw_price_cents_per_kwh),
    marginCentsPerKwh: Number(row.margin_cents_per_kwh),
    source: row.source,
    fetchedAt: timestamp(row.fetched_at),
    metadata: row.metadata,
  };
}

export function openingStateFromRow(row: OpeningStateRow): OpeningStateRecord {
  return {
    observationId: row.observation_id,
    houseId: row.house_id,
    floorId: row.floor_id,
    elementId: row.element_id,
    state: row.state,
    openFraction: row.open_fraction === null ? null : Number(row.open_fraction),
    source: row.source,
    observedAt: timestamp(row.observed_at),
    validUntil: row.valid_until === null ? null : timestamp(row.valid_until),
    externalId: row.external_id,
    connectionId: row.connection_id,
    recordedAt: timestamp(row.recorded_at),
    metadata: row.metadata,
  };
}

export function heatPumpStateFromRow(row: HeatPumpStateRow): HeatPumpStateRecord {
  return {
    connectionId: row.connection_id,
    houseId: row.house_id,
    equipmentId: row.equipment_id,
    deviceId: row.device_id,
    name: row.name,
    brand: row.brand,
    model: row.model,
    transport: row.transport ?? "local",
    floorId: row.floor_id ?? null,
    roomId: row.room_id ?? null,
    x: row.x == null ? null : Number(row.x),
    y: row.y == null ? null : Number(row.y),
    z: row.z == null ? null : Number(row.z),
    observedAt: timestamp(row.observed_at),
    receivedAt: timestamp(row.received_at),
    available: row.available,
    power: row.power,
    selectedMode: row.selected_mode,
    targetTemperatureC: row.target_temperature_c === null ? null : Number(row.target_temperature_c),
    currentTemperatureC: row.current_temperature_c === null ? null : Number(row.current_temperature_c),
    currentTemperatureSource: row.current_temperature_source,
    currentHumidityPercent: row.current_humidity_percent === null ? null : Number(row.current_humidity_percent),
    targetHumidityPercent: row.target_humidity_percent === null ? null : Number(row.target_humidity_percent),
    fanSpeed: row.fan_speed,
    horizontalSwing: row.horizontal_swing,
    verticalSwing: row.vertical_swing,
    freshAir: row.fresh_air,
    anion: row.anion,
    sleep: row.sleep,
    light: row.light,
    quiet: row.quiet,
    turbo: row.turbo,
    xfan: row.xfan,
    steadyHeat: row.steady_heat,
    powerSave: row.power_save,
    cleanFilter: row.clean_filter,
    waterFull: row.water_full,
    dehumidifierMode: row.dehumidifier_mode,
    compressorFrequencyHz: row.compressor_frequency_hz == null ? null : Number(row.compressor_frequency_hz),
    diagnostics: row.diagnostics ?? {},
    activity: row.activity,
    activityEvidence: row.activity_evidence,
  };
}

export function measurementBucketFromRow(row: MeasurementBucketRow): MeasurementBucketRecord {
  return {
    sensorId: row.sensor_id,
    metric: row.metric,
    bucketStart: timestamp(row.bucket_start),
    sampleCount: Number(row.sample_count),
    average: Number(row.average),
    minimum: Number(row.minimum),
    maximum: Number(row.maximum),
    canonicalUnit: row.canonical_unit,
  };
}
