import type {
  BatchWriteResult,
  ColdStorageMode,
  ElectricityPriceRecord,
  HeatPumpStateRecord,
  LegacyReadingRecord,
  MeasurementSampleRecord,
  OpeningStateRecord,
  OutdoorTemperatureRecord,
  QueryControl,
  TelemetrySchemaInitResult,
} from "../../types.js";
import { ProcedureFeatureRow } from "../support/01-default-schema-to-measurement-bucket-from-row.js";
import "../core.js";

declare module "../core.js" {
  interface TimeseriesStoreInternals {
    initialize(control?: QueryControl): Promise<TelemetrySchemaInitResult>;
    invalidateInitialization(): void;
    __initialize(control: QueryControl): Promise<TelemetrySchemaInitResult>;
    __detectTimescaleFeatures(control: QueryControl): Promise<ProcedureFeatureRow>;
    __assertNoRawRetentionPolicy(control: QueryControl): Promise<void>;
    __configureColdStorage(
        hypertables: readonly string[],
        features: ProcedureFeatureRow,
        warnings: string[],
        control: QueryControl,
      ): Promise<ColdStorageMode>;
    __configureContinuousAggregates(
        features: ProcedureFeatureRow,
        warnings: string[],
        control: QueryControl,
      ): Promise<"continuous" | "view" | "unavailable">;
    __configureFallbackAggregates(
        warnings: string[],
        control: QueryControl,
        preserveContinuousAggregates?: boolean ,
      ): Promise<"continuous" | "view" | "unavailable">;
    __relationKind(relation: string, control: QueryControl): Promise<string | null>;
    __isContinuousAggregate(relation: string, control: QueryControl): Promise<boolean>;
    upsertMeasurementSamples(samples: readonly MeasurementSampleRecord[], control?: QueryControl): Promise<BatchWriteResult>;
    upsertLegacyReadings(readings: readonly LegacyReadingRecord[], control?: QueryControl): Promise<BatchWriteResult>;
    upsertOutdoorTemperatureSamples(samples: readonly OutdoorTemperatureRecord[], control?: QueryControl): Promise<BatchWriteResult>;
    upsertElectricityPriceSamples(samples: readonly ElectricityPriceRecord[], control?: QueryControl): Promise<BatchWriteResult>;
    upsertOpeningStateSamples(samples: readonly OpeningStateRecord[], control?: QueryControl): Promise<BatchWriteResult>;
    upsertHeatPumpStateSamples(samples: readonly HeatPumpStateRecord[], control?: QueryControl): Promise<BatchWriteResult>;
  }

  interface TimeseriesStoreCore {
    initialize(control?: QueryControl): Promise<TelemetrySchemaInitResult>;
    invalidateInitialization(): void;
    upsertMeasurementSamples(samples: readonly MeasurementSampleRecord[], control?: QueryControl): Promise<BatchWriteResult>;
    upsertLegacyReadings(readings: readonly LegacyReadingRecord[], control?: QueryControl): Promise<BatchWriteResult>;
    upsertOutdoorTemperatureSamples(samples: readonly OutdoorTemperatureRecord[], control?: QueryControl): Promise<BatchWriteResult>;
    upsertElectricityPriceSamples(samples: readonly ElectricityPriceRecord[], control?: QueryControl): Promise<BatchWriteResult>;
    upsertOpeningStateSamples(samples: readonly OpeningStateRecord[], control?: QueryControl): Promise<BatchWriteResult>;
    upsertHeatPumpStateSamples(samples: readonly HeatPumpStateRecord[], control?: QueryControl): Promise<BatchWriteResult>;
  }
}
