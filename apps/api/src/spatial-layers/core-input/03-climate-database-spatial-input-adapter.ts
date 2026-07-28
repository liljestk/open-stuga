import {
  configuredPlanElementOpeningState,
  floorMetersPerPlanUnit,
  resolvePlanElementOpeningState,
  type AirflowPlanElement,
  type Floor,
  type House,
  type MeasurementSample,
  type OutdoorTemperatureSample,
  type OpeningStateObservation,
  type Property,
  type PropertyArea,
  type Reading,
  type Sensor,
} from "@climate-twin/contracts";
import {
  validateTopology,
  type CoordinateFrame,
  type SpatialClimateSample,
  type SpatialConnection,
  type SpatialConnectionStateInterval,
  type SpatialContextEvent,
  type SpatialLayerEngineInput,
  type SpatialSensorBinding,
  type SpatialSensorCalibration,
  type SpatialTopology,
  type SpatialZone,
  type Vector2,
  type Vector3,
} from "@climate-twin/spatial-layers";
import { outdoorLocationKey } from "../../db.js";
import type {
  HybridTelemetryReadProvenance,
  HybridTelemetryReader,
} from "../../timeseries/read-facade.js";
import type {
  SpatialConfigurationVersion,
  SpatialCoreDescription,
  SpatialCoreDataset,
  SpatialCoreInputPort,
  SpatialDataPartition,
  SpatialScope,
  StoredSpatialContextEvent,
  StoredSpatialSensorBinding,
  StoredSpatialSensorCalibration,
} from "../types.js";
import { CoreClimateReader, SpatialTelemetryReader } from "./01-spatial-telemetry-reader-to-architectural-opening-ar.js";
import { ResolvedSpatialControlData, buildHouseTopology, buildOpeningConnectionStateIntervals, buildPropertyTopology, canonicalCalibrations, canonicalContextEvents, pairSparseClimateSamples, queryMetrics, telemetryReadWarnings } from "./02-apply-architectural-opening-states-to-telemetry-read.js";

export class ClimateDatabaseSpatialInputAdapter implements SpatialCoreInputPort {
  constructor(readonly core: CoreClimateReader, readonly telemetry: SpatialTelemetryReader) {}

  listScopes(): SpatialScope[] {
    return [
      ...this.core.listProperties(10_000, 0).map((property) => ({ kind: "property" as const, id: property.id })),
      ...this.core.listHouses().map((house) => ({ kind: "house" as const, id: house.id })),
    ];
  }

  scopeExists(scope: SpatialScope): boolean {
    return scope.kind === "house" ? this.core.getHouse(scope.id) !== null : this.core.getProperty(scope.id) !== null;
  }

  housesForScope(scope: SpatialScope): House[] {
    if (scope.kind === "house") {
      const house = this.core.getHouse(scope.id);
      return house ? [house] : [];
    }
    return this.core.listHouses().filter((house) => house.propertyId === scope.id);
  }

