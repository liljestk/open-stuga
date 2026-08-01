import type { HouseLocation, StugubyPropertyLink } from "./building-structure.js";

/** A managed parcel or estate that groups buildings and outdoor areas. */
export interface Property {
  id: string;
  name: string;
  description: string | null;
  /** Default Property weather reference and map centre before other geometry is available. */
  location: HouseLocation | null;
  /** Present only when this row is the local projection of a Stuguby Property. */
  stuguby?: StugubyPropertyLink;
  createdAt: string;
  updatedAt: string;
}

export type ElectricityPriceProvider = "porssisahko" | "custom";

export type ElectricityContractType = "spot" | "fixed" | "other";

/** Property-owned price source and the small set of contract adjustments used for cost estimates. */
export interface PropertyElectricityConfig {
  propertyId: string;
  provider: ElectricityPriceProvider;
  /** A JSON feed compatible with the Pörssisähkö `prices` response shape. */
  endpointUrl: string;
  enabled: boolean;
  marginCentsPerKwh: number;
  contractType: ElectricityContractType;
  contractName: string | null;
  retailer: string | null;
  monthlyFeeEur: number | null;
  lastFetchedAt: string | null;
  lastError: string | null;
  updatedAt: string;
}

export type PropertyElectricityConfigInput = Pick<PropertyElectricityConfig,
  "provider" | "endpointUrl" | "enabled" | "marginCentsPerKwh" | "contractType"
> & Partial<Pick<PropertyElectricityConfig, "contractName" | "retailer" | "monthlyFeeEur">>;

/** Raw source values are retained in cents/kWh; effective values are derived and never overwrite them. */
export interface PropertyElectricityPricePoint {
  propertyId: string;
  startAt: string;
  endAt: string;
  rawPriceCentsPerKwh: number;
  effectivePriceCentsPerKwh: number;
  effectivePriceEurPerKwh: number;
  fetchedAt: string;
}

export interface EnergyOptimizationWindow {
  startAt: string;
  endAt: string;
  averagePriceCentsPerKwh: number;
  relativeToAveragePercent: number;
  rank: "best" | "good" | "expensive";
}

export interface EnergyOptimizationInsight {
  id: string;
  severity: "info" | "opportunity" | "warning";
  title: string;
  explanation: string;
  estimatedSavingsEur: number | null;
}

/** Read-only, reproducible optimization report. It never controls equipment. */
export interface EnergyOptimizationReport {
  propertyId: string;
  generatedAt: string;
  priceCoverageFrom: string | null;
  priceCoverageUntil: string | null;
  averagePriceCentsPerKwh: number | null;
  currentPriceCentsPerKwh: number | null;
  currentPricePercentile: number | null;
  suggestedWindows: EnergyOptimizationWindow[];
  recentDailyConsumptionKwh: number | null;
  estimatedDailyCostEur: number | null;
  baselinePowerWatts: number | null;
  peakPowerWatts: number | null;
  insights: EnergyOptimizationInsight[];
  limitations: string[];
}

/**
 * House-authorized projection used for Home consumption and running-cost UI.
 * Contract/source identity and the unadjusted upstream price are deliberately
 * excluded because those remain Property-administration data.
 */
export type HomeElectricityPricePoint = Pick<PropertyElectricityPricePoint,
  "startAt" | "endAt" | "effectivePriceCentsPerKwh" | "effectivePriceEurPerKwh" | "fetchedAt"
>;

/** The telemetry model used to derive one source's consumption. */
export type HomeEnergyConsumptionBasis = "energy_counter" | "integrated_power";

/** Confidence in the time allocation used for a displayed cost. */
export type HomeEnergyCostQuality = "measured" | "estimated" | "partial";

/** Whether the calculation source has been acknowledged by the time-series archive. */
export type HomeEnergyArchiveState = "local-only" | "pending" | "archived";

/** Time-aligned energy cost for one Home electricity source. */
export interface HomeEnergyCost {
  houseId: string;
  sensorId: string;
  from: string;
  to: string;
  measurementBasis: HomeEnergyConsumptionBasis;
  consumptionKwh: number | null;
  pricedConsumptionKwh: number | null;
  costEur: number | null;
  priceCoveragePercent: number;
  measurementCoverageFrom: string | null;
  measurementCoverageUntil: string | null;
  quality: HomeEnergyCostQuality;
  archiveState: HomeEnergyArchiveState;
  complete: boolean;
  calculatedAt: string;
}

export const HOME_ENERGY_SUMMARY_ALGORITHM_VERSION = "home-energy-summary/v2" as const;

/**
 * Server-authoritative aggregation across every electricity source visible in
 * one Home. Per-source contributions retain the model and completeness needed
 * to audit the combined values.
 */
