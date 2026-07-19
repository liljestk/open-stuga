import {
  immutableDependencySnapshots,
  type SpatialLayerEngineManifest,
  type SpatialLayerSnapshot,
} from "@climate-twin/spatial-layers";
import type { SpatialSnapshotNotifier } from "./notifier.js";
import {
  SpatialExecutionAbortedError,
  SpatialExecutionTimeoutError,
  type SpatialEngineExecutor,
} from "./executor.js";
import { SpatialLayerStateStore } from "./state-store.js";
import type {
  PersistedSpatialLayerSnapshot,
  SpatialConfigurationVersion,
  SpatialCoreDataset,
  SpatialCoreInputPort,
  SpatialDataPartition,
  SpatialEngineAssignment,
  SpatialEngineHealth,
  SpatialEngineRegistryPort,
  SpatialScope,
} from "./types.js";

const DEFAULT_WINDOWS_MINUTES: Record<string, number> = {
  "climate-scalars": 90,
  "graph-propagation": 90,
  "unexplained-activity": 180,
};

export interface SpatialEngineHostLogger {
  info?(fields: Record<string, unknown>, message: string): void;
  warn?(fields: Record<string, unknown>, message: string): void;
  error?(fields: Record<string, unknown>, message: string): void;
}

export interface SpatialEngineRunReport {
  scope: SpatialScope;
  bucketAt: string;
  status: "succeeded" | "partial" | "failed" | "disabled";
  snapshots: PersistedSpatialLayerSnapshot[];
  failures: Array<{ engineId: string; code: string; message: string }>;
}

export interface SpatialScopeOverview {
  partition: SpatialDataPartition;
  scope: SpatialScope;
  configuration: SpatialConfigurationVersion;
  assignments: SpatialEngineAssignment[];
  topology: SpatialCoreDataset["topology"];
  warnings: string[];
}

function sameScope(left: SpatialScope, right: SpatialScope): boolean {
  return left.kind === right.kind && left.id === right.id;
}

function errorDetails(error: unknown): { code: string; message: string } {
  if (error instanceof SpatialDataModeChangedError) return { code: "DATA_MODE_CHANGED", message: error.message };
  if (error instanceof SpatialDependencyExecutionError) return { code: "DEPENDENCY_FAILED", message: error.message };
  if (error instanceof SpatialExecutionTimeoutError) return { code: "ENGINE_TIMEOUT", message: error.message };
  if (error instanceof SpatialExecutionAbortedError) return { code: "ENGINE_ABORTED", message: error.message };
  if (error instanceof Error) return { code: "ENGINE_FAILURE", message: error.message };
  return { code: "ENGINE_FAILURE", message: "Unknown spatial engine failure" };
}

class SpatialDependencyExecutionError extends Error {}

interface SpatialExecutionPlanItem {
  assignment: SpatialEngineAssignment;
  manifest: SpatialLayerEngineManifest;
  persistOutputs: boolean;
}

interface SpatialExecutionPlan {
  items: SpatialExecutionPlanItem[];
  failures: Array<{ engineId: string; code: string; message: string }>;
}

