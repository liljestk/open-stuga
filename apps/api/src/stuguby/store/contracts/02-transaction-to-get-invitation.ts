import {
  type StugubyInvitation,
  type StugubyMember,
  type StugubyMemberState,
  type StugubyNodeIdentity,
  type StugubyRole,
  type StugubySummary,
} from "@climate-twin/stuguby-protocol";
import { StugubyLocalInvitation, StugubyLocalMember, StugubyRow } from "../support/01-stuguby-row-to-event-blob-digests.js";
import "../core.js";

declare module "../core.js" {
  interface StugubyStoreInternals {
    transaction<T>(operation: () => T): T;
    createCoordinatedStuguby(input: {
            id?: string;
            name: string;
            description?: string | null;
            coordinatorUrl: string;
        }, identity: StugubyNodeIdentity): StugubySummary;
    saveJoinedStuguby(summary: StugubySummary, members: StugubyMember[], localMember: StugubyMember): StugubySummary;
    listStugubys(): StugubySummary[];
    getNodePublicOrigin(): string | null;
    setNodePublicOrigin(value: string, now?: string): number;
    getStuguby(id: string): StugubySummary | null;
    deleteStuguby(stugubyId: string): string[];
    isCoordinator(stugubyId: string): boolean;
    reconcileUnjoinedCoordinatorOrigins(coordinatorUrl: string, now?: string): number;
    reconcileUnjoinedCoordinatorOriginsInTransaction(coordinatorUrl: string, now: string): number;
    summaryFromRow(row: StugubyRow): StugubySummary;
    listMembers(stugubyId: string): StugubyMember[];
    listLocalMembers(stugubyId: string): StugubyLocalMember[];
    getMember(stugubyId: string, nodeId: string): StugubyMember | null;
    upsertMember(member: StugubyMember): void;
    updateMember(stugubyId: string, nodeId: string, role: StugubyRole, state: StugubyMemberState): StugubyMember;
    updateMemberLocalLabel(stugubyId: string, nodeId: string, localLabel: string | null): StugubyLocalMember;
    createInvitation(input: {
            stugubyId: string;
            localLabel?: string | null;
            role: Exclude<StugubyRole, "steward">;
            secretHash: string;
            expiresAt: string;
            coordinatorUrl: string;
        }): StugubyLocalInvitation;
    listInvitations(stugubyId: string): StugubyInvitation[];
    listLocalInvitations(stugubyId: string): StugubyLocalInvitation[];
    getInvitation(id: string): StugubyInvitation | null;
  }

  interface StugubyStoreCore {
    transaction<T>(operation: () => T): T;
    createCoordinatedStuguby(input: {
            id?: string;
            name: string;
            description?: string | null;
            coordinatorUrl: string;
        }, identity: StugubyNodeIdentity): StugubySummary;
    saveJoinedStuguby(summary: StugubySummary, members: StugubyMember[], localMember: StugubyMember): StugubySummary;
    listStugubys(): StugubySummary[];
    getNodePublicOrigin(): string | null;
    setNodePublicOrigin(value: string, now?: string): number;
    getStuguby(id: string): StugubySummary | null;
    deleteStuguby(stugubyId: string): string[];
    isCoordinator(stugubyId: string): boolean;
    reconcileUnjoinedCoordinatorOrigins(coordinatorUrl: string, now?: string): number;
    listMembers(stugubyId: string): StugubyMember[];
    listLocalMembers(stugubyId: string): StugubyLocalMember[];
    getMember(stugubyId: string, nodeId: string): StugubyMember | null;
    upsertMember(member: StugubyMember): void;
    updateMember(stugubyId: string, nodeId: string, role: StugubyRole, state: StugubyMemberState): StugubyMember;
    updateMemberLocalLabel(stugubyId: string, nodeId: string, localLabel: string | null): StugubyLocalMember;
    createInvitation(input: {
            stugubyId: string;
            localLabel?: string | null;
            role: Exclude<StugubyRole, "steward">;
            secretHash: string;
            expiresAt: string;
            coordinatorUrl: string;
        }): StugubyLocalInvitation;
    listInvitations(stugubyId: string): StugubyInvitation[];
    listLocalInvitations(stugubyId: string): StugubyLocalInvitation[];
    getInvitation(id: string): StugubyInvitation | null;
  }
}