export interface HomeEnergySummary {
  schemaVersion: 2;
  algorithmVersion: typeof HOME_ENERGY_SUMMARY_ALGORITHM_VERSION;
  houseId: string;
  from: string;
  to: string;
  consumptionKwh: number | null;
  pricedConsumptionKwh: number | null;
  costEur: number | null;
  priceCoveragePercent: number;
  quality: HomeEnergyCostQuality;
  archiveState: HomeEnergyArchiveState;
  aggregationMode: "whole_home" | "independent_sources" | "submeters_only";
  complete: boolean;
  sourceCount: number;
  totalSources: number;
  excludedSourceCount: number;
  failedSourceCount: number;
  contributions: HomeEnergyCost[];
  calculatedAt: string;
}

export const DEFAULT_ELECTRICITY_PRICE_ENDPOINT = "https://api.porssisahko.net/v2/latest-prices.json" as const;

export type PropertyCreateInput = Pick<Property, "name"> & Partial<Pick<Property, "id" | "description" | "location">>;

export type PropertyPatch = Partial<Pick<Property, "name" | "description" | "location">>;

/** One WGS84 property-map coordinate. */
export interface GeoCoordinate {
  latitude: number;
  longitude: number;
}

export type PropertyAreaKind =
  | "well"
  | "beach"
  | "garage"
  | "plantation"
  | "garden"
  | "field"
  | "forest"
  | "shoreline"
  | "dock"
  | "road"
  | "yard"
  | "building"
  | "other";

/** A named outdoor area or fixed-position asset within a property. */
export interface PropertyArea {
  id: string;
  propertyId: string;
  name: string;
  kind: PropertyAreaKind;
  description: string | null;
  /** Optional fixed position for point assets such as wells, sheds, and tanks. */
  location?: GeoCoordinate;
  /** Empty for point assets; boundaries are closed implicitly and must not repeat their first vertex. */
  polygon: GeoCoordinate[];
  createdAt: string;
  updatedAt: string;
}

export type PropertyAreaInput = Pick<PropertyArea, "propertyId" | "name" | "kind" | "polygon">
  & Partial<Pick<PropertyArea, "id" | "description" | "location">>;

/** Updating propertyId moves the complete area aggregate, including its equipment and scoped context. */
export type PropertyAreaPatch = Partial<Pick<PropertyArea, "propertyId" | "name" | "kind" | "description" | "polygon">> & {
  location?: GeoCoordinate | null;
};

export type AreaEquipmentStatus = "active" | "out-of-service" | "retired";

/**
 * One Property-owned maintainable or trackable item.
 *
 * `areaId` and `houseId` describe the expected location and are mutually
 * exclusive. Both may be null for an unassigned item. `location` is an
 * optional manually pinned expected point; a derived tracking position never
 * overwrites any of these fields.
 */
export interface AreaEquipment {
  id: string;
  propertyId: string;
  areaId: string | null;
  houseId?: string | null;
  location?: GeoCoordinate;
  name: string;
  kind: string;
  manufacturer: string | null;
  model: string | null;
  serialNumber: string | null;
  status: AreaEquipmentStatus;
  notes: string | null;
  createdAt: string;
  updatedAt: string;
}

export type AreaEquipmentInput = Pick<AreaEquipment, "name" | "kind">
  & Partial<Pick<AreaEquipment,
    "id" | "propertyId" | "areaId" | "houseId" | "location"
    | "manufacturer" | "model" | "serialNumber" | "status" | "notes"
  >>;

export type AreaEquipmentPatch = Partial<Pick<AreaEquipment,
  "areaId" | "houseId" | "name" | "kind" | "manufacturer" | "model" | "serialNumber" | "status" | "notes"
>> & {
  location?: GeoCoordinate | null;
};

export type EquipmentAttachmentKind = "photo" | "document";

/** Metadata for one locally stored photo, manual, or related document. */
export interface EquipmentAttachment {
  id: string;
  equipmentId: string;
  kind: EquipmentAttachmentKind;
  name: string;
  mimeType: string;
  size: number;
  createdAt: string;
}

export interface EquipmentAttachmentUploadInput {
  kind: EquipmentAttachmentKind;
  name: string;
  mimeType: string;
  /** Base64 bytes, optionally prefixed by a data URL. */
  data: string;
}

/** A labelled HTTP(S) reference to manufacturer or other relevant information. */
export interface EquipmentLink {
  id: string;
  equipmentId: string;
  label: string;
  url: string;
  createdAt: string;
  updatedAt: string;
}

export type EquipmentLinkInput = Pick<EquipmentLink, "label" | "url">;

export type EquipmentLinkPatch = Partial<EquipmentLinkInput>;

/**
 * One consistent, Property-scoped inventory read for companion clients.
 * `syncToken` is opaque and changes whenever a visible area or equipment
 * record, attachment, or link changes; tracking state continues to join by
 * `AreaEquipment.id`.
 */
export interface PropertyInventorySnapshot {
  propertyId: string;
  generatedAt: string;
  syncToken: string;
  areas: PropertyArea[];
  equipment: AreaEquipment[];
  attachments: EquipmentAttachment[];
  links: EquipmentLink[];
}