function buildExecutionPlan(
  registry: SpatialEngineRegistryPort,
  assignments: SpatialEngineAssignment[],
  requestedLayerIds: string[],
): SpatialExecutionPlan {
  const assignmentByEngine = new Map(assignments.map((assignment) => [assignment.engineId, assignment]));
  const roots = assignments.filter(
    (assignment) => assignment.enabled && requestedAssignmentLayers(assignment, requestedLayerIds).length > 0,
  );
  const validRoots: string[] = [];
  const failures: SpatialExecutionPlan["failures"] = [];

  const validateClosure = (engineId: string, visiting: Set<string>, visited: Set<string>): void => {
    if (visited.has(engineId)) return;
    if (visiting.has(engineId)) throw new Error(`Spatial layer engine dependency cycle at ${engineId}`);
    const assignment = assignmentByEngine.get(engineId);
    if (!assignment) throw new Error(`No engine assignment exists for required dependency ${engineId}`);
    const manifest = registry.resolve(engineId).manifest;
    if (manifest.version !== assignment.engineVersion) {
      throw new Error(`Assigned ${engineId}@${assignment.engineVersion} is unavailable; installed version is ${manifest.version}`);
    }
    visiting.add(engineId);
    for (const dependencyId of manifest.dependencies ?? []) validateClosure(dependencyId, visiting, visited);
    visiting.delete(engineId);
    visited.add(engineId);
  };

  for (const root of roots) {
    try {
      validateClosure(root.engineId, new Set(), new Set());
      validRoots.push(root.engineId);
    } catch (error) {
      failures.push({
        engineId: root.engineId,
        code: "DEPENDENCY_CONFIGURATION_ERROR",
        message: error instanceof Error ? error.message : "Invalid engine dependency configuration",
      });
    }
  }

  const ordered: string[] = [];
  const visited = new Set<string>();
  const visit = (engineId: string): void => {
    if (visited.has(engineId)) return;
    const manifest = registry.resolve(engineId).manifest;
    for (const dependencyId of manifest.dependencies ?? []) visit(dependencyId);
    visited.add(engineId);
    ordered.push(engineId);
  };
  for (const engineId of validRoots) visit(engineId);

  return {
    items: ordered.map((engineId) => {
      const assignment = assignmentByEngine.get(engineId)!;
      return {
        assignment,
        manifest: registry.resolve(engineId).manifest,
        persistOutputs: assignment.enabled && requestedAssignmentLayers(assignment, requestedLayerIds).length > 0,
      };
    }),
    failures,
  };
}

function configuredWindow(configuration: SpatialConfigurationVersion, engineId: string): number {
  const windows = configuration.config.engineWindowsMinutes;
  const candidate = windows && typeof windows === "object" && !Array.isArray(windows)
    ? (windows as Record<string, unknown>)[engineId]
    : undefined;
  return typeof candidate === "number" && Number.isFinite(candidate)
    ? Math.max(5, Math.min(24 * 60, Math.round(candidate)))
    : DEFAULT_WINDOWS_MINUTES[engineId] ?? 90;
}

function requestedAssignmentLayers(assignment: SpatialEngineAssignment, requested: string[]): string[] {
  if (requested.length === 0) return assignment.layerIds;
  return assignment.layerIds.filter((layerId) => requested.includes(layerId));
}

function validateOutputs(
  manifest: SpatialLayerEngineManifest,
  assignment: SpatialEngineAssignment,
  scope: SpatialScope,
  bucketAt: string,
  snapshots: SpatialLayerSnapshot[],
): SpatialLayerSnapshot[] {
  const allowed = new Set(assignment.layerIds);
  const seen = new Set<string>();
  return snapshots.filter((snapshot) => {
    if (!sameScope(snapshot.scope, scope)) throw new Error(`Engine ${manifest.id} returned a snapshot for another scope`);
    if (snapshot.model.id !== manifest.id || snapshot.model.version !== manifest.version) {
      throw new Error(`Engine ${manifest.id} returned mismatched model provenance`);
    }
    if (snapshot.generatedAt !== new Date(bucketAt).toISOString()) {
      throw new Error(`Engine ${manifest.id} returned an unexpected generatedAt`);
    }
    if (!manifest.producedLayerIds.includes(snapshot.layerId)) {
      throw new Error(`Engine ${manifest.id} returned undeclared layer ${snapshot.layerId}`);
    }
    if (seen.has(snapshot.layerId)) throw new Error(`Engine ${manifest.id} returned layer ${snapshot.layerId} twice`);
    seen.add(snapshot.layerId);
    return allowed.has(snapshot.layerId);
  });
}

export class SpatialDataModeChangedError extends Error {}

export class EngineHost {
  readonly #controllers = new Set<AbortController>();
  #partition: SpatialDataPartition;
  #partitionGeneration = 0;
  #closed = false;

  constructor(readonly dependencies: {
    partition: SpatialDataPartition;
    coreInput: SpatialCoreInputPort;
    state: SpatialLayerStateStore;
    registry: SpatialEngineRegistryPort;
    notifier: SpatialSnapshotNotifier;
    executor: SpatialEngineExecutor;
    timeoutMs?: number;
    now?: () => Date;
    logger?: SpatialEngineHostLogger;
  }) {
    this.#partition = dependencies.partition;
  }

