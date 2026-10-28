import { HttpError } from "../../../http-error.js";
import type { StugubySharedProperty } from "@climate-twin/stuguby-protocol";
import type { ClimateDatabase } from "../../../db.js";
import type { TelemetryBus } from "../../../events.js";
import type { StugubyNodeKeys } from "../../identity.js";
import { StugubyStore } from "../../store.js";

export class StugubyError extends HttpError {
  constructor(status: number, code: string, message: string) {
    super(status, code, message);
    this.name = "StugubyError";
  }
}

export interface StugubyServiceOptions {
  database: ClimateDatabase;
  store: StugubyStore;
  keys: StugubyNodeKeys;
  bus: TelemetryBus;
  assetDirectory: string;
  fetcher?: typeof fetch;
  syncIntervalMs?: number;
  publicOrigin?: string | null;
  suggestedPublicOrigin?: string | null;
  allowUiPublicOrigin?: boolean;
  localTelemetryHistoryComplete?: (from?: string) => boolean;
}

export interface MachineRequestProof {
  method: string;
  path: string;
  body: Uint8Array;
  nodeId: string | undefined;
  timestamp: string | undefined;
  requestId: string | undefined;
  signature: string | undefined;
}

export interface Notification {
  stugubyId: string;
  targetNodeId: string;
  cursor: number;
}

export type SharedPropertyInput = Pick<StugubySharedProperty,
  "name" | "description" | "location" | "areas" | "equipment" | "notes" | "maintenance"
> & Partial<Pick<StugubySharedProperty, "editPolicy" | "designatedSuccessorNodeId">>;
