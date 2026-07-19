import type {
  SpatialLayerEngine,
  SpatialLayerEngineHealth,
  SpatialLayerEngineInput,
  SpatialLayerEngineManifest,
  SpatialLayerDependencySnapshot,
  SpatialLayerSnapshot,
} from './contracts.js';
import { UnexplainedActivityEngine } from './activity.js';
import { ClimateScalarEngine } from './climate-scalars.js';
import { GraphPropagationEngine } from './propagation.js';

function freezeRecursively(value: unknown): void {
  if (value === null || typeof value !== 'object' || Object.isFrozen(value)) return;
  for (const child of Object.values(value as Record<string, unknown>)) freezeRecursively(child);
  Object.freeze(value);
}

/** Clone and freeze dependency payloads before exposing them to a model. */
export function immutableDependencySnapshots(
  snapshots: readonly (SpatialLayerSnapshot | SpatialLayerDependencySnapshot)[],
): readonly SpatialLayerDependencySnapshot[] {
  const copies = snapshots.map((snapshot) => {
    const copy = structuredClone(snapshot);
    freezeRecursively(copy);
    return copy as SpatialLayerDependencySnapshot;
  });
  return Object.freeze(copies);
}

export class SpatialLayerEngineRegistry {
  readonly #engines = new Map<string, SpatialLayerEngine>();

  register(engine: SpatialLayerEngine): this {
    if (this.#engines.has(engine.manifest.id)) {
      throw new Error(`Spatial layer engine ${engine.manifest.id} is already registered`);
    }
    this.#engines.set(engine.manifest.id, engine);
    return this;
  }

  unregister(engineId: string): boolean {
    return this.#engines.delete(engineId);
  }

  resolve(engineId: string): SpatialLayerEngine {
    const engine = this.#engines.get(engineId);
    if (engine === undefined) throw new Error(`Unknown spatial layer engine: ${engineId}`);
    return engine;
  }

  list(): SpatialLayerEngineManifest[] {
    return [...this.#engines.values()]
      .map((engine) => engine.manifest)
      .sort((left, right) => left.id.localeCompare(right.id));
  }

  health(): SpatialLayerEngineHealth[] {
    return this.list().map((manifest) => ({
      engineId: manifest.id,
      modelVersion: manifest.version,
      maturity: manifest.maturity,
      state: 'available',
    }));
  }

  async infer(engineId: string, input: SpatialLayerEngineInput): Promise<SpatialLayerSnapshot[]> {
    const engine = this.resolve(engineId);
    if (!engine.manifest.supportedScopes.includes(input.scope.kind)) {
      throw new Error(`Engine ${engineId} does not support ${input.scope.kind} scope`);
    }
    return await engine.infer({
      ...input,
      dependencySnapshots: immutableDependencySnapshots(input.dependencySnapshots ?? []),
    });
  }

  async inferAll(
    input: SpatialLayerEngineInput,
    engineIds: readonly string[] = this.list().map((manifest) => manifest.id),
  ): Promise<SpatialLayerSnapshot[]> {
    const ordered = this.dependencyOrder(engineIds);
    const snapshots: SpatialLayerSnapshot[] = [];
    const outputsByEngine = new Map<string, SpatialLayerSnapshot[]>();
    for (const engineId of ordered) {
      const manifest = this.resolve(engineId).manifest;
      const dependencyOutputs = (manifest.dependencies ?? []).flatMap((dependencyId) => outputsByEngine.get(dependencyId) ?? []);
      const engineInput: SpatialLayerEngineInput = {
        ...input,
        dependencySnapshots: immutableDependencySnapshots(dependencyOutputs),
      };
      const outputs = await this.infer(engineId, engineInput);
      outputsByEngine.set(engineId, outputs);
      snapshots.push(...outputs);
    }
    return snapshots;
  }

  private dependencyOrder(engineIds: readonly string[]): string[] {
    const ordered: string[] = [];
    const visiting = new Set<string>();
    const visited = new Set<string>();
    const visit = (engineId: string): void => {
      if (visited.has(engineId)) return;
      if (visiting.has(engineId)) throw new Error(`Spatial layer engine dependency cycle at ${engineId}`);
      visiting.add(engineId);
      const engine = this.resolve(engineId);
      for (const dependency of engine.manifest.dependencies ?? []) {
        visit(dependency);
      }
      visiting.delete(engineId);
      visited.add(engineId);
      ordered.push(engineId);
    };
    for (const engineId of engineIds) visit(engineId);
    return ordered;
  }
}

export function createBuiltinSpatialLayerRegistry(): SpatialLayerEngineRegistry {
  return new SpatialLayerEngineRegistry()
    .register(new ClimateScalarEngine())
    .register(new GraphPropagationEngine())
    .register(new UnexplainedActivityEngine());
}
