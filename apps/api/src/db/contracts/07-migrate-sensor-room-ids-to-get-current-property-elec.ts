import type {
  Property,
  PropertyElectricityConfig,
  PropertyElectricityConfigInput,
  PropertyElectricityPricePoint,
  PropertyCreateInput,
  StugubyPropertyLink,
} from "@climate-twin/contracts";
import "../core.js";

declare module "../core.js" {
  interface DatabaseInternals {
    migrateSensorRoomIds(): void;
    seed(): void;
    close(): void;
    listProperties(limit?: number, offset?: number): Property[];
    getProperty(id: string): Property | null;
    setPropertyStugubyLink(id: string, link: StugubyPropertyLink | null): Property | null;
    assertTelemetryResourceIdAvailable(
        resourceType: "property" | "house" | "sensor",
        resourceId: string,
      ): void;
    createProperty(input: PropertyCreateInput): Property;
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
  }

  interface ClimateDatabaseCore {
    seed(): void;
    close(): void;
    listProperties(limit?: number, offset?: number): Property[];
    getProperty(id: string): Property | null;
    setPropertyStugubyLink(id: string, link: StugubyPropertyLink | null): Property | null;
    createProperty(input: PropertyCreateInput): Property;
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
  }
}
