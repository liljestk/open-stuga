import type {
  House,
} from "@climate-twin/contracts";
import {
  type StugubyHomeCommand,
  type StugubyHomeCommandResult,
  type StugubyHomeCommandSnapshot,
} from "@climate-twin/stuguby-protocol";
import "../core.js";

declare module "../core.js" {
  interface StugubyServiceInternals {
    captureHomeMutation(houseId: string): StugubyHomeCommand | null;
    editableHomeSnapshot(house: House): StugubyHomeCommandSnapshot;
    applyHomeCommandAs(actorNodeId: string, candidate: unknown): StugubyHomeCommandResult;
  }

  interface StugubyServiceCore {
    captureHomeMutation(houseId: string): StugubyHomeCommand | null;
    applyHomeCommandAs(actorNodeId: string, candidate: unknown): StugubyHomeCommandResult;
  }
}
