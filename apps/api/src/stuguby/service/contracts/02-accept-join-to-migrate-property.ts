import {
  type StugubyJoinRequest,
  type StugubyJoinResponse,
  type StugubyMember,
  type StugubyMemberState,
  type StugubyRole,
  type StugubyShareGrant,
  type StugubySharedProperty,
} from "@climate-twin/stuguby-protocol";
import type { ClimateDatabase } from "../../../db.js";
import {
  type StugubyLocalMember,
  type StugubyPropertyAdoption,
} from "../../store.js";
import { SharedPropertyInput } from "../support/01-stuguby-error-to-without-local-grant-identity.js";
import "../core.js";

declare module "../core.js" {
  interface StugubyServiceInternals {
    acceptJoin(request: StugubyJoinRequest): StugubyJoinResponse;
    updateMember(stugubyId: string, nodeId: string, role: StugubyRole, state: StugubyMemberState): StugubyMember;
    updateMemberLocalLabel(stugubyId: string, nodeId: string, value: unknown): StugubyLocalMember;
    updateSharedProperty(stugubyId: string, baseRevision: number, input: SharedPropertyInput): Promise<StugubySharedProperty>;
    updateSharedPropertyAs(actorNodeId: string, stugubyId: string, baseRevision: number, input: SharedPropertyInput): StugubySharedProperty;
    adoptProperty(stugubyId: string, localPropertyId?: string): StugubyPropertyAdoption;
    migrateProperty(stugubyId: string, sourcePropertyId: string): {
            adoption: StugubyPropertyAdoption;
            migrationSnapshotId: string;
            moved: ReturnType<ClimateDatabase["migratePropertyInto"]>;
            createdGrants: StugubyShareGrant[];
        };
  }

  interface StugubyServiceCore {
    acceptJoin(request: StugubyJoinRequest): StugubyJoinResponse;
    updateMember(stugubyId: string, nodeId: string, role: StugubyRole, state: StugubyMemberState): StugubyMember;
    updateMemberLocalLabel(stugubyId: string, nodeId: string, value: unknown): StugubyLocalMember;
    updateSharedProperty(stugubyId: string, baseRevision: number, input: SharedPropertyInput): Promise<StugubySharedProperty>;
    updateSharedPropertyAs(actorNodeId: string, stugubyId: string, baseRevision: number, input: SharedPropertyInput): StugubySharedProperty;
    adoptProperty(stugubyId: string, localPropertyId?: string): StugubyPropertyAdoption;
    migrateProperty(stugubyId: string, sourcePropertyId: string): {
            adoption: StugubyPropertyAdoption;
            migrationSnapshotId: string;
            moved: ReturnType<ClimateDatabase["migratePropertyInto"]>;
            createdGrants: StugubyShareGrant[];
        };
  }
}