  async describe(request: {
    partition: SpatialDataPartition;
    scope: SpatialScope;
    bucketAt: string;
    configuration: SpatialConfigurationVersion;
    bindings: StoredSpatialSensorBinding[];
  }): Promise<SpatialCoreDescription> {
    const resolved = await this.#resolveControlData(
      request.scope,
      request.bucketAt,
      request.configuration,
      request.bindings,
    );
    return { topology: resolved.built.topology, warnings: resolved.built.warnings };
  }

  async load(request: {
    partition: SpatialDataPartition;
    scope: SpatialScope;
    bucketAt: string;
    windowMinutes: number;
    requiredMetrics: string[];
    configuration: SpatialConfigurationVersion;
    bindings: StoredSpatialSensorBinding[];
    calibrations: StoredSpatialSensorCalibration[];
    contextEvents: StoredSpatialContextEvent[];
  }): Promise<SpatialCoreDataset> {
    const bucketEpoch = Date.parse(request.bucketAt);
    if (!Number.isFinite(bucketEpoch)) throw new TypeError("bucketAt must be an ISO timestamp");
    const windowStart = new Date(bucketEpoch - request.windowMinutes * 60_000).toISOString();
    const windowEnd = new Date(bucketEpoch).toISOString();
    const resolved = await this.#resolveControlData(
      request.scope,
      request.bucketAt,
      request.configuration,
      request.bindings,
    );
    let openingStateObservations: OpeningStateObservation[] = [];
    let openingProvenance: HybridTelemetryReadProvenance[] = [];
    if (resolved.house !== null) {
      if (this.telemetry.openingStateSnapshot && this.telemetry.openingStateHistory) {
        const [leading, history] = await Promise.all([
          this.telemetry.openingStateSnapshot({ houseId: resolved.house.id, at: windowStart, limit: 10_000 }),
          this.telemetry.openingStateHistory({
            houseId: resolved.house.id,
            from: windowStart,
            to: windowEnd,
            limit: 10_000,
          }),
        ]);
        openingStateObservations = [...leading.records, ...history.records];
        openingProvenance = [leading.provenance, history.provenance];
      } else {
        openingStateObservations = [
          ...this.core.listOpeningStateObservations(resolved.house.id, 10_000, windowStart),
          ...this.core.listOpeningStateObservationHistory(resolved.house.id, windowStart, windowEnd, 10_000),
        ];
      }
      openingStateObservations = [...new Map(
        openingStateObservations.map((observation) => [observation.id, observation]),
      ).values()].sort((left, right) => (
        left.observedAt.localeCompare(right.observedAt) || left.id.localeCompare(right.id)
      ));
    }
    const measurements = await this.telemetry.measurementWindow({
      sensorIds: resolved.sensors.map((sensor) => sensor.id),
      metrics: queryMetrics(request.requiredMetrics),
      from: windowStart,
      to: windowEnd,
      limit: 250_000,
    });
    const outdoorReads = await Promise.all(resolved.houses.map((candidate) => this.telemetry.outdoorTemperatureHistory({
      houseId: candidate.id,
      locationKey: outdoorLocationKey(candidate.location),
      from: windowStart,
      to: windowEnd,
      limit: 20_000,
    })));
    const sparseSamples = measurements.records;
    const outdoorTemperature = outdoorReads.flatMap((result) => result.records);
    const engineInput: SpatialLayerEngineInput = {
      scope: request.scope,
      topology: resolved.built.topology,
      ...(resolved.house === null ? {} : {
        connectionStateIntervals: buildOpeningConnectionStateIntervals({
          house: resolved.house,
          sensors: resolved.sensors,
          bindings: request.bindings,
          topology: resolved.built.topology,
          openingStateObservations,
          windowStart,
          windowEnd,
          configuration: request.configuration.config,
        }),
      }),
      samples: pairSparseClimateSamples(sparseSamples),
      calibrations: canonicalCalibrations(request.calibrations),
      contextEvents: canonicalContextEvents(request.contextEvents),
      generatedAt: request.bucketAt,
      windowStart,
      windowEnd,
      configVersion: String(request.configuration.version),
      targetBucketSeconds: 60,
      config: request.configuration.config,
    };
    return {
      engineInput,
      house: resolved.house,
      property: resolved.property,
      houses: resolved.houses,
      propertyAreas: resolved.propertyAreas,
      sensors: resolved.sensors,
      sparseSamples,
      outdoorTemperature,
      topology: resolved.built.topology,
      warnings: [
        ...resolved.built.warnings,
        ...telemetryReadWarnings([
          measurements.provenance,
          ...outdoorReads.map((result) => result.provenance),
          ...openingProvenance,
        ]),
      ],
    };
  }

  async #resolveControlData(
    scope: SpatialScope,
    bucketAt: string,
    configuration: SpatialConfigurationVersion,
    bindings: StoredSpatialSensorBinding[],
  ): Promise<ResolvedSpatialControlData> {
    if (!Number.isFinite(Date.parse(bucketAt))) throw new TypeError("bucketAt must be an ISO timestamp");
    const houses = this.housesForScope(scope);
    const house = scope.kind === "house" ? houses[0] ?? null : null;
    const property = scope.kind === "property"
      ? this.core.getProperty(scope.id)
      : house ? this.core.getProperty(house.propertyId) : null;
    if ((scope.kind === "house" && !house) || (scope.kind === "property" && !property)) {
      throw new Error(`${scope.kind} ${scope.id} does not exist`);
    }
    const sensors = houses.flatMap((candidate) => this.core.listSensors(candidate.id)).filter((sensor) => sensor.enabled);
    const openingStateObservations = house
      ? this.telemetry.openingStateSnapshot
        ? (await this.telemetry.openingStateSnapshot({ houseId: house.id, at: bucketAt, limit: 10_000 })).records
        : this.core.listOpeningStateObservations(house.id, 10_000, bucketAt)
      : [];
    const built = house
      ? buildHouseTopology({ house, sensors, bindings, at: bucketAt, configuration: configuration.config,
        openingStateObservations })
      : buildPropertyTopology({ property: property!, houses, sensors, at: bucketAt, configuration: configuration.config });
    return {
      house,
      property,
      houses,
      propertyAreas: property ? this.core.listPropertyAreas(property.id, 10_000, 0) : [],
      sensors,
      built,
    };
  }
}
