import type {
  MeasurementSample,
  OpeningStateObservation,
  OutdoorConditions,
  OutdoorTemperatureSample,
  PropertyElectricityPricePoint,
  Reading,
} from "@climate-twin/contracts";
import type {
  ElectricityPriceRecord,
  LegacyReadingRecord,
  MeasurementSampleRecord,
  OpeningStateRecord,
  OutdoorTemperatureRecord,
} from "./types.js";

export type SourcedElectricityPrice = PropertyElectricityPricePoint & { source: string };

export function compareText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

export function compareMeasurements(left: MeasurementSample, right: MeasurementSample): number {
  return compareText(left.timestamp, right.timestamp)
    || compareText(left.sensorId, right.sensorId)
    || compareText(left.metric, right.metric)
    || compareText(left.source, right.source);
}

export function compareReadings(left: Reading, right: Reading): number {
  return compareText(left.timestamp, right.timestamp)
    || compareText(left.sensorId, right.sensorId)
    || compareText(left.source, right.source);
}

export function compareOutdoor(left: OutdoorTemperatureSample, right: OutdoorTemperatureSample): number {
  return compareText(left.timestamp, right.timestamp)
    || compareText(left.houseId, right.houseId)
    || compareText(left.locationKey, right.locationKey)
    || compareText(left.source, right.source);
}

export function compareElectricityPrices(left: SourcedElectricityPrice, right: SourcedElectricityPrice): number {
  return compareText(left.startAt, right.startAt) || compareText(left.source, right.source);
}

export function compareOpeningStates(left: OpeningStateObservation, right: OpeningStateObservation): number {
  return compareText(left.observedAt, right.observedAt) || compareText(left.id, right.id);
}

export const measurementKey = (record: MeasurementSample): string => (
  JSON.stringify([record.sensorId, record.metric, record.timestamp, record.source])
);
export const measurementCoverageKey = (record: { sensorId: string; metric: string }): string => (
  JSON.stringify([record.sensorId, record.metric])
);
export const readingKey = (record: Reading): string => (
  JSON.stringify([record.sensorId, record.timestamp, record.source])
);
export const outdoorKey = (record: OutdoorTemperatureSample): string => (
  JSON.stringify([record.houseId, record.locationKey, record.timestamp, record.source])
);
export const electricityPriceKey = (record: SourcedElectricityPrice): string => (
  JSON.stringify([record.propertyId, record.startAt])
);
export const openingStateKey = (record: OpeningStateObservation): string => record.id;
export const openingStateIdentityKey = (record: OpeningStateObservation): string => JSON.stringify([
  record.floorId,
  record.elementId,
  record.source,
  record.externalId ?? "",
  record.connectionId ?? "",
]);

export function archivedElectricityPrice(record: ElectricityPriceRecord): SourcedElectricityPrice {
  const effectivePriceCentsPerKwh = record.rawPriceCentsPerKwh + record.marginCentsPerKwh;
  return {
    propertyId: record.propertyId,
    startAt: record.startAt,
    endAt: record.endAt,
    rawPriceCentsPerKwh: record.rawPriceCentsPerKwh,
    effectivePriceCentsPerKwh,
    effectivePriceEurPerKwh: effectivePriceCentsPerKwh / 100,
    fetchedAt: record.fetchedAt,
    source: record.source,
  };
}

export function archivedMeasurement(record: MeasurementSampleRecord): MeasurementSample {
  return {
    sensorId: record.sensorId,
    metric: record.metric,
    value: record.value,
    canonicalUnit: record.canonicalUnit,
    timestamp: record.timestamp,
    source: record.source as MeasurementSample["source"],
    quality: record.quality as MeasurementSample["quality"],
  };
}

export function archivedReading(record: LegacyReadingRecord): Reading {
  return {
    sensorId: record.sensorId,
    timestamp: record.timestamp,
    temperature: record.temperature,
    humidity: record.humidity,
    battery: record.battery,
    source: record.source as Reading["source"],
    quality: record.quality as Reading["quality"],
  };
}

function objectValue(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

export function archivedOutdoor(record: OutdoorTemperatureRecord): OutdoorTemperatureSample {
  const metadata = objectValue(record.metadata);
  const conditions = objectValue(metadata?.conditions) as OutdoorConditions | null;
  return {
    houseId: record.houseId,
    locationKey: record.locationKey,
    timestamp: record.timestamp,
    temperatureC: record.temperatureC,
    source: record.source as OutdoorTemperatureSample["source"],
    fetchedAt: record.fetchedAt,
    stationId: record.stationId,
    stationName: record.stationName,
    ...(conditions ? { conditions } : {}),
  };
}

export function archivedOpeningState(record: OpeningStateRecord): OpeningStateObservation {
  return {
    id: record.observationId,
    houseId: record.houseId,
    floorId: record.floorId,
    elementId: record.elementId,
    state: record.state,
    ...(record.openFraction === null ? {} : { openFraction: record.openFraction }),
    source: record.source as OpeningStateObservation["source"],
    observedAt: record.observedAt,
    ...(record.validUntil === null ? {} : { validUntil: record.validUntil }),
    ...(record.externalId === null ? {} : { externalId: record.externalId }),
    ...(record.connectionId === null ? {} : { connectionId: record.connectionId }),
  };
}
