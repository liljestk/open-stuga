import type { DatabaseSync } from "node:sqlite";
import {
  installRegisteredMethods,
  type RegisteredMethodSet,
} from "../../method-registry.js";

export const stugubyStoreState = Symbol("StugubyStore.state");

export interface StugubyStoreState {
  db: DatabaseSync;
}

export function createStugubyStoreState(): StugubyStoreState {
  return {
    db: undefined as unknown as DatabaseSync,
  };
}

export interface StugubyStoreInternals {
  readonly [stugubyStoreState]: StugubyStoreState;
  readonly localNodeId: string;
}

export type StugubyStoreMethodSet = RegisteredMethodSet<StugubyStoreInternals>;

export class StugubyStoreCore {
  readonly [stugubyStoreState] = createStugubyStoreState();
  constructor(
      db: DatabaseSync,
      readonly localNodeId: string,
      options: { readOnly?: boolean } = {},
    ) {
      const service = this as unknown as StugubyStoreInternals;
      this[stugubyStoreState].db = db;
      if (!options.readOnly) service.migrate();
    }
}

export function registerStugubyStoreMethods(methods: StugubyStoreMethodSet): void {
  installRegisteredMethods("StugubyStore", StugubyStoreCore.prototype, methods);
}
