import { randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import {
  installRegisteredMethods,
  type AssertNoMethodKeys,
  type IncompatibleMethodKeys,
  type RegisteredMethodSet,
} from "../../method-registry.js";
import {
  STUGBY_PROTOCOL_VERSION,
  STUGBY_MAX_EVENT_PAGE_BYTES,
  type JsonValue,
  type StugubyDataset,
  type StugubyDeletionReceipt,
  type StugubyInvitation,
  type StugubyHomeCommand,
  type StugubyHomeCommandResult,
  type StugubyMember,
  type StugubyMemberState,
  type StugubyNodeIdentity,
  type StugubyPropertyCommand,
  type StugubyPropertyCommandResult,
  type StugubyPropertyConflict,
  type StugubyPropertyEntityKind,
  type StugubyRemoteResource,
  type StugubyRole,
  type StugubyShareGrant,
  type StugubySharedProperty,
  type StugubySignedEvent,
  type StugubySummary,
  type StugubyTelemetryPayload,
} from "@climate-twin/stuguby-protocol";

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

type StugubyStorePublicMethodMismatch = AssertNoMethodKeys<
  IncompatibleMethodKeys<StugubyStoreCore, StugubyStoreInternals>
>;

export function registerStugubyStoreMethods(methods: StugubyStoreMethodSet): void {
  installRegisteredMethods("StugubyStore", StugubyStoreCore.prototype, methods);
}
