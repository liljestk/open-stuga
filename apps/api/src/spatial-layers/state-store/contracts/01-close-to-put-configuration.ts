import type {
  SpatialConfigurationVersion,
  SpatialDataPartition,
  SpatialScope,
} from "../../types.js";
import "../core.js";

declare module "../core.js" {
  interface SpatialLayerStateStoreInternals {
    close(): void;
    transaction<T>(operation: () => T): T;
    migrate(): void;
    rekeyLegacySourceDatabaseId(legacySourceDbId: string, stableSourceDbId: string): {
            migratedModes: SpatialDataPartition["dataMode"][];
            migratedRows: number;
        };
    getCurrentConfiguration(partition: SpatialDataPartition, scope: SpatialScope): SpatialConfigurationVersion;
    putConfiguration(input: {
            partition: SpatialDataPartition;
            scope: SpatialScope;
            baseVersion: number;
            config: Record<string, unknown>;
            createdAt?: string;
            createdBy?: string | null;
        }): SpatialConfigurationVersion;
  }

  interface SpatialLayerStateStoreCore {
    close(): void;
    rekeyLegacySourceDatabaseId(legacySourceDbId: string, stableSourceDbId: string): {
            migratedModes: SpatialDataPartition["dataMode"][];
            migratedRows: number;
        };
    getCurrentConfiguration(partition: SpatialDataPartition, scope: SpatialScope): SpatialConfigurationVersion;
    putConfiguration(input: {
            partition: SpatialDataPartition;
            scope: SpatialScope;
            baseVersion: number;
            config: Record<string, unknown>;
            createdAt?: string;
            createdBy?: string | null;
        }): SpatialConfigurationVersion;
  }
}
