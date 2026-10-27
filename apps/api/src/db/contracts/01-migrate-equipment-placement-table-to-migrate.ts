import type {
  MeasurementSample,
  Reading,
  SecurityAuditEvent,
} from "@climate-twin/contracts";
import { DemoTelemetryPurgeResult, IntegrationMappingKind, IntegrationMappingSet, SecurityAuditEventInput, TelemetryArchiveTable, TelemetryArchiveWatermarks } from "../support/01-json-value-to-area-equipment-row.js";
import "../core.js";

declare module "../core.js" {
  interface DatabaseInternals {
    migrateEquipmentPlacementTable(): void;
    isRealDataMode(): boolean;
    realDataModeActivatedAt(): string | null;
    mockScenarioId(): string | null;
    recordSecurityAuditEvent(input: SecurityAuditEventInput): SecurityAuditEvent;
    listSecurityAuditEvents(limit?: number, offset?: number): SecurityAuditEvent[];
    setMockScenarioId(scenario: string): void;
    telemetryArchiveSourceId(): string;
    getIntegrationMappingSet<T>(kind: IntegrationMappingKind): IntegrationMappingSet<T> | null;
    saveIntegrationMappingSet<T>(kind: IntegrationMappingKind, mappings: readonly T[]): IntegrationMappingSet<T>;
    telemetryArchiveCheckpoint(table: TelemetryArchiveTable): number;
    saveTelemetryArchiveCheckpoint(table: TelemetryArchiveTable, rowId: number): void;
    telemetryArchiveDirtyCount(): number;
    telemetryArchiveWatermarks(): TelemetryArchiveWatermarks;
    activateRealDataMode(): DemoTelemetryPurgeResult;
    purgeSourceLabelledDemoTelemetry(): void;
    purgeSharedHomeLocalState(houseId?: string): void;
    prepareTelemetrySources(sources: Array<MeasurementSample["source"] | Reading["source"]>): void;
    migrate(): void;
  }

  interface ClimateDatabaseCore {
    isRealDataMode(): boolean;
    realDataModeActivatedAt(): string | null;
    mockScenarioId(): string | null;
    recordSecurityAuditEvent(input: SecurityAuditEventInput): SecurityAuditEvent;
    listSecurityAuditEvents(limit?: number, offset?: number): SecurityAuditEvent[];
    setMockScenarioId(scenario: string): void;
    telemetryArchiveSourceId(): string;
    getIntegrationMappingSet<T>(kind: IntegrationMappingKind): IntegrationMappingSet<T> | null;
    saveIntegrationMappingSet<T>(kind: IntegrationMappingKind, mappings: readonly T[]): IntegrationMappingSet<T>;
    telemetryArchiveCheckpoint(table: TelemetryArchiveTable): number;
    saveTelemetryArchiveCheckpoint(table: TelemetryArchiveTable, rowId: number): void;
    telemetryArchiveDirtyCount(): number;
    telemetryArchiveWatermarks(): TelemetryArchiveWatermarks;
    activateRealDataMode(): DemoTelemetryPurgeResult;
    purgeSharedHomeLocalState(houseId?: string): void;
    migrate(): void;
  }
}
