import type {
  AreaEquipment,
  AreaEquipmentInput,
  Property,
  PropertyArea,
  PropertyAreaInput,
  PropertyAreaPatch,
  PropertyPatch,
} from "@climate-twin/contracts";
import type { EnergyCostAggregateQuery, EnergyCostAggregateRecord, PowerCostAggregateQuery } from "../../timeseries/types.js";
import { LocalMaintenanceTaskRevisionActor } from "../support/02-equipment-attachment-row-to-sensor-data-gap-state.js";
import "../core.js";

declare module "../core.js" {
  interface DatabaseInternals {
    energyCostAggregate(query: EnergyCostAggregateQuery): EnergyCostAggregateRecord;
    powerCostAggregate(query: PowerCostAggregateQuery): EnergyCostAggregateRecord;
    updateProperty(id: string, patch: PropertyPatch): Property | null;
    deleteProperty(id: string): boolean;
    listPropertyAreas(propertyId?: string, limit?: number, offset?: number): PropertyArea[];
    getPropertyArea(id: string): PropertyArea | null;
    createPropertyArea(input: PropertyAreaInput): PropertyArea;
    updatePropertyArea(id: string, patch: PropertyAreaPatch, actor?: LocalMaintenanceTaskRevisionActor): PropertyArea | null;
    deletePropertyArea(id: string): boolean;
    listAreaEquipment(filters?: {
            propertyId?: string;
            areaId?: string;
            houseId?: string;
            limit?: number;
            offset?: number;
        }): AreaEquipment[];
    getAreaEquipment(id: string): AreaEquipment | null;
    createAreaEquipment(input: AreaEquipmentInput): AreaEquipment;
  }

  interface ClimateDatabaseCore {
    energyCostAggregate(query: EnergyCostAggregateQuery): EnergyCostAggregateRecord;
    powerCostAggregate(query: PowerCostAggregateQuery): EnergyCostAggregateRecord;
    updateProperty(id: string, patch: PropertyPatch): Property | null;
    deleteProperty(id: string): boolean;
    listPropertyAreas(propertyId?: string, limit?: number, offset?: number): PropertyArea[];
    getPropertyArea(id: string): PropertyArea | null;
    createPropertyArea(input: PropertyAreaInput): PropertyArea;
    updatePropertyArea(id: string, patch: PropertyAreaPatch, actor?: LocalMaintenanceTaskRevisionActor): PropertyArea | null;
    deletePropertyArea(id: string): boolean;
    listAreaEquipment(filters?: {
            propertyId?: string;
            areaId?: string;
            houseId?: string;
            limit?: number;
            offset?: number;
        }): AreaEquipment[];
    getAreaEquipment(id: string): AreaEquipment | null;
    createAreaEquipment(input: AreaEquipmentInput): AreaEquipment;
  }
}
