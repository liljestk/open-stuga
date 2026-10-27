import { mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import {
  installRegisteredMethods,
  type RegisteredMethodSet,
} from "../../method-registry.js";

export const spatialLayerStateStoreState = Symbol("SpatialLayerStateStore.state");

export interface SpatialLayerStateStoreState {
  transactionDepth: number;
}

export function createSpatialLayerStateStoreState(): SpatialLayerStateStoreState {
  return {
    transactionDepth: 0,
  };
}

export interface SpatialLayerStateStoreInternals {
  readonly [spatialLayerStateStoreState]: SpatialLayerStateStoreState;
  readonly db: DatabaseSync;
}

export type SpatialLayerStateStoreMethodSet = RegisteredMethodSet<SpatialLayerStateStoreInternals>;

export class SpatialLayerStateStoreCore {
  readonly db: DatabaseSync;
  readonly [spatialLayerStateStoreState] = createSpatialLayerStateStoreState();
  constructor(path: string) {
      const service = this as unknown as SpatialLayerStateStoreInternals;

      if (path !== ":memory:") mkdirSync(dirname(resolve(path)), { recursive: true });
      const db = new DatabaseSync(path);
      this.db = db;
      try {
        db.exec("PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000;");
        service.migrate();
      } catch (error) {
        // A corrupt or incompatible optional state database must not leave a
        // partially constructed SQLite handle behind. On Windows that handle
        // also keeps the file locked after the research subsystem fails open.
        try {
          db.close();
        } catch {
          // Preserve the initialization error, which is the actionable failure.
        }
        throw error;
      }
    }
}

export function registerSpatialLayerStateStoreMethods(methods: SpatialLayerStateStoreMethodSet): void {
  installRegisteredMethods(
    "SpatialLayerStateStore",
    SpatialLayerStateStoreCore.prototype,
    methods,
  );
}