  get partition(): SpatialDataPartition {
    return { ...this.#partition };
  }

  get manifests(): SpatialLayerEngineManifest[] {
    return this.dependencies.registry.list();
  }

  private now(): Date {
    return this.dependencies.now?.() ?? new Date();
  }

  /** Ensure zero-config scalar output while research engines remain opt-in. */
  ensureScopeDefaults(scope: SpatialScope, at = this.now().toISOString()): {
    configuration: SpatialConfigurationVersion;
    assignments: SpatialEngineAssignment[];
  } {
    if (!this.dependencies.coreInput.scopeExists(scope)) throw new Error(`${scope.kind} ${scope.id} does not exist`);
    let configuration = this.dependencies.state.getCurrentConfiguration(this.#partition, scope);
    if (configuration.version === 0) {
      configuration = this.dependencies.state.putConfiguration({
        partition: this.#partition,
        scope,
        baseVersion: 0,
        config: {
          featureFlags: {
            spatialLayersEnabled: true,
            experimentalPropagationEnabled: false,
            researchActivityEnabled: false,
          },
          engineWindowsMinutes: { ...DEFAULT_WINDOWS_MINUTES },
        },
        createdAt: at,
        createdBy: "system-default",
      });
    }
    const existing = new Map(this.dependencies.state.listAssignments(this.#partition, scope).map((item) => [item.engineId, item]));
    for (const manifest of this.manifests) {
      if (existing.has(manifest.id)) continue;
      const enabled = manifest.id === "climate-scalars";
      const assignment: SpatialEngineAssignment = {
        scope,
        engineId: manifest.id,
        engineVersion: manifest.version,
        enabled,
        layerIds: [...manifest.producedLayerIds],
        configVersion: configuration.version,
        updatedAt: at,
      };
      this.dependencies.state.putAssignment(this.#partition, assignment);
      existing.set(manifest.id, assignment);
    }
    return { configuration, assignments: [...existing.values()].sort((left, right) => left.engineId.localeCompare(right.engineId)) };
  }

  ensureAllScopeDefaults(at = this.now().toISOString()): SpatialScope[] {
    const scopes = this.dependencies.coreInput.listScopes();
    for (const scope of scopes) this.ensureScopeDefaults(scope, at);
    return scopes;
  }

  async describeScope(scope: SpatialScope, bucketAt = this.now().toISOString()): Promise<SpatialScopeOverview> {
    const { configuration, assignments } = this.ensureScopeDefaults(scope, bucketAt);
    const houses = this.dependencies.coreInput.housesForScope(scope);
    const from = new Date(Date.parse(bucketAt) - 180 * 60_000).toISOString();
    const bindings = houses.flatMap((house) => this.dependencies.state.listBindings(this.#partition, house.id, from, bucketAt));
    const description = await this.dependencies.coreInput.describe({
      partition: this.#partition,
      scope,
      bucketAt,
      configuration,
      bindings,
    });
    return {
      partition: this.partition,
      scope,
      configuration,
      assignments,
      topology: description.topology,
      warnings: description.warnings,
    };
  }

  async inferScope(scope: SpatialScope, bucketAt: string, requestedLayerIds: string[] = []): Promise<SpatialEngineRunReport> {
    if (this.#closed) throw new Error("Spatial engine host is closed");
    const partition = this.partition;
    const partitionGeneration = this.#partitionGeneration;
    const normalizedBucketAt = new Date(bucketAt).toISOString();
    const { configuration } = this.ensureScopeDefaults(scope, normalizedBucketAt);
    const plan = buildExecutionPlan(
      this.dependencies.registry,
      this.dependencies.state.listAssignments(partition, scope),
      requestedLayerIds,
    );
    if (plan.items.length === 0 && plan.failures.length === 0) {
      return { scope, bucketAt: normalizedBucketAt, status: "disabled", snapshots: [], failures: [] };
    }
    const persisted: PersistedSpatialLayerSnapshot[] = [];
    const failures: Array<{ engineId: string; code: string; message: string }> = [...plan.failures];
    const outputsByEngine = new Map<string, SpatialLayerSnapshot[]>();
    const statusByEngine = new Map<string, "succeeded" | "failed" | "skipped">();
    for (const item of plan.items) {
      const { assignment, manifest } = item;
      const startedAt = this.now();
      const run = this.dependencies.state.startRun({
        partition,
        scope,
        engineId: assignment.engineId,
        engineVersion: assignment.engineVersion,
        bucketAt: normalizedBucketAt,
        configVersion: configuration.version,
        startedAt: startedAt.toISOString(),
      });
      let inputDigest: string | null = null;
      try {
        const unavailableDependencies = (manifest.dependencies ?? []).filter(
          (dependencyId) => statusByEngine.get(dependencyId) !== "succeeded" || (outputsByEngine.get(dependencyId)?.length ?? 0) === 0,
        );
        if (unavailableDependencies.length > 0) {
          throw new SpatialDependencyExecutionError(
            `Engine ${manifest.id} was skipped because prerequisite output failed or was unavailable: ${unavailableDependencies.join(", ")}`,
          );
        }
        if (!manifest.supportedScopes.includes(scope.kind)) throw new Error(`Engine ${manifest.id} does not support ${scope.kind}`);
        const windowMinutes = configuredWindow(configuration, assignment.engineId);
        const from = new Date(Date.parse(normalizedBucketAt) - windowMinutes * 60_000).toISOString();
        const houses = this.dependencies.coreInput.housesForScope(scope);
        const bindings = houses.flatMap((house) => this.dependencies.state.listBindings(partition, house.id, from, normalizedBucketAt));
        const calibrations = houses.flatMap((house) => this.dependencies.state.listCalibrations(partition, house.id, from, normalizedBucketAt));
        const contextEvents = houses.flatMap((house) => this.dependencies.state.listContextEvents(partition, house.id, from, normalizedBucketAt));
        const dataset = await this.dependencies.coreInput.load({
          partition,
          scope,
          bucketAt: normalizedBucketAt,
          windowMinutes,
          requiredMetrics: manifest.requiredMetrics,
          configuration,
          bindings,
          calibrations,
          contextEvents,
        });
        if (partitionGeneration !== this.#partitionGeneration) throw new SpatialDataModeChangedError("Spatial data mode changed during input loading");
        const dependencySnapshots = immutableDependencySnapshots(
          (manifest.dependencies ?? []).flatMap((dependencyId) => outputsByEngine.get(dependencyId) ?? []),
        );
        const controller = new AbortController();
        this.#controllers.add(controller);
        const timeoutMs = Math.max(100, this.dependencies.timeoutMs ?? 10_000);
        try {
          const inferred = await this.dependencies.executor.execute({
            engineId: manifest.id,
            input: { ...dataset.engineInput, dependencySnapshots },
            timeoutMs,
            signal: controller.signal,
          });
          if (partitionGeneration !== this.#partitionGeneration) throw new SpatialDataModeChangedError("Spatial data mode changed before persistence");
          const outputs = validateOutputs(manifest, assignment, scope, normalizedBucketAt, inferred)
            .map((snapshot) => ({
              ...snapshot,
              warnings: [...new Set([...snapshot.warnings, ...dataset.warnings])],
              reasonCodes: [...new Set([...snapshot.reasonCodes, ...dataset.warnings.map(() => "topology-configuration-warning")])],
            }));
          inputDigest = outputs[0]?.inputDigest ?? null;
          outputsByEngine.set(manifest.id, outputs);
          statusByEngine.set(manifest.id, "succeeded");
          const persistenceOutputs = item.persistOutputs
            ? outputs.filter((snapshot) => requestedLayerIds.length === 0 || requestedLayerIds.includes(snapshot.layerId))
            : [];
          const snapshots = this.dependencies.state.persistSnapshots(partition, persistenceOutputs, this.now().toISOString());
          persisted.push(...snapshots);
          this.dependencies.state.finishRun(partition, run.id, {
            status: "succeeded",
            finishedAt: this.now().toISOString(),
            inputDigest,
            snapshotIds: snapshots.map((snapshot) => snapshot.id),
            durationMs: this.now().getTime() - startedAt.getTime(),
          });
          if (snapshots.length > 0) {
            this.dependencies.notifier.publish({
              partition,
              scope,
              snapshotIds: snapshots.map((snapshot) => snapshot.id),
              bucketAt: normalizedBucketAt,
              emittedAt: this.now().toISOString(),
            });
          }
        } finally {
          this.#controllers.delete(controller);
        }
      } catch (error) {
        const normalizedError = error instanceof SpatialExecutionAbortedError && partitionGeneration !== this.#partitionGeneration
          ? new SpatialDataModeChangedError("Spatial data mode changed during inference")
          : error;
        const details = errorDetails(normalizedError);
        failures.push({ engineId: assignment.engineId, ...details });
        statusByEngine.set(
          assignment.engineId,
          normalizedError instanceof SpatialDependencyExecutionError || normalizedError instanceof SpatialDataModeChangedError
            ? "skipped"
            : "failed",
        );
        const status = normalizedError instanceof SpatialDataModeChangedError
          ? "skipped"
          : normalizedError instanceof SpatialDependencyExecutionError
            ? "skipped"
            : normalizedError instanceof SpatialExecutionTimeoutError ? "timed_out" : "failed";
        this.dependencies.state.finishRun(partition, run.id, {
          status,
          finishedAt: this.now().toISOString(),
          inputDigest,
          errorCode: details.code,
          errorMessage: details.message,
          durationMs: this.now().getTime() - startedAt.getTime(),
        });
        this.dependencies.logger?.warn?.({
          scopeKind: scope.kind,
          scopeId: scope.id,
          dataMode: partition.dataMode,
          engineId: assignment.engineId,
          errorCode: details.code,
        }, "Spatial layer engine failed in isolation");
      }
    }
    return {
      scope,
      bucketAt: normalizedBucketAt,
      status: failures.length === 0 ? "succeeded" : persisted.length > 0 ? "partial" : "failed",
      snapshots: persisted,
      failures,
    };
  }

  health(scope: SpatialScope): SpatialEngineHealth[] {
    const defaults = this.ensureScopeDefaults(scope);
    const assignments = defaults.assignments;
    const latestSnapshots = this.dependencies.state.currentSnapshots(this.#partition, scope)
      .filter((snapshot) => snapshot.configVersion === String(defaults.configuration.version));
    return assignments.map((assignment) => {
      const latestRun = this.dependencies.state.latestRun(this.#partition, scope, assignment.engineId);
      const matching = latestSnapshots.filter((snapshot) => snapshot.model.id === assignment.engineId);
      const state: SpatialEngineHealth["state"] = !assignment.enabled
        ? "disabled"
        : latestRun === null
          ? "never_run"
          : latestRun.status === "failed" || latestRun.status === "timed_out"
            ? "error"
            : matching.some((snapshot) => snapshot.status === "insufficient_data")
              ? "degraded_sensor_data"
              : "healthy";
      return {
        scope,
        engineId: assignment.engineId,
        engineVersion: assignment.engineVersion,
        enabled: assignment.enabled,
        state,
        latestRun,
        latestSnapshotAt: matching.reduce<string | null>((latest, snapshot) => !latest || snapshot.generatedAt > latest ? snapshot.generatedAt : latest, null),
      };
    });
  }

  /** Called synchronously when the core one-way demo -> real latch activates. */
  handleDataModeActivated(nextPartition: SpatialDataPartition): void {
    const previous = this.#partition;
    if (previous.sourceDbId === nextPartition.sourceDbId && previous.dataMode === nextPartition.dataMode) return;
    for (const controller of this.#controllers) controller.abort();
    this.#controllers.clear();
    this.dependencies.state.cancelOutstandingJobs(previous, this.now().toISOString());
    this.#partition = { ...nextPartition };
    this.#partitionGeneration += 1;
    this.ensureAllScopeDefaults(this.now().toISOString());
  }

  close(): void {
    this.#closed = true;
    for (const controller of this.#controllers) controller.abort();
    this.#controllers.clear();
    this.dependencies.executor.close();
  }
}
